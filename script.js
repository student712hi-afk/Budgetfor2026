(() => {
  'use strict';

  const APP_VERSION = 1;
  const STORAGE_KEY = 'budgetos_data_v1';

  const Util = {
    uid: () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    monthKey: (d = new Date()) => new Date(d).toISOString().slice(0, 7),
    money: (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n || 0),
    percent: (n) => `${Number.isFinite(n) ? n.toFixed(1) : 0}%`,
    safeNum: (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? n : null;
    },
    clamp: (v, min, max) => Math.min(max, Math.max(min, v)),
    monthsBack: (count, base) => Array.from({ length: count }, (_, i) => {
      const d = new Date(`${base}-01T00:00:00`);
      d.setMonth(d.getMonth() - (count - 1 - i));
      return d.toISOString().slice(0, 7);
    })
  };

  const defaultData = () => ({
    version: APP_VERSION,
    meta: { lastBackup: null },
    income: [],
    expenses: [],
    categories: [
      { id: Util.uid(), name: 'Housing', limit: 1800 },
      { id: Util.uid(), name: 'Food', limit: 700 },
      { id: Util.uid(), name: 'Transport', limit: 400 },
      { id: Util.uid(), name: 'Utilities', limit: 300 },
      { id: Util.uid(), name: 'Leisure', limit: 450 }
    ],
    debts: [],
    debtExtraPayments: [],
    goals: [],
    assets: [
      { id: Util.uid(), name: 'Cash', value: 0, month: Util.monthKey() },
      { id: Util.uid(), name: 'Investments', value: 0, month: Util.monthKey() }
    ]
  });

  const StorageController = {
    load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return defaultData();
        const parsed = JSON.parse(raw);
        if (parsed.version !== APP_VERSION) return { ...defaultData(), ...parsed, version: APP_VERSION };
        return parsed;
      } catch {
        return defaultData();
      }
    },
    save(data) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    },
    export(data) {
      data.meta.lastBackup = new Date().toISOString();
      this.save(data);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `budgetos-backup-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    },
    import(file, callback) {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const imported = JSON.parse(reader.result);
          if (!imported || typeof imported !== 'object') throw new Error('Invalid JSON');
          callback({ ...defaultData(), ...imported, version: APP_VERSION });
        } catch {
          alert('Invalid backup file.');
        }
      };
      reader.readAsText(file);
    },
    reset() {
      localStorage.removeItem(STORAGE_KEY);
      return defaultData();
    }
  };

  const state = {
    data: StorageController.load(),
    month: Util.monthKey(),
    modalContext: null
  };

  const DataLayer = {
    listMonthly(collection) { return state.data[collection].filter((x) => (x.month || state.month) === state.month); },
    upsert(collection, item) {
      const arr = state.data[collection];
      const i = arr.findIndex((x) => x.id === item.id);
      if (i > -1) arr[i] = item; else arr.push(item);
      StorageController.save(state.data);
    },
    remove(collection, id) {
      state.data[collection] = state.data[collection].filter((x) => x.id !== id);
      StorageController.save(state.data);
    }
  };

  const CalculationEngine = {
    monthlyTotals(month = state.month) {
      const income = state.data.income.filter((i) => i.month === month || i.recurring).reduce((s, i) => s + i.amount, 0);
      const expenses = state.data.expenses.filter((e) => e.month === month || e.recurring).reduce((s, e) => s + e.amount, 0);
      const debts = state.data.debts.reduce((s, d) => s + d.balance, 0);
      const assets = state.data.assets.filter((a) => a.month === month).reduce((s, a) => s + a.value, 0);
      const net = income - expenses;
      return { income, expenses, net, savingsRate: income ? (net / income) * 100 : 0, debts, assets, netWorth: assets - debts };
    },
    ytdIncome() {
      const year = state.month.slice(0, 4);
      return state.data.income.filter((i) => i.month.startsWith(year)).reduce((s, i) => s + i.amount, 0);
    },
    expenseByCategory(month = state.month) {
      return state.data.expenses
        .filter((e) => e.month === month || e.recurring)
        .reduce((acc, e) => ((acc[e.category] = (acc[e.category] || 0) + e.amount), acc), {});
    },
    burnRate() {
      const day = new Date().getDate();
      const spent = state.data.expenses.filter((e) => e.month === state.month).reduce((s, e) => s + e.amount, 0);
      return day ? (spent / day) * 30 : 0;
    },
    previousMonthComparison() {
      const d = new Date(`${state.month}-01T00:00:00`);
      d.setMonth(d.getMonth() - 1);
      const prev = d.toISOString().slice(0, 7);
      const curr = this.monthlyTotals(state.month).expenses;
      const before = this.monthlyTotals(prev).expenses;
      return before ? ((curr - before) / before) * 100 : 0;
    },
    fixedVariableRatio() {
      const fixedNames = ['Housing', 'Utilities', 'Transport'];
      const monthExp = state.data.expenses.filter((e) => e.month === state.month || e.recurring);
      const fixed = monthExp.filter((e) => fixedNames.includes(e.category)).reduce((s, e) => s + e.amount, 0);
      const variable = monthExp.reduce((s, e) => s + e.amount, 0) - fixed;
      return { fixed, variable };
    },
    budgetAdherence() {
      const spendByCat = this.expenseByCategory();
      const over = state.data.categories.reduce((acc, c) => acc + Math.max(0, (spendByCat[c.name] || 0) - c.limit), 0);
      const totalLimits = state.data.categories.reduce((s, c) => s + c.limit, 0);
      return totalLimits ? Util.clamp(100 - (over / totalLimits) * 100, 0, 100) : 100;
    },
    debtRatio() {
      const t = this.monthlyTotals();
      return t.assets ? (t.debts / t.assets) * 100 : 100;
    },
    financialHealthScore() {
      const savings = Util.clamp(this.monthlyTotals().savingsRate, 0, 40) * 1.5;
      const debt = (100 - Util.clamp(this.debtRatio(), 0, 100)) * 0.3;
      const adherence = this.budgetAdherence() * 0.4;
      return Util.clamp((savings + debt + adherence) / 1.2, 0, 100);
    },
    goalSuggestion(goal) {
      const months = Math.max(1, Math.ceil((new Date(goal.targetDate) - new Date()) / (1000 * 60 * 60 * 24 * 30)));
      return Math.max(0, (goal.targetAmount - goal.currentAmount) / months);
    },
    debtSimulation(strategy = 'snowball') {
      const debts = state.data.debts.map((d) => ({ ...d }));
      if (!debts.length) return { months: 0, interest: 0 };
      let monthCount = 0; let totalInterest = 0;
      const sorter = strategy === 'snowball'
        ? (a, b) => a.balance - b.balance
        : (a, b) => a.interestRate - b.interestRate;
      while (debts.some((d) => d.balance > 0) && monthCount < 800) {
        monthCount += 1;
        debts.sort(sorter);
        let extraPool = state.data.debtExtraPayments.reduce((s, p) => s + p.amount, 0);
        debts.forEach((d, idx) => {
          if (d.balance <= 0) return;
          const monthlyRate = d.interestRate / 100 / 12;
          const interest = d.balance * monthlyRate;
          totalInterest += interest;
          d.balance += interest;
          let payment = Math.min(d.minimumPayment + (idx === 0 ? extraPool : 0), d.balance);
          if (idx === 0) extraPool = Math.max(0, extraPool - Math.max(0, payment - d.minimumPayment));
          d.balance -= payment;
        });
      }
      return { months: monthCount, interest: totalInterest };
    },
    monthlyNetWorthTrend() {
      return Util.monthsBack(6, state.month).map((m) => {
        const t = this.monthlyTotals(m);
        return { month: m, value: t.netWorth };
      });
    }
  };

  const UI = {
    el: (id) => document.getElementById(id),
    render() {
      this.renderCards();
      this.renderIncome();
      this.renderExpenses();
      this.renderDebts();
      this.renderGoals();
      this.renderAssets();
      this.renderHealth();
      this.renderCharts();
      this.el('backupTimestamp').textContent = state.data.meta.lastBackup ? new Date(state.data.meta.lastBackup).toLocaleString() : 'Never';
      this.el('monthFilter').value = state.month;
    },
    renderCards() {
      const t = CalculationEngine.monthlyTotals();
      const cards = [
        ['Monthly Income', Util.money(t.income)],
        ['Monthly Expenses', Util.money(t.expenses)],
        ['Net Cash Flow', Util.money(t.net)],
        ['Savings Rate', Util.percent(t.savingsRate)],
        ['Total Debt', Util.money(t.debts)],
        ['Net Worth', Util.money(t.netWorth)]
      ];
      this.el('summaryCards').innerHTML = cards.map(([label, value]) => `<article class="card"><div class="label">${label}</div><div class="value">${value}</div></article>`).join('');
    },
    table(headers, rows, actions) {
      return `<table class="table"><thead><tr>${headers.map((h) => `<th>${h}</th>`).join('')}<th></th></tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}<td>${actions(r[0])}</td></tr>`).join('')}</tbody></table>`;
    },
    renderIncome() {
      const rows = DataLayer.listMonthly('income').map((i) => [i.id, i.name, Util.money(i.amount), i.recurring ? 'Yes' : 'No']);
      this.el('incomeStats').innerHTML = `<article class="card"><div class="label">YTD Income</div><div class="value">${Util.money(CalculationEngine.ytdIncome())}</div></article>`;
      this.el('incomeTable').innerHTML = this.table(['Source', 'Amount', 'Recurring'], rows, (id) => `<button data-edit="income:${id}" class="btn">Edit</button> <button data-delete="income:${id}" class="btn danger">Delete</button>`)
        .replaceAll('<td>undefined</td>', '');
    },
    renderExpenses() {
      const byCat = CalculationEngine.expenseByCategory();
      const rows = DataLayer.listMonthly('expenses').map((e) => [e.id, e.name, e.category, Util.money(e.amount), e.recurring ? 'Yes' : 'No']);
      const overBudget = state.data.categories.filter((c) => (byCat[c.name] || 0) > c.limit).length;
      this.el('expenseStats').innerHTML = `
        <article class="card"><div class="label">Burn Rate</div><div class="value">${Util.money(CalculationEngine.burnRate())}/mo</div></article>
        <article class="card"><div class="label">Vs Previous Month</div><div class="value">${Util.percent(CalculationEngine.previousMonthComparison())}</div></article>
        <article class="card"><div class="label">Over Budget Categories</div><div class="value">${overBudget}</div></article>`;
      this.el('expenseTable').innerHTML = this.table(['Name', 'Category', 'Amount', 'Recurring'], rows, (id) => `<button data-edit="expense:${id}" class="btn">Edit</button> <button data-delete="expense:${id}" class="btn danger">Delete</button>`)
        .replaceAll('<td>undefined</td>', '');
    },
    renderDebts() {
      const rows = state.data.debts.map((d) => [d.id, d.name, Util.money(d.balance), `${d.interestRate}%`, Util.money(d.minimumPayment)]);
      this.el('debtTable').innerHTML = this.table(['Name', 'Balance', 'Rate', 'Minimum'], rows, (id) => `<button data-edit="debt:${id}" class="btn">Edit</button> <button data-delete="debt:${id}" class="btn danger">Delete</button>`)
        .replaceAll('<td>undefined</td>', '');
      const snow = CalculationEngine.debtSimulation('snowball');
      const ava = CalculationEngine.debtSimulation('avalanche');
      this.el('debtSimulation').innerHTML = `
        <h3>Strategy Comparison</h3>
        <p>Snowball: ${snow.months} months, ${Util.money(snow.interest)} interest.</p>
        <p>Avalanche: ${ava.months} months, ${Util.money(ava.interest)} interest.</p>
        <p>Time saved: <strong>${Math.max(0, snow.months - ava.months)} months</strong></p>
        <button class="btn" data-open-modal="extraPayModal">Log Extra Payment</button>`;
    },
    renderGoals() {
      const rows = state.data.goals.map((g) => [g.id, g.name, Util.money(g.currentAmount), Util.money(g.targetAmount), g.targetDate, Util.money(CalculationEngine.goalSuggestion(g))]);
      this.el('goalTable').innerHTML = this.table(['Goal', 'Current', 'Target', 'Date', 'Suggested/mo'], rows, (id) => `<button data-edit="goal:${id}" class="btn">Edit</button> <button data-delete="goal:${id}" class="btn danger">Delete</button>`)
        .replaceAll('<td>undefined</td>', '');
    },
    renderAssets() {
      const rows = state.data.assets.filter((a) => a.month === state.month).map((a) => [a.id, a.name, Util.money(a.value)]);
      this.el('assetTable').innerHTML = this.table(['Asset', 'Value'], rows, (id) => `<button data-edit="asset:${id}" class="btn">Edit</button> <button data-delete="asset:${id}" class="btn danger">Delete</button>`)
        .replaceAll('<td>undefined</td>', '');
    },
    renderHealth() {
      const score = CalculationEngine.financialHealthScore();
      const ratio = CalculationEngine.fixedVariableRatio();
      this.el('healthPanel').innerHTML = `
        <p>Score: <strong>${score.toFixed(0)}/100</strong></p>
        <div class="health-meter"><span style="width:${score}%"></span></div>
        <p>Budget adherence: ${Util.percent(CalculationEngine.budgetAdherence())}</p>
        <p>Fixed vs variable: ${Util.money(ratio.fixed)} / ${Util.money(ratio.variable)}</p>`;
    },
    chart(ctxId, draw) {
      const c = this.el(ctxId); const ctx = c.getContext('2d');
      ctx.clearRect(0, 0, c.width, c.height);
      draw(ctx, c.width, c.height);
    },
    renderCharts() {
      const totals = CalculationEngine.monthlyTotals();
      this.chart('barChart', (ctx, w, h) => {
        const max = Math.max(totals.income, totals.expenses, 1); const base = h - 40;
        [['Income', totals.income, '#5e8bff', 110], ['Expenses', totals.expenses, '#ff6d7a', 320]].forEach(([label, val, color, x]) => {
          const barH = (val / max) * (h - 80);
          ctx.fillStyle = color; ctx.fillRect(x, base - barH, 120, barH);
          ctx.fillStyle = '#97a6c6'; ctx.fillText(String(label), x + 35, h - 12);
        });
      });
      const byCat = CalculationEngine.expenseByCategory();
      this.chart('pieChart', (ctx, w, h) => {
        const total = Object.values(byCat).reduce((s, v) => s + v, 0) || 1;
        const colors = ['#5e8bff', '#39d98a', '#f6bf5f', '#ff6d7a', '#8f7fff', '#49c5b6'];
        let angle = -Math.PI / 2;
        Object.entries(byCat).forEach(([name, value], i) => {
          const next = angle + (value / total) * Math.PI * 2;
          ctx.beginPath(); ctx.moveTo(w / 2, h / 2); ctx.arc(w / 2, h / 2, 90, angle, next); ctx.closePath();
          ctx.fillStyle = colors[i % colors.length]; ctx.fill(); angle = next;
          ctx.fillStyle = '#97a6c6'; ctx.fillText(name, 20, 20 + i * 18);
        });
      });
      this.chart('trendChart', (ctx, w, h) => {
        const months = Util.monthsBack(6, state.month);
        const points = months.map((m) => CalculationEngine.monthlyTotals(m).net);
        const min = Math.min(...points, 0); const max = Math.max(...points, 1); const span = Math.max(1, max - min);
        ctx.strokeStyle = '#233047'; ctx.beginPath(); ctx.moveTo(40, h - 30); ctx.lineTo(w - 20, h - 30); ctx.stroke();
        ctx.strokeStyle = '#5e8bff'; ctx.beginPath();
        points.forEach((v, i) => {
          const x = 50 + (i * (w - 90)) / (points.length - 1);
          const y = h - 40 - ((v - min) / span) * (h - 70);
          if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          ctx.fillStyle = '#97a6c6'; ctx.fillText(months[i].slice(5), x - 8, h - 10);
        });
        ctx.stroke();
      });
      this.chart('netWorthChart', (ctx, w, h) => {
        const trend = CalculationEngine.monthlyNetWorthTrend();
        const vals = trend.map((t) => t.value); const min = Math.min(...vals, 0); const max = Math.max(...vals, 1); const span = Math.max(1, max - min);
        ctx.strokeStyle = '#39d98a'; ctx.beginPath();
        trend.forEach((t, i) => {
          const x = 40 + (i * (w - 70)) / (trend.length - 1);
          const y = h - 35 - ((t.value - min) / span) * (h - 65);
          if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
          ctx.fillStyle = '#97a6c6'; ctx.fillText(t.month.slice(5), x - 8, h - 10);
        });
        ctx.stroke();
      });
    }
  };

  const forms = {
    incomeModal: { title: 'Income', collection: 'income', fields: [['name', 'text'], ['amount', 'number'], ['month', 'month'], ['recurring', 'checkbox']] },
    expenseModal: { title: 'Expense', collection: 'expenses', fields: [['name', 'text'], ['category', 'select'], ['amount', 'number'], ['month', 'month'], ['recurring', 'checkbox']] },
    debtModal: { title: 'Debt', collection: 'debts', fields: [['name', 'text'], ['balance', 'number'], ['interestRate', 'number'], ['minimumPayment', 'number']] },
    goalModal: { title: 'Goal', collection: 'goals', fields: [['name', 'text'], ['currentAmount', 'number'], ['targetAmount', 'number'], ['targetDate', 'date']] },
    assetModal: { title: 'Asset', collection: 'assets', fields: [['name', 'text'], ['value', 'number'], ['month', 'month']] },
    extraPayModal: { title: 'Extra Debt Payment', collection: 'debtExtraPayments', fields: [['name', 'text'], ['amount', 'number']] },
    categoryModal: { title: 'Category Limit', collection: 'categories', fields: [['name', 'text'], ['limit', 'number']] }
  };

  const EventController = {
    init() {
      document.getElementById('spaNav').addEventListener('click', this.handleNav);
      document.body.addEventListener('click', this.handleClicks.bind(this));
      document.getElementById('monthFilter').addEventListener('change', (e) => { state.month = e.target.value; UI.render(); });
      document.getElementById('dynamicForm').addEventListener('submit', this.submitForm);
      document.getElementById('exportBtn').addEventListener('click', () => { StorageController.export(state.data); UI.render(); });
      document.getElementById('importInput').addEventListener('change', (e) => e.target.files[0] && StorageController.import(e.target.files[0], (d) => { state.data = d; StorageController.save(d); UI.render(); }));
      document.getElementById('resetBtn').addEventListener('click', () => {
        if (confirm('This will erase everything. Continue?') && confirm('Final confirmation: permanently reset data?')) {
          state.data = StorageController.reset(); UI.render();
        }
      });
      document.getElementById('quickAddBtn').addEventListener('click', () => this.openModal('expenseModal'));
    },
    handleNav(e) {
      const btn = e.target.closest('.nav-link'); if (!btn) return;
      document.querySelectorAll('.nav-link').forEach((n) => n.classList.remove('active'));
      btn.classList.add('active');
      const view = btn.dataset.view;
      document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
      document.getElementById(view).classList.add('active');
      document.getElementById('viewTitle').textContent = btn.textContent;
    },
    handleClicks(e) {
      const close = e.target.closest('[data-close-modal]');
      if (close) UI.el('formModal').close();
      const open = e.target.closest('[data-open-modal]');
      if (open) this.openModal(open.dataset.openModal);
      const del = e.target.closest('[data-delete]');
      if (del) {
        const [collection, id] = del.dataset.delete.split(':');
        if (confirm('Are you sure you want to delete this item?')) {
          const key = collection === 'expense' ? 'expenses' : `${collection}${collection.endsWith('s') ? '' : 's'}`;
          DataLayer.remove(key, id); UI.render();
        }
      }
      const edit = e.target.closest('[data-edit]');
      if (edit) {
        const [type, id] = edit.dataset.edit.split(':');
        const map = { income: 'income', expense: 'expenses', debt: 'debts', goal: 'goals', asset: 'assets' };
        this.openModal(`${type}Modal`, state.data[map[type]].find((x) => x.id === id));
      }
    },
    openModal(formKey, item = null) {
      const config = forms[formKey]; if (!config) return;
      state.modalContext = { config, item };
      UI.el('formModalTitle').textContent = `${item ? 'Edit' : 'Add'} ${config.title}`;
      UI.el('formFields').innerHTML = config.fields.map(([name, type]) => {
        const value = item ? item[name] : (name === 'month' ? state.month : type === 'checkbox' ? false : '');
        if (type === 'select') {
          return `<label class="field">${name}<select name="${name}">${state.data.categories.map((c) => `<option ${c.name === value ? 'selected' : ''}>${c.name}</option>`).join('')}</select></label>`;
        }
        return `<label class="field">${name}<input name="${name}" type="${type}" ${type === 'checkbox' ? (value ? 'checked' : '') : `value="${value ?? ''}"`} ${type === 'number' ? 'min="0" step="0.01"' : ''} required="${type === 'checkbox' ? '' : 'required'}"></label>`;
      }).join('');
      UI.el('formError').textContent = '';
      UI.el('formModal').showModal();
    },
    submitForm(e) {
      e.preventDefault();
      const ctx = state.modalContext; if (!ctx) return;
      const formData = new FormData(e.target);
      const payload = { id: ctx.item?.id || Util.uid() };
      for (const [name, type] of ctx.config.fields) {
        if (type === 'checkbox') payload[name] = !!e.target.elements[name]?.checked;
        else if (type === 'number') {
          const n = Util.safeNum(formData.get(name));
          if (n === null) return UI.el('formError').textContent = `${name} must be a valid non-negative number.`;
          payload[name] = n;
        } else payload[name] = String(formData.get(name) || '').trim();
      }
      if (!payload.name) return UI.el('formError').textContent = 'Name is required.';
      DataLayer.upsert(ctx.config.collection, payload);
      UI.el('formModal').close();
      UI.render();
    }
  };

  EventController.init();
  UI.render();
})();

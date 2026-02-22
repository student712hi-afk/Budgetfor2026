(() => {
  'use strict';

  const SCHEMA_VERSION = 2;
  const STORAGE_KEY = 'budgetfor2026_store';
  const DEFAULT_CATEGORIES = ['Housing', 'Food', 'Transport', 'Utilities', 'Health', 'Leisure', 'Debt Payment', 'Other'];

  const U = {
    id: () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    nowISO: () => new Date().toISOString(),
    todayISO: () => new Date().toISOString().slice(0, 10),
    toMonthKey: (dateISO) => String(dateISO || '').slice(0, 7),
    thisMonth: () => new Date().toISOString().slice(0, 7),
    esc: (s) => String(s ?? '').replace(/[&<>'"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])),
    num: (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; },
    monthCmp: (a, b) => a.localeCompare(b),
    monthsBack: (n, fromMonth) => Array.from({ length: n }, (_, i) => {
      const d = new Date(`${fromMonth}-01T00:00:00`);
      d.setMonth(d.getMonth() - (n - 1 - i));
      return d.toISOString().slice(0, 7);
    })
  };

  const defaultState = () => ({
    schemaVersion: SCHEMA_VERSION,
    meta: { lastSavedAt: null, lastBackupAt: null },
    data: {
      settings: { showCents: true, monthlyExtraPayment: 0 },
      activeMonth: U.thisMonth(),
      transactions: [],
      budgets: { baseLimits: Object.fromEntries(DEFAULT_CATEGORIES.map((c) => [c, 0])), overrides: {} },
      debts: [],
      goals: [],
      assets: [
        { id: U.id(), name: 'Cash', value: 0 },
        { id: U.id(), name: 'Investments', value: 0 },
        { id: U.id(), name: 'Property', value: 0 }
      ],
      snapshots: []
    }
  });

  const Storage = {
    state: defaultState(),
    load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return;
        this.state = { ...defaultState(), ...parsed, schemaVersion: SCHEMA_VERSION };
      } catch { this.state = defaultState(); }
    },
    save() {
      this.state.meta.lastSavedAt = U.nowISO();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    },
    exportFull() {
      this.state.meta.lastBackupAt = U.nowISO();
      this.save();
      this.download('budgetfor2026-full.json', this.state);
    },
    exportReport(reportObj, monthKey) {
      this.download(`budget-report-${monthKey}.json`, reportObj);
    },
    download(name, payload) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
    },
    reset() {
      localStorage.removeItem(STORAGE_KEY);
      this.state = defaultState();
      this.save();
    }
  };

  const Engine = {
    recurringActive(tx, month) {
      if (!tx.recurring) return U.toMonthKey(tx.dateISO) === month;
      if (!tx.startMonth) return false;
      if (U.monthCmp(tx.startMonth, month) > 0) return false;
      if (tx.endMonth && U.monthCmp(month, tx.endMonth) > 0) return false;
      return true;
    },
    monthTransactions(month) { return Storage.state.data.transactions.filter((t) => this.recurringActive(t, month)); },
    totals(month) {
      const tx = this.monthTransactions(month);
      const income = tx.filter((t) => t.type === 'income').reduce((s, t) => s + t.amount, 0);
      const expenses = tx.filter((t) => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
      const debt = Storage.state.data.debts.reduce((s, d) => s + d.balance, 0);
      const assets = Storage.state.data.assets.reduce((s, a) => s + a.value, 0);
      const net = income - expenses;
      return { income, expenses, net, savingsRate: income ? (net / income) * 100 : 0, debt, assets, netWorth: assets - debt };
    },
    categorySpend(month) {
      const out = {};
      this.monthTransactions(month).filter((t) => t.type === 'expense').forEach((t) => { out[t.category] = (out[t.category] || 0) + t.amount; });
      return out;
    },
    categoryLimit(category, month) {
      const ov = Storage.state.data.budgets.overrides[month]?.[category];
      return ov ?? Storage.state.data.budgets.baseLimits[category] ?? 0;
    },
    budgetOverAmount(month) {
      const spend = this.categorySpend(month);
      return Object.keys(Storage.state.data.budgets.baseLimits).reduce((sum, c) => sum + Math.max(0, (spend[c] || 0) - this.categoryLimit(c, month)), 0);
    },
    fixedVariableRatio(month) {
      const fixed = ['Housing', 'Utilities', 'Transport', 'Debt Payment'];
      const tx = this.monthTransactions(month).filter((t) => t.type === 'expense');
      const fixedAmt = tx.filter((t) => fixed.includes(t.category)).reduce((s, t) => s + t.amount, 0);
      const total = tx.reduce((s, t) => s + t.amount, 0);
      return { fixed: fixedAmt, variable: total - fixedAmt };
    },
    debtSimulation(strategy) {
      const debts = Storage.state.data.debts.map((d) => ({ ...d }));
      if (!debts.length) return { months: 0, interest: 0 };
      const extra = Storage.state.data.settings.monthlyExtraPayment || 0;
      let months = 0; let totalInterest = 0;
      const sorter = strategy === 'snowball' ? (a, b) => a.balance - b.balance : (a, b) => b.apr - a.apr;
      while (debts.some((d) => d.balance > 0.01) && months < 800) {
        months += 1;
        debts.sort(sorter);
        let extraPool = extra;
        for (let i = 0; i < debts.length; i += 1) {
          const d = debts[i];
          if (d.balance <= 0) continue;
          const interest = d.balance * (d.apr / 100 / 12);
          totalInterest += interest;
          d.balance += interest;
          const pay = Math.min(d.balance, d.minPayment + (extraPool > 0 && i === 0 ? extraPool : 0));
          if (i === 0) extraPool = Math.max(0, extraPool - Math.max(0, pay - d.minPayment));
          d.balance -= pay;
        }
      }
      return { months, interest: totalInterest };
    },
    goalMonthly(goal) {
      if (!goal.targetDate) return 0;
      const months = Math.max(1, Math.ceil((new Date(goal.targetDate) - new Date()) / (1000 * 60 * 60 * 24 * 30)));
      return Math.max(0, (goal.targetAmount - goal.currentAmount) / months);
    }
  };

  const UI = {
    fmt(n) {
      const d = Storage.state.data.settings.showCents ? 2 : 0;
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0);
    },
    pct(n) { return `${(Number.isFinite(n) ? n : 0).toFixed(1)}%`; },
    renderTable({ columns, rows, actions }) {
      const head = columns.map((c) => `<th>${U.esc(c.label)}</th>`).join('');
      const body = rows.length ? rows.map((row) => {
        const tds = columns.map((c) => `<td>${U.esc(row[c.key])}</td>`).join('');
        const actionBtns = actions.map((a) => `<button class="btn" data-action="${a.action}" data-type="${a.type}" data-id="${U.esc(row.id)}">${U.esc(a.label)}</button>`).join(' ');
        return `<tr>${tds}<td>${actionBtns}</td></tr>`;
      }).join('') : `<tr><td colspan="${columns.length + 1}" class="empty">No records for this view.</td></tr>`;
      return `<table class="table"><thead><tr>${head}<th>Actions</th></tr></thead><tbody>${body}</tbody></table>`;
    },
    drawBar(id, income, expense) {
      const c = document.getElementById(id); const x = c.getContext('2d'); x.clearRect(0, 0, c.width, c.height);
      const max = Math.max(income, expense, 1); const base = c.height - 30;
      [[income, '#5f87ff', 'Income', 120], [expense, '#ff6d84', 'Expenses', 300]].forEach(([v, col, label, left]) => {
        const h = (v / max) * 160; x.fillStyle = col; x.fillRect(left, base - h, 90, h); x.fillStyle = '#9baac0'; x.fillText(label, left, base + 18);
      });
    },
    drawPie(id, data) {
      const c = document.getElementById(id); const x = c.getContext('2d'); x.clearRect(0, 0, c.width, c.height);
      const vals = Object.entries(data); const total = vals.reduce((s, [, v]) => s + v, 0) || 1;
      const colors = ['#5f87ff', '#44d19d', '#ffb85f', '#ff6d84', '#9478ff', '#44c2d1', '#78889c'];
      let a = -Math.PI / 2;
      vals.slice(0, 6).forEach(([k, v], i) => {
        const n = a + (v / total) * Math.PI * 2;
        x.beginPath(); x.moveTo(250, 120); x.arc(250, 120, 90, a, n); x.closePath(); x.fillStyle = colors[i % colors.length]; x.fill();
        x.fillStyle = '#9baac0'; x.fillText(k, 16, 24 + i * 16); a = n;
      });
    },
    drawLine(id, values, labels, color = '#5f87ff') {
      const c = document.getElementById(id); const x = c.getContext('2d'); x.clearRect(0, 0, c.width, c.height);
      const min = Math.min(...values, 0), max = Math.max(...values, 1), span = Math.max(1, max - min);
      x.strokeStyle = '#263446'; x.beginPath(); x.moveTo(40, c.height - 30); x.lineTo(c.width - 20, c.height - 30); x.stroke();
      x.strokeStyle = color; x.beginPath();
      values.forEach((v, i) => {
        const px = 50 + i * ((c.width - 80) / Math.max(1, values.length - 1));
        const py = c.height - 40 - ((v - min) / span) * (c.height - 70);
        if (i === 0) x.moveTo(px, py); else x.lineTo(px, py);
        x.fillStyle = '#9baac0'; x.fillText(labels[i].slice(5), px - 8, c.height - 8);
      });
      x.stroke();
    },
    refresh() {
      const { data, meta } = Storage.state;
      const m = data.activeMonth;
      document.getElementById('activeMonth').value = m;
      document.getElementById('lastSaved').textContent = meta.lastSavedAt ? new Date(meta.lastSavedAt).toLocaleString() : '—';
      document.getElementById('lastBackup').textContent = meta.lastBackupAt ? new Date(meta.lastBackupAt).toLocaleString() : '—';
      document.getElementById('toggleCents').checked = data.settings.showCents;
      this.renderDashboard(); this.renderTransactions(); this.renderBudgets(); this.renderDebts(); this.renderGoals(); this.renderReports();
    },
    renderDashboard() {
      const t = Engine.totals(Storage.state.data.activeMonth);
      const cards = [['Income', this.fmt(t.income)], ['Expenses', this.fmt(t.expenses)], ['Net Cash Flow', this.fmt(t.net)], ['Savings Rate', this.pct(t.savingsRate)], ['Total Debt', this.fmt(t.debt)], ['Net Worth', this.fmt(t.netWorth)]];
      document.getElementById('summaryCards').innerHTML = cards.map(([l, v]) => `<div class="card stat"><div class="label">${U.esc(l)}</div><div class="value">${U.esc(v)}</div></div>`).join('');
      this.drawBar('chartBar', t.income, t.expenses);
      this.drawPie('chartPie', Engine.categorySpend(Storage.state.data.activeMonth));
      const months = U.monthsBack(6, Storage.state.data.activeMonth);
      this.drawLine('chartTrend', months.map((mk) => Engine.totals(mk).net), months);
    },
    renderTransactions() {
      const m = Storage.state.data.activeMonth;
      const q = document.getElementById('searchTx').value.toLowerCase();
      const cat = document.getElementById('filterCategory').value;
      const cats = ['', ...Object.keys(Storage.state.data.budgets.baseLimits)];
      document.getElementById('filterCategory').innerHTML = cats.map((c) => `<option value="${U.esc(c)}">${c || 'All categories'}</option>`).join('');
      const rows = Engine.monthTransactions(m)
        .filter((t) => (!q || t.name.toLowerCase().includes(q)) && (!cat || t.category === cat))
        .map((t) => ({ id: t.id, date: t.dateISO, type: t.type, name: t.name, category: t.category, amount: this.fmt(t.amount), recurring: t.recurring ? `Yes (${t.startMonth}${t.endMonth ? `→${t.endMonth}` : ''})` : 'No' }));
      document.getElementById('transactionsTable').innerHTML = this.renderTable({
        columns: [{ key: 'date', label: 'Date' }, { key: 'type', label: 'Type' }, { key: 'name', label: 'Description' }, { key: 'category', label: 'Category' }, { key: 'amount', label: 'Amount' }, { key: 'recurring', label: 'Recurring' }],
        rows,
        actions: [{ action: 'edit', type: 'transaction', label: 'Edit' }, { action: 'delete', type: 'transaction', label: 'Delete' }]
      });
    },
    renderBudgets() {
      const m = Storage.state.data.activeMonth; const spend = Engine.categorySpend(m);
      const cats = Object.keys(Storage.state.data.budgets.baseLimits);
      const html = cats.length ? cats.map((c) => {
        const lim = Engine.categoryLimit(c, m); const used = spend[c] || 0; const pct = lim > 0 ? Math.min(100, (used / lim) * 100) : 0;
        return `<div><div class="toolbar"><strong>${U.esc(c)}</strong><span class="${used > lim && lim > 0 ? 'bad' : 'ok'}">${this.fmt(used)} / ${this.fmt(lim)}</span></div><div class="progress"><span style="width:${pct}%"></span></div></div>`;
      }).join('<hr style="border-color:var(--line)">') : '<p class="empty">No budget categories.</p>';
      document.getElementById('budgetList').innerHTML = html;
    },
    renderDebts() {
      const debts = Storage.state.data.debts;
      if (!debts.length) document.getElementById('debtList').innerHTML = '<p class="empty">No debts yet.</p>';
      else document.getElementById('debtList').innerHTML = debts.map((d) => `<div><div class="toolbar"><strong>${U.esc(d.name)}</strong><span>${this.fmt(d.balance)} @ ${d.apr}%</span></div><div class="muted">Min payment: ${this.fmt(d.minPayment)}</div><div class="toolbar right"><button class="btn" data-action="edit" data-type="debt" data-id="${d.id}">Edit</button><button class="btn" data-action="delete" data-type="debt" data-id="${d.id}">Delete</button></div></div>`).join('<hr style="border-color:var(--line)">');
      const snow = Engine.debtSimulation('snowball');
      const ava = Engine.debtSimulation('avalanche');
      document.getElementById('debtSimulator').innerHTML = `<label>Monthly extra payment <input id="monthlyExtra" type="number" min="0" step="0.01" value="${Storage.state.data.settings.monthlyExtraPayment || 0}"></label>
        <table class="table"><thead><tr><th>Method</th><th>Months</th><th>Interest</th></tr></thead><tbody>
        <tr><td>Snowball</td><td>${snow.months}</td><td>${this.fmt(snow.interest)}</td></tr>
        <tr><td>Avalanche</td><td>${ava.months}</td><td>${this.fmt(ava.interest)}</td></tr>
        <tr><td><strong>Months saved (best)</strong></td><td colspan="2">${Math.max(0, snow.months - ava.months)}</td></tr>
        </tbody></table>`;
    },
    renderGoals() {
      const t = Engine.totals(Storage.state.data.activeMonth);
      const html = Storage.state.data.goals.length ? Storage.state.data.goals.map((g) => `<div><div class="toolbar"><strong>${U.esc(g.name)}</strong><span>${this.fmt(g.currentAmount)} / ${this.fmt(g.targetAmount)}</span></div><div class="muted">Recommended monthly: ${this.fmt(Engine.goalMonthly(g))}</div><div class="muted">Allocate leftover suggestion: ${this.fmt(Math.max(0, t.net))}</div><div class="toolbar right"><button class="btn" data-action="edit" data-type="goal" data-id="${g.id}">Edit</button><button class="btn" data-action="delete" data-type="goal" data-id="${g.id}">Delete</button></div></div>`).join('<hr style="border-color:var(--line)">') : '<p class="empty">No goals yet.</p>';
      document.getElementById('goalList').innerHTML = html;
    },
    renderReports() {
      const m = Storage.state.data.activeMonth; const t = Engine.totals(m); const r = Engine.fixedVariableRatio(m);
      document.getElementById('reportSummary').innerHTML = `<h3>Monthly Summary (${m})</h3><div class="grid two"><p>Income: ${this.fmt(t.income)}</p><p>Expenses: ${this.fmt(t.expenses)}</p><p>Net cash flow: ${this.fmt(t.net)}</p><p>Savings rate: ${this.pct(t.savingsRate)}</p><p>Over-budget amount: ${this.fmt(Engine.budgetOverAmount(m))}</p><p>Fixed / Variable: ${this.fmt(r.fixed)} / ${this.fmt(r.variable)}</p></div>`;
      const spend = Engine.categorySpend(m); const entries = Object.entries(spend).sort((a, b) => b[1] - a[1]);
      const top = entries.slice(0, 6); const other = entries.slice(6).reduce((s, [, v]) => s + v, 0); if (other) top.push(['Other', other]);
      document.getElementById('reportCategory').innerHTML = `<h3>Category Breakdown</h3>${this.renderTable({ columns: [{ key: 'category', label: 'Category' }, { key: 'amount', label: 'Amount' }], rows: top.map(([k, v], i) => ({ id: `r${i}`, category: k, amount: this.fmt(v) })), actions: [] })}`;
      this.drawPie('reportPie', Object.fromEntries(top));
      const metric = document.getElementById('reportTrendMetric').value;
      const months = U.monthsBack(6, m);
      const vals = months.map((mk) => { const tt = Engine.totals(mk); return metric === 'income' ? tt.income : metric === 'expense' ? tt.expenses : tt.net; });
      this.drawLine('reportTrend', vals, months, metric === 'expense' ? '#ff6d84' : '#5f87ff');
    }
  };

  const Modal = {
    open(type, mode, id) {
      const d = Storage.state.data; const activeMonth = d.activeMonth;
      const record = id ? (type === 'transaction' ? d.transactions.find((x) => x.id === id) : d[`${type}s`]?.find((x) => x.id === id)) : null;
      const formDefs = {
        transaction: { title: `${mode === 'edit' ? 'Edit' : 'Add'} Transaction`, fields: [
          ['type', 'select', true, ['income', 'expense']], ['name', 'text', true], ['category', 'text', true], ['amount', 'number', true], ['dateISO', 'date', true], ['recurring', 'checkbox', false], ['startMonth', 'month', false], ['endMonth', 'month', false]
        ] },
        budget: { title: 'Budget Limit', fields: [['category', 'text', true], ['baseLimit', 'number', true], ['overrideMonth', 'month', false], ['overrideLimit', 'number', false]] },
        debt: { title: `${mode === 'edit' ? 'Edit' : 'Add'} Debt`, fields: [['name', 'text', true], ['balance', 'number', true], ['apr', 'number', true], ['minPayment', 'number', true]] },
        payment: { title: 'Record Debt Payment', fields: [['debtId', 'select', true, d.debts.map((x) => x.id)], ['amount', 'number', true], ['dateISO', 'date', true]] },
        goal: { title: `${mode === 'edit' ? 'Edit' : 'Add'} Goal`, fields: [['name', 'text', true], ['targetAmount', 'number', true], ['currentAmount', 'number', true], ['targetDate', 'date', false]] }
      };
      const cfg = formDefs[type]; if (!cfg) return;
      const defaults = { type: 'expense', dateISO: U.todayISO(), recurring: false, startMonth: activeMonth, endMonth: '', overrideMonth: activeMonth };
      const row = { ...defaults, ...(record || {}) };
      document.getElementById('modalTitle').textContent = cfg.title;
      document.getElementById('modal').dataset.type = type;
      document.getElementById('modal').dataset.mode = mode;
      document.getElementById('modal').dataset.id = id || '';
      document.getElementById('modalFields').innerHTML = cfg.fields.map(([k, t, req, opts]) => {
        const v = row[k] ?? '';
        if (t === 'checkbox') return `<label class="field"><span>${k}</span><input name="${k}" type="checkbox" ${v ? 'checked' : ''}></label>`;
        if (t === 'select') {
          const options = (opts || []).map((o) => `<option value="${U.esc(o)}" ${String(o) === String(v) ? 'selected' : ''}>${U.esc(type === 'payment' && k === 'debtId' ? d.debts.find((x) => x.id === o)?.name || o : o)}</option>`).join('');
          return `<label class="field"><span>${k}</span><select name="${k}" ${req ? 'required' : ''}>${options}</select></label>`;
        }
        return `<label class="field"><span>${k}</span><input name="${k}" type="${t}" value="${U.esc(v)}" ${req ? 'required' : ''} ${t === 'number' ? 'min="0" step="0.01"' : ''}></label>`;
      }).join('');
      document.getElementById('modalError').textContent = '';
      document.getElementById('modal').showModal();
    },
    close() { document.getElementById('modal').close(); }
  };

  const Events = {
    bind() {
      document.getElementById('nav').addEventListener('click', (e) => {
        const btn = e.target.closest('.nav-btn'); if (!btn) return;
        document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active')); btn.classList.add('active');
        document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
        document.getElementById(btn.dataset.view).classList.add('active');
        document.getElementById('viewTitle').textContent = btn.textContent;
      });

      document.body.addEventListener('click', (e) => {
        if (e.target.closest('[data-close-modal]')) Modal.close();
        const open = e.target.closest('[data-open-modal]');
        if (open) Modal.open(open.dataset.openModal, open.dataset.mode || 'create', open.dataset.id || '');
        const act = e.target.closest('[data-action]');
        if (act) this.handleAction(act.dataset.action, act.dataset.type, act.dataset.id);
      });

      document.getElementById('modalForm').addEventListener('submit', this.submitModal);
      document.getElementById('activeMonth').addEventListener('change', (e) => { Storage.state.data.activeMonth = e.target.value; Storage.save(); UI.refresh(); });
      document.getElementById('searchTx').addEventListener('input', () => UI.renderTransactions());
      document.getElementById('filterCategory').addEventListener('change', () => UI.renderTransactions());
      document.getElementById('reportTrendMetric').addEventListener('change', () => UI.renderReports());
      document.getElementById('toggleCents').addEventListener('change', (e) => { Storage.state.data.settings.showCents = e.target.checked; Storage.save(); UI.refresh(); });
      document.getElementById('saveSnapshot').addEventListener('click', () => { Storage.state.data.snapshots.push({ month: Storage.state.data.activeMonth, netWorth: Engine.totals(Storage.state.data.activeMonth).netWorth, createdAt: U.nowISO() }); Storage.save(); UI.refresh(); });
      document.getElementById('exportData').addEventListener('click', () => { Storage.exportFull(); UI.refresh(); });
      document.getElementById('exportReport').addEventListener('click', () => Storage.exportReport({ month: Storage.state.data.activeMonth, summary: Engine.totals(Storage.state.data.activeMonth), category: Engine.categorySpend(Storage.state.data.activeMonth) }, Storage.state.data.activeMonth));
      document.getElementById('importData').addEventListener('change', this.importJSON);
      document.getElementById('resetData').addEventListener('click', () => {
        if (confirm('Reset all local data?\nThis action cannot be undone.') && confirm('Please confirm again: permanently delete all saved budgeting data?')) {
          Storage.reset(); UI.refresh();
        }
      });
      document.getElementById('debts').addEventListener('input', (e) => {
        if (e.target.id === 'monthlyExtra') {
          const n = U.num(e.target.value); if (n === null) return;
          Storage.state.data.settings.monthlyExtraPayment = n; Storage.save(); UI.renderDebts();
        }
      });
      window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && document.getElementById('modal').open) Modal.close(); });
    },
    handleAction(action, type, id) {
      const map = { transaction: 'transactions', debt: 'debts', goal: 'goals' };
      if (action === 'edit') Modal.open(type, 'edit', id);
      if (action === 'delete' && confirm('Delete this item?')) {
        Storage.state.data[map[type]] = Storage.state.data[map[type]].filter((x) => x.id !== id);
        Storage.save(); UI.refresh();
      }
    },
    submitModal(e) {
      e.preventDefault();
      const modal = document.getElementById('modal');
      const type = modal.dataset.type; const mode = modal.dataset.mode; const id = modal.dataset.id;
      const fd = new FormData(e.target); const out = { id: id || U.id() };
      const needPositive = ['amount', 'baseLimit', 'overrideLimit', 'balance', 'apr', 'minPayment', 'targetAmount', 'currentAmount'];
      for (const [k, v] of fd.entries()) {
        if (needPositive.includes(k)) { const n = U.num(v); if (n === null) return document.getElementById('modalError').textContent = `${k} must be a non-negative number`; out[k] = n; }
        else out[k] = String(v).trim();
      }
      out.recurring = !!e.target.elements.recurring?.checked;
      if ((type === 'transaction' && (!out.name || !out.dateISO || !out.category)) || ((type === 'debt' || type === 'goal') && !out.name)) return document.getElementById('modalError').textContent = 'Please fill all required fields.';

      if (type === 'transaction') {
        if (!out.startMonth) out.startMonth = Storage.state.data.activeMonth;
        if (!out.recurring) { out.startMonth = ''; out.endMonth = ''; }
        const arr = Storage.state.data.transactions; const idx = arr.findIndex((x) => x.id === out.id); if (idx > -1) arr[idx] = out; else arr.push(out);
      } else if (type === 'budget') {
        Storage.state.data.budgets.baseLimits[out.category] = out.baseLimit;
        if (out.overrideMonth) {
          Storage.state.data.budgets.overrides[out.overrideMonth] = Storage.state.data.budgets.overrides[out.overrideMonth] || {};
          Storage.state.data.budgets.overrides[out.overrideMonth][out.category] = out.overrideLimit || 0;
        }
      } else if (type === 'debt') {
        const arr = Storage.state.data.debts; const idx = arr.findIndex((x) => x.id === out.id); if (idx > -1) arr[idx] = out; else arr.push(out);
      } else if (type === 'goal') {
        const arr = Storage.state.data.goals; const idx = arr.findIndex((x) => x.id === out.id); if (idx > -1) arr[idx] = out; else arr.push(out);
      } else if (type === 'payment') {
        const debt = Storage.state.data.debts.find((d) => d.id === out.debtId); if (!debt) return document.getElementById('modalError').textContent = 'Debt not found.';
        debt.balance = Math.max(0, debt.balance - out.amount);
        Storage.state.data.transactions.push({ id: U.id(), type: 'expense', name: `Debt payment: ${debt.name}`, category: 'Debt Payment', amount: out.amount, dateISO: out.dateISO || U.todayISO(), recurring: false, startMonth: '', endMonth: '' });
      }
      Storage.save(); Modal.close(); UI.refresh();
    },
    importJSON(e) {
      const file = e.target.files?.[0]; if (!file) return;
      const r = new FileReader();
      r.onload = () => {
        try {
          const parsed = JSON.parse(r.result);
          const preview = parsed?.data ? `transactions:${parsed.data.transactions?.length || 0}, debts:${parsed.data.debts?.length || 0}, goals:${parsed.data.goals?.length || 0}` : 'Invalid structure';
          document.getElementById('importPreview').textContent = `Preview -> ${preview}`;
          if (!parsed?.data || !confirm('Apply imported data?')) return;
          Storage.state = { ...defaultState(), ...parsed, schemaVersion: SCHEMA_VERSION };
          Storage.save(); UI.refresh();
        } catch {
          document.getElementById('importPreview').textContent = 'Import failed: invalid JSON file.';
        }
      };
      r.readAsText(file);
    }
  };

  Storage.load();
  Storage.save();
  Events.bind();
  UI.refresh();
})();

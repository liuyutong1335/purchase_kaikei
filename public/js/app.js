'use strict';
// CMP-PURCHASEKAIKEI-004: フロントエンド（左メニュー + 5 ビュー構成）
// ビュー: ダッシュボード / 新規申請 / 申請一覧（詳細含む） / 支払予定 / 会計（試算表・元帳）
const STATUS_LABELS = {
  submitted: '申請済み',
  approved: '承認済み',
  rejected: '却下',
  ordered: '発注済み',
  received: '全量検収済',
};

const PAYABLE_STATUS_LABELS = { scheduled: '支払予定', paid: '支払済み' };
const DEPARTMENT_LABELS = { D10: 'D10 営業部', D20: 'D20 開発部', D90: 'D90 管理部' };

const FLOW_STEPS = [
  { key: 'submitted', label: '申請' },
  { key: 'approved', label: '承認' },
  { key: 'ordered', label: '発注' },
  { key: 'received', label: '検収' },
];

const state = { filter: '', selectedId: null, view: 'dashboard', rejectTargetId: null, receiveTarget: null, cache: { purchases: [], payables: [] } };

const $ = (sel) => document.querySelector(sel);

function yen(n) {
  return n.toLocaleString('ja-JP', { style: 'currency', currency: 'JPY' });
}

async function api(path, opts) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body.message || body.error || `HTTP ${res.status}`);
  }
  return body;
}

function toast(text, ok) {
  const el = document.createElement('div');
  el.className = `toast ${ok ? 'ok' : 'err'}`;
  el.textContent = text;
  $('#toast-area').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

/* ---------- ビュー切り替え ---------- */

function showView(name) {
  state.view = name;
  document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  if (name === 'dashboard') renderDashboard();
  if (name === 'accounting') initAccountingView();
  if (name === 'management') initManagementView();
}

/* ---------- KPI / ダッシュボード ---------- */

function loadKpis(purchases, payables) {
  const waiting = purchases.filter((p) => p.status === 'submitted');
  const ordered = purchases.filter((p) => p.status === 'ordered' || p.status === 'received');
  const scheduled = payables.filter((x) => x.status === 'scheduled');
  const paid = payables.filter((x) => x.status === 'paid');

  $('#kpi-approval').textContent = waiting.length;
  $('#kpi-ordered').textContent = ordered.length;

  const scheduledSum = scheduled.reduce((s, x) => s + x.amount, 0);
  $('#kpi-payable').textContent = yen(scheduledSum);
  $('#kpi-payable-note').textContent = `支払予定 ${scheduled.length} 件`;

  const paidSum = paid.reduce((s, x) => s + x.amount, 0);
  $('#kpi-paid').textContent = yen(paidSum);
  $('#kpi-paid-note').textContent = `支払済み ${paid.length} 件`;
}

function renderDashboard() {
  const { purchases, payables } = state.cache;
  loadKpis(purchases, payables);

  const tbody = $('#recent-table tbody');
  tbody.innerHTML = '';
  for (const p of [...purchases].slice(-5).reverse()) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${p.id}</td>
      <td title="${p.item}"><span class="cell-ellipsis">${p.item}</span></td>
      <td class="amount">${yen(p.amount)}</td>
      <td><span class="badge ${p.status}">${STATUS_LABELS[p.status]}</span></td>
      <td>${p.receivedTotal}/${p.qty}</td>
      <td><button class="detail-btn" data-id="${p.id}">詳細</button></td>
    `;
    tbody.appendChild(tr);
  }
}

/* ---------- 一覧 ---------- */

function renderList() {
  const all = state.cache.purchases;
  const purchases = state.filter ? all.filter((p) => p.status === state.filter) : all;

  renderFilters(all);
  const tbody = $('#purchase-table tbody');
  tbody.innerHTML = '';
  $('#list-empty').hidden = purchases.length > 0;
  for (const p of purchases) {
    const tr = document.createElement('tr');
    if (p.id === state.selectedId) tr.className = 'selected';
    tr.innerHTML = `
      <td>${p.id}</td>
      <td title="${p.item}"><span class="cell-ellipsis">${p.item}</span></td>
      <td>${p.qty}</td>
      <td class="amount">${yen(p.amount)}</td>
      <td title="${p.requester}"><span class="cell-ellipsis">${p.requester}</span></td>
      <td>${DEPARTMENT_LABELS[p.department] || p.department}</td>
      <td><span class="badge ${p.status}">${STATUS_LABELS[p.status]}</span></td>
      <td>${p.receivedTotal}/${p.qty}</td>
      <td>${p.orderNo || '—'}</td>
      <td><button class="detail-btn" data-id="${p.id}">詳細</button></td>
    `;
    tbody.appendChild(tr);
  }
}

function renderFilters(all) {
  const counts = {};
  for (const p of all) counts[p.status] = (counts[p.status] || 0) + 1;

  const defs = [
    { status: '', label: '全て', count: all.length },
    ...Object.keys(STATUS_LABELS).map((s) => ({ status: s, label: STATUS_LABELS[s], count: counts[s] || 0 })),
  ];

  const box = $('#filter-buttons');
  box.innerHTML = '';
  for (const d of defs) {
    const btn = document.createElement('button');
    btn.dataset.status = d.status;
    btn.className = state.filter === d.status ? 'active' : '';
    btn.innerHTML = `${d.label}<span class="count">${d.count}</span>`;
    box.appendChild(btn);
  }
}

/* ---------- 支払予定 ---------- */

function renderPayables() {
  const payables = state.cache.payables;
  const tbody = $('#payable-table tbody');
  tbody.innerHTML = '';
  $('#payables-empty').hidden = payables.length > 0;

  let scheduledSum = 0;
  for (const x of payables) {
    if (x.status === 'scheduled') scheduledSum += x.amount;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${x.id}</td>
      <td>${x.purchaseId}</td>
      <td title="${x.purchaseItem}"><span class="cell-ellipsis">${x.purchaseItem}</span></td>
      <td>${x.receivedQty}</td>
      <td class="amount">${yen(x.amount)}</td>
      <td>${x.scheduledDate}</td>
      <td><span class="badge ${x.status}">${PAYABLE_STATUS_LABELS[x.status]}</span></td>
      <td>${x.status === 'scheduled' ? `<button class="pay-btn" data-id="${x.id}">支払済みにする</button>` : (x.entryId ? `仕訳 #${x.entryId}` : '')}</td>
    `;
    tbody.appendChild(tr);
  }

  const total = $('#payables-total');
  total.hidden = scheduledSum === 0;
  total.innerHTML = `未払い合計<strong>${yen(scheduledSum)}</strong>`;
}

/* ---------- データ読み込み ---------- */

async function refreshAll() {
  state.cache.purchases = await api('/api/purchases');
  state.cache.payables = await api('/api/payables');
  renderList();
  renderPayables();
  renderDashboard();
  if (state.selectedId && !$('#detail-panel').hidden) {
    await showDetail(state.selectedId);
  }
}

/* ---------- 詳細 ---------- */

function stepperOf(p) {
  const doneSet = { submitted: 1, approved: 2, ordered: 3, received: 4 };
  const reached = doneSet[p.status] || 0;
  return FLOW_STEPS.map((s, i) => {
    const n = i + 1;
    return { ...s, cls: n <= reached ? 'done' : '' };
  });
}

async function showDetail(id) {
  const p = await api(`/api/purchases/${id}`);
  state.selectedId = id;
  $('#detail-panel').hidden = false;
  $('#detail-id').textContent = p.id;

  const stepper = $('#detail-stepper');
  stepper.innerHTML = '';
  for (const s of stepperOf(p)) {
    const li = document.createElement('li');
    li.className = s.cls;
    li.textContent = s.label;
    stepper.appendChild(li);
  }

  $('#detail-info').innerHTML = `
    <div><div class="item-label">品目</div>${p.item}</div>
    <div><div class="item-label">数量</div>${p.qty}</div>
    <div><div class="item-label">単価</div>${yen(p.unitPrice)}</div>
    <div><div class="item-label">金額</div>${yen(p.amount)}</div>
    <div><div class="item-label">申請者</div>${p.requester}</div>
    <div><div class="item-label">部門</div>${DEPARTMENT_LABELS[p.department] || p.department}</div>
    <div><div class="item-label">状態</div><span class="badge ${p.status}">${STATUS_LABELS[p.status]}</span></div>
    <div><div class="item-label">検収進捗</div>${p.receivedTotal}/${p.qty}</div>
    <div><div class="item-label">発注番号</div>${p.orderNo || '—'}</div>
    <div><div class="item-label">仕訳</div>${(p.journal || []).map((j) => `#${j.entryId}（${j.kind === 'receive' ? '検収' : '支払'}）`).join(' ') || '—'}</div>
  `;

  const actions = $('#detail-actions');
  actions.innerHTML = '';
  for (const b of actionButtons(p)) {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    btn.className = `btn ${b.cls}`;
    btn.addEventListener('click', () => b.onClick(p));
    actions.appendChild(btn);
  }

  const history = $('#detail-history');
  history.innerHTML = '';
  for (const h of [...p.history].reverse()) {
    const li = document.createElement('li');
    const toLabel = STATUS_LABELS[h.to] || h.to;
    const fromLabel = h.from && h.from !== h.to ? `（${STATUS_LABELS[h.from] || h.from} → ${toLabel}）` : '';
    li.innerHTML = `
      <div>${toLabel} ${fromLabel}</div>
      <div class="his-meta">${h.at.replace('T', ' ').slice(0, 16)} / ${h.actor}${h.comment ? ` / ${h.comment}` : ''}${h.entryId ? ` / 仕訳 entry #${h.entryId}` : ''}</div>
    `;
    history.appendChild(li);
  }
}

function actionButtons(p) {
  const refresh = async () => {
    await refreshAll();
    if (state.selectedId) await showDetail(state.selectedId);
  };
  const buttons = [];
  if (p.status === 'submitted') {
    buttons.push({
      label: '承認',
      cls: 'primary',
      onClick: async (p) => {
        try {
          await api(`/api/purchases/${p.id}/approve`, { method: 'POST', body: JSON.stringify({}) });
          toast('承認しました', true);
          await refresh();
        } catch (err) { toast(`エラー: ${err.message}`, false); }
      },
    });
    buttons.push({ label: '却下', cls: 'danger', onClick: (p) => openRejectModal(p) });
  }
  if (p.status === 'rejected') {
    buttons.push({
      label: '再申請',
      cls: 'primary',
      onClick: async (p) => {
        try {
          await api(`/api/purchases/${p.id}/resubmit`, { method: 'POST', body: JSON.stringify({}) });
          toast('再申請しました', true);
          await refresh();
        } catch (err) { toast(`エラー: ${err.message}`, false); }
      },
    });
  }
  if (p.status === 'approved') {
    buttons.push({
      label: '発注',
      cls: 'primary',
      onClick: async (p) => {
        try {
          const ordered = await api(`/api/purchases/${p.id}/order`, { method: 'POST', body: JSON.stringify({}) });
          toast(`発注しました（${ordered.orderNo}）`, true);
          await refresh();
        } catch (err) { toast(`エラー: ${err.message}`, false); }
      },
    });
  }
  if (p.status === 'ordered' && p.receivedTotal < p.qty) {
    buttons.push({ label: '検収', cls: 'primary', onClick: (p) => openReceiveModal(p) });
  }
  return buttons;
}

/* ---------- モーダル ---------- */

function openRejectModal(p) {
  state.rejectTargetId = p.id;
  $('#reject-target').textContent = `${p.id} ${p.item}（${yen(p.amount)}）`;
  $('#reject-comment').value = '';
  $('#reject-modal').hidden = false;
  $('#reject-comment').focus();
}

function openReceiveModal(p) {
  state.receiveTarget = p;
  const remaining = p.qty - p.receivedTotal;
  $('#receive-target').textContent = `${p.id} ${p.item}（検収済み ${p.receivedTotal}/${p.qty}）`;
  $('#receive-remaining').textContent = remaining;
  const qty = $('#receive-qty');
  qty.max = remaining;
  qty.value = remaining;
  $('#receive-date').value = new Date().toISOString().slice(0, 10);
  $('#receive-note').value = '';
  $('#receive-modal').hidden = false;
  qty.focus();
}

$('#reject-cancel').addEventListener('click', () => { $('#reject-modal').hidden = true; });
$('#receive-cancel').addEventListener('click', () => { $('#receive-modal').hidden = true; });

$('#reject-submit').addEventListener('click', async () => {
  const comment = $('#reject-comment').value.trim();
  if (!comment) { toast('却下理由を入力してください', false); return; }
  try {
    await api(`/api/purchases/${state.rejectTargetId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ comment }),
    });
    $('#reject-modal').hidden = true;
    toast('却下しました', true);
    await refreshAll();
  } catch (err) { toast(`エラー: ${err.message}`, false); }
});

$('#receive-submit').addEventListener('click', async () => {
  const p = state.receiveTarget;
  const qty = Number($('#receive-qty').value);
  const date = $('#receive-date').value;
  const remaining = p.qty - p.receivedTotal;
  if (!Number.isInteger(qty) || qty < 1) { toast('検収数量を入力してください', false); return; }
  if (qty > remaining) { toast(`残数量（${remaining}）を超えています`, false); return; }
  if (!date) { toast('検収日を入力してください', false); return; }
  try {
    const { payable } = await api(`/api/purchases/${p.id}/receive`, {
      method: 'POST',
      body: JSON.stringify({ receivedQty: qty, receivedAt: date, comment: $('#receive-note').value }),
    });
    $('#receive-modal').hidden = true;
    toast(`検収しました（支払予定 ${payable.id} 計上・仕訳 entry #${payable.entryId || '—'}・予定日 ${payable.scheduledDate}）`, true);
    await refreshAll();
  } catch (err) { toast(`エラー: ${err.message}`, false); }
});

for (const id of ['reject-modal', 'receive-modal']) {
  document.getElementById(id).addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.hidden = true;
  });
}

/* ---------- フォーム ---------- */

function updateAmountPreview() {
  const qty = Number($('#qty').value) || 0;
  const price = Number($('#unitPrice').value) || 0;
  $('#amount-preview').textContent = yen(qty * price);
}

$('#qty').addEventListener('input', updateAmountPreview);
$('#unitPrice').addEventListener('input', updateAmountPreview);

$('#purchase-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  try {
    const created = await api('/api/purchases', {
      method: 'POST',
      body: JSON.stringify({
        requester: form.requester.value,
        item: form.item.value,
        qty: Number(form.qty.value),
        unitPrice: Number(form.unitPrice.value),
        department: form.department.value,
        note: form.note.value,
      }),
    });
    form.reset();
    form.qty.value = 1;
    form.unitPrice.value = 0;
    form.department.value = 'D90';
    updateAmountPreview();
    toast(`申請を登録しました（${created.id}）`, true);
    await refreshAll();
  } catch (err) {
    toast(`登録エラー: ${err.message}`, false);
  }
});

/* ---------- 会計ビュー ---------- */

let accountsCache = null;

async function initAccountingView() {
  refreshSyncStatus();
  try {
    const { accounts } = await api('/api/accounting/accounts');
    accountsCache = accounts;
    const sel = $('#ledger-account');
    sel.innerHTML = '';
    for (const a of accounts) {
      const opt = document.createElement('option');
      opt.value = a.code;
      opt.textContent = `${a.code} ${a.name}`;
      sel.appendChild(opt);
    }
    await Promise.all([renderTrialBalance(), renderLedger()]);
  } catch (err) {
    setKaikeiStatus(false, err.message);
  }
}

function setKaikeiStatus(ok, message) {
  const el = $('#kaikei-status-text');
  el.textContent = ok ? '● 内蔵エンジン稼働中' : `● エラー（${message || ''}）`;
  el.style.color = ok ? '#7ee2a8' : '#ff9c94';
}

async function renderTrialBalance() {
  const from = $('#tb-from').value;
  const to = $('#tb-to').value;
  const department = $('#tb-department').value;
  const qs = new URLSearchParams();
  if (from) qs.set('from', from);
  if (to) qs.set('to', to);
  if (department) qs.set('department', department);
  try {
    const data = await api(`/api/accounting/trial-balance${qs.toString() ? `?${qs}` : ''}`);
    const tbody = $('#trial-balance-table tbody');
    tbody.innerHTML = '';
    const rows = data.rows || data.entries || [];
    $('#tb-empty').hidden = rows.length > 0;
    $('#tb-empty').textContent = '表示できるデータがありません（仕訳計上後に照会してください）';
    for (const r of rows) {
      const balance = r.balance ?? (r.credit_balance || r.debit_balance || 0);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.account_code ?? r.code ?? ''}</td>
        <td>${r.account_name ?? r.name ?? ''}</td>
        <td>${r.category ?? ''}</td>
        <td class="amount">${yen(r.debit_total ?? r.debit ?? 0)}</td>
        <td class="amount">${yen(r.credit_total ?? r.credit ?? 0)}</td>
        <td class="amount">${yen(balance)}</td>
      `;
      tbody.appendChild(tr);
    }
  } catch (err) {
    const tbody = $('#trial-balance-table tbody');
    tbody.innerHTML = '';
    $('#tb-empty').hidden = false;
    $('#tb-empty').textContent = `取得に失敗: ${err.message}`;
    toast(`試算表の取得に失敗: ${err.message}`, false);
  }
}

async function renderLedger() {
  const code = $('#ledger-account').value;
  if (!code) {
    $('#ledger-empty').hidden = false;
    $('#ledger-empty').textContent = '科目を選んで「照会」を押してください';
    return;
  }
  try {
    const data = await api(`/api/accounting/ledger/${code}`);
    const tbody = $('#ledger-table tbody');
    tbody.innerHTML = '';
    const rows = data.rows || data.entries || data.lines || [];
    $('#ledger-empty').hidden = rows.length > 0;
    $('#ledger-empty').textContent = 'この科目の仕訳はありません';
    for (const r of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.date ?? ''}</td>
        <td>${r.entry_id ?? r.entryId ?? r.id ?? ''}</td>
        <td>${r.description ?? ''}</td>
        <td class="amount">${yen(r.debit ?? 0)}</td>
        <td class="amount">${yen(r.credit ?? 0)}</td>
        <td class="amount">${yen(r.balance ?? r.running_balance ?? 0)}</td>
      `;
      tbody.appendChild(tr);
    }
  } catch (err) {
    const tbody = $('#ledger-table tbody');
    tbody.innerHTML = '';
    $('#ledger-empty').hidden = false;
    $('#ledger-empty').textContent = `元帳の取得に失敗: ${err.message}`;
    toast(`元帳の取得に失敗: ${err.message}`, false);
  }
}

$('#tb-refresh').addEventListener('click', renderTrialBalance);
$('#ledger-refresh').addEventListener('click', renderLedger);

/* ---------- kaikei-api ミラー連携（v3・Outbox） ---------- */

function renderSyncStatus(s) {
  const el = $('#sync-status');
  if (!s.pending && !s.lastError) {
    el.textContent = '● 同期済み — 未同期の仕訳はありません';
    el.className = 'sync-status ok';
  } else if (s.pending && !s.lastError) {
    el.textContent = `● 未同期 ${s.pending} 件 — kaikei-api（${s.url}）が届きません。起動すると自動で再送します`;
    el.className = 'sync-status warn';
  } else if (s.pending && s.lastError) {
    el.textContent = `● 未同期 ${s.pending} 件 — 直近エラー: ${s.lastError.message}`;
    el.className = 'sync-status warn';
  } else {
    el.textContent = `● 直近エラー: ${s.lastError.message}`;
    el.className = 'sync-status warn';
  }
}

async function refreshSyncStatus() {
  try {
    renderSyncStatus(await api('/api/accounting/sync'));
  } catch (err) {
    const el = $('#sync-status');
    el.textContent = `状態の取得に失敗: ${err.message}`;
    el.className = 'sync-status warn';
  }
}

$('#sync-retry').addEventListener('click', async () => {
  try {
    const r = await api('/api/accounting/sync', { method: 'POST', body: JSON.stringify({}) });
    toast(`ミラー送信: ${r.sent} 件送信・未同期 ${r.remaining} 件`, r.remaining === 0);
    await refreshSyncStatus();
  } catch (err) {
    toast(`再送に失敗: ${err.message}`, false);
  }
});

/* ---------- 経営ダッシュボード（kanri-dwh 連携） ---------- */

function mgmtQuery() {
  const qs = new URLSearchParams();
  if ($('#mgmt-from').value) qs.set('from', $('#mgmt-from').value);
  if ($('#mgmt-to').value) qs.set('to', $('#mgmt-to').value);
  const s = qs.toString();
  return s ? `?${s}` : '';
}

// 簡素バー: 比率は div 幅で表現するだけ（数値の正本は常に表）
function bar(v, max) {
  const pct = max > 0 ? Math.max(2, Math.round((v / max) * 100)) : 0;
  return `<div class="bar"><span style="width:${pct}%"></span></div>`;
}

function setKanriStatus(ok, message) {
  const el = $('#kanri-status');
  el.textContent = message;
  el.className = `sync-status ${ok ? 'ok' : 'warn'}`;
  $('#kanri-etl').disabled = !ok;
}

function setMgmtTablesError(message) {
  for (const [table, empty] of [['#pl-table', '#pl-empty'], ['#sales-table', '#sales-empty'], ['#expense-table', '#expense-empty'], ['#cash-table', '#cash-empty']]) {
    $(table + ' tbody').innerHTML = '';
    const el = $(empty);
    el.hidden = false;
    el.textContent = message;
  }
}

function fillTable(tbodySel, emptySel, rows, html) {
  const tbody = $(tbodySel);
  tbody.innerHTML = '';
  $(emptySel).hidden = rows.length > 0;
  rows.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = html(r, i, rows);
    tbody.appendChild(tr);
  });
}

async function initManagementView() {
  let rec;
  try {
    rec = await api('/api/management/kpi/reconcile');
  } catch (err) {
    setKanriStatus(false, '● 管理会計 DWH（kanri-dwh・port 8100）に接続できません — 起動するとこの画面の数字が動きます');
    setMgmtTablesError('kanri-dwh に接続できません');
    $('#mkpi-profit').textContent = '–';
    $('#mkpi-cash').textContent = '–';
    $('#mkpi-reconcile').textContent = '不明';
    return;
  }
  setKanriStatus(rec.matched, rec.matched
    ? '● 突合OK — DWH と源泉（kaikei-api）の仕訳が一致しています'
    : '● 突合不一致 — 下の「データ連携」で取込（ETL）をやり直してください');
  $('#mkpi-reconcile').textContent = rec.matched ? '✔ 一致' : '✖ 不一致';
  $('#mkpi-reconcile').style.color = rec.matched ? '' : 'var(--danger)';
  await renderManagement();
}

async function renderManagement() {
  const q = mgmtQuery();
  for (const empty of ['#pl-empty', '#sales-empty', '#expense-empty', '#cash-empty']) {
    $(empty).textContent = '表示できるデータがありません'; // 前回のエラー表示を戻す
  }
  try {
    const [pl, sales, expense, cash] = await Promise.all([
      api(`/api/management/kpi/pl-by-department${q}`),
      api(`/api/management/kpi/sales-by-month${q}`),
      api(`/api/management/kpi/expense-by-account${q}`),
      api(`/api/management/kpi/cash-trend${q}`),
    ]);

    // KPI カード（経営サマリ）
    const totalProfit = pl.rows.reduce((s, r) => s + r.profit, 0);
    const profitEl = $('#mkpi-profit');
    profitEl.textContent = `${totalProfit < 0 ? '−' : ''}${yen(Math.abs(totalProfit))}`;
    profitEl.style.color = totalProfit < 0 ? 'var(--danger)' : '';

    const lastCash = cash.rows[cash.rows.length - 1];
    $('#mkpi-cash').textContent = lastCash ? yen(lastCash.total) : '–';
    $('#mkpi-cash-note').textContent = lastCash ? `現金 + 普通預金（${lastCash.month} 月末）` : '現金 + 普通預金';

    // 部門別損益（損益の絶対値バーは数字の下に置く — 独立列は狭い画面であふれるため）
    const profitMax = Math.max(0, ...pl.rows.map((r) => Math.abs(r.profit)));
    fillTable('#pl-table', '#pl-empty', pl.rows, (r) => `
      <td>${r.department} ${r.name}</td>
      <td class="amount">${yen(r.revenue)}</td>
      <td class="amount">${yen(r.expense)}</td>
      <td class="amount" style="font-weight:600; color:${r.profit < 0 ? 'var(--danger)' : 'var(--text)'}">
        ${r.profit < 0 ? '−' : ''}${yen(Math.abs(r.profit))}
        <div class="bar ${r.profit < 0 ? 'neg' : ''}" style="width:110px"><span style="width:${profitMax ? Math.max(2, Math.round((Math.abs(r.profit) / profitMax) * 100)) : 0}%"></span></div>
      </td>
    `);

    // 資金の推移（月末残高。直近月を太らせる）
    const cashMax = Math.max(0, ...cash.rows.map((r) => r.total));
    fillTable('#cash-table', '#cash-empty', cash.rows, (r, i, arr) => `
      <td>${r.month}${i === arr.length - 1 ? ' <span class="tag-latest">直近</span>' : ''}</td>
      <td class="amount">${yen(r.cash)}</td>
      <td class="amount">${yen(r.deposit)}</td>
      <td class="amount" style="font-weight:${i === arr.length - 1 ? 600 : 400}">${yen(r.total)}</td>
      <td style="width:30%">${bar(r.total, cashMax)}</td>
    `);

    // 費用の内訳（多い順に並べ替え）
    const expenseRows = [...expense.rows].sort((a, b) => b.expense - a.expense);
    const expenseMax = Math.max(0, ...expenseRows.map((r) => r.expense));
    $('#expense-total').textContent = expense.total ? `合計 ${yen(expense.total)}` : '';
    fillTable('#expense-table', '#expense-empty', expenseRows, (r) => `
      <td>${r.account_code} ${r.name}</td>
      <td class="amount">${yen(r.expense)}</td>
      <td style="width:40%">${bar(r.expense, expenseMax)}</td>
    `);

    // 月別売上（仕訳のない月は見せない — 0 円の並びは情報ではないため）
    const byMonth = new Map();
    for (const r of sales.rows) byMonth.set(r.month, (byMonth.get(r.month) || 0) + r.revenue);
    const months = [...byMonth.entries()].filter(([, v]) => v > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const salesMax = Math.max(0, ...months.map(([, v]) => v));
    fillTable('#sales-table', '#sales-empty', months, ([m, v]) => `
      <td>${m}</td>
      <td class="amount">${yen(v)}</td>
      <td style="width:40%">${bar(v, salesMax)}</td>
    `);
  } catch (err) {
    setMgmtTablesError(`KPI の取得に失敗: ${err.message}`);
  }
}

$('#mgmt-refresh').addEventListener('click', renderManagement);

$('#kanri-etl').addEventListener('click', async () => {
  $('#kanri-etl').disabled = true;
  try {
    const r = await api('/api/management/etl', { method: 'POST', body: JSON.stringify({}) });
    toast(`取込完了: 仕訳 ${r.entry_count} 件・明細 ${r.line_count} 行（${r.date_from} 〜 ${r.date_to}）`, true);
    await initManagementView();
  } catch (err) {
    toast(`取込に失敗: ${err.message}`, false);
    await initManagementView();
  }
});

/* ---------- イベント ---------- */

$('#nav').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (btn) showView(btn.dataset.view);
});

$('#filter-buttons').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-status]');
  if (!btn) return;
  state.filter = btn.dataset.status;
  renderList();
});

$('#purchase-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('.detail-btn');
  if (btn) await showDetail(btn.dataset.id);
});

$('#recent-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('.detail-btn');
  if (btn) {
    showView('list');
    await showDetail(btn.dataset.id);
  }
});

$('#payable-table').addEventListener('click', async (e) => {
  const btn = e.target.closest('.pay-btn');
  if (!btn) return;
  try {
    const paid = await api(`/api/payables/${btn.dataset.id}/pay`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    toast(`支払を記録しました（仕訳 entry #${paid.entryId || '—'}）`, true);
    await refreshAll();
  } catch (err) {
    toast(`エラー: ${err.message}`, false);
  }
});

$('#detail-close').addEventListener('click', () => {
  $('#detail-panel').hidden = true;
  state.selectedId = null;
});

refreshAll();
initAccountingView();

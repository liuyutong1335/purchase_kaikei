'use strict';
// CMP-PURCHASEKAIKEI-004: フロントエンド（左メニュー + 5 ビュー構成）
// ビュー: ダッシュボード / 新規申請 / 申請一覧（詳細含む） / 支払予定 / 会計（試算表・元帳）
const STATUS_LABELS = {
  submitted: '申請済み',
  approved: '承認済み',
  rejected: '却下',
  ordered: '発注済み',
  received: '全量検収済',
  paid: '支払済み',
  withdrawn: '取下げ',
  correction_pending: '訂正承認待ち',
};

const PAYABLE_STATUS_LABELS = { scheduled: '支払予定', paid: '支払済み' };
const DEPARTMENT_LABELS = { D10: 'D10 営業部', D20: 'D20 開発部', D90: 'D90 管理部' };
const ROLE_LABELS = { requester: '申請者', approver: '承認者', accounting: '経理', admin: '管理者' };

// v6 ステップ 1: 操作者・ロール切替（選択はこのブラウザだけに記憶する）
const OPERATOR_KEY = 'pk-operator-code';

const state = {
  filter: '',
  selectedId: null,
  view: 'dashboard',
  rejectTargetId: null,
  receiveTarget: null,
  withdrawTargetId: null,
  updateTarget: null,
  correctionTarget: null,
  operator: null, // { code, name, role }
  masters: { vendors: [], items: [] },
  users: [],
  cache: { purchases: [], payables: [] },
};

const FLOW_STEPS = [
  { key: 'submitted', label: '申請' },
  { key: 'approved', label: '承認' },
  { key: 'ordered', label: '発注' },
  { key: 'received', label: '検収' },
  { key: 'paid', label: '支払' },
];

const $ = (sel) => document.querySelector(sel);

/* ---------- 操作者・ロール切替（v6 ステップ 1） ---------- */

// 名前は画面に出さない（個人情報表示の抑止）。ユーザーはコード + ロールで見せる
function userName(code) {
  return code || '—';
}

function currentActor() {
  return state.operator ? state.operator.code : null;
}

async function initOperator() {
  try {
    state.users = await api('/api/users');
  } catch (err) {
    $('#operator-label').textContent = `ユーザーの取得に失敗: ${err.message}`;
    return;
  }
  const sel = $('#operator-select');
  sel.innerHTML = '';
  for (const u of state.users) {
    const opt = document.createElement('option');
    opt.value = u.code;
    opt.textContent = `${u.code} / ${ROLE_LABELS[u.role] || u.role}`;
    sel.appendChild(opt);
  }
  let saved = null;
  try {
    saved = localStorage.getItem(OPERATOR_KEY);
  } catch { /* プライベートウィンドウ等では記憶しないだけ */ }
  const initial = state.users.find((u) => u.code === saved) || state.users[0];
  if (initial) setOperator(initial.code);
  sel.addEventListener('change', () => setOperator(sel.value));
}

function setOperator(code) {
  const u = state.users.find((x) => x.code === code);
  if (!u) return;
  state.operator = u;
  $('#operator-select').value = u.code;
  $('#operator-label').textContent = `${u.code} / ${ROLE_LABELS[u.role] || u.role}`;
  syncRequesterField();
  try {
    localStorage.setItem(OPERATOR_KEY, u.code);
  } catch { /* 記憶できなくても動作には影響しない */ }
}

function syncRequesterField() {
  const field = $('#requester');
  if (field) field.value = state.operator ? state.operator.code : '';
}

// 申請フォームの仕入先・品目セレクトをマスタから作る（v6 ステップ 8）
async function initPurchaseFormMasters() {
  const vendorSel = $('#vendor');
  const itemSel = $('#item');
  try {
    const [vendors, items] = await Promise.all([api('/api/vendors'), api('/api/items')]);
    state.masters = { vendors, items };
    if (vendorSel.options.length <= 1) {
      for (const v of vendors) {
        const opt = document.createElement('option');
        opt.value = v.code;
        opt.textContent = `${v.code} ${v.name}`;
        vendorSel.appendChild(opt);
      }
    }
    if (itemSel.options.length <= 1) {
      for (const i of items) {
        const opt = document.createElement('option');
        opt.value = i.code;
        opt.textContent = `${i.code} ${i.name}`;
        itemSel.appendChild(opt);
      }
    }
  } catch (err) {
    toast(`マスタの取得に失敗: ${err.message}`, false);
  }
}

// 品目を選んだら標準単価を初期値としてセットする
function onItemChange() {
  const item = (state.masters.items || []).find((i) => i.code === $('#item').value);
  if (item && item.unitPrice > 0) {
    $('#unitPrice').value = item.unitPrice;
    updateAmountPreview();
  }
}

function yen(n) {
  // currency style は環境で全角￥などに揺れるため、半角円記号 + 桁区切りで固定する
  return `¥${Number(n || 0).toLocaleString('ja-JP')}`;
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
  if (name === 'list') { initPurchaseFilters(); renderList(); }
  if (name === 'journal') initJournalView();
  if (name === 'accounting') initAccountingView();
  if (name === 'management') initManagementView();
  if (name === 'masters') { initPurchaseFilters(); initMastersView(); }
  if (name === 'new') syncRequesterField();
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

const PURCHASE_FILTER_IDS = ['#pf-q', '#pf-requester', '#pf-department', '#pf-vendor', '#pf-status', '#pf-requested-from', '#pf-requested-to', '#pf-order-from', '#pf-order-to', '#pf-receive-from', '#pf-receive-to', '#pf-scheduled-from', '#pf-scheduled-to'];

function purchaseFilterQuery() {
  const qs = new URLSearchParams();
  const val = (sel) => $(sel).value.trim();
  if (val('#pf-q')) qs.set('q', val('#pf-q'));
  if (val('#pf-requester')) qs.set('requester', val('#pf-requester'));
  if (val('#pf-department')) qs.set('department', val('#pf-department'));
  if (val('#pf-vendor')) qs.set('vendor', val('#pf-vendor'));
  if (val('#pf-status')) qs.set('status', val('#pf-status'));
  if (val('#pf-requested-from')) qs.set('requestedFrom', val('#pf-requested-from'));
  if (val('#pf-requested-to')) qs.set('requestedTo', val('#pf-requested-to'));
  if (val('#pf-order-from')) qs.set('orderFrom', val('#pf-order-from'));
  if (val('#pf-order-to')) qs.set('orderTo', val('#pf-order-to'));
  if (val('#pf-receive-from')) qs.set('receiveFrom', val('#pf-receive-from'));
  if (val('#pf-receive-to')) qs.set('receiveTo', val('#pf-receive-to'));
  if (val('#pf-scheduled-from')) qs.set('scheduledFrom', val('#pf-scheduled-from'));
  if (val('#pf-scheduled-to')) qs.set('scheduledTo', val('#pf-scheduled-to'));
  return qs.toString();
}

async function renderList() {
  // 複合検索はサーバー側で行う（state.cache はダッシュボード用に全件を保持したまま）
  const qs = purchaseFilterQuery();
  if (state.filter) qs.set('status', state.filter);
  let purchases;
  try {
    purchases = await api(`/api/purchases${qs ? `?${qs}` : ''}`);
  } catch (err) {
    toast(`一覧の取得に失敗: ${err.message}`, false);
    return;
  }

  renderFilters(purchases);
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
      <td title="${userName(p.requester)}"><span class="cell-ellipsis">${userName(p.requester)}</span></td>
      <td>${DEPARTMENT_LABELS[p.department] || p.department}</td>
      <td title="${p.vendorName || ''}"><span class="cell-ellipsis">${p.vendorCode ? `${p.vendorCode} ${p.vendorName || ''}` : '—'}</span></td>
      <td><span class="badge ${p.status}">${STATUS_LABELS[p.status]}</span></td>
      <td>${p.requestedDate || '—'}</td>
      <td>${p.orderDate || '—'}</td>
      <td>${p.receiveDate || '—'}</td>
      <td>${p.scheduledDate || '—'}</td>
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
      <td>${x.orderNo || '—'}</td>
      <td>${x.vendorCode || '—'}</td>
      <td>${x.vendorName || '—'}</td>
      <td title="${x.purchaseItem}"><span class="cell-ellipsis">${x.purchaseItem}</span></td>
      <td>${x.receivedDate || '—'}</td>
      <td>${x.scheduledDate}</td>
      <td class="amount">${yen(x.amount)}</td>
      <td><span class="badge ${x.status}">${PAYABLE_STATUS_LABELS[x.status]}</span></td>
      <td>${x.status === 'scheduled' ? `<button class="pay-btn" data-id="${x.id}">支払済みにする</button>` : (x.entryId ? `仕訳 #${x.entryId}` : '')}</td>
    `;
    tbody.appendChild(tr);
  }

  const total = $('#payables-total');
  total.hidden = scheduledSum === 0;
  total.innerHTML = `未払い合計<strong>${yen(scheduledSum)}</strong>`;
}

/* ---------- 仕訳一覧（v6 ステップ 4） ---------- */

const LINK_STATE_LABELS = { linked: '連携済み', unlinked: '未連携', error: 'エラー' };
const ENTRY_TYPE_LABELS = { normal: '通常', receive: '検収', pay: '支払', reversal: '取消' };
const JOURNAL_FILTER_IDS = ['#jf-q', '#jf-account', '#jf-state', '#jf-from', '#jf-to'];

async function initJournalView() {
  // 科目セレクト（すでに取得済みなら再取得しない）
  const sel = $('#jf-account');
  if (sel.options.length <= 1) {
    try {
      const { accounts } = await api('/api/accounting/accounts');
      for (const a of accounts) {
        const opt = document.createElement('option');
        opt.value = a.code;
        opt.textContent = `${a.code} ${a.name}`;
        sel.appendChild(opt);
      }
    } catch (err) { /* 科目が空でも一覧は出せる */ }
  }
  await renderJournal();
}

async function renderJournal() {
  const qs = new URLSearchParams();
  if ($('#jf-q').value.trim()) qs.set('q', $('#jf-q').value.trim());
  if ($('#jf-account').value) qs.set('account', $('#jf-account').value);
  if ($('#jf-state').value) qs.set('state', $('#jf-state').value);
  if ($('#jf-from').value) qs.set('from', $('#jf-from').value);
  if ($('#jf-to').value) qs.set('to', $('#jf-to').value);

  let rows;
  try {
    rows = await api(`/api/accounting/entries${qs.toString() ? `?${qs}` : ''}`);
  } catch (err) {
    toast(`仕訳一覧の取得に失敗: ${err.message}`, false);
    return;
  }
  const tbody = $('#journal-table tbody');
  tbody.innerHTML = '';
  $('#journal-empty').hidden = rows.length > 0;
  for (const e of [...rows].reverse()) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>#${e.id}</td>
      <td>${e.date}</td>
      <td>${e.voucherNo || '—'}</td>
      <td>${e.purchaseId ? `<button class="link-btn" data-purchase="${e.purchaseId}">${e.purchaseId}</button>` : '—'}</td>
      <td title="${e.description}"><span class="cell-ellipsis">${e.description}${e.multiLine ? ' <span class="tag-latest">他</span>' : ''}</span></td>
      <td>${e.debitAccount || '—'}</td>
      <td>${e.creditAccount || '—'}</td>
      <td class="amount">${yen(e.amount)}</td>
      <td>${e.status === 'active' ? '有効' : '取消済'}</td>
      <td>${e.postedBy || '—'}</td>
      <td><span class="badge link-${e.linkState}">${LINK_STATE_LABELS[e.linkState] || e.linkState}</span></td>
      <td><button class="detail-btn" data-id="${e.id}">詳細</button></td>
    `;
    tbody.appendChild(tr);
  }
}

async function showJournalDetail(id) {
  const e = await api(`/api/accounting/entries/${id}`);
  $('#journal-detail-panel').hidden = false;
  $('#jd-id').textContent = `#${e.id}（${ENTRY_TYPE_LABELS[e.entryType] || e.entryType}）`;
  $('#jd-info').innerHTML = `
    <div><div class="item-label">計上日</div>${e.date}</div>
    <div><div class="item-label">元伝票番号</div>${e.voucherNo || '—'}</div>
    <div><div class="item-label">申請番号</div>${e.purchaseId || '—'}</div>
    <div><div class="item-label">摘要</div>${e.description}</div>
    <div><div class="item-label">計上者</div>${e.postedBy || '—'}</div>
    <div><div class="item-label">計上日時</div>${(e.createdAt || '').replace('T', ' ').slice(0, 19)}</div>
    <div><div class="item-label">状態</div>${e.status === 'active' ? '有効' : '取消済'}</div>
    ${e.reversesEntryId ? `<div><div class="item-label">取消対象仕訳</div><button class="link-btn" data-journal="${e.reversesEntryId}">#${e.reversesEntryId}</button></div>` : ''}
    ${e.reversedBy ? `<div><div class="item-label">取消仕訳</div><button class="link-btn" data-journal="${e.reversedBy}">#${e.reversedBy}</button></div>` : ''}
  `;
  const linesTbody = $('#jd-lines-table tbody');
  linesTbody.innerHTML = '';
  for (const l of e.lines) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${l.account_code}</td>
      <td class="amount">${l.side === 'debit' ? yen(l.amount) : ''}</td>
      <td class="amount">${l.side === 'credit' ? yen(l.amount) : ''}</td>
    `;
    linesTbody.appendChild(tr);
  }
  const link = $('#jd-link');
  link.textContent = e.linkState === 'linked'
    ? `● 連携済み — kaikei-api 側の仕訳 #${e.kaikeiEntryId}`
    : e.linkState === 'error'
      ? '● エラー — 再送待ち（連携メニューから再送できます）'
      : '● 未連携 — kaikei-api が起動すると自動で送信されます';
  link.className = `sync-status ${e.linkState === 'linked' ? 'ok' : 'warn'}`;

  const pbox = $('#jd-purchase');
  if (e.purchase) {
    pbox.innerHTML = `
      <div class="jd-purchase-row">
        <button class="link-btn" data-purchase="${e.purchase.id}">${e.purchase.id}: ${e.purchase.item}（${yen(e.purchase.amount)}・${STATUS_LABELS[e.purchase.status]}）へ移動</button>
      </div>
      ${e.purchase.changeHistory && e.purchase.changeHistory.length > 0 ? `
        <ul class="history">
          ${e.purchase.changeHistory.map((c) => `
            <li>
              <div>${c.reason}</div>
              ${c.changes.map((ch) => `<div class="his-meta">${ch.field}: ${ch.before} → ${ch.after}</div>`).join('')}
              <div class="his-meta">${c.at.replace('T', ' ').slice(0, 16)} / 修正者: ${c.actor}</div>
            </li>
          `).join('')}
        </ul>
      ` : '<div class="his-meta">変更履歴はありません</div>'}
    `;
  } else {
    pbox.innerHTML = '<div class="his-meta">元申請なし（手動仕訳・ステップ 5 の取消/訂正仕訳など）</div>';
  }
}

// 購買詳細 → 仕訳（順リンク）: showDetail の 仕訳 参照をクリック可能にする
function journalLinkHtml(p) {
  if (!p.journal || p.journal.length === 0) return '—';
  return p.journal.map((j) =>
    `<button class="link-btn" data-journal="${j.entryId}">#${j.entryId}（${j.kind === 'receive' ? '検収' : '支払'}）</button>`
  ).join(' ');
}

/* ---------- マスタ管理（v6 ステップ 8） ---------- */

const DEPT_MASTER = [
  { code: 'D10', name: '営業部' },
  { code: 'D20', name: '開発部' },
  { code: 'D90', name: '管理部（共通）' },
];

function fillSimpleTable(tbodySel, rows, html) {
  const tbody = $(tbodySel);
  tbody.innerHTML = '';
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.innerHTML = html(r);
    tbody.appendChild(tr);
  }
}

async function initMastersView() {
  try {
    const [vendors, items, { accounts }] = await Promise.all([
      api('/api/vendors'), api('/api/items'), api('/api/accounting/accounts'),
    ]);
    state.masters = { vendors, items };
    fillSimpleTable('#vendor-table tbody', vendors, (v) => `<td>${v.code}</td><td>${v.name}</td>`);
    fillSimpleTable('#item-table tbody', items, (i) => `<td>${i.code}</td><td>${i.name}</td><td class="amount">${yen(i.unitPrice)}</td>`);
    fillSimpleTable('#master-account-table tbody', accounts, (a) => `<td>${a.code}</td><td>${a.name}</td><td>${a.category}</td>`);
  } catch (err) {
    toast(`マスタの取得に失敗: ${err.message}`, false);
  }
  // 名前は画面に出さない（操作者切替と同じ方針。コード + ロールで見せる）
  fillSimpleTable('#master-user-table tbody', state.users.length > 0 ? state.users : (state.operator ? [state.operator] : []),
    (u) => `<td>${u.code}</td><td>${ROLE_LABELS[u.role] || u.role}</td>`);
  fillSimpleTable('#master-dept-table tbody', DEPT_MASTER, (d) => `<td>${d.code}</td><td>${d.name}</td>`);
}

$('#vendor-add').addEventListener('click', async () => {
  const name = $('#vendor-name').value.trim();
  if (!name) { toast('仕入先名を入力してください', false); return; }
  try {
    const v = await api('/api/vendors', { method: 'POST', body: JSON.stringify({ name }) });
    $('#vendor-name').value = '';
    toast(`仕入先を登録しました（${v.code}）`, true);
    await initMastersView();
    await initPurchaseFormMasters();
  } catch (err) { toast(`エラー: ${err.message}`, false); }
});

$('#item-add').addEventListener('click', async () => {
  const name = $('#item-name').value.trim();
  const unitPrice = Number($('#item-price').value);
  if (!name) { toast('品目名を入力してください', false); return; }
  try {
    const i = await api('/api/items', { method: 'POST', body: JSON.stringify({ name, unitPrice }) });
    $('#item-name').value = '';
    toast(`品目を登録しました（${i.code}）`, true);
    await initMastersView();
    await initPurchaseFormMasters();
  } catch (err) { toast(`エラー: ${err.message}`, false); }
});

// マスタ横断のキーワード絞り込み（コード・名称が部分一致する行だけ残す）
function applyMasterFilter() {
  const q = ($('#master-filter').value || '').trim().toLowerCase();
  for (const tr of document.querySelectorAll('#view-masters table tbody tr')) {
    tr.hidden = q !== '' && !tr.textContent.toLowerCase().includes(q);
  }
}

$('#master-filter').addEventListener('input', applyMasterFilter);
$('#master-filter-reset').addEventListener('click', () => {
  $('#master-filter').value = '';
  applyMasterFilter();
});

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
  const doneSet = { submitted: 1, approved: 2, ordered: 3, received: 4, paid: 5, correction_pending: 4 };
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
    <div><div class="item-label">申請者</div>${userName(p.requester)}</div>
    <div><div class="item-label">部門</div>${DEPARTMENT_LABELS[p.department] || p.department}</div>
    <div><div class="item-label">仕入先</div>${p.vendorCode ? `${p.vendorCode} ${p.vendorName || ''}` : '—'}</div>
    <div><div class="item-label">状態</div><span class="badge ${p.status}">${STATUS_LABELS[p.status]}</span></div>
    <div><div class="item-label">検収進捗</div>${p.receivedTotal}/${p.qty}</div>
    <div><div class="item-label">発注番号</div>${p.orderNo || '—'}</div>
    <div><div class="item-label">仕訳</div>${journalLinkHtml(p)}</div>
  `;

  const actions = $('#detail-actions');
  actions.innerHTML = '';
  for (const b of actionButtons(p)) {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    btn.className = `btn ${b.cls}`;
    btn.disabled = !!b.disabled;
    btn.title = b.title || '';
    btn.addEventListener('click', () => b.onClick(p));
    actions.appendChild(btn);
    // 本人の申請のときは理由を目立たせる（v6 ステップ 2）
    if (b.disabled && b.title) {
      const note = document.createElement('div');
      note.className = 'self-approval-note';
      note.textContent = b.title;
      actions.appendChild(note);
    }
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

  // v6 ステップ 3: 変更履歴（変更前 → 変更後 / 修正者 / 日時 / 理由）
  const changeBox = $('#detail-change-history');
  changeBox.innerHTML = '';
  changeBox.hidden = !(p.changeHistory && p.changeHistory.length > 0);
  for (const c of [...(p.changeHistory || [])].reverse()) {
    const li = document.createElement('li');
    const fields = c.changes.map((ch) => {
      const val = (v) => (ch.field === 'unitPrice' || ch.field === 'qty' ? String(v) : v == null ? '—' : v);
      return `<div class="his-meta">${ch.field}: ${val(ch.before)} → ${val(ch.after)}</div>`;
    }).join('');
    li.innerHTML = `
      <div>${c.reason}</div>
      ${fields}
      <div class="his-meta">${c.at.replace('T', ' ').slice(0, 16)} / 修正者: ${c.actor}</div>
    `;
    changeBox.appendChild(li);
  }
}

function actionButtons(p) {
  const refresh = async () => {
    await refreshAll();
    if (state.selectedId) await showDetail(state.selectedId);
  };
  const actorBody = () => JSON.stringify({ actor: currentActor() });
  const buttons = [];
  if (p.status === 'submitted') {
    // v6 ステップ 2: 自己承認禁止 — 本人の申請は承認ボタンを無効化し理由を表示する
    const isSelf = p.requester === currentActor();
    buttons.push({
      label: '承認',
      cls: 'primary',
      disabled: isSelf,
      title: isSelf ? 'この申請は本人が作成したため承認できません。' : '',
      onClick: async (p) => {
        try {
          await api(`/api/purchases/${p.id}/approve`, { method: 'POST', body: actorBody() });
          toast('承認しました', true);
          await refresh();
        } catch (err) { toast(`エラー: ${err.message}`, false); }
      },
    });
    buttons.push({ label: '却下', cls: 'danger', onClick: (p) => openRejectModal(p) });
    // v6 ステップ 3: 取下げ（申請者本人のみ・サーバーでも検証）
    buttons.push({ label: '取下げ', cls: 'danger', disabled: !isSelf, title: isSelf ? '' : '取下げは申請者本人のみできます', onClick: (p) => openWithdrawModal(p) });
  }
  if (p.status === 'rejected' || p.status === 'withdrawn') {
    // v6 ステップ 3: 修正（ withdrawn / rejected のみ・変更履歴に残る）→ その後再申請
    buttons.push({ label: '修正', cls: '', onClick: (p) => openUpdateModal(p, { changeRequest: false }) });
    buttons.push({
      label: '再申請',
      cls: 'primary',
      onClick: async (p) => {
        try {
          await api(`/api/purchases/${p.id}/resubmit`, { method: 'POST', body: actorBody() });
          toast('再申請しました', true);
          await refresh();
        } catch (err) { toast(`エラー: ${err.message}`, false); }
      },
    });
  }
  if (p.status === 'approved') {
    // v6 ステップ 3: 変更申請 — 修正のうえ submitted に戻り、再承認を経る
    buttons.push({ label: '変更申請', cls: '', onClick: (p) => openUpdateModal(p, { changeRequest: true }) });
    buttons.push({
      label: '発注',
      cls: 'primary',
      onClick: async (p) => {
        try {
          const ordered = await api(`/api/purchases/${p.id}/order`, { method: 'POST', body: actorBody() });
          toast(`発注しました（${ordered.orderNo}）`, true);
          await refresh();
        } catch (err) { toast(`エラー: ${err.message}`, false); }
      },
    });
  }
  if (p.status === 'ordered') {
    // v6 ステップ 3: 発注済みは直接上書きせず変更履歴のみ残す
    buttons.push({ label: '修正（変更履歴に残す）', cls: '', onClick: (p) => openUpdateModal(p, { changeRequest: false }) });
  }
  if (p.status === 'ordered' && p.receivedTotal < p.qty) {
    buttons.push({ label: '検収', cls: 'primary', onClick: (p) => openReceiveModal(p) });
  }
  if (p.status === 'received' || p.status === 'paid') {
    // v6 ステップ 5: 検収後の訂正は 訂正申請 → 承認 → 取消仕訳 → 再計上
    buttons.push({ label: '訂正申請', cls: '', onClick: (p) => openCorrectionModal(p) });
  }
  if (p.status === 'correction_pending') {
    // 訂正申請の承認（申請者本人は承認不可 — 通常の承認と同じ理屈）
    const isSelf = p.requester === currentActor();
    buttons.push({
      label: '訂正を承認して再計上',
      cls: 'primary',
      disabled: isSelf,
      title: isSelf ? 'この申請は本人が作成したため承認できません。' : '',
      onClick: async (p) => {
        try {
          const r = await api(`/api/purchases/${p.id}/approve-correction`, { method: 'POST', body: actorBody() });
          toast(`訂正しました（取消・再計上とも履歴に記録・状態: ${STATUS_LABELS[r.status] || r.status}）`, true);
          await refresh();
        } catch (err) { toast(`エラー: ${err.message}`, false); }
      },
    });
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

// v6 ステップ 3: 取下げ・修正（変更申請）モーダル
function openWithdrawModal(p) {
  state.withdrawTargetId = p.id;
  $('#withdraw-target').textContent = `${p.id} ${p.item}（${yen(p.amount)}）`;
  $('#withdraw-modal').hidden = false;
}

function openUpdateModal(p, { changeRequest }) {
  state.updateTarget = { id: p.id, changeRequest };
  $('#update-target').textContent = changeRequest
    ? `${p.id} ${p.item}（変更申請 — 保存後、再承認を経ます）`
    : `${p.id} ${p.item}（修正 — 変更履歴に残ります）`;
  $('#update-item').value = p.item;
  $('#update-qty').value = p.qty;
  $('#update-unitPrice').value = p.unitPrice;
  $('#update-department').value = p.department;
  $('#update-note').value = p.note || '';
  $('#update-reason').value = '';
  $('#update-modal').hidden = false;
  $('#update-item').focus();
}

// v6 ステップ 5: 検収後の訂正申請（承認後に取消仕訳 → 訂正仕訳を計上）
function openCorrectionModal(p) {
  state.correctionTarget = p.id;
  $('#correction-target').textContent = `${p.id} ${p.item}（検収済 ${p.receivedTotal}/${p.qty}・${yen(p.receivedTotal * p.unitPrice)}）`;
  $('#correction-item').value = p.item;
  $('#correction-unitPrice').value = p.unitPrice;
  $('#correction-note').value = p.note || '';
  $('#correction-reason').value = '';
  $('#correction-modal').hidden = false;
  $('#correction-item').focus();
}

$('#reject-cancel').addEventListener('click', () => { $('#reject-modal').hidden = true; });
$('#receive-cancel').addEventListener('click', () => { $('#receive-modal').hidden = true; });
$('#withdraw-cancel').addEventListener('click', () => { $('#withdraw-modal').hidden = true; });
$('#update-cancel').addEventListener('click', () => { $('#update-modal').hidden = true; });
$('#correction-cancel').addEventListener('click', () => { $('#correction-modal').hidden = true; });

$('#correction-submit').addEventListener('click', async () => {
  const reason = $('#correction-reason').value.trim();
  if (!reason) { toast('訂正理由を入力してください', false); return; }
  try {
    await api(`/api/purchases/${state.correctionTarget}/request-correction`, {
      method: 'POST',
      body: JSON.stringify({
        actor: currentActor(),
        reason,
        updates: {
          item: $('#correction-item').value.trim(),
          unitPrice: Number($('#correction-unitPrice').value),
          note: $('#correction-note').value,
        },
      }),
    });
    $('#correction-modal').hidden = true;
    toast('訂正申請を受け付けました（承認後に取消仕訳・訂正仕訳を計上します）', true);
    await refreshAll();
    if (state.selectedId) await showDetail(state.selectedId);
  } catch (err) { toast(`エラー: ${err.message}`, false); }
});

$('#withdraw-submit').addEventListener('click', async () => {
  try {
    await api(`/api/purchases/${state.withdrawTargetId}/withdraw`, {
      method: 'POST',
      body: JSON.stringify({ actor: currentActor() }),
    });
    $('#withdraw-modal').hidden = true;
    toast('取下げました（修正して再申請できます）', true);
    await refreshAll();
    if (state.selectedId) await showDetail(state.selectedId);
  } catch (err) { toast(`エラー: ${err.message}`, false); }
});

$('#update-submit').addEventListener('click', async () => {
  const { id, changeRequest } = state.updateTarget || {};
  const reason = $('#update-reason').value.trim();
  if (!reason) { toast('変更理由を入力してください', false); return; }
  try {
    await api(`/api/purchases/${id}/update`, {
      method: 'POST',
      body: JSON.stringify({
        actor: currentActor(),
        reason,
        updates: {
          item: $('#update-item').value.trim(),
          qty: Number($('#update-qty').value),
          unitPrice: Number($('#update-unitPrice').value),
          department: $('#update-department').value,
          note: $('#update-note').value,
        },
      }),
    });
    $('#update-modal').hidden = true;
    toast(changeRequest ? '変更申請を受け付けました（再承認を経ます）' : '修正しました（変更履歴に記録）', true);
    await refreshAll();
    if (state.selectedId) await showDetail(state.selectedId);
  } catch (err) { toast(`エラー: ${err.message}`, false); }
});

$('#reject-submit').addEventListener('click', async () => {
  const comment = $('#reject-comment').value.trim();
  if (!comment) { toast('却下理由を入力してください', false); return; }
  try {
    await api(`/api/purchases/${state.rejectTargetId}/reject`, {
      method: 'POST',
      body: JSON.stringify({ actor: currentActor(), comment }),
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
      body: JSON.stringify({ receivedQty: qty, receivedAt: date, comment: $('#receive-note').value, actor: currentActor() }),
    });
    $('#receive-modal').hidden = true;
    toast(`検収しました（支払予定 ${payable.id} 計上・仕訳 entry #${payable.entryId || '—'}・予定日 ${payable.scheduledDate}）`, true);
    await refreshAll();
  } catch (err) { toast(`エラー: ${err.message}`, false); }
});

for (const id of ['reject-modal', 'receive-modal', 'withdraw-modal', 'update-modal', 'correction-modal']) {
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
    const itemMaster = (state.masters.items || []).find((i) => i.code === form.item.value);
    const created = await api('/api/purchases', {
      method: 'POST',
      body: JSON.stringify({
        requester: currentActor(), // v6 ステップ 1: 申請者は常に現在の操作者
        item: itemMaster ? itemMaster.name : form.item.value, // マスタ名を使用（表記揺れ防止）
        vendorCode: form.vendor.value,
        itemCode: form.item.value,
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

$('#item').addEventListener('change', onItemChange);

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
      body: JSON.stringify({ actor: currentActor() }),
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

/* ---------- 申請一覧の複合検索（v6 ステップ 6） ---------- */

function initPurchaseFilters() {
  // 申請者（ユーザーマスタ）と状態の選択肢を一度だけ作る
  const req = $('#pf-requester');
  if (req.options.length <= 1) {
    for (const u of state.users) {
      const opt = document.createElement('option');
      opt.value = u.code;
      opt.textContent = `${u.code} / ${ROLE_LABELS[u.role] || u.role}`;
      req.appendChild(opt);
    }
  }
  const ven = $('#pf-vendor');
  if (ven.options.length <= 1) {
    for (const v of state.masters.vendors || []) {
      const opt = document.createElement('option');
      opt.value = v.code;
      opt.textContent = `${v.code} ${v.name}`;
      ven.appendChild(opt);
    }
  }
  const st = $('#pf-status');
  if (st.options.length <= 1) {
    for (const [key, label] of Object.entries(STATUS_LABELS)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = `状態: ${label}`;
      st.appendChild(opt);
    }
  }
}

$('#pf-refresh').addEventListener('click', renderList);
$('#pf-reset').addEventListener('click', () => {
  for (const id of PURCHASE_FILTER_IDS) $(id).value = '';
  state.filter = '';
  renderList();
});
for (const id of PURCHASE_FILTER_IDS) {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') renderList(); });
}

/* ---------- 仕訳一覧のイベント（v6 ステップ 4） ---------- */

$('#jf-refresh').addEventListener('click', renderJournal);
$('#jf-reset').addEventListener('click', () => {
  for (const id of JOURNAL_FILTER_IDS) $(id).value = '';
  renderJournal();
});
for (const id of JOURNAL_FILTER_IDS) {
  $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') renderJournal(); });
}

$('#journal-table').addEventListener('click', async (e) => {
  const detail = e.target.closest('.detail-btn');
  if (detail) { await showJournalDetail(detail.dataset.id); return; }
  // 申請番号 → 購買詳細への順リンク
  const purchaseBtn = e.target.closest('.link-btn[data-purchase]');
  if (purchaseBtn) {
    showView('list');
    await showDetail(purchaseBtn.dataset.purchase);
  }
});

$('#jd-close').addEventListener('click', () => { $('#journal-detail-panel').hidden = true; });

// 元申請 → 仕訳一覧（詳細付き）への逆リンク
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.link-btn[data-journal]');
  if (!btn) return;
  showView('journal');
  await showJournalDetail(btn.dataset.journal);
});

refreshAll();
initOperator();
initPurchaseFormMasters();
initAccountingView();

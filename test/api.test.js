'use strict';
// TS-INT-PURCHASEKAIKEI-001..006 + TS-E2E-PURCHASEKAIKEI-001（v2: 内蔵会計エンジン・外部依存なし）
// v5: store が非同期（PostgreSQL）になったため startServer も async 化。
//     store.test.js と並列実行されるため、DB はこのファイル専用の purchase_test_api を使う。
process.env.PG_DATABASE = process.env.PG_DATABASE || 'purchase_test_api';
process.env.PG_PASSWORD = process.env.PG_PASSWORD || 'pk-training-2026';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, PurchaseStore } = require('../server');
const { KaikeiUnavailableError } = require('../store/kaikei-client');

// pg 接続を開きっぱなしにすると node --test のプロセスが終わらないため最後に全 close
test.after(async () => { await PurchaseStore.closeAll(); });

// モック kaikei クライアント（テストが実ネットワークに流れないように注入する）
function stubKaikei({ fail = false } = {}) {
  const posted = [];
  const state = { fail };
  let nextId = 500;
  return {
    posted,
    state,
    baseUrl: 'http://localhost:8000',
    postEntry: async (body) => {
      if (state.fail) throw new KaikeiUnavailableError(new Error('down'));
      posted.push(body);
      return { id: nextId++, ...body };
    },
  };
}

async function startServer({ kaikeiFail = true, kanri, fresh = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-api-'));
  const kaikei = stubKaikei({ fail: kaikeiFail });
  const app = createApp(await PurchaseStore.create(dir, kaikei, { fresh }), kanri);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, kaikei };
}

// kanri-dwh（管理会計 DWH）のスタブ: fail で障害を再現
function stubKanri() {
  const state = { fail: false };
  return {
    state,
    kpi: async (name, query) => {
      if (state.fail) { const e = new Error('down'); e.code = 'kanri_unavailable'; throw e; }
      if (name === 'reconcile') return { dwh: { debit: 100, credit: 100 }, source: { debit: 100, credit: 100 }, matched: true };
      return { rows: [{ month: '2026-09', revenue: 5000, expense: 2000, total: 3000, name: 'X', department: 'D10', account_code: '5110', cash: 1000, deposit: 2000 }] };
    },
    runEtl: async () => {
      if (state.fail) { const e = new Error('down'); e.code = 'kanri_unavailable'; throw e; }
      return { entry_count: 3, line_count: 6, date_from: '2026-09-01', date_to: '2026-09-30' };
    },
  };
}

function post(base, url, body) {
  return fetch(`${base}${url}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createPurchase(base, overrides = {}) {
  const res = await post(base, '/api/purchases', {
    item: 'モニタ', qty: 2, unitPrice: 30000, requester: 'u01', ...overrides,
  });
  assert.equal(res.status, 201);
  return res.json();
}

test('TS-INT-001: 申請登録（部門含む）→一覧照会、部門不正は 400', async () => {
  const { server, base } = await startServer();
  try {
    const p = await createPurchase(base, { department: 'D20' });
    assert.equal(p.status, 'submitted');
    assert.equal(p.department, 'D20');
    const def = await createPurchase(base); // 部門未指定
    assert.equal(def.department, 'D90');
    const bad = await post(base, '/api/purchases', { item: 'x', qty: 1, unitPrice: 100, requester: 'u01', department: 'D99' });
    assert.equal(bad.status, 400);
  } finally { server.close(); }
});

test('TS-INT-002: 承認 / 却下（comment 必須）/ 再申請', async () => {
  const { server, base } = await startServer();
  try {
    const p = await createPurchase(base, { qty: 1, unitPrice: 150000 });
    const noComment = await post(base, `/api/purchases/${p.id}/reject`, { actor: '鈴木 (部長)' });
    assert.equal(noComment.status, 400);
    await post(base, `/api/purchases/${p.id}/reject`, { actor: '鈴木 (部長)', comment: '予算超過' });
    await post(base, `/api/purchases/${p.id}/resubmit`, { actor: '山田 (申請者)' });
    const detail = await (await fetch(`${base}/api/purchases/${p.id}`)).json();
    assert.equal(detail.status, 'submitted');
    assert.ok(detail.history.some((h) => h.to === 'rejected' && h.comment === '予算超過'));
    await post(base, `/api/purchases/${p.id}/approve`, { actor: '鈴木 (部長)' });
    assert.equal((await (await fetch(`${base}/api/purchases/${p.id}`)).json()).status, 'approved');
  } finally { server.close(); }
});

test('TS-INT-003: 発注（approved のみ・発注番号採番・他状態は 409）', async () => {
  const { server, base } = await startServer();
  try {
    const p = await createPurchase(base, { qty: 1, unitPrice: 50000 });
    const early = await post(base, `/api/purchases/${p.id}/order`, { actor: '佐藤 (管理担当)' });
    assert.equal(early.status, 409);
    await post(base, `/api/purchases/${p.id}/approve`, { actor: '鈴木 (部長)' });
    const res = await post(base, `/api/purchases/${p.id}/order`, { actor: '佐藤 (管理担当)' });
    const ordered = await res.json();
    assert.equal(ordered.status, 'ordered');
    assert.match(ordered.orderNo, /^PO-\d{4}-\d{3}$/);
  } finally { server.close(); }
});

test('TS-INT-004: 分割検収 → 支払予定計上 + 仕訳自動計上', async () => {
  const { server, base } = await startServer();
  try {
    const p = await createPurchase(base, { item: '業務用プリンタ', qty: 10, unitPrice: 5000, department: 'D10' });
    await post(base, `/api/purchases/${p.id}/approve`, { actor: '鈴木 (部長)' });
    await post(base, `/api/purchases/${p.id}/order`, { actor: '佐藤 (管理担当)' });

    const over = await post(base, `/api/purchases/${p.id}/receive`, { actor: '佐藤 (管理担当)', receivedQty: 11, receivedAt: '2026-09-10' });
    assert.equal(over.status, 400);

    const r1 = await post(base, `/api/purchases/${p.id}/receive`, { actor: '佐藤 (管理担当)', receivedQty: 4, receivedAt: '2026-09-10' });
    const after1 = await r1.json();
    assert.equal(after1.purchase.status, 'ordered');
    assert.equal(after1.payable.amount, 20000);
    assert.equal(after1.payable.scheduledDate, '2026-10-31');
    assert.ok(after1.purchase.journal[0].entryId); // 仕訳が計上され entry id を記録

    const r2 = await post(base, `/api/purchases/${p.id}/receive`, { actor: '佐藤 (管理担当)', receivedQty: 6, receivedAt: '2026-09-20' });
    assert.equal((await r2.json()).purchase.status, 'received');

    const payables = await (await fetch(`${base}/api/payables?status=scheduled`)).json();
    assert.equal(payables.length, 2);
  } finally { server.close(); }
});

test('TS-INT-005: 支払実行 → 仕訳自動計上・entryId 記録・二重支払 409', async () => {
  const { server, base } = await startServer();
  try {
    const p = await createPurchase(base, { qty: 1, unitPrice: 80000, department: 'D90' });
    await post(base, `/api/purchases/${p.id}/approve`, { actor: '鈴木 (部長)' });
    await post(base, `/api/purchases/${p.id}/order`, { actor: '佐藤 (管理担当)' });
    await post(base, `/api/purchases/${p.id}/receive`, { actor: '佐藤 (管理担当)', receivedQty: 1, receivedAt: '2026-09-10' });

    const payables = await (await fetch(`${base}/api/payables?status=scheduled`)).json();
    const pay = await post(base, `/api/payables/${payables[0].id}/pay`, { actor: '佐藤 (管理担当)' });
    const paid = await pay.json();
    assert.equal(paid.status, 'paid');
    assert.equal(paid.entryId, 2); // 検収 #1 → 支払 #2

    const repay = await post(base, `/api/payables/${payables[0].id}/pay`, { actor: '佐藤 (管理担当)' });
    assert.equal(repay.status, 409); // 2 重支払
  } finally { server.close(); }
});

test('TS-INT-006: 会計 API が購買操作を反映する', async () => {
  const { server, base } = await startServer();
  try {
    const p = await createPurchase(base, { item: '開発用サーバー', qty: 5, unitPrice: 40000, department: 'D20' });
    await post(base, `/api/purchases/${p.id}/approve`, { actor: '鈴木 (部長)' });
    await post(base, `/api/purchases/${p.id}/order`, { actor: '佐藤 (管理担当)' });
    await post(base, `/api/purchases/${p.id}/receive`, { actor: '佐藤 (管理担当)', receivedQty: 5, receivedAt: '2026-09-10' });

    // 科目一覧（内蔵マスタ 11 科目）
    const { accounts } = await (await fetch(`${base}/api/accounting/accounts`)).json();
    assert.equal(accounts.length, 11);

    // 試算表: 仕入高 200,000 / 買掛金 200,000・貸借一致
    const tb = await (await fetch(`${base}/api/accounting/trial-balance`)).json();
    assert.equal(tb.rows.length, 11);
    assert.equal(tb.balanced, true);
    assert.equal(tb.rows.find((r) => r.account_code === '5110').debit_balance, 200000);
    assert.equal(tb.rows.find((r) => r.account_code === '2110').credit_balance, 200000);

    // 部門フィルタ: D10（この購買は D20）では仕入高 0
    const tbD10 = await (await fetch(`${base}/api/accounting/trial-balance?department=D10`)).json();
    assert.equal(tbD10.rows.find((r) => r.account_code === '5110').debit_balance, 0);

    // 元帳: 購買検収の行がある
    const led = await (await fetch(`${base}/api/accounting/ledger/5110`)).json();
    assert.equal(led.rows.length, 1);
    assert.equal(led.rows[0].description, `購買検収 ${p.id}（開発用サーバー）`);
    assert.equal(led.rows[0].balance, 200000);

    // 未知科目は 404
    const missing = await fetch(`${base}/api/accounting/ledger/9999`);
    assert.equal(missing.status, 404);
  } finally { server.close(); }
});

test('TS-E2E-001: 購買会計フロー完走（申請→支払→試算表/元帳照会）', async () => {
  const { server, base } = await startServer();
  try {
    const p = await createPurchase(base, { item: '開発用サーバー', qty: 5, unitPrice: 40000, department: 'D20' });
    await post(base, `/api/purchases/${p.id}/approve`, { actor: '鈴木 (部長)', comment: '承認' });
    await post(base, `/api/purchases/${p.id}/order`, { actor: '佐藤 (管理担当)' });
    await post(base, `/api/purchases/${p.id}/receive`, { actor: '佐藤 (管理担当)', receivedQty: 2, receivedAt: '2026-09-10' });
    await post(base, `/api/purchases/${p.id}/receive`, { actor: '佐藤 (管理担当)', receivedQty: 3, receivedAt: '2026-09-25' });

    const detail = await (await fetch(`${base}/api/purchases/${p.id}`)).json();
    assert.equal(detail.status, 'received');
    assert.equal(detail.journal.length, 2); // 検収 × 2

    const payables = await (await fetch(`${base}/api/payables`)).json();
    assert.equal(payables.length, 2);
    for (const x of payables) {
      await post(base, `/api/payables/${x.id}/pay`, { actor: '佐藤 (管理担当)' });
    }
    const paid = await (await fetch(`${base}/api/payables?status=paid`)).json();
    assert.equal(paid.length, 2);
    assert.ok(paid.every((x) => x.entryId)); // 全支払予定に支払仕訳の entry id

    // 会計レポートで全 4 件（検収 2 + 支払 2）を確認
    const tb = await (await fetch(`${base}/api/accounting/trial-balance`)).json();
    assert.equal(tb.balanced, true);
    assert.equal(tb.rows.find((r) => r.account_code === '5110').debit_balance, 200000); // 検収 2+3 = 5 × 40000
    assert.equal(tb.rows.find((r) => r.account_code === '2110').credit_balance, 0); // 支払で全額消込
    const led = await (await fetch(`${base}/api/accounting/ledger/2110`)).json();
    assert.equal(led.rows.length, 4); // 買掛金: 検収 2 + 支払 2
  } finally { server.close(); }
});

test('TS-INT-007: ミラー連携 API（Outbox）— 障害でキュー保持・再送で送信', async () => {
  const { server, base, kaikei } = await startServer(); // kaikeiFail 既定 true（障害状態）
  try {
    const p = await createPurchase(base, { item: '連携テスト', qty: 3, unitPrice: 1000, department: 'D20' });
    await post(base, `/api/purchases/${p.id}/approve`, { actor: '鈴木 (部長)' });
    await post(base, `/api/purchases/${p.id}/order`, { actor: '佐藤 (管理担当)' });
    await post(base, `/api/purchases/${p.id}/receive`, { actor: '佐藤 (管理担当)', receivedQty: 3, receivedAt: '2026-09-10' });

    // 障害中でも検収は成功し、仕訳は未同期キューに保持される（v1 との決定的な違い）
    const status = await (await fetch(`${base}/api/accounting/sync`)).json();
    assert.equal(status.pending, 1);
    assert.equal(status.url, 'http://localhost:8000');

    // 復帰 → 再送
    kaikei.state.fail = false;
    const r = await post(base, '/api/accounting/sync', {});
    const body = await r.json();
    assert.equal(body.sent, 1);
    assert.equal(body.remaining, 0);
    assert.equal(kaikei.posted[0].department, 'D20');

    // 同期済み
    const after = await (await fetch(`${base}/api/accounting/sync`)).json();
    assert.equal(after.pending, 0);
  } finally { server.close(); }
});

test('NFR-002: サーバー再起後も purchases + payables + 仕訳台帳が保持される', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-persist-'));
  const app1 = createApp(await PurchaseStore.create(dir, stubKaikei({ fail: true }), { fresh: true }));
  const s1 = app1.listen(0);
  const base1 = `http://127.0.0.1:${s1.address().port}`;
  const p = await createPurchase(base1, { item: '永続化チェック', qty: 1, unitPrice: 50000 });
  await post(base1, `/api/purchases/${p.id}/approve`, { actor: '鈴木 (部長)' });
  await post(base1, `/api/purchases/${p.id}/order`, { actor: '佐藤 (管理担当)' });
  await post(base1, `/api/purchases/${p.id}/receive`, { actor: '佐藤 (管理担当)', receivedQty: 1, receivedAt: '2026-09-10' });
  await new Promise((r) => s1.close(r));

  const app2 = createApp(await PurchaseStore.create(dir, stubKaikei()));
  const s2 = app2.listen(0);
  const base2 = `http://127.0.0.1:${s2.address().port}`;
  try {
    const detail = await (await fetch(`${base2}/api/purchases/${p.id}`)).json();
    assert.equal(detail.item, '永続化チェック');
    assert.equal(detail.status, 'received');
    assert.equal(detail.journal.length, 1); // 仕訳参照も保持
    const payables = await (await fetch(`${base2}/api/payables`)).json();
    assert.equal(payables.length, 1);
    const tb = await (await fetch(`${base2}/api/accounting/trial-balance`)).json();
    assert.equal(tb.rows.find((r) => r.account_code === '5110').debit_balance, 50000); // 仕訳台帳も復元
  } finally { s2.close(); }
});

/* ---------- 経営ダッシュボード（kanri-dwh 連携・プロキシ） ---------- */

test('TS-INT-008: 管理会計 KPI プロキシ — kanri-dwh の応答をそのまま返す', async () => {
  const { server, base } = await startServer({ kanri: stubKanri() });
  try {
    const rec = await (await fetch(`${base}/api/management/kpi/reconcile`)).json();
    assert.equal(rec.matched, true); // 突合状態

    const pl = await (await fetch(`${base}/api/management/kpi/pl-by-department?from=2026-09&department=D10`)).json();
    assert.equal(pl.rows.length, 1);

    const noKpi = await fetch(`${base}/api/management/kpi/unknown`);
    assert.equal(noKpi.status, 404); // 未知の KPI は 404
  } finally { server.close(); }
});

test('TS-INT-009: ETL 起動プロキシ — 成功時は報告を返し、kanri-dwh 障害時は 502', async () => {
  const kanri = stubKanri();
  const { server, base } = await startServer({ kanri });
  try {
    const r = await post(base, '/api/management/etl', {});
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.entry_count, 3);

    kanri.state.fail = true; // 障害 → 502（購買操作には無関係）
    const down = await post(base, '/api/management/etl', {});
    assert.equal(down.status, 502);
  } finally { server.close(); }
});

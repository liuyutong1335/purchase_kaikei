'use strict';
// TS-UNIT-PURCHASEKAIKEI-001/002: store の遷移ガード + 部門検証 + 内蔵会計エンジンの unit テスト（v2）
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PurchaseStore, TransitionError, ValidationError, nextMonthEnd } = require('../store/purchase-store');
const { JournalEngine, ACCOUNTS_MASTER } = require('../store/journal');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-store-'));
  return new PurchaseStore(dir);
}

function orderedPurchase(store, { qty = 10, unitPrice = 1000, department } = {}) {
  const p = store.create({ item: 'ノートPC', qty, unitPrice, requester: '山田', department });
  store.approve(p.id, '鈴木 (部長)', 'OK');
  store.order(p.id, '佐藤 (管理担当)');
  return store.get(p.id);
}

test('nextMonthEnd: 月末締め翌月末払いの日付計算', () => {
  assert.equal(nextMonthEnd('2026-09-15'), '2026-10-31');
  assert.equal(nextMonthEnd('2026-01-31'), '2026-02-28'); // 平年
  assert.equal(nextMonthEnd('2024-01-31'), '2024-02-29'); // うるう年
  assert.equal(nextMonthEnd('2026-12-05'), '2027-01-31'); // 年跨ぎ
});

test('create: 正常登録で状態=submitted、既定部門は D90', () => {
  const store = freshStore();
  const p = store.create({ item: 'ノートPC', qty: 2, unitPrice: 150000, requester: '山田' });
  assert.equal(p.status, 'submitted');
  assert.equal(p.department, 'D90'); // AC-001-02
  assert.deepEqual(p.journal, []);
  assert.equal(p.history.length, 1);
});

test('create: 部門は D10/D20/D90 のみ', () => {
  const store = freshStore();
  assert.throws(() => store.create({ item: 'x', qty: 1, unitPrice: 100, requester: 'x', department: 'D99' }), ValidationError);
  const p = store.create({ item: 'x', qty: 1, unitPrice: 100, requester: 'x', department: 'D20' });
  assert.equal(p.department, 'D20');
});

test('create: 必須項目不足は ValidationError', () => {
  const store = freshStore();
  assert.throws(() => store.create({ qty: 1, unitPrice: 100, requester: 'x' }), ValidationError);
  assert.throws(() => store.create({ item: 'x', qty: 0, unitPrice: 100, requester: 'x' }), ValidationError);
  assert.throws(() => store.create({ item: 'x', qty: 1, unitPrice: -1, requester: 'x' }), ValidationError);
  assert.throws(() => store.create({ item: 'x', qty: 1, unitPrice: 100 }), ValidationError);
});

test('AC-002-01: 承認は submitted → approved の 1 段（金額に関係なく）', () => {
  const store = freshStore();
  const p1 = store.create({ item: 'A', qty: 2, unitPrice: 50000, requester: '山田' }); // 10万
  const p2 = store.create({ item: 'B', qty: 1, unitPrice: 990000, requester: '山田' }); // 99万でも 1 段
  store.approve(p1.id, '鈴木 (部長)', '');
  store.approve(p2.id, '鈴木 (部長)', '');
  assert.equal(store.get(p1.id).status, 'approved');
  assert.equal(store.get(p2.id).status, 'approved');
  assert.throws(() => store.approve(p1.id, '鈴木 (部長)', ''), TransitionError);
});

test('AC-002-02/03: 却下は comment 必須、再申請で submitted に戻る', () => {
  const store = freshStore();
  const p = store.create({ item: 'A', qty: 1, unitPrice: 150000, requester: '山田' });
  assert.throws(() => store.reject(p.id, '鈴木 (部長)', ''), ValidationError);
  store.reject(p.id, '鈴木 (部長)', '予算超過');
  assert.equal(store.get(p.id).status, 'rejected');
  store.resubmit(p.id, '山田 (申請者)', '単価を見直し再申請');
  assert.equal(store.get(p.id).status, 'submitted');
  assert.ok(store.get(p.id).history.some((h) => h.to === 'rejected' && h.comment === '予算超過'));
});

test('AC-003-01: order は approved のみ、発注番号は連番', () => {
  const store = freshStore();
  const p1 = store.create({ item: 'A', qty: 1, unitPrice: 50000, requester: '山田' });
  assert.throws(() => store.order(p1.id, '佐藤 (管理担当)'), TransitionError); // submitted からの発注
  store.approve(p1.id, '鈴木 (部長)', '');
  store.order(p1.id, '佐藤 (管理担当)');
  const year = new Date().getFullYear();
  assert.equal(store.get(p1.id).orderNo, `PO-${year}-001`);
});

test('AC-004-01/03: 検収ごとに仕訳（借 5110 / 貸 2110）が計上され支払予定が計上される', () => {
  const store = freshStore();
  const p = orderedPurchase(store, { qty: 10, unitPrice: 1000, department: 'D20' });

  const { purchase, payable } = store.receive(p.id, '佐藤 (管理担当)', 4, '2026-09-10');
  assert.equal(store.get(p.id).receivedTotal, 4);

  // 仕訳対応表: 借方 仕入高 5110 / 貸方 買掛金 2110、金額 = 検収数量 × 単価、部門引き継ぎ
  assert.equal(store.journal.entries.length, 1);
  const entry = store.journal.entries[0];
  assert.equal(entry.date, '2026-09-10');
  assert.equal(entry.department, 'D20');
  assert.deepEqual(entry.lines, [
    { account_code: '5110', side: 'debit', amount: 4000 },
    { account_code: '2110', side: 'credit', amount: 4000 },
  ]);

  // 仕訳参照が購買記録に保持される（NFR-003）
  assert.equal(purchase.journal.length, 1);
  assert.equal(purchase.journal[0].entryId, entry.id);
  assert.ok(purchase.history.find((h) => h.entryId).comment.includes(`entry #${entry.id}`));

  // 支払予定: 支払仕訳の entryId はまだ null
  assert.equal(payable.amount, 4000);
  assert.equal(payable.scheduledDate, '2026-10-31');
  assert.equal(payable.entryId, null);

  // 残 6 を超える 7 個目は拒否
  assert.throws(() => store.receive(p.id, '佐藤 (管理担当)', 7), ValidationError);

  store.receive(p.id, '佐藤 (管理担当)', 6, '2026-09-20');
  assert.equal(store.get(p.id).status, 'received'); // AC-004-02 全量検収済
  assert.equal(store.listPayables().length, 2);
  assert.equal(store.journal.entries.length, 2);
});

test('AC-005-02/03: 支払実行で仕訳（借 2110 / 貸 1120）計上・entryId 記録・二重支払不可', () => {
  const store = freshStore();
  const p = orderedPurchase(store, { qty: 1, unitPrice: 1000, department: 'D90' });
  const { payable } = store.receive(p.id, '佐藤 (管理担当)', 1, '2026-09-10');

  const paid = store.pay(payable.id, '佐藤 (管理担当)');
  assert.equal(paid.status, 'paid');
  assert.equal(paid.entryId, 2);
  const payEntry = store.journal.entries[1];
  assert.deepEqual(payEntry.lines, [
    { account_code: '2110', side: 'debit', amount: 1000 },
    { account_code: '1120', side: 'credit', amount: 1000 },
  ]);
  assert.equal(payEntry.department, 'D90');
  assert.throws(() => store.pay(payable.id, '佐藤 (管理担当)'), TransitionError); // 2 重支払
  assert.throws(() => store.pay('PAY-9999', '佐藤 (管理担当)'), Error);
});

/* ---------- 内蔵会計エンジン（TS-UNIT-002） ---------- */

function engineWith(entries) {
  const e = new JournalEngine(entries);
  e.counters = { entry: 0 };
  return e;
}

test('engine: 貸借不一致・未知科目・不正金額は拒否', () => {
  const e = engineWith([]);
  assert.throws(() => e.post({ date: '2026-09-10', department: 'D90', lines: [
    { account_code: '5110', side: 'debit', amount: 100 },
    { account_code: '2110', side: 'credit', amount: 90 },
  ] }), /unbalanced/);
  assert.throws(() => e.post({ date: '2026-09-10', department: 'D90', lines: [
    { account_code: '9999', side: 'debit', amount: 100 },
    { account_code: '2110', side: 'credit', amount: 100 },
  ] }), /unknown account/);
  assert.throws(() => e.post({ date: '2026-09-10', department: 'D90', lines: [
    { account_code: '5110', side: 'debit', amount: 0 },
    { account_code: '2110', side: 'credit', amount: 0 },
  ] }), /positive integer/);
});

test('engine: 試算表は 11 科目すべて（残高 0 含む）・貸借一致', () => {
  const e = engineWith([]);
  e.post({ date: '2026-09-10', department: 'D20', description: 't', lines: [
    { account_code: '5110', side: 'debit', amount: 4000 },
    { account_code: '2110', side: 'credit', amount: 4000 },
  ] });
  const tb = e.trialBalance();
  assert.equal(tb.rows.length, ACCOUNTS_MASTER.length); // 残高 0 科目も行表示
  assert.equal(tb.balanced, true); // 借方合計 = 貸方合計
  const shire = tb.rows.find((r) => r.account_code === '5110');
  assert.equal(shire.debit_balance, 4000); // 費用は借方残高
  const kaikake = tb.rows.find((r) => r.account_code === '2110');
  assert.equal(kaikake.credit_balance, 4000); // 負債は貸方残高
});

test('engine: 元帳は日付昇順・残高繰越。貸方科目は逆符号', () => {
  const e = engineWith([]);
  e.post({ date: '2026-09-10', department: 'D20', description: '検収1', lines: [
    { account_code: '2110', side: 'credit', amount: 4000 },
    { account_code: '5110', side: 'debit', amount: 4000 },
  ] });
  e.post({ date: '2026-09-20', department: 'D20', description: '支払1', lines: [
    { account_code: '2110', side: 'debit', amount: 4000 },
    { account_code: '1120', side: 'credit', amount: 4000 },
  ] });
  const led = e.ledger('2110');
  assert.equal(led.rows.length, 2);
  assert.equal(led.rows[0].balance, 4000); // 貸方残高 4000
  assert.equal(led.rows[1].balance, 0); // 支払で消込
  // 期間フィルタ
  assert.equal(e.ledger('2110', { from: '2026-09-15' }).rows.length, 1);
  assert.throws(() => e.ledger('9999'), Error);
});

test('engine: 部門フィルタ（department 指定はその部門の仕訳のみ集計）', () => {
  const e = engineWith([]);
  e.post({ date: '2026-09-10', department: 'D10', description: 'a', lines: [
    { account_code: '5110', side: 'debit', amount: 1000 },
    { account_code: '2110', side: 'credit', amount: 1000 },
  ] });
  e.post({ date: '2026-09-11', department: 'D20', description: 'b', lines: [
    { account_code: '5110', side: 'debit', amount: 2000 },
    { account_code: '2110', side: 'credit', amount: 2000 },
  ] });
  const d10 = e.trialBalance({ department: 'D10' });
  assert.equal(d10.rows.find((r) => r.account_code === '5110').debit_balance, 1000);
  assert.equal(d10.balanced, true); // 部門別でも貸借一致
});

test('persistence: 再生成後も purchases + payables + entries（仕訳台帳）が保持される (NFR-002)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-store-'));
  const store = new PurchaseStore(dir);
  const p = store.create({ item: 'モニタ', qty: 2, unitPrice: 30000, requester: '山田', department: 'D10' });
  store.approve(p.id, '鈴木 (部長)', 'OK');
  store.order(p.id, '佐藤 (管理担当)');
  const { payable } = store.receive(p.id, '佐藤 (管理担当)', 2, '2026-09-10');
  store.pay(payable.id, '佐藤 (管理担当)');

  const reloaded = new PurchaseStore(dir);
  assert.equal(reloaded.get(p.id).status, 'received');
  assert.equal(reloaded.get(p.id).department, 'D10');
  assert.equal(reloaded.get(p.id).journal.length, 2); // 検収 + 支払の仕訳参照
  assert.equal(reloaded.journal.entries.length, 2); // 仕訳台帳も保持
  const [paidPayable] = reloaded.listPayables('paid');
  assert.equal(paidPayable.entryId, 2);
});

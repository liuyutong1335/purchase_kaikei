'use strict';
// TS-UNIT-PURCHASEKAIKEI-001/002: store の遷移ガード + 部門検証 + 内蔵会計エンジンの unit テスト（v2）
// v5: store が非同期（PostgreSQL）になったため全テストを async 化。
//     他のテストファイルと並列実行されるため、DB はこのファイル専用の purchase_test_store を使う。
process.env.PG_DATABASE = process.env.PG_DATABASE || 'purchase_test_store';
process.env.PG_PASSWORD = process.env.PG_PASSWORD || 'pk-training-2026';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PurchaseStore, TransitionError, ValidationError, SelfApprovalError, nextMonthEnd } = require('../store/purchase-store');
const { JournalEngine, ACCOUNTS_MASTER } = require('../store/journal');
const { KaikeiUnavailableError } = require('../store/kaikei-client');

// pg 接続を開きっぱなしにすると node --test のプロセスが終わらないため最後に全 close
test.after(async () => { await PurchaseStore.closeAll(); });

// モック kaikei クライアント（v3 ミラー連携のテスト用）: fail で障害を再現
function stubKaikei() {
  const state = { fail: false };
  const posted = [];
  let nextId = 500;
  return {
    state,
    posted,
    baseUrl: 'http://localhost:8000',
    postEntry: async (body) => {
      if (state.fail) throw new KaikeiUnavailableError(new Error('down'));
      posted.push(body);
      return { id: nextId++, ...body };
    },
  };
}

async function freshStore(kaikei) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-store-'));
  return PurchaseStore.create(dir, kaikei || stubKaikei(), { fresh: true });
}

async function orderedPurchase(store, { qty = 10, unitPrice = 1000, department } = {}) {
  const p = await store.create({ item: 'ノートPC', qty, unitPrice, requester: 'u01', department });
  await store.approve(p.id, 'u02', 'OK');
  await store.order(p.id, '佐藤 (管理担当)');
  return store.get(p.id);
}

test('nextMonthEnd: 月末締め翌月末払いの日付計算', () => {
  assert.equal(nextMonthEnd('2026-09-15'), '2026-10-31');
  assert.equal(nextMonthEnd('2026-01-31'), '2026-02-28'); // 平年
  assert.equal(nextMonthEnd('2024-01-31'), '2024-02-29'); // うるう年
  assert.equal(nextMonthEnd('2026-12-05'), '2027-01-31'); // 年跨ぎ
});

test('create: 正常登録で状態=submitted、既定部門は D90', async () => {
  const store = await freshStore();
  const p = await store.create({ item: 'ノートPC', qty: 2, unitPrice: 150000, requester: 'u01' });
  assert.equal(p.status, 'submitted');
  assert.equal(p.department, 'D90'); // AC-001-02
  assert.deepEqual(p.journal, []);
  assert.equal(p.history.length, 1);
});

test('create: 部門は D10/D20/D90 のみ', async () => {
  const store = await freshStore();
  assert.throws(() => store.create({ item: 'x', qty: 1, unitPrice: 100, requester: 'u01', department: 'D99' }), ValidationError);
  const p = await store.create({ item: 'x', qty: 1, unitPrice: 100, requester: 'u01', department: 'D20' });
  assert.equal(p.department, 'D20');
});

test('create: 必須項目不足は ValidationError', async () => {
  const store = await freshStore();
  assert.throws(() => store.create({ qty: 1, unitPrice: 100, requester: 'u01' }), ValidationError);
  assert.throws(() => store.create({ item: 'x', qty: 0, unitPrice: 100, requester: 'u01' }), ValidationError);
  assert.throws(() => store.create({ item: 'x', qty: 1, unitPrice: -1, requester: 'u01' }), ValidationError);
  assert.throws(() => store.create({ item: 'x', qty: 1, unitPrice: 100 }), ValidationError);
});

// v6 ステップ 1: ユーザーマスタ（操作者・ロール）
test('users: マスタが 4 人シードされ、listUsers で取れる', async () => {
  const store = await freshStore();
  const users = store.listUsers();
  assert.equal(users.length, 4);
  assert.deepEqual(users.map((u) => u.code).sort(), ['u01', 'u02', 'u03', 'u99']);
  assert.equal(users.find((u) => u.code === 'u02').role, 'approver');
});

// v6 ステップ 1: 申請者はユーザーマスタのコードのみ
test('create: 申請者はユーザーマスタに存在するコードのみ（表記揺れ防止）', async () => {
  const store = await freshStore();
  assert.throws(() => store.create({ item: 'x', qty: 1, unitPrice: 100, requester: '山田' }), ValidationError);
  const p = await store.create({ item: 'x', qty: 1, unitPrice: 100, requester: 'u01' });
  assert.equal(p.requester, 'u01');
});

// v6 ステップ 2: 自己承認禁止
test('approve: 申請者本人は自分の申請を承認できない（SelfApprovalError）', async () => {
  const store = await freshStore();
  const p = await store.create({ item: 'A', qty: 1, unitPrice: 1000, requester: 'u01' });
  assert.throws(() => store.approve(p.id, 'u01', ''), SelfApprovalError);
  assert.equal(store.get(p.id).status, 'submitted'); // 状態は動かない
  await store.approve(p.id, 'u02', ''); // 他人なら承認できる
  assert.equal(store.get(p.id).status, 'approved');
});

// v6 ステップ 8: マスタ管理（仕入先・品目）
test('masters: 仕入先・品目がシードされ、追加できる（コード自動採番・重複不可）', async () => {
  const store = await freshStore();
  assert.equal(store.listVendors().length, 3);
  assert.equal(store.listItems().length, 5);

  // 追加（コード自動採番）
  const v = await store.addVendor({ name: '株式会社ガンマ' });
  assert.equal(v.code, 'V004');
  const i = await store.addItem({ name: 'シュレッダー', unitPrice: 15000 });
  assert.equal(i.code, 'I006');

  // 重複コードは不可・名前必須
  await assert.rejects(() => store.addVendor({ code: 'V004', name: 'x' }), ValidationError);
  await assert.rejects(() => store.addVendor({ name: '' }), ValidationError);
  await assert.rejects(() => store.addItem({ name: 'x', unitPrice: -1 }), ValidationError);

  // 再起動（hydrate）してもマスタは消えない
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-store-'));
  const s2 = await PurchaseStore.create(dir, stubKaikei());
  assert.equal(s2.listVendors().length, 4);
  assert.equal(s2.listItems().length, 6);
});

test('create: 仕入先・品目はマスタのコードで受け、存在しないコードは拒否', async () => {
  const store = await freshStore();
  assert.throws(() => store.create({ item: 'x', qty: 1, unitPrice: 100, requester: 'u01', vendorCode: 'V999' }), ValidationError);
  const p = await store.create({ item: 'ノートPC', qty: 1, unitPrice: 120000, requester: 'u01', vendorCode: 'V001', itemCode: 'I003' });
  assert.equal(p.vendorCode, 'V001');
  assert.equal(p.itemCode, 'I003');
  const enriched = store.listPurchases({ vendor: 'V001' });
  assert.equal(enriched.length, 1);
  assert.equal(enriched[0].vendorName, 'オフィスワン商事');
});

// v6 ステップ 4: 仕訳一覧（元伝票・申請番号・計上者・API 連携状態）
test('listEntries: 検収・支払の仕訳がメタデータ付きで一覧でき、条件検索できる', async () => {
  const store = await freshStore();
  const p = await orderedPurchase(store, { qty: 2, unitPrice: 5000, department: 'D10' }); // 検収仕訳 1 件
  const { payable } = await store.receive(p.id, 'u03', 2, '2026-09-10');
  await store.pay(payable.id, 'u03'); // 支払仕訳 1 件

  const all = store.listEntries();
  assert.equal(all.length, 2);
  const receiveEntry = all.find((e) => e.entryType === 'receive');
  assert.equal(receiveEntry.purchaseId, p.id);
  assert.equal(receiveEntry.voucherNo, `${p.id}-R1`);
  assert.equal(receiveEntry.postedBy, 'u03');
  assert.equal(receiveEntry.debitAccount, '5110 仕入高');
  assert.equal(receiveEntry.creditAccount, '2110 買掛金');
  assert.equal(receiveEntry.amount, 10000);
  assert.equal(receiveEntry.status, 'active');
  const payEntry = all.find((e) => e.entryType === 'pay');
  assert.equal(payEntry.voucherNo, payable.id); // 元伝票 = 支払予定
  assert.equal(payEntry.creditAccount, '1120 普通預金');

  // 検索: 科目・摘要・API 連携状態
  assert.equal(store.listEntries({ account: '1120' }).length, 1); // 普通預金を含むのは支払のみ
  assert.equal(store.listEntries({ q: 'PU-0001' }).length, 2); // 申請番号で 2 件
  assert.equal(store.listEntries({ state: 'linked' }).length, 2); // スタブが正常送信 → 自動同期済み
  assert.equal(store.listEntries({ state: 'unlinked' }).length, 0);
});

test('getEntry: 元申請（変更履歴付き）を逆リンクできる', async () => {
  const store = await freshStore();
  const p = await store.create({ item: 'A', qty: 1, unitPrice: 1000, requester: 'u01' });
  await store.withdraw(p.id, 'u01');
  await store.update(p.id, 'u01', { qty: 2 }, '数量修正');
  await store.resubmit(p.id, 'u01');
  await store.approve(p.id, 'u02', '');
  await store.order(p.id, 'u03');
  const { payable } = await store.receive(p.id, 'u03', 2, '2026-09-10');

  const entry = store.getEntry(store.listEntries()[0].id);
  assert.equal(entry.purchase.id, p.id);
  assert.equal(entry.purchase.item, 'A');
  assert.equal(entry.purchase.changeHistory.length, 1); // withdrawn 時の修正履歴が見える
  assert.equal(entry.purchase.changeHistory[0].reason, '数量修正');
});

// v6 ステップ 3: 取下げ → 修正 → 再申請
test('withdraw: submitted → withdrawn は本人のみ。他人は不可', async () => {
  const store = await freshStore();
  const p = await store.create({ item: 'A', qty: 1, unitPrice: 1000, requester: 'u01' });
  assert.throws(() => store.withdraw(p.id, 'u02'), ValidationError); // 他人は取下げ不可
  await store.withdraw(p.id, 'u01');
  assert.equal(store.get(p.id).status, 'withdrawn');
  assert.throws(() => store.withdraw(p.id, 'u01'), TransitionError); // 二重取下げ不可
});

test('update: withdrawn/rejected は修正のみ・approved は変更申請で再承認へ・ordered は履歴のみ・received は不可', async () => {
  const store = await freshStore();
  // withdrawn: 修正できる（状態は動かない・change_history に記録）
  const p1 = await store.create({ item: 'A', qty: 1, unitPrice: 1000, requester: 'u01' });
  await store.withdraw(p1.id, 'u01');
  const beforeAt = p1.createdAt;
  await store.update(p1.id, 'u01', { qty: 3 }, '数量の誤り修正');
  const p1b = store.get(p1.id);
  assert.equal(p1b.status, 'withdrawn'); // 状態は動かない
  assert.equal(p1b.qty, 3);
  assert.equal(p1b.amount, 3000); // 金額も再計算
  assert.equal(p1b.changeHistory.length, 1);
  assert.deepEqual(p1b.changeHistory[0].changes, [
    { field: 'qty', before: 1, after: 3 },
    { field: 'amount', before: 1000, after: 3000 }, // 金額は数量×単価で連動再計算
  ]);
  assert.equal(p1b.changeHistory[0].actor, 'u01');
  assert.equal(p1b.createdAt, beforeAt); // createdAt は不変
  await store.resubmit(p1.id, 'u01');
  assert.equal(store.get(p1.id).status, 'submitted');

  // approved: 変更申請 → submitted に戻る（再承認を経る）
  const p2 = await store.create({ item: 'A', qty: 1, unitPrice: 1000, requester: 'u01' });
  await store.approve(p2.id, 'u02', '');
  await store.update(p2.id, 'u01', { item: 'A改' }, '品目名修正');
  const p2b = store.get(p2.id);
  assert.equal(p2b.status, 'submitted'); // 再承認を経る
  assert.equal(p2b.item, 'A改');

  // ordered: 直接上書きせず変更履歴のみ（状態維持）
  await store.approve(p2.id, 'u02', '');
  await store.order(p2.id, 'u03');
  await store.update(p2.id, 'u01', { note: '納期確認済' }, '備考追記');
  const p2c = store.get(p2.id);
  assert.equal(p2c.status, 'ordered');
  assert.equal(p2c.note, '納期確認済');
  assert.equal(p2c.changeHistory.length, 2);

  // received: 変更不可（訂正は取消仕訳フロー）
  const { payable } = await store.receive(p2.id, 'u03', 1, '2026-09-10');
  await assert.rejects(() => store.update(p2.id, 'u01', { note: 'x' }, '理由'), TransitionError);
  await store.pay(payable.id, 'u03'); // 支払済みも同様に不可（ここでは状態確認のみ）
  await assert.rejects(() => store.update(p2.id, 'u01', { note: 'y' }, '理由'), TransitionError);
});

test('update: 理由必須・変更なしは不可', async () => {
  const store = await freshStore();
  const p = await store.create({ item: 'A', qty: 1, unitPrice: 1000, requester: 'u01' });
  await store.withdraw(p.id, 'u01');
  await assert.rejects(() => store.update(p.id, 'u01', { qty: 2 }, ''), ValidationError); // 理由必須
  await assert.rejects(() => store.update(p.id, 'u01', { note: '' }, '備考だけ変更')); // 変更なし
  await assert.rejects(() => store.update(p.id, 'u01', { qty: 0 }, '理由'), ValidationError); // 不正値
});

// v6 ステップ 6: 購買一覧の複合検索（申請日・発注日・検収日・支払予定日の派生付き）
test('listPurchases: 複合条件で検索でき、派生日付が付く', async () => {
  const store = await freshStore();
  const p1 = await store.create({ item: 'ノートPC', qty: 1, unitPrice: 100000, requester: 'u01', department: 'D10' });
  await store.approve(p1.id, 'u02', '');
  await store.order(p1.id, 'u03');
  const { payable } = await store.receive(p1.id, 'u03', 1, '2026-09-10');
  const p2 = await store.create({ item: 'マウス', qty: 5, unitPrice: 500, requester: 'u01', department: 'D20' });

  // 派生日付: 申請日・発注日・検収日・支払予定日
  const enriched = store.listPurchases().find((x) => x.id === p1.id);
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(enriched.orderDate, today);
  assert.equal(enriched.receiveDate, '2026-09-10');
  assert.equal(enriched.scheduledDate, payable.scheduledDate);
  assert.ok(enriched.requestedDate <= today);

  // 条件: 品目・部門・申請者・キーワード・支払予定日
  assert.equal(store.listPurchases({ item: 'ノート' }).length, 1);
  assert.equal(store.listPurchases({ department: 'D20' }).length, 1);
  assert.equal(store.listPurchases({ department: 'D10' }).length, 1);
  assert.equal(store.listPurchases({ q: 'PO-' }).length, 1); // 発注番号
  assert.equal(store.listPurchases({ scheduledFrom: payable.scheduledDate, scheduledTo: payable.scheduledDate }).length, 1);
  assert.equal(store.listPurchases({ scheduledFrom: '2099-01-01' }).length, 0);
});

// v6 ステップ 5: 訂正申請 → 承認 → 取消仕訳 → 訂正仕訳で再計上
test('correction: received の単価訂正が 取消仕訳 + 訂正仕訳 で反映される（元・取消・訂正すべて残る）', async () => {
  const store = await freshStore();
  const p = await orderedPurchase(store, { qty: 1, unitPrice: 100000 }); // 検収仕訳: 仕入高 100,000 / 買掛金 100,000
  const { payable } = await store.receive(p.id, 'u03', 1, '2026-09-10');
  assert.equal(store.listEntries().length, 1);

  // 訂正申請（単価 100,000 → 80,000）
  await store.requestCorrection(p.id, 'u01', { unitPrice: 80000 }, '単価の誤り');
  assert.equal(store.get(p.id).status, 'correction_pending');

  // 自己承認は不可・却下せず承認すると 再計上まで一括で走る
  await assert.rejects(() => store.approveCorrection(p.id, 'u01'), SelfApprovalError);
  await store.approveCorrection(p.id, 'u02');

  const entries = store.listEntries();
  // 元仕訳 + 取消仕訳 + 訂正仕訳 の 3 件すべてが残る（直接編集・削除はしていない）
  assert.equal(entries.length, 3);
  const original = entries.find((e) => e.id === 1);
  const reversal = entries.find((e) => e.entryType === 'reversal');
  const corrected = entries.find((e) => e.entryType === 'correction');

  assert.equal(original.status, 'reversed'); // 元仕訳は取消済み
  assert.equal(original.reversedBy, reversal.id);
  // 取消仕訳: 貸借入替（買掛金 100,000 / 仕入高 100,000）
  assert.deepEqual(reversal.lines, [
    { account_code: '5110', side: 'credit', amount: 100000 },
    { account_code: '2110', side: 'debit', amount: 100000 },
  ]);
  assert.equal(reversal.reversesEntryId, 1);
  // 訂正仕訳: 正しい金額（80,000）で再計上
  assert.deepEqual(corrected.lines, [
    { account_code: '5110', side: 'debit', amount: 80000 },
    { account_code: '2110', side: 'credit', amount: 80000 },
  ]);
  assert.equal(corrected.voucherNo, `${p.id}-CORR`);

  // 購買は received に戻り、支払予定・試算表も訂正後の金額に揃う
  assert.equal(store.get(p.id).status, 'received');
  assert.equal(store.listPayables().find((y) => y.id === payable.id).amount, 80000);
  const tb = store.journal.trialBalance();
  const shire = tb.rows.find((r) => r.account_code === '5110');
  assert.equal(shire.debit_balance, 80000); // 100,000 - 100,000 + 80,000
});

test('correction: paid の購買は支払仕訳も取消・再計上される', async () => {
  const store = await freshStore();
  const p = await orderedPurchase(store, { qty: 1, unitPrice: 1000 });
  const { payable } = await store.receive(p.id, 'u03', 1, '2026-09-10');
  await store.pay(payable.id, 'u03');
  assert.equal(store.get(p.id).status, 'paid');

  await store.requestCorrection(p.id, 'u01', { unitPrice: 500 }, '金額訂正');
  await store.approveCorrection(p.id, 'u02');

  const entries = store.listEntries();
  // 検収 + 支払 ×（元 + 取消）+ 訂正（検収 + 支払）= 6 件
  assert.equal(entries.length, 6);
  assert.equal(entries.filter((e) => e.entryType === 'reversal').length, 2);
  assert.equal(entries.filter((e) => e.entryType === 'correction').length, 2);
  assert.equal(store.get(p.id).status, 'paid'); // 元の状態へ戻る
  const tb = store.journal.trialBalance();
  const bank = tb.rows.find((r) => r.account_code === '1120');
  assert.equal(bank.debit_balance, -500); // 普通預金は借方残高: -1,000 +1,000 -500（支出方向）
});

test('AC-002-01: 承認は submitted → approved の 1 段（金額に関係なく）', async () => {
  const store = await freshStore();
  const p1 = await store.create({ item: 'A', qty: 2, unitPrice: 50000, requester: 'u01' }); // 10万
  const p2 = await store.create({ item: 'B', qty: 1, unitPrice: 990000, requester: 'u01' }); // 99万でも 1 段
  await store.approve(p1.id, 'u02', '');
  await store.approve(p2.id, 'u02', '');
  assert.equal(store.get(p1.id).status, 'approved');
  assert.equal(store.get(p2.id).status, 'approved');
  assert.throws(() => store.approve(p1.id, 'u02', ''), TransitionError);
});

test('AC-002-02/03: 却下は comment 必須、再申請で submitted に戻る', async () => {
  const store = await freshStore();
  const p = await store.create({ item: 'A', qty: 1, unitPrice: 150000, requester: 'u01' });
  assert.throws(() => store.reject(p.id, 'u02', ''), ValidationError);
  await store.reject(p.id, 'u02', '予算超過');
  assert.equal(store.get(p.id).status, 'rejected');
  await store.resubmit(p.id, '山田 (申請者)', '単価を見直し再申請');
  assert.equal(store.get(p.id).status, 'submitted');
  assert.ok(store.get(p.id).history.some((h) => h.to === 'rejected' && h.comment === '予算超過'));
});

test('AC-003-01: order は approved のみ、発注番号は連番', async () => {
  const store = await freshStore();
  const p1 = await store.create({ item: 'A', qty: 1, unitPrice: 50000, requester: 'u01' });
  assert.throws(() => store.order(p1.id, '佐藤 (管理担当)'), TransitionError); // submitted からの発注
  await store.approve(p1.id, 'u02', '');
  await store.order(p1.id, '佐藤 (管理担当)');
  const year = new Date().getFullYear();
  assert.equal(store.get(p1.id).orderNo, `PO-${year}-001`);
});

test('AC-004-01/03: 検収ごとに仕訳（借 5110 / 貸 2110）が計上され支払予定が計上される', async () => {
  const store = await freshStore();
  const p = await orderedPurchase(store, { qty: 10, unitPrice: 1000, department: 'D20' });

  const { purchase, payable } = await store.receive(p.id, '佐藤 (管理担当)', 4, '2026-09-10');
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

  await store.receive(p.id, '佐藤 (管理担当)', 6, '2026-09-20');
  assert.equal(store.get(p.id).status, 'received'); // AC-004-02 全量検収済
  assert.equal(store.listPayables().length, 2);
  assert.equal(store.journal.entries.length, 2);
});

test('AC-005-02/03: 支払実行で仕訳（借 2110 / 貸 1120）計上・entryId 記録・二重支払不可', async () => {
  const store = await freshStore();
  const p = await orderedPurchase(store, { qty: 1, unitPrice: 1000, department: 'D90' });
  const { payable } = await store.receive(p.id, '佐藤 (管理担当)', 1, '2026-09-10');

  const paid = await store.pay(payable.id, '佐藤 (管理担当)');
  assert.equal(paid.status, 'paid');
  assert.equal(paid.entryId, 2);
  const payEntry = store.journal.entries[1];
  assert.deepEqual(payEntry.lines, [
    { account_code: '2110', side: 'debit', amount: 1000 },
    { account_code: '1120', side: 'credit', amount: 1000 },
  ]);
  assert.equal(payEntry.department, 'D90');
  assert.throws(() => store.pay(payable.id, '佐藤 (管理担当)'), TransitionError); // 2 重支払
  assert.throws(() => store.pay('PAY-9999', '佐藤 (管理担当)'), Error); // 存在しない支払予定（pay は同期メソッド）
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

test('persistence: 再生成後も purchases + payables + entries（仕訳台帳）が保持される (NFR-002)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pk-store-'));
  const store = await PurchaseStore.create(dir, stubKaikei(), { fresh: true });
  const p = await store.create({ item: 'モニタ', qty: 2, unitPrice: 30000, requester: 'u01', department: 'D10' });
  await store.approve(p.id, 'u02', 'OK');
  await store.order(p.id, '佐藤 (管理担当)');
  const { payable } = await store.receive(p.id, '佐藤 (管理担当)', 2, '2026-09-10');
  await store.pay(payable.id, '佐藤 (管理担当)');
  await store.syncPending(); // ミラー送信を確定的に完了させる

  const reloaded = await PurchaseStore.create(dir, stubKaikei());
  assert.equal(reloaded.get(p.id).status, 'paid');
  assert.equal(reloaded.get(p.id).department, 'D10');
  assert.equal(reloaded.get(p.id).journal.length, 2); // 検収 + 支払の仕訳参照
  assert.equal(reloaded.journal.entries.length, 2); // 仕訳台帳も保持
  const [paidPayable] = reloaded.listPayables('paid');
  assert.equal(paidPayable.entryId, 2);
});

/* ---------- kaikei-api ミラー連携（v3・Outbox / TS-UNIT-003 相当） ---------- */

test('AC-007-01: 検収・支払の仕訳が kaikei-api にミラー送信され kaikeiEntryId が記録される', async () => {
  const kaikei = stubKaikei();
  const store = await freshStore(kaikei);
  const p = await orderedPurchase(store, { qty: 5, unitPrice: 1000, department: 'D20' });

  await store.receive(p.id, '佐藤 (管理担当)', 5, '2026-09-10');
  await store.syncPending();

  assert.equal(kaikei.posted.length, 1);
  assert.equal(kaikei.posted[0].department, 'D20');
  assert.deepEqual(kaikei.posted[0].lines, [
    { account_code: '5110', side: 'debit', amount: 5000 },
    { account_code: '2110', side: 'credit', amount: 5000 },
  ]);
  assert.equal(store.journal.entries[0].kaikeiEntryId, 500);
  assert.equal(store.syncStatus().pending, 0);
});

test('AC-007-02: 障害時はキュー保持で購買は止まらず、復帰後の再送で取り込まれる', async () => {
  const kaikei = stubKaikei();
  const store = await freshStore(kaikei);
  const p = await orderedPurchase(store, { qty: 5, unitPrice: 1000 });
  kaikei.state.fail = true;

  // 障害中でも検収・支払は普通に成功する（v1 との決定的な違い）
  const { payable } = await store.receive(p.id, '佐藤 (管理担当)', 5, '2026-09-10');
  await store.pay(payable.id, '佐藤 (管理担当)');
  assert.equal(store.get(p.id).status, 'paid');
  assert.equal(store.syncStatus().pending, 2); // 2 件がキューに保持

  await store.syncPending(); // 障害中の再送 → 減らない
  assert.equal(store.syncStatus().pending, 2);
  assert.equal(kaikei.posted.length, 0);

  kaikei.state.fail = false; // 復帰
  const r = await store.syncPending();
  assert.equal(r.sent, 2);
  assert.equal(store.syncStatus().pending, 0);
  assert.equal(store.journal.entries[0].kaikeiEntryId, 500);
  assert.equal(store.journal.entries[1].kaikeiEntryId, 501);
});

test('auto-sync: 検収・支払を待たずとも復帰後に自動再送される', async () => {
  const kaikei = stubKaikei();
  const store = await freshStore(kaikei);
  const p = await orderedPurchase(store, { qty: 2, unitPrice: 1000 });
  kaikei.state.fail = true;
  await store.receive(p.id, '佐藤 (管理担当)', 2, '2026-09-10');
  assert.equal(store.syncStatus().pending, 1);

  store.startAutoSync(50); // 50ms 間隔で自動再送
  try {
    await new Promise((r) => setTimeout(r, 30));
    kaikei.state.fail = false; // 復帰 → タイマーが自動で回収するはず
    for (let i = 0; i < 20 && store.syncStatus().pending > 0; i += 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(store.syncStatus().pending, 0);
    assert.equal(kaikei.posted.length, 1);
    assert.equal(store.journal.entries[0].kaikeiEntryId, 500);
  } finally {
    store.stopAutoSync();
  }
});

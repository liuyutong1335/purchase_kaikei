'use strict';
// CMP-PURCHASEKAIKEI-002: ドメイン層 — SQLite 永続化・状態遷移ガード・履歴記録・発注番号採番
// v2: 内蔵会計エンジン（store/journal.js）で仕訳を自動計上。外部 API 依存なし。
//   検収 → 仕訳（借: 仕入高 5110 / 貸: 買掛金 2110）
//   支払 → 仕訳（借: 買掛金 2110 / 貸: 普通預金 1120）
// v4: 永続化を JSON ファイルから SQLite（node:sqlite・依存追加なし）に変更。
// 購買・支払予定・仕訳台帳・Outbox キューを同一トランザクションで書き込むため常に整合する。
// 旧 purchases.json がある場合は初回起動時に自動取り込み（移行）する。
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { JournalEngine } = require('./journal');
const { KaikeiClient } = require('./kaikei-client');

const STATUSES = ['submitted', 'approved', 'rejected', 'ordered', 'received'];
const DEPARTMENTS = ['D10', 'D20', 'D90'];

class TransitionError extends Error {
  constructor(action, from) {
    super(`invalid_transition: ${action} is not allowed from "${from}"`);
    this.name = 'TransitionError';
    this.code = 'invalid_transition';
  }
}

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'validation_error';
  }
}

function now() {
  return new Date().toISOString();
}

// 月末締め翌月末払い: 検収月の翌月末日を支払予定日とする
// 年月は文字列で扱い、タイムゾーンによる日ずれを防ぐ
function nextMonthEnd(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate(); // 翌月 0 日 = 末日
  return `${ny}-${String(nm).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
}

class PurchaseStore {
  // kaikei: kaikei-api ミラー送信用クライアント（省略時は本物・テストではスタブを注入）。
  // v3: 連携は Outbox 方式 — 仕訳は常に内蔵エンジンで即計上し、kaikei-api へは
  // 後からミラー送信する。失敗しても購買操作は止まらず、キューに溜めて再送する。
  constructor(dataDir, kaikei) {
    this.dataDir = dataDir;
    this.dbFile = path.join(dataDir, 'purchase-kaikei.db');
    this.kaikei = kaikei || new KaikeiClient();
    this.db = this.#open();
    this.data = this.#hydrate();
    this.#migrateJsonIfFresh();
    // 内蔵会計エンジン（entries 配列・counters を store と共有）
    this.journal = new JournalEngine(this.data.entries);
    this.journal.counters = this.data.counters;
    this._syncing = false; // ミラー送信の多重実行防止
  }

  /* ---------- SQLite 永続化（v4） ---------- */

  #open() {
    fs.mkdirSync(this.dataDir, { recursive: true });
    const db = new DatabaseSync(this.dbFile);
    db.exec(`
      CREATE TABLE IF NOT EXISTS counters (
        name  TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS purchases (
        id             TEXT PRIMARY KEY,
        item           TEXT    NOT NULL,
        qty            INTEGER NOT NULL,
        unit_price     REAL    NOT NULL,
        amount         REAL    NOT NULL,
        requester      TEXT    NOT NULL,
        department     TEXT    NOT NULL,
        note           TEXT    NOT NULL DEFAULT '',
        status         TEXT    NOT NULL,
        order_no       TEXT,
        received_total INTEGER NOT NULL DEFAULT 0,
        journal        TEXT    NOT NULL DEFAULT '[]', -- 仕訳参照（JSON）: NFR-003
        history        TEXT    NOT NULL DEFAULT '[]', -- 遷移履歴（JSON）
        created_at     TEXT    NOT NULL
      );
      CREATE TABLE IF NOT EXISTS payables (
        id             TEXT PRIMARY KEY,
        purchase_id    TEXT    NOT NULL,
        purchase_item  TEXT    NOT NULL,
        department     TEXT    NOT NULL,
        received_qty   INTEGER NOT NULL,
        amount         INTEGER NOT NULL,
        scheduled_date TEXT    NOT NULL,
        status         TEXT    NOT NULL,
        entry_id       INTEGER,                      -- 支払仕訳の entry id（AC-005-03）
        created_at     TEXT    NOT NULL,
        paid_at        TEXT
      );
      CREATE TABLE IF NOT EXISTS journal_entries (
        id              INTEGER PRIMARY KEY,
        date            TEXT NOT NULL,
        description     TEXT NOT NULL,
        department      TEXT NOT NULL,
        kaikei_entry_id INTEGER,                     -- ミラー送信済みの kaikei-api 側 id
        created_at      TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS journal_lines (
        entry_id     INTEGER NOT NULL REFERENCES journal_entries (id),
        seq          INTEGER NOT NULL,
        account_code TEXT    NOT NULL,
        side         TEXT    NOT NULL,
        amount       INTEGER NOT NULL,
        PRIMARY KEY (entry_id, seq)
      );
      CREATE TABLE IF NOT EXISTS pending_links (
        seq            INTEGER PRIMARY KEY,          -- Outbox: 送信順を保持
        local_entry_id INTEGER NOT NULL,
        payload        TEXT    NOT NULL              -- kaikei-api 契約 §3 の形式（JSON）
      );
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
    `);
    return db;
  }

  // DB → メモリ（this.data）。形状は v3 までの JSON と同じ（既存テスト・ビュー互換）
  #hydrate() {
    const counters = { purchase: 0, order: 0, payable: 0, entry: 0 };
    for (const row of this.db.prepare('SELECT name, value FROM counters').all()) {
      counters[row.name] = Number(row.value);
    }
    const purchases = this.db.prepare('SELECT * FROM purchases ORDER BY created_at, id').all().map((r) => ({
      id: r.id,
      item: r.item,
      qty: Number(r.qty),
      unitPrice: Number(r.unit_price),
      amount: Number(r.amount),
      requester: r.requester,
      department: r.department,
      note: r.note,
      status: r.status,
      orderNo: r.order_no,
      receivedTotal: Number(r.received_total),
      journal: JSON.parse(r.journal),
      history: JSON.parse(r.history),
      createdAt: r.created_at,
    }));
    const payables = this.db.prepare('SELECT * FROM payables ORDER BY created_at, id').all().map((r) => ({
      id: r.id,
      purchaseId: r.purchase_id,
      purchaseItem: r.purchase_item,
      department: r.department,
      receivedQty: Number(r.received_qty),
      amount: Number(r.amount),
      scheduledDate: r.scheduled_date,
      status: r.status,
      entryId: r.entry_id == null ? null : Number(r.entry_id),
      createdAt: r.created_at,
      paidAt: r.paid_at,
    }));
    const linesByEntry = new Map();
    for (const l of this.db.prepare('SELECT entry_id, seq, account_code, side, amount FROM journal_lines ORDER BY entry_id, seq').all()) {
      if (!linesByEntry.has(l.entry_id)) linesByEntry.set(l.entry_id, []);
      linesByEntry.get(l.entry_id).push({ account_code: l.account_code, side: l.side, amount: Number(l.amount) });
    }
    const entries = this.db.prepare('SELECT * FROM journal_entries ORDER BY id').all().map((r) => ({
      id: Number(r.id),
      date: r.date,
      description: r.description,
      department: r.department,
      ...(r.kaikei_entry_id == null ? {} : { kaikeiEntryId: Number(r.kaikei_entry_id) }),
      lines: linesByEntry.get(r.id) || [],
      createdAt: r.created_at,
    }));
    const pendingLinks = this.db.prepare('SELECT local_entry_id, payload FROM pending_links ORDER BY seq').all()
      .map((r) => ({ localEntryId: Number(r.local_entry_id), payload: JSON.parse(r.payload) }));
    const data = { purchases, payables, entries, pendingLinks, counters };
    const lastLinkError = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('lastLinkError');
    if (lastLinkError && lastLinkError.value != null) data.lastLinkError = JSON.parse(lastLinkError.value);
    return data;
  }

  // メモリ → DB。購買・支払予定・仕訳台帳・Outbox キューを 1 トランザクションで書き込む
  // （v2 までの「同じ書き込み時に保存」の整合性保証を SQLite にそのまま持ち込む）
  #save() {
    const d = this.data;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const putCounter = this.db.prepare('INSERT OR REPLACE INTO counters (name, value) VALUES (?, ?)');
      for (const [name, value] of Object.entries(d.counters)) putCounter.run(name, value);

      const putPurchase = this.db.prepare(`INSERT OR REPLACE INTO purchases
        (id, item, qty, unit_price, amount, requester, department, note, status, order_no, received_total, journal, history, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const p of d.purchases) {
        putPurchase.run(p.id, p.item, p.qty, p.unitPrice, p.amount, p.requester, p.department, p.note,
          p.status, p.orderNo, p.receivedTotal, JSON.stringify(p.journal), JSON.stringify(p.history), p.createdAt);
      }

      const putPayable = this.db.prepare(`INSERT OR REPLACE INTO payables
        (id, purchase_id, purchase_item, department, received_qty, amount, scheduled_date, status, entry_id, created_at, paid_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const y of d.payables) {
        putPayable.run(y.id, y.purchaseId, y.purchaseItem, y.department, y.receivedQty, y.amount,
          y.scheduledDate, y.status, y.entryId, y.createdAt, y.paidAt);
      }

      const putEntry = this.db.prepare(`INSERT OR REPLACE INTO journal_entries
        (id, date, description, department, kaikei_entry_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
      const putLine = this.db.prepare('INSERT OR REPLACE INTO journal_lines (entry_id, seq, account_code, side, amount) VALUES (?, ?, ?, ?, ?)');
      for (const e of d.entries) {
        putEntry.run(e.id, e.date, e.description, e.department, e.kaikeiEntryId ?? null, e.createdAt);
        for (const [seq, l] of e.lines.entries()) putLine.run(e.id, seq, l.account_code, l.side, l.amount);
      }

      // Outbox キューは順序ごと差し替え（shift で先頭を消すため）
      this.db.prepare('DELETE FROM pending_links').run();
      const putLink = this.db.prepare('INSERT INTO pending_links (seq, local_entry_id, payload) VALUES (?, ?, ?)');
      for (const [seq, job] of d.pendingLinks.entries()) putLink.run(seq, job.localEntryId, JSON.stringify(job.payload));

      this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run('lastLinkError', d.lastLinkError ? JSON.stringify(d.lastLinkError) : null);

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // v3 以前の purchases.json → SQLite の 1 回だけの移行（DB が空のときだけ）
  #migrateJsonIfFresh() {
    if (this.data.purchases.length > 0 || this.data.entries.length > 0) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'purchases.json'), 'utf8'));
    } catch {
      return; // 初回起動時はファイルが無い
    }
    if (!Array.isArray(data.purchases)) return;
    if (!Array.isArray(data.entries)) data.entries = []; // v1 からの移行
    if (!Array.isArray(data.pendingLinks)) data.pendingLinks = []; // v3: 未同期キュー
    if (!data.counters || data.counters.entry == null) data.counters = { purchase: 0, order: 0, payable: 0, entry: 0 };
    this.data = {
      purchases: data.purchases,
      payables: Array.isArray(data.payables) ? data.payables : [],
      entries: data.entries,
      pendingLinks: data.pendingLinks,
      counters: data.counters,
      ...(data.lastLinkError ? { lastLinkError: data.lastLinkError } : {}),
    };
    this.#save();
    console.error(`purchases.json から SQLite (${path.basename(this.dbFile)}) への移行が完了しました`);
  }

  #load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (!Array.isArray(data.entries)) data.entries = []; // v1 からの移行
      if (data.counters.entry == null) data.counters.entry = 0;
      if (!Array.isArray(data.pendingLinks)) data.pendingLinks = []; // v3: 未同期キュー
      return data;
    } catch {
      // 初回起動時はファイルが無い
      return { purchases: [], payables: [], entries: [], pendingLinks: [], counters: { purchase: 0, order: 0, payable: 0, entry: 0 } };
    }
  }

  create({ item, qty, unitPrice, requester, department, note }) {
    if (!item || typeof item !== 'string' || !item.trim()) {
      throw new ValidationError('item is required');
    }
    if (!Number.isInteger(qty) || qty < 1) {
      throw new ValidationError('qty must be an integer >= 1');
    }
    if (typeof unitPrice !== 'number' || unitPrice < 0 || Number.isNaN(unitPrice)) {
      throw new ValidationError('unitPrice must be a number >= 0');
    }
    if (!requester || typeof requester !== 'string' || !requester.trim()) {
      throw new ValidationError('requester is required');
    }
    if (department != null && !DEPARTMENTS.includes(department)) {
      throw new ValidationError(`department must be one of ${DEPARTMENTS.join('/')}`);
    }
    this.data.counters.purchase += 1;
    const id = `PU-${String(this.data.counters.purchase).padStart(4, '0')}`;
    const purchase = {
      id,
      item: item.trim(),
      qty,
      unitPrice,
      amount: qty * unitPrice,
      requester: requester.trim(),
      department: department || 'D90', // AC-001-02: 既定 D90（管理部・共通）
      note: note || '',
      status: 'submitted',
      orderNo: null,
      receivedTotal: 0,
      journal: [], // 仕訳参照: { kind, entryId, qty?, amount, date }（NFR-003）
      createdAt: now(),
      history: [
        { from: null, to: 'submitted', at: now(), actor: requester.trim(), comment: '購買申請登録' },
      ],
    };
    this.data.purchases.push(purchase);
    this.#save();
    return purchase;
  }

  list(status) {
    if (status) {
      return this.data.purchases.filter((p) => p.status === status);
    }
    return this.data.purchases;
  }

  get(id) {
    const purchase = this.data.purchases.find((p) => p.id === id);
    if (!purchase) {
      throw new ValidationError(`purchase not found: ${id}`);
    }
    return purchase;
  }

  listPayables(status) {
    if (status) {
      return this.data.payables.filter((x) => x.status === status);
    }
    return this.data.payables;
  }

  #find(id) {
    const purchase = this.data.purchases.find((p) => p.id === id);
    if (!purchase) {
      const err = new Error(`purchase not found: ${id}`);
      err.code = 'not_found';
      throw err;
    }
    return purchase;
  }

  #push(purchase, from, to, actor, comment, extra) {
    purchase.status = to;
    purchase.history.push({ from, to, at: now(), actor: actor || '担当', comment: comment || '', ...extra });
  }

  // AC-002-01: 承認（1段）。submitted → approved。
  approve(id, actor, comment) {
    const purchase = this.#find(id);
    if (purchase.status !== 'submitted') {
      throw new TransitionError('approve', purchase.status);
    }
    this.#push(purchase, 'submitted', 'approved', actor, comment || '');
    this.#save();
    return purchase;
  }

  // AC-002-02: 却下（submitted のみ。コメント必須）
  reject(id, actor, comment) {
    if (!comment || !comment.trim()) {
      throw new ValidationError('comment is required to reject');
    }
    const purchase = this.#find(id);
    if (purchase.status !== 'submitted') {
      throw new TransitionError('reject', purchase.status);
    }
    this.#push(purchase, purchase.status, 'rejected', actor, comment.trim());
    this.#save();
    return purchase;
  }

  // AC-002-03: 再申請（rejected → submitted。履歴保持）
  resubmit(id, actor, comment) {
    const purchase = this.#find(id);
    if (purchase.status !== 'rejected') {
      throw new TransitionError('resubmit', purchase.status);
    }
    this.#push(purchase, 'rejected', 'submitted', actor, comment || '修正のうえ再申請', { resubmit: true });
    this.#save();
    return purchase;
  }

  // AC-003-01: 発注（approved のみ。遷移失敗時は採番 counter を消費しない）
  order(id, actor) {
    const purchase = this.#find(id);
    if (purchase.status !== 'approved') {
      throw new TransitionError('order', purchase.status);
    }
    this.data.counters.order += 1;
    const orderNo = `PO-${new Date().getFullYear()}-${String(this.data.counters.order).padStart(3, '0')}`;
    purchase.orderNo = orderNo;
    this.#push(purchase, 'approved', 'ordered', actor, `発注（発注番号: ${orderNo}）`);
    this.#save();
    return purchase;
  }

  // AC-004-01/03: 分割検収。検収 1 回ごとに (1) 仕訳 1 件を計上（借: 仕入高 / 貸: 買掛金）、
  // (2) 支払予定 1 件を計上する。全量検収で received（AC-004-02）。
  receive(id, actor, receivedQty, receivedAt, comment) {
    const purchase = this.#find(id);
    if (purchase.status !== 'ordered') {
      throw new TransitionError('receive', purchase.status);
    }
    const qty = receivedQty == null ? purchase.qty - purchase.receivedTotal : receivedQty;
    if (!Number.isInteger(qty) || qty < 1) {
      throw new ValidationError('receivedQty must be an integer >= 1');
    }
    if (purchase.receivedTotal + qty > purchase.qty) {
      throw new ValidationError(`receivedQty exceeds remaining (${purchase.qty - purchase.receivedTotal})`);
    }
    const amount = qty * purchase.unitPrice;
    if (!Number.isInteger(amount) || amount < 1) {
      throw new ValidationError(`amount (qty × unitPrice = ${amount}) must be an integer >= 1`);
    }
    const date = receivedAt || now().slice(0, 10);

    // 仕訳計上（借: 仕入高 5110 / 貸: 買掛金 2110）
    const entry = this.journal.post({
      date,
      department: purchase.department,
      description: `購買検収 ${purchase.id}（${purchase.item}）`,
      lines: [
        { account_code: '5110', side: 'debit', amount },
        { account_code: '2110', side: 'credit', amount },
      ],
    });

    purchase.receivedTotal += qty;
    this.#push(purchase, 'ordered', purchase.receivedTotal === purchase.qty ? 'received' : 'ordered', actor,
      `検収（数量: ${qty} / 累計: ${purchase.receivedTotal}/${purchase.qty}）・仕訳 entry #${entry.id}`,
      { receivedQty: qty, receivedAt: date, entryId: entry.id });
    purchase.journal.push({ kind: 'receive', entryId: entry.id, qty, amount, date });

    // AC-005-01: 検収ごとに支払予定を計上（金額 = 検収数量 × 単価、支払予定日 = 検収月の翌月末日）
    this.data.counters.payable += 1;
    const payable = {
      id: `PAY-${String(this.data.counters.payable).padStart(4, '0')}`,
      purchaseId: purchase.id,
      purchaseItem: purchase.item,
      department: purchase.department,
      receivedQty: qty,
      amount,
      scheduledDate: nextMonthEnd(date),
      status: 'scheduled',
      entryId: null, // 支払実行時に支払仕訳の entry id を保存（AC-005-03）
      createdAt: now(),
      paidAt: null,
    };
    this.data.payables.push(payable);
    this.#save();
    this.#enqueueLink(entry);
    this.#trySyncPending().catch(() => {}); // ベストエフォート（失敗はキューに残る）
    return { purchase, payable };
  }

  // AC-005-02/03: 支払予定単位で支払済み化（scheduled のみ）。
  // 仕訳 1 件を計上（借: 買掛金 / 貸: 普通預金）してから状態を更新する。
  pay(payableId, actor, comment) {
    const payable = this.data.payables.find((x) => x.id === payableId);
    if (!payable) {
      const err = new Error(`payable not found: ${payableId}`);
      err.code = 'not_found';
      throw err;
    }
    if (payable.status !== 'scheduled') {
      throw new TransitionError('pay', payable.status);
    }
    const purchase = this.data.purchases.find((p) => p.id === payable.purchaseId);

    // 仕訳計上（借: 買掛金 2110 / 貸: 普通預金 1120）
    const entry = this.journal.post({
      date: now().slice(0, 10),
      department: purchase ? purchase.department : 'D90',
      description: `購買支払 ${payable.purchaseId} / ${payable.id}`,
      lines: [
        { account_code: '2110', side: 'debit', amount: payable.amount },
        { account_code: '1120', side: 'credit', amount: payable.amount },
      ],
    });

    payable.status = 'paid';
    payable.paidAt = now();
    payable.entryId = entry.id;
    if (purchase) {
      this.#push(purchase, purchase.status, purchase.status, actor,
        `支払実行（${payable.id}: ${payable.amount}円・仕訳 entry #${entry.id}）`, { entryId: entry.id });
      purchase.journal.push({ kind: 'pay', entryId: entry.id, payableId: payable.id, amount: payable.amount, date: now().slice(0, 10) });
    }
    this.#save();
    this.#enqueueLink(entry);
    this.#trySyncPending().catch(() => {}); // ベストエフォート
    return payable;
  }

  /* ---------- kaikei-api ミラー連携（v3・Outbox 方式） ---------- */

  // 仕訳をミラー送信キューに入れる（payload は kaikei-api 契約 §3 の形式そのまま）
  #enqueueLink(entry) {
    this.data.pendingLinks.push({
      localEntryId: entry.id,
      payload: {
        date: entry.date,
        description: entry.description,
        department: entry.department,
        lines: entry.lines.map((l) => ({ account_code: l.account_code, side: l.side, amount: l.amount })),
      },
    });
    this.#save();
  }

  // キュー内の未送信仕訳を kaikei-api へ送る。1 件でも接続不可なら残りを残して中断。
  // 成功した仕訳には kaikeiEntryId（向こう側の採番 id）を記録する。
  async syncPending() {
    if (this._syncing) return this.syncStatus();
    this._syncing = true;
    try {
      let sent = 0;
      while (this.data.pendingLinks.length > 0) {
        const job = this.data.pendingLinks[0];
        try {
          const remote = await this.kaikei.postEntry(job.payload);
          const entry = this.data.entries.find((e) => e.id === job.localEntryId);
          if (entry) entry.kaikeiEntryId = remote.id;
          this.data.pendingLinks.shift();
          sent += 1;
        } catch (err) {
          if (err.code === 'kaikei_unavailable') break; // 相手が居ない → 後で再送
          // kaikei 側の業務エラー（未知科目など）は再送しても届かないので破棄して記録
          this.data.pendingLinks.shift();
          this.data.lastLinkError = { at: now(), localEntryId: job.localEntryId, message: err.message };
        }
      }
      this.#save();
      return { sent, remaining: this.data.pendingLinks.length, ...this.syncStatus() };
    } finally {
      this._syncing = false;
    }
  }

  syncStatus() {
    return {
      enabled: true,
      url: this.kaikei.baseUrl,
      pending: this.data.pendingLinks.length,
      lastError: this.data.lastLinkError || null,
    };
  }

  // 操作のたびにベストエフォートで送る（失敗は握りつぶし・キューに残す）
  async #trySyncPending() {
    try {
      await this.syncPending();
    } catch (err) {
      this.data.lastLinkError = { at: now(), message: err.message };
    }
  }

  /* ---------- 自動再送タイマー ---------- */

  // Outbox キューに残りがある間、定間隔で自動再送する（相手が復帰したら
  // 検収・支払を待たずに追いつく。unref なのでプロセスの終了を妨げない）
  startAutoSync(intervalMs = 30_000) {
    this.stopAutoSync();
    this._autoSyncTimer = setInterval(() => {
      if (this.data.pendingLinks.length > 0) this.#trySyncPending();
    }, intervalMs);
    this._autoSyncTimer.unref();
    // 起動直後にも 1 回：前回の未送信分をできるだけ早く回収する
    if (this.data.pendingLinks.length > 0) this.#trySyncPending();
  }

  stopAutoSync() {
    if (this._autoSyncTimer) {
      clearInterval(this._autoSyncTimer);
      this._autoSyncTimer = null;
    }
  }
}

module.exports = {
  PurchaseStore,
  TransitionError,
  ValidationError,
  STATUSES,
  DEPARTMENTS,
  nextMonthEnd,
};

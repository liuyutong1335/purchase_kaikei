'use strict';
// CMP-PURCHASEKAIKEI-002: ドメイン層 — PostgreSQL 永続化・状態遷移ガード・履歴記録・発注番号採番
// v2: 内蔵会計エンジン（store/journal.js）で仕訳を自動計上。外部 API 依存なし。
//   検収 → 仕訳（借: 仕入高 5110 / 貸: 買掛金 2110）
//   支払 → 仕訳（借: 買掛金 2110 / 貸: 普通預金 1120）
// v4: SQLite 永続化（node:sqlite・7 テーブル・同一トランザクション）。
// v5: PostgreSQL に統一（1 サーバ 3 データベースの purchase DB。pg ドライバ・API は不変）。
//     pg は非同期 API のため全メソッドが async（v4 までの同期呼び出しからの置き換え）。
//     購買・支払予定・仕訳台帳・Outbox キューを同一トランザクションで書き込むため常に整合する。
//     旧 purchases.json（v3 以前）は初回起動時に自動取り込み（移行）する。
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { JournalEngine } = require('./journal');
const { KaikeiClient } = require('./kaikei-client');

// .env（app ルート）を読む — 依存を増やさないため 10 行で自前実装
// （DB パスワード等の接続情報はコミットしない — NFR-PURCHASEKAIKEI-001-05）
function loadDotEnv() {
  try {
    const envFile = path.join(__dirname, '..', '.env');
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // .env が無い場合はプロセスの環境変数のみで動く
  }
}

const DDL = `
  CREATE TABLE IF NOT EXISTS counters (
    name  TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS purchases (
    id             TEXT PRIMARY KEY,
    item           TEXT    NOT NULL,
    qty            INTEGER NOT NULL,
    unit_price     DOUBLE PRECISION NOT NULL,
    amount         DOUBLE PRECISION NOT NULL,
    requester      TEXT    NOT NULL,
    department     TEXT    NOT NULL,
    note           TEXT    NOT NULL DEFAULT '',
    status         TEXT    NOT NULL,
    order_no       TEXT,
    received_total INTEGER NOT NULL DEFAULT 0,
    journal        JSONB   NOT NULL DEFAULT '[]', -- 仕訳参照（JSON）: NFR-003
    history        JSONB   NOT NULL DEFAULT '[]', -- 遷移履歴（JSON）
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
    payload        JSONB   NOT NULL              -- kaikei-api 契約 §3 の形式
  );
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`;

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
  // 生成済みインスタンスの登録簿（テスト終了時の一括 close 用。pg の接続は
  // 開きっぱなしだと node --test のプロセスが終了しないため）
  static #live = new Set();

  // 非同期ファクトリ（PG 接続・スキーマ作成・hydrate・移行を済ませて返す）。
  // fresh: true はテスト用 — 既存データを全消しして空の状態から始める。
  static async create(dataDir, kaikei, { fresh = false } = {}) {
    const store = new PurchaseStore(dataDir, kaikei);
    await store.client.connect();
    PurchaseStore.#live.add(store);
    await store.client.query(DDL);
    if (fresh) {
      await store.client.query('TRUNCATE purchases, payables, journal_entries, journal_lines, pending_links, counters, meta');
    }
    await store.#hydrate();
    await store.#migrateJsonIfFresh();
    // 内蔵会計エンジン（entries 配列・counters を store と共有）
    store.journal = new JournalEngine(store.data.entries);
    store.journal.counters = store.data.counters;
    return store;
  }

  // kaikei: kaikei-api ミラー送信用クライアント（省略時は本物・テストではスタブを注入）。
  constructor(dataDir, kaikei) {
    loadDotEnv();
    this.dataDir = dataDir;
    this.kaikei = kaikei || new KaikeiClient();
    this.client = new Client({
      host: process.env.PG_HOST || 'localhost',
      port: Number(process.env.PG_PORT || 5432),
      user: process.env.PG_USER || 'postgres',
      password: process.env.PG_PASSWORD,
      database: process.env.PG_DATABASE || 'purchase',
    });
    this.data = { purchases: [], payables: [], entries: [], pendingLinks: [], counters: { purchase: 0, order: 0, payable: 0, entry: 0 } };
  }

  /* ---------- PostgreSQL 永続化（v5） ---------- */

  // DB → メモリ（this.data）。形状は v3 までの JSON と同じ（既存テスト・ビュー互換）。
  // JSONB 列は pg が自動でオブジェクトにしてくれる（JSON.parse 不要）。
  async #hydrate() {
    const counters = { purchase: 0, order: 0, payable: 0, entry: 0 };
    for (const row of (await this.client.query('SELECT name, value FROM counters')).rows) {
      counters[row.name] = Number(row.value);
    }
    const purchases = (await this.client.query('SELECT * FROM purchases ORDER BY created_at, id')).rows.map((r) => ({
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
      journal: r.journal || [],
      history: r.history || [],
      createdAt: r.created_at,
    }));
    const payables = (await this.client.query('SELECT * FROM payables ORDER BY created_at, id')).rows.map((r) => ({
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
    for (const l of (await this.client.query('SELECT entry_id, seq, account_code, side, amount FROM journal_lines ORDER BY entry_id, seq')).rows) {
      if (!linesByEntry.has(l.entry_id)) linesByEntry.set(l.entry_id, []);
      linesByEntry.get(l.entry_id).push({ account_code: l.account_code, side: l.side, amount: Number(l.amount) });
    }
    const entries = (await this.client.query('SELECT * FROM journal_entries ORDER BY id')).rows.map((r) => ({
      id: Number(r.id),
      date: r.date,
      description: r.description,
      department: r.department,
      ...(r.kaikei_entry_id == null ? {} : { kaikeiEntryId: Number(r.kaikei_entry_id) }),
      lines: linesByEntry.get(r.id) || [],
      createdAt: r.created_at,
    }));
    const pendingLinks = (await this.client.query('SELECT local_entry_id, payload FROM pending_links ORDER BY seq')).rows
      .map((r) => ({ localEntryId: Number(r.local_entry_id), payload: r.payload }));
    const data = { purchases, payables, entries, pendingLinks, counters };
    const lastLinkError = (await this.client.query('SELECT value FROM meta WHERE key = $1', ['lastLinkError'])).rows[0];
    if (lastLinkError && lastLinkError.value != null) data.lastLinkError = lastLinkError.value;
    this.data = data;
  }

  // メモリ → DB。pg は非同期のため save が入れ子で走り得る（例: receive の保存中に
  // syncPending の保存が割り込む）— 同一クライアント上で交错すると DELETE+INSERT が
  // 干渉して主キー衝突する。v4 までの同期 SQLite では起き得なかった。
  // → キューで直列化し「常にメモリの最新状態を 1 トランザクションで書く」に戻す。
  #saveQueue = Promise.resolve();

  #save() {
    const run = this.#saveQueue.then(() => this.#saveNow());
    this.#saveQueue = run.catch(() => {}); // 失敗しても列は継続
    return run;
  }

  // メモリ → DB の実体。購買・支払予定・仕訳台帳・Outbox キューを 1 トランザクションで書き込む
  // （v2 からの「同じ書き込み時に保存」の整合性保証をそのまま維持）
  async #saveNow() {
    const d = this.data;
    const c = this.client;
    await c.query('BEGIN');
    try {
      const putCounter = 'INSERT INTO counters (name, value) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET value = EXCLUDED.value';
      for (const [name, value] of Object.entries(d.counters)) await c.query(putCounter, [name, value]);

      const putPurchase = `INSERT INTO purchases
        (id, item, qty, unit_price, amount, requester, department, note, status, order_no, received_total, journal, history, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (id) DO UPDATE SET
          item=EXCLUDED.item, qty=EXCLUDED.qty, unit_price=EXCLUDED.unit_price, amount=EXCLUDED.amount,
          requester=EXCLUDED.requester, department=EXCLUDED.department, note=EXCLUDED.note,
          status=EXCLUDED.status, order_no=EXCLUDED.order_no, received_total=EXCLUDED.received_total,
          journal=EXCLUDED.journal, history=EXCLUDED.history, created_at=EXCLUDED.created_at`;
      for (const p of d.purchases) {
        await c.query(putPurchase, [p.id, p.item, p.qty, p.unitPrice, p.amount, p.requester, p.department,
          p.note, p.status, p.orderNo, p.receivedTotal, JSON.stringify(p.journal), JSON.stringify(p.history), p.createdAt]);
      }

      const putPayable = `INSERT INTO payables
        (id, purchase_id, purchase_item, department, received_qty, amount, scheduled_date, status, entry_id, created_at, paid_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        ON CONFLICT (id) DO UPDATE SET
          purchase_id=EXCLUDED.purchase_id, purchase_item=EXCLUDED.purchase_item, department=EXCLUDED.department,
          received_qty=EXCLUDED.received_qty, amount=EXCLUDED.amount, scheduled_date=EXCLUDED.scheduled_date,
          status=EXCLUDED.status, entry_id=EXCLUDED.entry_id, created_at=EXCLUDED.created_at, paid_at=EXCLUDED.paid_at`;
      for (const y of d.payables) {
        await c.query(putPayable, [y.id, y.purchaseId, y.purchaseItem, y.department, y.receivedQty, y.amount,
          y.scheduledDate, y.status, y.entryId, y.createdAt, y.paidAt]);
      }

      const putEntry = `INSERT INTO journal_entries (id, date, description, department, kaikei_entry_id, created_at)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (id) DO UPDATE SET date=EXCLUDED.date, description=EXCLUDED.description,
          department=EXCLUDED.department, kaikei_entry_id=EXCLUDED.kaikei_entry_id, created_at=EXCLUDED.created_at`;
      const putLine = 'INSERT INTO journal_lines (entry_id, seq, account_code, side, amount) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (entry_id, seq) DO UPDATE SET account_code=EXCLUDED.account_code, side=EXCLUDED.side, amount=EXCLUDED.amount';
      for (const e of d.entries) {
        await c.query(putEntry, [e.id, e.date, e.description, e.department, e.kaikeiEntryId ?? null, e.createdAt]);
        for (const [seq, l] of e.lines.entries()) await c.query(putLine, [e.id, seq, l.account_code, l.side, l.amount]);
      }

      // Outbox キューは順序ごと差し替え（shift で先頭を消すため）
      await c.query('DELETE FROM pending_links');
      const putLink = 'INSERT INTO pending_links (seq, local_entry_id, payload) VALUES ($1,$2,$3)';
      for (const [seq, job] of d.pendingLinks.entries()) await c.query(putLink, [seq, job.localEntryId, JSON.stringify(job.payload)]);

      await c.query("INSERT INTO meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        ['lastLinkError', d.lastLinkError ? JSON.stringify(d.lastLinkError) : null]);

      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    }
  }

  // v3 以前の purchases.json → PG の 1 回だけの移行（DB が空のときだけ）
  async #migrateJsonIfFresh() {
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
    await this.#save();
    console.error(`purchases.json から PostgreSQL (database: ${process.env.PG_DATABASE || 'purchase'}) への移行が完了しました`);
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
    return this.#save().then(() => purchase);
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
    return this.#save().then(() => purchase);
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
    return this.#save().then(() => purchase);
  }

  // AC-002-03: 再申請（rejected → submitted。履歴保持）
  resubmit(id, actor, comment) {
    const purchase = this.#find(id);
    if (purchase.status !== 'rejected') {
      throw new TransitionError('resubmit', purchase.status);
    }
    this.#push(purchase, 'rejected', 'submitted', actor, comment || '修正のうえ再申請', { resubmit: true });
    return this.#save().then(() => purchase);
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
    return this.#save().then(() => purchase);
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
    this.#enqueueLink(entry);
    return this.#save().then(() => {
      this.#trySyncPending().catch(() => {}); // ベストエフォート（失敗はキューに残る）
      return { purchase, payable };
    });
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
    this.#enqueueLink(entry);
    return this.#save().then(() => {
      this.#trySyncPending().catch(() => {}); // ベストエフォート
      return payable;
    });
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
  }

  // キュー内の未送信仕訳を kaikei-api へ送る。1 件でも接続不可なら残りを残して中断。
  // 成功した仕訳には kaikeiEntryId（向こう側の採番 id）を記録する。
  // 同時呼び出しはスキップではなく直列化して待たせる（receive・pay のベストエフォート
  // 送信とテスト等の明示呼び出しが競合しても、await した呼び出しは必ず自前の 1 巡を行う）。
  #syncQueue = Promise.resolve();

  syncPending() {
    const run = this.#syncQueue.then(() => this.#syncNow());
    this.#syncQueue = run.catch(() => {}); // 失敗しても列は継続
    return run;
  }

  async #syncNow() {
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
    await this.#save();
    return { sent, remaining: this.data.pendingLinks.length, ...this.syncStatus() };
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

  // PG 接続・タイマーを閉じる（テストの後始末用。サーバー本番では呼ばない）
  async close() {
    this.stopAutoSync();
    PurchaseStore.#live.delete(this);
    try {
      await this.client.end();
    } catch {
      // すでに切れている場合は無視
    }
  }

  // 生成済みの全インスタンスを一括 close（node --test の after フックから使う）
  static async closeAll() {
    await Promise.allSettled([...PurchaseStore.#live].map((s) => s.close()));
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

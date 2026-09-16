// 一時スクリプト: 旧シードの氏名表記（requester・履歴 actor）をユーザーコードに一括置換する。
// v6 から申請者はユーザーマスタのコードで受けるが、v6 以前の seed は氏名で登録されていたため
// 既存 16 件のデータをコード側に寄せる。実行は一度だけ（冪等: コード以外に該当氏名がなければ何もしない）。
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// dotenv は依存に入っていないため .env を直接読む
const env = {};
try {
  for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
} catch { /* .env がなくても既定値で動く */ }

function toCode(actor) {
  if (!actor) return actor;
  if (/山田|Liu/.test(actor)) return 'u01';
  if (/鈴木/.test(actor)) return 'u02';
  if (/佐藤/.test(actor)) return 'u03';
  if (/Admin/.test(actor)) return 'u99';
  return actor;
}

(async () => {
  const client = new Client({
    host: env.PG_HOST || 'localhost',
    port: Number(env.PG_PORT || 5433),
    user: env.PG_USER || 'postgres',
    password: env.PG_PASSWORD,
    database: env.PG_DATABASE || 'purchase',
  });
  await client.connect();

  // purchases: requester + history JSONB 内の actor
  const purchases = (await client.query('SELECT id, requester, history FROM purchases')).rows;
  let pCount = 0;
  for (const row of purchases) {
    const req = toCode(row.requester);
    let changed = req !== row.requester;
    let history = row.history;
    if (Array.isArray(history)) {
      history = history.map((h) => {
        const a = toCode(h.actor);
        if (a !== h.actor) { changed = true; return { ...h, actor: a }; }
        return h;
      });
    }
    if (!changed) continue;
    await client.query('UPDATE purchases SET requester = $1, history = $2::jsonb WHERE id = $3', [req, JSON.stringify(history), row.id]);
    pCount += 1;
  }

  // change_history: actor（v6 以降の生成だが念のため）
  const ch = (await client.query('SELECT id, actor FROM change_history')).rows;
  let cCount = 0;
  for (const row of ch) {
    const a = toCode(row.actor);
    if (a !== row.actor) {
      await client.query('UPDATE change_history SET actor = $1 WHERE id = $2', [a, row.id]);
      cCount += 1;
    }
  }

  // journal_entries: posted_by（旧データは空だが念のため）
  const je = (await client.query("SELECT DISTINCT posted_by FROM journal_entries WHERE posted_by IS NOT NULL AND posted_by <> ''")).rows;
  for (const row of je) {
    const a = toCode(row.posted_by);
    if (a !== row.posted_by) {
      await client.query('UPDATE journal_entries SET posted_by = $1 WHERE posted_by = $2', [a, row.posted_by]);
    }
  }

  const rest = (await client.query("SELECT DISTINCT requester FROM purchases WHERE requester !~ '^u\\d+$'")).rows;
  console.log(`purchases updated: ${pCount}, change_history updated: ${cCount}`);
  console.log(`remaining non-code requesters: ${JSON.stringify(rest)}`);
  await client.end();
})().catch((err) => { console.error(err); process.exit(1); });

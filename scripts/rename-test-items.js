'use strict';
// 一時スクリプト: 英語テストデータの品目名を日本語に修正する（v6 言語統一）
// 使い方: node scripts/rename-test-items.js  → 実行後サーバーを再起動
// 接続情報は .env から読む（資格情報をソースに書かない）
const fs = require('fs');
const path = require('path');

for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] == null) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const { Client } = require('pg');

(async () => {
  const c = new Client({
    host: process.env.PG_HOST || 'localhost',
    port: Number(process.env.PG_PORT || 5433),
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE || 'purchase',
  });
  await c.connect();
  const updates = [
    ['PU-0014', '無線LANルータ'],
    ['PU-0015', 'ポータブル外部HDD'],
  ];
  for (const [id, item] of updates) {
    const r = await c.query('UPDATE purchases SET item = $1 WHERE id = $2', [item, id]);
    console.log(`${id}: ${r.rowCount} row updated -> ${item}`);
  }
  await c.end();
})().catch((e) => { console.error('ERR:', e.message); process.exit(1); });

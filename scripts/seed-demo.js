'use strict';
// デモデータ投入スクリプト（稼働中のサーバーの API 経由で投入）
// 使い方: ① 本アプリを起動（npm start / start.bat・port 3010） ② node scripts/seed-demo.js
// 仕訳は内蔵会計エンジンが自動計上するため、外部 API は不要
const base = process.env.PK_URL || 'http://localhost:3010';

async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

const DEMO = [
  { item: '文具セット（コピー用紙・インク他）', qty: 1, unitPrice: 9800, requester: 'u01', department: 'D90', note: '四半期ごとのまとめ買い', stage: 'submitted' },
  { item: 'ノートPC 15台', qty: 15, unitPrice: 98000, requester: 'u01', department: 'D20', note: '新入社員用', stage: 'approved' },
  { item: 'オフィスチェア', qty: 6, unitPrice: 35000, requester: 'u03', department: 'D90', note: '会議室リニューアル', stage: 'ordered', receives: [[2, '2026-09-05']] },
  { item: 'ホワイトボード', qty: 3, unitPrice: 12000, requester: 'u02', department: 'D10', stage: 'received', receives: [[3, '2026-09-08']] },
  { item: 'セキュリティソフト更新ライセンス', qty: 1, unitPrice: 80000, requester: 'u03', department: 'D20', stage: 'paid', receives: [[1, '2026-08-20']] },
  { item: '高級モニタ 4K 32インチ', qty: 1, unitPrice: 180000, requester: 'u01', department: 'D20', note: '設計作業用', stage: 'rejected', rejectComment: 'コスト見直しをお願いします' },
  { item: 'タブレット', qty: 3, unitPrice: 45000, requester: 'u02', department: 'D10', note: '店舗棚班用', stage: 'ordered', receives: [[1, '2026-09-09']] },
  { item: 'マウス・キーボードセット', qty: 10, unitPrice: 3500, requester: 'u03', department: 'D90', stage: 'ordered', receives: [[6, '2026-09-09']] },
  { item: 'コピー用紙 A4 50箱', qty: 1, unitPrice: 15000, requester: 'u01', department: 'D90', stage: 'submitted' },
  { item: '会議テーブル', qty: 2, unitPrice: 65000, requester: 'u02', department: 'D10', note: '面談室増設', stage: 'received', receives: [[2, '2026-09-01']] },
  { item: '名刺用紙', qty: 500, unitPrice: 80, requester: 'u01', department: 'D90', stage: 'paid', receives: [[500, '2026-08-25']] },
  { item: 'ロック付き書庫', qty: 3, unitPrice: 28000, requester: 'u03', department: 'D90', stage: 'submitted' },
];

const APPROVED_STAGES = ['approved', 'ordered', 'received', 'paid'];

async function seedOne(d) {
  const p = await post('/api/purchases', {
    item: d.item, qty: d.qty, unitPrice: d.unitPrice, requester: d.requester, department: d.department, note: d.note || '',
  });

  if (d.stage === 'rejected') {
    await post(`/api/purchases/${p.id}/reject`, { actor: 'u02', comment: d.rejectComment || '見送り' });
    return p.id;
  }

  if (d.stage === 'submitted') return p.id;

  if (APPROVED_STAGES.includes(d.stage)) {
    await post(`/api/purchases/${p.id}/approve`, { actor: 'u02', comment: '承認します' });
    if (d.stage === 'approved') return p.id;

    await post(`/api/purchases/${p.id}/order`, { actor: 'u03' });
    for (const [qty, date] of d.receives || []) {
      await post(`/api/purchases/${p.id}/receive`, { actor: 'u03', receivedQty: qty, receivedAt: date });
    }
    if (d.stage === 'ordered') return p.id;

    // received までは全量検収が必要（receives が足りなければ残を一括で）
    const now = await (await fetch(`${base}/api/purchases/${p.id}`)).json();
    if (now.status !== 'received') {
      await post(`/api/purchases/${p.id}/receive`, {
        actor: 'u03',
        receivedQty: d.qty - now.receivedTotal,
        receivedAt: '2026-09-09',
      });
    }
    if (d.stage === 'received') return p.id;

    if (d.stage === 'paid') {
      const payables = await (await fetch(`${base}/api/payables?status=scheduled`)).json();
      for (const x of payables.filter((x) => x.purchaseId === p.id)) {
        await post(`/api/payables/${x.id}/pay`, { actor: 'u03' });
      }
    }
    return p.id;
  }
  throw new Error(`unknown stage: ${d.stage}`);
}

async function main() {
  const created = [];
  for (const d of DEMO) created.push(await seedOne(d));
  console.log(`デモデータを ${created.length} 件投入しました: ${created.join(', ')}`);
  console.log('（仕訳は内蔵会計エンジンに 9 件計上されています。「会計」ビューで試算表・元帳を確認できます）');
}

main().catch((err) => {
  console.error('投入に失敗しました:', err.message);
  console.error('本アプリ (port 3010) が起動しているか確認してください');
  process.exit(1);
});

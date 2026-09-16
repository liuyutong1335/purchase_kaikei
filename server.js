'use strict';
// CMP-PURCHASEKAIKEI-001: Express サーバー — 静的配信 + REST API + 遷移ガード + 内蔵会計エンジン
// v5: store が非同期（PostgreSQL）になったため全ハンドラを async 化。API 契約は v4 までと不変。
const path = require('path');
const express = require('express');
const { PurchaseStore, TransitionError, ValidationError, SelfApprovalError } = require('./store/purchase-store');
const { KanriClient } = require('./store/kanri-client');

function createApp(store, kanri) {
  const app = express();
  app.use(express.json());
  // 開発時の更新を即反映させたいので、静的ファイルは常に再検証させる
  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));

  const kanriClient = kanri || new KanriClient();

  const handleError = (err, res) => {
    if (res.headersSent) return;
    if (err instanceof TransitionError) return res.status(409).json({ error: err.code, message: err.message });
    if (err instanceof SelfApprovalError) return res.status(403).json({ error: err.code, message: err.message });
    if (err instanceof ValidationError) return res.status(400).json({ error: err.code, message: err.message });
    if (err.code === 'not_found') return res.status(404).json({ error: err.message });
    if (err.code === 'kaikei_unavailable' || err.code === 'kanri_unavailable' || err.code === 'kanri_source_error') {
      return res.status(502).json({ error: err.code, message: err.message });
    }
    // 最後の安全網: 未分類エラーでも 500 を返してプロセスを生かす（Express 4 は async の
    // 例外を uncaught で落とすため、ここで再 throw しない）
    console.error('unhandled error:', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  };

  // CT-API-PURCHASEKAIKEI-001: 申請登録（部門付き）
  app.post('/api/purchases', async (req, res) => {
    try {
      res.status(201).json(await store.create(req.body || {}));
    } catch (err) {
      handleError(err, res);
    }
  });

  // CT-API-PURCHASEKAIKEI-001: 一覧（v6 ステップ 6: 複合検索）
  app.get('/api/purchases', (req, res) => {
    res.json(store.listPurchases({
      q: req.query.q,
      requester: req.query.requester,
      department: req.query.department,
      vendor: req.query.vendor,
      item: req.query.item,
      status: req.query.status,
      requestedFrom: req.query.requestedFrom,
      requestedTo: req.query.requestedTo,
      orderFrom: req.query.orderFrom,
      orderTo: req.query.orderTo,
      receiveFrom: req.query.receiveFrom,
      receiveTo: req.query.receiveTo,
      scheduledFrom: req.query.scheduledFrom,
      scheduledTo: req.query.scheduledTo,
    }));
  });

  // v6 ステップ 1: ユーザーマスタ（操作者切替用）
  app.get('/api/users', (req, res) => {
    res.json(store.listUsers());
  });

  // v6 ステップ 8: 仕入先・品目マスタ（一覧 + 追加）
  app.get('/api/vendors', (req, res) => {
    res.json(store.listVendors());
  });

  app.post('/api/vendors', async (req, res) => {
    try {
      res.status(201).json(await store.addVendor(req.body || {}));
    } catch (err) {
      handleError(err, res);
    }
  });

  app.get('/api/items', (req, res) => {
    res.json(store.listItems());
  });

  app.post('/api/items', async (req, res) => {
    try {
      res.status(201).json(await store.addItem(req.body || {}));
    } catch (err) {
      handleError(err, res);
    }
  });

  // CT-API-PURCHASEKAIKEI-001: 詳細（履歴・仕訳参照含む）
  app.get('/api/purchases/:id', (req, res) => {
    try {
      res.json(store.get(req.params.id));
    } catch (err) {
      handleError(err, res);
    }
  });

  // CT-API-PURCHASEKAIKEI-002/003/004/005 + v6-003: approve / reject / resubmit / order / receive / withdraw / update
  const actions = {
    approve: (id, body) => store.approve(id, body.actor, body.comment),
    reject: (id, body) => store.reject(id, body.actor, body.comment),
    resubmit: (id, body) => store.resubmit(id, body.actor, body.comment),
    order: (id, body) => store.order(id, body.actor),
    receive: (id, body) => store.receive(id, body.actor, body.receivedQty, body.receivedAt, body.comment),
    withdraw: (id, body) => store.withdraw(id, body.actor),
    update: (id, body) => store.update(id, body.actor, body.updates, body.reason),
    'request-correction': (id, body) => store.requestCorrection(id, body.actor, body.updates, body.reason),
    'approve-correction': (id, body) => store.approveCorrection(id, body.actor),
  };

  for (const [action, run] of Object.entries(actions)) {
    app.post(`/api/purchases/:id/${action}`, async (req, res) => {
      try {
        res.json(await run(req.params.id, req.body || {}));
      } catch (err) {
        handleError(err, res);
      }
    });
  }

  // CT-API-PURCHASEKAIKEI-005: 支払予定一覧 / 支払実行（仕訳計上を伴う）
  app.get('/api/payables', (req, res) => {
    res.json(store.listPayables(req.query.status));
  });

  app.post('/api/payables/:id/pay', async (req, res) => {
    try {
      res.json(await store.pay(req.params.id, (req.body || {}).actor, (req.body || {}).comment));
    } catch (err) {
      handleError(err, res);
    }
  });

  // CT-API-PURCHASEKAIKEI-006: 会計レポート（内蔵エンジンが仕訳台帳から計算・外部依存なし）
  app.get('/api/accounting/accounts', (req, res) => {
    res.json({ accounts: store.journal.getAccounts() });
  });

  app.get('/api/accounting/trial-balance', (req, res) => {
    try {
      res.json(store.journal.trialBalance({ from: req.query.from, to: req.query.to, department: req.query.department }));
    } catch (err) {
      handleError(err, res);
    }
  });

  app.get('/api/accounting/ledger/:code', (req, res) => {
    try {
      res.json(store.journal.ledger(req.params.code, { from: req.query.from, to: req.query.to }));
    } catch (err) {
      handleError(err, res);
    }
  });

  // v6 ステップ 4: 仕訳一覧（複合検索）/ 仕訳詳細（元申請・変更履歴への逆リンク付き）
  app.get('/api/accounting/entries', (req, res) => {
    res.json(store.listEntries({
      from: req.query.from,
      to: req.query.to,
      account: req.query.account,
      department: req.query.department,
      q: req.query.q,
      state: req.query.state,
    }));
  });

  app.get('/api/accounting/entries/:id', (req, res) => {
    try {
      res.json(store.getEntry(Number(req.params.id)));
    } catch (err) {
      handleError(err, res);
    }
  });

  // CT-API-PURCHASEKAIKEI-007: kaikei-api ミラー連携（v3・Outbox）
  app.get('/api/accounting/sync', (req, res) => {
    res.json(store.syncStatus());
  });

  app.post('/api/accounting/sync', async (req, res) => {
    try {
      res.json(await store.syncPending());
    } catch (err) {
      handleError(err, res);
    }
  });

  // 管理会計 DWH（kanri-dwh）連携 — プロキシのみ（購買操作には無関係・障害時は 502）
  const KPI_NAMES = ['reconcile', 'pl-by-department', 'sales-by-month', 'expense-by-account', 'cash-trend'];

  app.get('/api/management/kpi/:name', async (req, res) => {
    if (!KPI_NAMES.includes(req.params.name)) {
      return res.status(404).json({ error: 'not_found', message: `unknown kpi: ${req.params.name}` });
    }
    try {
      const { from, to, department } = req.query;
      res.json(await kanriClient.kpi(req.params.name, { from, to, department }));
    } catch (err) {
      handleError(err, res);
    }
  });

  app.post('/api/management/etl', async (req, res) => {
    try {
      res.json(await kanriClient.runEtl());
    } catch (err) {
      handleError(err, res);
    }
  });

  return app;
}

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const port = process.env.PORT || 3010;
  (async () => {
    const store = await PurchaseStore.create(dataDir);
    store.startAutoSync(); // Outbox 自動再送（30 秒間隔・起動直後にも 1 回）
    createApp(store).listen(port, () => {
      console.log(`購買会計システム: http://localhost:${port}（会計エンジン内蔵・PostgreSQL: ${process.env.PG_DATABASE || 'purchase'}）`);
      if (process.env.NO_OPEN !== '1') {
        const { exec } = require('node:child_process');
        exec(`start "" http://localhost:${port}`, { shell: 'cmd.exe' }, () => {});
      }
    });
  })().catch((err) => {
    console.error('[ERROR] 起動に失敗しました（PostgreSQL の接続情報を .env で確認してください）:', err.message);
    process.exit(1);
  });
}

module.exports = { createApp, PurchaseStore };

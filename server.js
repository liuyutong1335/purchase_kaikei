'use strict';
// CMP-PURCHASEKAIKEI-001: Express サーバー — 静的配信 + REST API + 遷移ガード + 内蔵会計エンジン
const path = require('path');
const express = require('express');
const { PurchaseStore, TransitionError, ValidationError } = require('./store/purchase-store');

function createApp(store) {
  const app = express();
  app.use(express.json());
  // 開発時の更新を即反映させたいので、静的ファイルは常に再検証させる
  app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));

  const handleError = (err, res) => {
    if (res.headersSent) return;
    if (err instanceof TransitionError) return res.status(409).json({ error: err.code, message: err.message });
    if (err instanceof ValidationError) return res.status(400).json({ error: err.code, message: err.message });
    if (err.code === 'not_found') return res.status(404).json({ error: err.message });
    // 最後の安全網: 未分類エラーでも 500 を返してプロセスを生かす（Express 4 は async の
    // 例外を uncaught で落とすため、ここで再 throw しない）
    console.error('unhandled error:', err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  };

  // CT-API-PURCHASEKAIKEI-001: 申請登録（部門付き）
  app.post('/api/purchases', (req, res) => {
    try {
      res.status(201).json(store.create(req.body || {}));
    } catch (err) {
      handleError(err, res);
    }
  });

  // CT-API-PURCHASEKAIKEI-001: 一覧（状態フィルタ可）
  app.get('/api/purchases', (req, res) => {
    res.json(store.list(req.query.status));
  });

  // CT-API-PURCHASEKAIKEI-001: 詳細（履歴・仕訳参照含む）
  app.get('/api/purchases/:id', (req, res) => {
    try {
      res.json(store.get(req.params.id));
    } catch (err) {
      handleError(err, res);
    }
  });

  // CT-API-PURCHASEKAIKEI-002/003/004/005: approve / reject / resubmit / order / receive
  const actions = {
    approve: (id, body) => store.approve(id, body.actor, body.comment),
    reject: (id, body) => store.reject(id, body.actor, body.comment),
    resubmit: (id, body) => store.resubmit(id, body.actor, body.comment),
    order: (id, body) => store.order(id, body.actor),
    receive: (id, body) => store.receive(id, body.actor, body.receivedQty, body.receivedAt, body.comment),
  };

  for (const [action, run] of Object.entries(actions)) {
    app.post(`/api/purchases/:id/${action}`, (req, res) => {
      try {
        res.json(run(req.params.id, req.body || {}));
      } catch (err) {
        handleError(err, res);
      }
    });
  }

  // CT-API-PURCHASEKAIKEI-005: 支払予定一覧 / 支払実行（仕訳計上を伴う）
  app.get('/api/payables', (req, res) => {
    res.json(store.listPayables(req.query.status));
  });

  app.post('/api/payables/:id/pay', (req, res) => {
    try {
      res.json(store.pay(req.params.id, (req.body || {}).actor, (req.body || {}).comment));
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

  return app;
}

if (require.main === module) {
  const dataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  const store = new PurchaseStore(dataDir);
  const port = process.env.PORT || 3010;
  createApp(store).listen(port, () => {
    console.log(`購買会計システム: http://localhost:${port}（会計エンジン内蔵・単体で完結）`);
    if (process.env.NO_OPEN !== '1') {
      const { exec } = require('node:child_process');
      exec(`start "" http://localhost:${port}`, { shell: 'cmd.exe' }, () => {});
    }
  });
}

module.exports = { createApp, PurchaseStore };

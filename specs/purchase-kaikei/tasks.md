---
artifact: tasks
template_id: TPL-TASKS-001
feature_id: FEAT-PURCHASEKAIKEI
feature_name: "purchase-kaikei"
---

# Tasks: purchase-kaikei

## Work Items

### WI-PURCHASEKAIKEI-001: プロジェクト雛形と購買ドメイン層
- mode: confirm
- complexity: medium
- risk_flags: []
- spec_refs: [AC-US-PURCHASEKAIKEI-001-01, AC-US-PURCHASEKAIKEI-002-01, AC-US-PURCHASEKAIKEI-004-01]
- plan_refs: [LIB-PURCHASEKAIKEI-001, CMP-PURCHASEKAIKEI-002]
- est_lines: 280
- est_files: 2
- description: purchase-management v3 の store を継承し、部門（department）検証と journal（仕訳参照）保持を追加。package.json / server.js 雛形

### WI-PURCHASEKAIKEI-002: 内蔵会計エンジン（v2 で kaikei-api クライアントから置換）
- mode: confirm
- complexity: medium
- risk_flags: []
- spec_refs: [AC-US-PURCHASEKAIKEI-004-03, AC-US-PURCHASEKAIKEI-005-03, AC-US-PURCHASEKAIKEI-006-01, AC-US-PURCHASEKAIKEI-006-02]
- plan_refs: [CMP-PURCHASEKAIKEI-005]
- est_lines: 130
- est_files: 1
- description: store/journal.js — 仕訳計上（貸借一致チェック・採番）・科目/部門マスタ（11 科目・3 部門）・残高試算表計算（全科目・残高 0 含む）・総勘定元帳計算（日付順・残高繰越）

### WI-PURCHASEKAIKEI-003: 購買フロー API + 仕訳自動計上の統合
- mode: confirm
- complexity: medium
- risk_flags: []
- spec_refs: [AC-US-PURCHASEKAIKEI-004-03, AC-US-PURCHASEKAIKEI-005-03, NFR-PURCHASEKAIKEI-001-03]
- plan_refs: [CT-API-PURCHASEKAIKEI-001〜005, CMP-PURCHASEKAIKEI-001]
- est_lines: 120
- est_files: 1
- description: receive / pay で journal エンジンを呼び出して仕訳を計上し、entry id を purchase.journal / payable.entryId に記録。購買データと同じ JSON に同時永続化（常に整合）

### WI-PURCHASEKAIKEI-004: 会計レポート API（内蔵エンジン）
- mode: confirm
- complexity: low
- risk_flags: []
- spec_refs: [AC-US-PURCHASEKAIKEI-006-01, AC-US-PURCHASEKAIKEI-006-02]
- plan_refs: [CT-API-PURCHASEKAIKEI-006, CMP-PURCHASEKAIKEI-005]
- est_lines: 40
- est_files: 1
- description: GET /api/accounting/accounts / trial-balance / ledger/:code（仕訳台帳から都度計算・外部依存なし）

### WI-PURCHASEKAIKEI-005: フロントエンド UI
- mode: confirm
- complexity: medium
- risk_flags: []
- spec_refs: [AC-US-PURCHASEKAIKEI-001-02, AC-US-PURCHASEKAIKEI-004-03, AC-US-PURCHASEKAIKEI-006-01, AC-US-PURCHASEKAIKEI-006-02]
- plan_refs: [CMP-PURCHASEKAIKEI-004]
- est_lines: 420
- est_files: 3
- description: purchase-management の UI を継承 + 申請フォームに部門選択 + 会計ビュー（試算表・科目別元帳）+ 履歴に仕訳 entry id 表示

### WI-PURCHASEKAIKEI-006: テスト
- mode: confirm
- complexity: medium
- risk_flags: []
- spec_refs: [AC-US-PURCHASEKAIKEI-004-03, AC-US-PURCHASEKAIKEI-005-03, AC-US-PURCHASEKAIKEI-006-01]
- plan_refs: [TS-UNIT-PURCHASEKAIKEI-001, TS-UNIT-PURCHASEKAIKEI-002]
- est_lines: 280
- est_files: 2
- description: node --test。unit（遷移ガード + 会計エンジン）+ integration（API 正経路・409 準経路・会計 API）+ E2E ジャーニー

### WI-PURCHASEKAIKEI-007: SQLite 永続化への移行（v4・2026-09-11 追溯登録）
- mode: confirm
- complexity: medium
- risk_flags: []
- spec_refs: [NFR-PURCHASEKAIKEI-001-02]
- plan_refs: [CMP-PURCHASEKAIKEI-007]
- est_lines: 180
- est_files: 1
- description: store/purchase-store.js — node:sqlite（依存追加なし）で 7 テーブル構成に移行。購買・支払予定・仕訳・Outbox キューを同一トランザクションで書き込み、旧 purchases.json は初回起動時に自動取り込み。実装済み（commit d7b1bcc・テスト 25/25）

### WI-PURCHASEKAIKEI-008: 未同期キューの自動再送タイマー（v4・2026-09-11 追溯登録）
- mode: confirm
- complexity: low
- risk_flags: []
- spec_refs: [AC-US-PURCHASEKAIKEI-007-02]
- plan_refs: [CT-API-PURCHASEKAIKEI-007, CMP-PURCHASEKAIKEI-002]
- est_lines: 30
- est_files: 2
- description: startAutoSync() — 30 秒間隔・起動直後 1 回の自動再送（unref でプロセス終了を妨げない）。テスト 1 件追加。実装済み（commit de3e1ad）

### WI-PURCHASEKAIKEI-009: 管理会計（kanri-dwh）連携 + 経営ダッシュボード（v4・2026-09-11 追溯登録）
- mode: confirm
- complexity: medium
- risk_flags: [external-dependency]
- spec_refs: [AC-US-PURCHASEKAIKEI-008-01, AC-US-PURCHASEKAIKEI-008-02]
- plan_refs: [CT-API-PURCHASEKAIKEI-008, CMP-PURCHASEKAIKEI-006]
- est_lines: 380
- est_files: 7
- description: store/kanri-client.js 新設 + /api/management/* プロキシ（whitelist・502 縮退）+ 経営ダッシュボード view（突合状態・部門別損益・月別売上・科目別費用・資金推移・ETL ボタン）。対向の kanri-dwh に POST /api/etl を新設（Kaikei-API-Kanri-DWH リポジトリ・commit 139444a）。実装済み（commit 0914da3・テスト 28/28・実機 3 システム E2E 済）

## Outer loop (post-task verification)

1. `stride_lint` 実行 → errors=0 まで自動修正 (max 5 iter)
2. test 実行 (unit / integration / e2e)
3. `stride_drift_detect` で SSoT 整合確認
4. `stride_evidence_collect` で Evidence Pack 充足確認
5. `stride_pr_check` で PR_READY 判定

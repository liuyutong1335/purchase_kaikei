# v4 実装詳細 — SQLite 永続化・kanri-dwh 連携・経営ダッシュボード（2026-09-11）

## 概要

v4 の変更は 2026-09-11 のセッションで SDD フローに先立って実装され、同日のユーザー指示
（「按照正规流程走一遍」）により STRIDE 正規フローで追溯承認する運びとなった。
本ドキュメントは実装の証跡をまとめる。

## 変更内容と commit（feature/kaikei-linkage ブランチ）

| commit | 内容 |
|---|---|
| d7b1bcc | 永続化を JSON から SQLite（node:sqlite・依存追加なし）に変更。7 テーブル・同一トランザクション・旧 purchases.json 自動取り込み。テスト 25/25 |
| de3e1ad | Outbox キューの自動再送タイマー（startAutoSync・30 秒間隔 + 起動直後 1 回）。テスト 26/26 |
| 8ea17a3 / b604b76 / f4cd4ad / 255a62b | UI 簡約刷新（深紺 × 金アクセント。トーナルバッジ・フラット化） |
| 0914da3 | 経営ダッシュボード（kanri-dwh 連携）: store/kanri-client.js 新設・/api/management/* プロキシ・6 ビュー化。テスト 28/28 |
| 2c1d561 | spec v4 / basic_design v3 の追溯更新 |

対向システム（Kaikei-API-Kanri-DWH リポジトリ・feature/kanri-dwh ブランチ）:
- commit 139444a: kanri-dwh に POST /api/etl を追加（CLI と同じ etl.run 経路・冪等・502 縮退）。テスト 12/12

## 検証の証跡

1. **自動テスト**: node --test 28/28 pass（test-evidence-2026-09-11-v4.txt に生出力を保存）。
   ※ stride_test_run は node:test のサマリ形式（ℹ 行）を認識しない（対応 framework は
   vitest / pytest / jest のみ）ため parse は不可だった — 工具制限の正直な記録。
2. **実機 3 システム E2E**（2026-09-11）: kaikei-api(:8000) + kanri-dwh(:8100) +
   purchase-kaikei(:3012) を起動し、ETL ボタンの API（POST /api/management/etl）経由で
   31 仕訳・63 明細を DuckDB に取込。突合 matched=true（借貸各 10,303,000）、
   部門別損益（D10 +384,000 / D20 +941,000 / D90 -136,000）を画面で確認（スクリーンショット済み）。
3. **MCP 検証**: 動作 tier engine-real（method 7.8.0-tecnos-stride / skew none /
   Gate verdict full）。
   - stride_validate_artifact: spec ✅ / basic_design ✅（format-only valid）
   - stride_lint: payload 全体（約 24KB）は CloudFront 403（前回 2026-09-10 と同じ既知制限）。
     対策として 2 分割（spec+basic_design / plan+tasks）で実行し、いずれも
     CANONICAL_BLOCK エラーなし（未投入成果物の MISSING_FILE のみ = 分割のため期待値）。
   - stride_generate_traceability: AC×Task の紐付けを確認（spec_refs 経由）。
     AC×Test の自動紐付けは tests/scenarios.yaml の読み込みが工具制約で不可 — 
     対応は basic_design.md の traceability_rows（手動マトリクス）で担保。

## 留痕（この日の記録）

- intake: basic_design_intake.md（questionnaire にセッション確定事項を記入）
- 成果物: spec.md v4 / basic_design.md v3 / plan.md v3 / tasks.md（WI-007〜009 追加）
- 承認: APPROVAL.md に v4 Final Gate 追記（HUMAN-ONLY・ユーザー本人が編集）
- セッションログ: products/session-logs/2026-09-11-purchase-kaikei.md

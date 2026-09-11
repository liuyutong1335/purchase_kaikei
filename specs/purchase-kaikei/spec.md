---
artifact: spec
template_id: TPL-SPEC-001
feature_id: FEAT-PURCHASEKAIKEI
feature_name: "purchase-kaikei"
version: 5
---

# 0. Canonical Spec (YAML SSoT)

```yaml
spec:
  id: SPEC-PURCHASEKAIKEI-001
  feature_id: FEAT-PURCHASEKAIKEI
  version: 5
  acceptance_criteria:
    - id: AC-US-PURCHASEKAIKEI-001-01
      description: 必須項目（品目・数量・単価・申請者）を入力して登録すると、状態=submitted の申請が一覧に表示される
      tags: [must]
    - id: AC-US-PURCHASEKAIKEI-001-02
      description: 申請には部門（D10/D20/D90、既定 D90）が付き、部門は仕訳の department に引き継がれる
      tags: [must]
    - id: AC-US-PURCHASEKAIKEI-002-01
      description: submitted の申請を承認すると状態=approved になり（1 段承認・金額に関係なく）、承認者・日時が履歴に記録される
      tags: [must]
    - id: AC-US-PURCHASEKAIKEI-002-02
      description: submitted の申請を却下すると状態=rejected になり、却下理由（コメント必須）が履歴に記録される
      tags: [must]
    - id: AC-US-PURCHASEKAIKEI-002-03
      description: rejected の申請は同一申請書で再申請でき、状態=submitted に戻る。過去の履歴は保持される
      tags: [must]
    - id: AC-US-PURCHASEKAIKEI-003-01
      description: approved の申請のみ発注を実行でき、状態=ordered になり発注番号 PO-YYYY-NNN が採番される。他状態への発注は拒否される
      tags: [must]
    - id: AC-US-PURCHASEKAIKEI-004-01
      description: ordered の申請には検収を複数回に分けて登録でき（分割検収）、残数量を超える検収は拒否される
      tags: [must]
    - id: AC-US-PURCHASEKAIKEI-004-02
      description: 申請数量の全量検収が完了すると状態=received になる
      tags: [must]
    - id: AC-US-PURCHASEKAIKEI-004-03
      description: 検収 1 回ごとに仕訳（借方 仕入高 5110 / 貸方 買掛金 2110、金額 = 検収数量 × 単価、department = 申請の部門）が 1 件自動計上され、entry id が購買記録（journal）に保存される
      tags: [must]
    - id: AC-US-PURCHASEKAIKEI-005-01
      description: 検収ごとに支払予定（金額 = 検収数量 × 単価、支払予定日 = 検収月の翌月末日）が作成され、状態=scheduled で一覧に表示される
      tags: [must]
    - id: AC-US-PURCHASEKAIKEI-005-02
      description: 支払予定単位で scheduled → paid にできる。scheduled 以外の支払予定は支払済みにできない
      tags: [must]
    - id: AC-US-PURCHASEKAIKEI-005-03
      description: 支払実行時に仕訳（借方 買掛金 2110 / 貸方 普通預金 1120、金額 = 支払額、department = 申請の部門）が 1 件自動計上され、entry id が支払予定に保存される
      tags: [must]
    - id: AC-US-PURCHASEKAIKEI-006-01
      description: 会計画面から残高試算表を照会でき、内蔵会計エンジンの計算結果（11 科目すべて・残高 0 科目を含む）が貸借一致で表示される
      tags: [must]
    - id: AC-US-PURCHASEKAIKEI-006-02
      description: 会計画面から科目を選んで総勘定元帳を照会でき、日付昇順・残高列（繰越含む）付きで表示される
      tags: [must]
    - id: AC-US-PURCHASEKAIKEI-007-01
      description: 検収・支払で計上した各仕訳は、kaikei-api（port 8000）が稼働している場合に自動でミラー送信され（Outbox 方式）、向こう側の entry id（kaikeiEntryId）が記録される。kaikei-api が無くても購買操作・会計機能は一切止まらない
      tags: [must]
    - id: AC-US-PURCHASEKAIKEI-007-02
      description: 送信失敗の仕訳は未同期キューに保持され、会計画面で件数と直近エラーが見え、再送信ボタン（POST /api/accounting/sync）で取り込める。kaikei-api 復帰後は自動再送タイマー（30 秒間隔・起動直後にも 1 回）と次の検収・支払で自動的に再送される
      tags: [must]
    - id: AC-US-PURCHASEKAIKEI-008-01
      description: 経営ダッシュボード画面で kanri-dwh（管理会計 DWH・port 8100）の突合状態と 4 KPI（部門別損益・月別売上・科目別費用・資金推移）を照会できる。kanri-dwh が稼働していない場合はその旨が表示され、購買操作・会計機能には一切影響しない
      tags: [must]
    - id: AC-US-PURCHASEKAIKEI-008-02
      description: 「DWH に取込（ETL）」ボタンで kanri-dwh の取込（POST /api/etl・CLI と同じ経路・冪等）を起動でき、kaikei-api にミラー済みの仕訳が分析 DWH に反映されて KPI に現れる
      tags: [must]
    - id: AC-US-PURCHASEKAIKEI-009-01
      description: 3 システムの全データが 1 台の PostgreSQL サーバ上の 3 つのデータベース（purchase / kaikei / kanri）に保存され、psql 等の標準ツールで直接照会できる。テーブル構造・API 応答・画面表示は v4 までと同一
      tags: [must]
    - id: AC-US-PURCHASEKAIKEI-009-02
      description: 一次移行スクリプト（scripts/migrate-to-pg.js）で旧 SQLite（purchase-kaikei.db）および DuckDB（kanri.duckdb）の既存データが PostgreSQL に移行され、移行後に突合が一致する
      tags: [must]
  non_functional:
    - id: NFR-PURCHASEKAIKEI-001-01
      type: performance
      target: 全 API の応答がローカル実行で 500ms 以内（デモ規模 < 1000 件）
    - id: NFR-PURCHASEKAIKEI-001-02
      type: persistence
      target: サーバー再起後も購買データ・支払予定・仕訳台帳（entry id 含む）が保持される（v5 で PostgreSQL 永続化 — 1 サーバ 3 データベース構成。v4 で SQLite 化、v3 まで JSON）
    - id: NFR-PURCHASEKAIKEI-001-03
      type: auditability
      target: 全状態遷移・検収・支払・仕訳計上（entry id 付き）が履歴として保存・照会できる
    - id: NFR-PURCHASEKAIKEI-001-04
      type: resilience
      target: kaikei-api 連携（v3・ミラー送信）が失敗しても購買・会計機能は完全に動作し、未同期仕訳は再送できる。単体でも Node.js だけで完結して動く
    - id: NFR-PURCHASEKAIKEI-001-05
      type: security
      target: DB 接続情報（パスワード等）は環境変数・.env で管理し、リポジトリにコミットしない（.gitignore で保証）
```

# 1. Human-readable section

## 状態遷移モデル

```
submitted ──承認(1段)──▶ approved ──発注──▶ ordered ──分割検収(随時)──▶ received(全量検収済)
    │                                                              │
    └─却下──▶ rejected ──再申請──▶ submitted（履歴は保持）          ├ 検収ごとに支払予定(payable)計上
                （payable: scheduled ──支払──▶ paid）               └ 検収・支払ごとに仕訳を自動計上（内蔵エンジン）
```

- 購買側の状態遷移は purchase-management v3（1 段承認・分割検収・月末締め翌月末払い）を引き継ぐ。
- 追加: 申請に**部門**を持つ（D10/D20/D90、既定 D90）。
- **v2 変更**: 会計機能を内蔵エンジン（仕訳台帳を保持し、試算表・総勘定元帳をその場で計算）に置換。検収・支払は常に即座に計上される。
- **v3 変更（本ブランチ feature/kaikei-linkage）**: kaikei-api への連携を **Outbox 方式（ミラー送信）** で再設計。内蔵エンジンが正本のまま、kaikei-api が稼働していれば仕訳を自動ミラー、失敗時は未同期キューで保持・再送。**連携失敗が購買操作を妨げることは v1 のような二度とない**。
- **v4 変更（2026-09-11・SDD 外での実装を追溯して本書に反映）**:
  - 永続化を JSON から **SQLite（node:sqlite・依存追加なし）** に移行。purchases / payables / journal_entries + journal_lines / pending_links（Outbox）/ counters / meta の 7 テーブルを同一トランザクションで書き込み、常に整合。旧 purchases.json は初回起動時に自動取り込み。
  - 未同期キューに**自動再送タイマー**（30 秒間隔・起動直後 1 回）を追加。
  - **kanri-dwh 連携（管理会計）を In-scope に変更**（ユーザー指示）: 経営ダッシュボード view で突合状態・部門別損益・月別売上・科目別費用・資金推移を照会。3 システムチェーン: purchase-kaikei →(ミラー)→ kaikei-api →(ETL)→ kanri-dwh →(KPI)→ purchase-kaikei。
  - UI を簡約デザイン（深紺 × 金アクセント）に刷新。
- **v5 変更（2026-09-11・ユーザー決定 4 項目）**: データ基盤を **PostgreSQL に統一**。
  - 1 台の PostgreSQL サーバ + 3 データベース（purchase / kaikei / kanri）— エンジン統一、システム境界と突合の意義は維持
  - DuckDB は退役（星型スキーマは Postgres のテーブル + ビューで再現）。SQLite（node:sqlite）も退役（Node 側は pg ドライバ追加・ユーザー承認済み）
  - 既存データは一次移行スクリプトで搬送。接続情報は環境変数管理（NFR-001-05 新設）

## 仕訳の対応表（内蔵会計エンジンが計上）

| 状態遷移 | 借方 | 貸方 | 金額 | department | description |
|---|---|---|---|---|---|
| 検収（数量 q・単価 p） | 5110 仕入高 | 2110 買掛金 | q × p | 申請の部門 | `購買検収 PU-XXXX（品目）` |
| 支払実行（支払予定） | 2110 買掛金 | 1120 普通預金 | 支払額 | 申請の部門 | `購買支払 PU-XXXX / PAY-XXXX` |

- 科目マスタは 11 科目（1110 現金 … 5410 広告宣伝費）・部門は D10/D20/D90。仕訳は借方合計 = 貸方合計で必ず貸借一致。

## Acceptance Criteria

| ID | Given | When | Then |
|---|---|---|---|
| AC-001-01 | 必須項目が入力されたフォーム | 登録を押す | 状態=submitted で一覧に表示される |
| AC-001-02 | 部門未選択のフォーム | 登録を押す | D90 で登録される（選択は D10/D20/D90 のみ） |
| AC-002-01 | submitted の申請 | 承認を実行 | 状態=approved、履歴に承認者・日時が記録される |
| AC-002-02 | submitted の申請 | コメント必須で却下 | 状態=rejected、履歴に却下理由が記録される |
| AC-002-03 | rejected の申請 | 再申請を実行 | 状態=submitted に戻り、過去の履歴が保持される |
| AC-003-01 | approved の申請 | 発注を実行 | 状態=ordered、発注番号採番（他状態は 409） |
| AC-004-01 | ordered の申請（数量 10） | 4個 → 6個 と分割検収 | 各検収で支払予定 1 件計上。11個目は拒否 |
| AC-004-02 | ordered の申請 | 全数量の検収完了 | 状態=received |
| AC-004-03 | ordered の申請 | 検収（数量 q） | 仕訳 1 件（借 5110 / 貸 2110）が自動計上され entry id を記録 |
| AC-005-01 | 検収（数量 q、検収日 d） | 支払予定一覧照会 | 金額 q×単価、支払予定日=d の翌月末日の予定が scheduled で表示される |
| AC-005-02 | scheduled の支払予定 | 支払済みをマーク | 状態=paid（他状態は 409） |
| AC-005-03 | scheduled の支払予定 | 支払実行 | 仕訳 1 件（借 2110 / 貸 1120）が自動計上され entry id を記録 |
| AC-006-01 | 仕訳が 1 件以上ある | 会計画面で試算表照会 | 11 科目すべて（残高 0 含む）が表示され、借方合計 = 貸方合計が保たれる |
| AC-006-02 | 仕訳が 1 件以上ある | 会計画面で科目選択 | 総勘定元帳（日付昇順・残高列）が表示される |
| AC-007-01 | kaikei-api 稼働中 | 検収・支払を実行 | 仕訳がミラー送信され kaikeiEntryId が記録される |
| AC-007-02 | kaikei-api 停止中に検収 | 復帰後（操作なし） | 自動再送タイマー（30 秒間隔）が未同期を送信する |
| AC-008-01 | kanri-dwh 稼働中 | 経営ダッシュボード照会 | 突合状態と 4 KPI（部門別損益・月別売上・科目別費用・資金推移）が表示される |
| AC-008-02 | ミラー済み仕訳がある | ETL ボタンを押す | 分析 DWH に取込まれ（冪等）KPI に反映される |
| AC-009-01 | PostgreSQL 稼働中 | 全機能を操作・psql で照会 | 全データが 1 サーバ 3 DB（purchase/kaikei/kanri）に保存され、表示・API 応答は v4 までと同一 |
| AC-009-02 | 旧 DB ファイルがある | 移行スクリプトを実行 | SQLite/DuckDB の既存データが PG に移行され、移行後に突合が一致する |

## Out-of-scope

- ~~管理会計（kanri-dwh）との連携~~ — **v4（2026-09-11）で In-scope に変更**（経営ダッシュボード・ETL 起動。ユーザー指示による）。kanri-dwh 側の KPI 集計ロジック自体は kanri-dwh リポジトリの責務で、本アプリはプロキシのみ
- 実金流連携・仕訳の取消（逆仕訳）UI
- 認証/権限制御（履歴のアクタは「担当」として記録）
- マルチテナント・デプロイ（ローカル実行のみ）

# 2. Spec drift watchdog

> AI agent: 本 spec を変更したら必ず plan.md / tasks.md / contracts/ を再 lint + drift_detect。

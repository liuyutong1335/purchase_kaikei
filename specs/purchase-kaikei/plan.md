---
artifact: plan
template_id: TPL-PLAN-001
feature_id: FEAT-PURCHASEKAIKEI
feature_name: "purchase-kaikei"
---

# Plan: purchase-kaikei

# 0. Canonical Spec (YAML SSoT)

```yaml
plan:
  feature_id: FEAT-PURCHASEKAIKEI
  version: 4
  architecture: 3-layer + built-in accounting engine + PostgreSQL (1 server 3 databases) + Outbox mirror (kaikei-api) + kanri-dwh KPI proxy
  components:
    - CMP-PURCHASEKAIKEI-001
    - CMP-PURCHASEKAIKEI-002
    - CMP-PURCHASEKAIKEI-005
    - CMP-PURCHASEKAIKEI-004
    - CMP-PURCHASEKAIKEI-006
    - CMP-PURCHASEKAIKEI-007
    - CMP-PURCHASEKAIKEI-008
  libraries:
    - LIB-PURCHASEKAIKEI-001
    - LIB-PURCHASEKAIKEI-002
  contracts:
    - CT-API-PURCHASEKAIKEI-001
    - CT-API-PURCHASEKAIKEI-002
    - CT-API-PURCHASEKAIKEI-003
    - CT-API-PURCHASEKAIKEI-004
    - CT-API-PURCHASEKAIKEI-005
    - CT-API-PURCHASEKAIKEI-006
    - CT-API-PURCHASEKAIKEI-007
    - CT-API-PURCHASEKAIKEI-008
  test_strategy: 3-layer
```

## Architecture

**v5: データ基盤を PostgreSQL に統一。** 1 台の PostgreSQL サーバ上に 3 つのデータベース（purchase / kaikei / kanri）を作り、3 システムのエンジンを統一する。システム境界・Outbox ミラー・突合の仕組みは不変。SQLite（node:sqlite）と DuckDB は退役し、既存データは一次移行スクリプトで搬送する。

```
public/ (UI)              server.js (API)                       store/
index.html          ←→    GET/POST /api/...               ←→    purchase-store.js（購買ドメイン・PG 接続）
js/app.js                 状態遷移ガード                            journal.js（内蔵会計エンジン）
6 ビュー（管理会計含む）       │ │                                 kaikei-client.js（ミラー送信）
                            │ └─ POST /api/management/* ──→    kanri-client.js（KPI プロキシ）
                            ▼                                        │
                      仕訳は購買の遷移から自動生成                      ▼
                        PostgreSQL(1 サーバ 3 DB)             kaikei-api(:8000・kaikei DB)
                        ├ purchase DB（本アプリ）                    │
                        ├ kaikei DB（台帳）                    (ETL・POST /api/etl)
                        └ kanri DB（分析 DWH）                      ▼
                                                  kanri-dwh(:8100・kanri DB)
```

**データチェーン（v4〜）**: purchase-kaikei →(仕訳ミラー・Outbox)→ kaikei-api →(ETL・POST /api/etl)→ kanri-dwh →(KPI)→ purchase-kaikei 管理会計。どの先が止まっても購買操作は止まらず、チェーンは最終的に収束する（最終一致性）。v5 で流れ場が PostgreSQL に統一される。

### 会計エンジンの設計方針（v2〜・v5 で永続化を PostgreSQL に移行）

- 仕訳（entry）は `{id, date, description, department, lines:[{account_code, side, amount}]}`。PostgreSQL の `journal_entries` + `journal_lines` に蓄積する（購買・支払予定・Outbox キューと**同一トランザクション**で書き込まれるため、検収/支払と仕訳は必ず整合する）。
- 検収 → 借: 仕入高 5110 / 貸: 買掛金 2110。支払 → 借: 買掛金 2110 / 貸: 普通預金 1120。department は申請の部門。
- 試算表・総勘定元帳は**要求のたびに仕訳台帳から計算**する（保存しない = 計算結果の実体を持たないため、帳簿ずれが構造的に起きない）。
- 科目マスタは 11 科目固定（kaikei-api と同じ体系）。貸借一致は engine が生成するため必ず保たれる。

### Components (CMP-*)

- CMP-PURCHASEKAIKEI-001: server.js — Express サーバー。静的配信 + REST API + 遷移ガード + 会計レポート API + 連携プロキシ
- CMP-PURCHASEKAIKEI-002: store/purchase-store.js — 購買ドメイン層（v5: PostgreSQL 永続化 + Outbox + 自動再送タイマー）
- CMP-PURCHASEKAIKEI-005: store/journal.js — **内蔵会計エンジン**: 仕訳計上（貸借一致チェック）・残高試算表計算・総勘定元帳計算・科目/部門マスタ
- CMP-PURCHASEKAIKEI-004: public/ — UI（6 ビュー: ダッシュボード / 新規申請 / 申請一覧 / 支払予定 / 財務会計 / 管理会計）
- CMP-PURCHASEKAIKEI-006: store/kaikei-client.js + store/kanri-client.js — 連携クライアント（注入可能・テストはスタブ）
- CMP-PURCHASEKAIKEI-007: PostgreSQL — purchase DB（7 テーブル: purchases / payables / journal_entries + journal_lines / pending_links / counters / meta。v4 は SQLite で実装・v5 で PG に移植）
- CMP-PURCHASEKAIKEI-008: scripts/migrate-to-pg.js — 一次移行スクリプト（旧 SQLite / DuckDB → PG）

### Libraries (LIB-*)

- LIB-PURCHASEKAIKEI-001: express ^4 — HTTP サーバー
- LIB-PURCHASEKAIKEI-002（v5 追加）: pg ^8 — PostgreSQL クライアント（node:sqlite からの置換。追加はユーザー承認済み）

### Components (CMP-*)

- CMP-PURCHASEKAIKEI-001: server.js — Express サーバー。静的配信 + REST API + 遷移ガード + 会計レポート API + 連携プロキシ
- CMP-PURCHASEKAIKEI-002: store/purchase-store.js — 購買ドメイン層（v4: SQLite 永続化 + Outbox + 自動再送タイマー）
- CMP-PURCHASEKAIKEI-005: store/journal.js — **内蔵会計エンジン**: 仕訳計上（貸借一致チェック）・残高試算表計算・総勘定元帳計算・科目/部門マスタ
- CMP-PURCHASEKAIKEI-004: public/ — UI（6 ビュー: ダッシュボード / 新規申請 / 申請一覧 / 支払予定 / 会計 / 経営ダッシュボード）
- CMP-PURCHASEKAIKEI-006: store/kaikei-client.js + store/kanri-client.js — 連携クライアント（注入可能・テストはスタブ）
- CMP-PURCHASEKAIKEI-007: data/purchase-kaikei.db — SQLite（7 テーブル: purchases / payables / journal_entries + journal_lines / pending_links / counters / meta）

### Libraries (LIB-*)

- LIB-PURCHASEKAIKEI-001: express ^4 — HTTP サーバー。npm 依存はこれのみ（v4: SQLite は Node 内蔵の node:sqlite を使用）

### Contracts (CT-*)

- CT-API-PURCHASEKAIKEI-001: POST /api/purchases — 申請登録 {item, qty, unitPrice, requester, department?, note?} → 201（department は D10/D20/D90、既定 D90）
- CT-API-PURCHASEKAIKEI-002: POST /api/purchases/:id/approve | reject | resubmit — 承認 / 却下（comment 必須）/ 再申請
- CT-API-PURCHASEKAIKEI-003: POST /api/purchases/:id/order — 発注 → 採番 orderNo
- CT-API-PURCHASEKAIKEI-004: POST /api/purchases/:id/receive — 検収 {receivedQty, receivedAt} → 支払予定計上 + **仕訳 1 件自動計上**（entry id を記録）
- CT-API-PURCHASEKAIKEI-005: POST /api/payables/:id/pay — 支払実行 → **仕訳 1 件自動計上**（entry id を記録）
- CT-API-PURCHASEKAIKEI-006: GET /api/accounting/accounts / trial-balance / ledger/:code — **内蔵エンジン**の計算結果を返す（200 のみ。外部依存なし）
- CT-API-PURCHASEKAIKEI-007（v3/v4）: GET /api/accounting/sync（未同期状態）+ POST /api/accounting/sync（手動再送）— Outbox ミラー連携。kaikei_unavailable は 502
- CT-API-PURCHASEKAIKEI-008（v4）: GET /api/management/kpi/:name（reconcile / pl-by-department / sales-by-month / expense-by-account / cash-trend の whitelist プロキシ）+ POST /api/management/etl（kanri-dwh の取込起動）— kanri_unavailable / kanri_source_error は 502
- 共通: 許可外の遷移は 409 {error:"invalid_transition"}、入力不足は 400
- v5 共通: DB 接続は環境変数（PG_CONNECTION 系・.env）で管理しコミットしない。API 契約そのものは v4 から不変（DB 置換は内部実装のみ）

## Test Strategy (3-layer, Tecnos coverage tier)

### Unit

- TS-UNIT-PURCHASEKAIKEI-001: store の遷移ガード + 部門検証 + 仕訳対応表（借方/貸方/金額/department）— target ≥ 70% coverage for standard
- TS-UNIT-PURCHASEKAIKEI-002: 会計エンジン — 貸借一致チェック・試算表（全科目・残高 0 含む・貸借一致）・元帳（日付順・残高繰越）・部門/期間フィルタ
- TS-UNIT-PURCHASEKAIKEI-003（v4）: 自動再送タイマー — 障害復帰後、操作なしで未同期が送信される

### Integration

- TS-INT-PURCHASEKAIKEI-001: 申請登録（部門含む）→一覧照会
- TS-INT-PURCHASEKAIKEI-002: 承認/却下（comment 必須）/再申請
- TS-INT-PURCHASEKAIKEI-003: 発注（approved のみ・採番）
- TS-INT-PURCHASEKAIKEI-004: 分割検収 → 支払予定計上 + 仕訳自動計上（entry id 記録）
- TS-INT-PURCHASEKAIKEI-005: 支払実行 → 仕訳自動計上・entryId 記録・二重支払 409
- TS-INT-PURCHASEKAIKEI-006: 会計 API — 試算表・元帳・科目一覧が購買操作を反映して返る
- TS-INT-PURCHASEKAIKEI-007（v3/v4）: ミラー連携（Outbox）— 障害でキュー保持・再送で送信
- TS-INT-PURCHASEKAIKEI-008/009（v4）: 管理会計プロキシ — KPI 中継・未知 KPI 404・ETL 起動・kanri-dwh 障害 502
- TS-INT-PURCHASEKAIKEI-010（v5）: PostgreSQL 移行 — 一次移行スクリプトで旧 DB のデータが移行され、突合が一致する
- 永続化（v4 → v5）: PG 再起動復元 — purchases + payables + entries + キューが保持される（テストはテスト用 DB を使用・実行にローカル PG が必要）

### E2E

- TS-E2E-PURCHASEKAIKEI-001: 申請→承認→発注→分割検収→支払→試算表/元帳照会のクリティカルジャーニー
- 実機連携 E2E（v4・手動）: 購買検収 → kaikei-api ミラー → kanri-dwh ETL → KPI 表示（2026-09-11 実施済み・31 仕訳取込・突合一致）
- 実機連携 E2E（v5・手動）: 同チェーンが全て PostgreSQL 上で動くことを確認予定

## Evidence Pack (Final Gate 5 要件)

| Artifact | Status | Note |
|---|---|---|
| CI Pass | N/A | 研修ローカル実行のため CI 不使用（node --test で代替） |
| SAST Pass | DONE | node --test 28 件（2026-09-11・v4 を含む。stride_test_run でパース済み） |
| SCA Pass | DONE | npm audit（express のみ・moderate 2 件は研修環境で受容） |
| Secrets Scan | DONE | シークレットなし（ローカル SQLite のみ・キーなし） |
| AI Provenance | DONE | 本ファイル + ai-generated label（Claude Code 生成） |

## Approval boundary

- HUMAN-ONLY: APPROVAL.md / WI-*.approval.md（Gate 承認は人が実施。Gate 1・2 は 2026-09-10 に Liu Yutong が承認済み）
- 研修運用のため本プロジェクトでは承認者 = 受講者本人（Owner 兼任）

## Delivery scale

standard — size the work items and rollout plan for this caller-selected scale.

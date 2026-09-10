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
  version: 2
  architecture: 3-layer + built-in accounting engine (standalone, no external API)
  components:
    - CMP-PURCHASEKAIKEI-001
    - CMP-PURCHASEKAIKEI-002
    - CMP-PURCHASEKAIKEI-005
    - CMP-PURCHASEKAIKEI-004
  libraries:
    - LIB-PURCHASEKAIKEI-001
  contracts:
    - CT-API-PURCHASEKAIKEI-001
    - CT-API-PURCHASEKAIKEI-002
    - CT-API-PURCHASEKAIKEI-003
    - CT-API-PURCHASEKAIKEI-004
    - CT-API-PURCHASEKAIKEI-005
    - CT-API-PURCHASEKAIKEI-006
  test_strategy: 3-layer
```

## Architecture

**v2: 単体完結**。purchase-management（Node.js + Express + JSON 永続化）を土台に、会計エンジン（仕訳台帳・試算表・総勘定元帳）を**内蔵**した 3 層構成。外部 API 連携はない（v1 の kaikei-api HTTP 連携は廃止）。

```
public/ (UI)          server.js (API)                 store/
index.html      ←→    GET/POST /api/...         ←→    purchase-store.js（購買ドメイン）
js/app.js             状態遷移ガード                     journal.js（内蔵会計エンジン）
5 ビュー（会計含む）         │                           data/purchases.json
                            ▼                          purchases + payables + entries
                      仕訳は購買の遷移から自動生成        （すべて 1 ファイルに永続化）
```

### 会計エンジンの設計方針（v2）

- 仕訳（entry）は `{id, date, description, department, lines:[{account_code, side, amount}]}`。data/purchases.json の `entries` 配列に蓄積する（購買データと同一ファイル・同一トランザクションで書き込まれるため、検収/支払と仕訳は必ず整合する）。
- 検収 → 借: 仕入高 5110 / 貸: 買掛金 2110。支払 → 借: 買掛金 2110 / 貸: 普通預金 1120。department は申請の部門。
- 試算表・総勘定元帳は**要求のたびに仕訳台帳から計算**する（保存しない = 計算結果の実体を持たないため、帳簿ずれが構造的に起きない）。
- 科目マスタは 11 科目固定（kaikei-api と同じ体系）。貸借一致は engine が生成するため必ず保たれる。

### Components (CMP-*)

- CMP-PURCHASEKAIKEI-001: server.js — Express サーバー。静的配信 + REST API + 遷移ガード + 会計レポート API
- CMP-PURCHASEKAIKEI-002: store/purchase-store.js — 購買ドメイン層（purchase-management v3 を継承 + 部門 + 仕訳自動計上の呼び出し）
- CMP-PURCHASEKAIKEI-005: store/journal.js — **内蔵会計エンジン**: 仕訳計上（貸借一致チェック）・残高試算表計算・総勘定元帳計算・科目/部門マスタ
- CMP-PURCHASEKAIKEI-004: public/ — UI（purchase-management の 4 ビュー + 部門選択 + 会計ビュー）

### Libraries (LIB-*)

- LIB-PURCHASEKAIKEI-001: express ^4 — HTTP サーバー。依存はこれのみ

### Contracts (CT-*)

- CT-API-PURCHASEKAIKEI-001: POST /api/purchases — 申請登録 {item, qty, unitPrice, requester, department?, note?} → 201（department は D10/D20/D90、既定 D90）
- CT-API-PURCHASEKAIKEI-002: POST /api/purchases/:id/approve | reject | resubmit — 承認 / 却下（comment 必須）/ 再申請
- CT-API-PURCHASEKAIKEI-003: POST /api/purchases/:id/order — 発注 → 採番 orderNo
- CT-API-PURCHASEKAIKEI-004: POST /api/purchases/:id/receive — 検収 {receivedQty, receivedAt} → 支払予定計上 + **仕訳 1 件自動計上**（entry id を記録）
- CT-API-PURCHASEKAIKEI-005: POST /api/payables/:id/pay — 支払実行 → **仕訳 1 件自動計上**（entry id を記録）
- CT-API-PURCHASEKAIKEI-006: GET /api/accounting/accounts / trial-balance / ledger/:code — **内蔵エンジン**の計算結果を返す（200 のみ。外部依存なし）
- 共通: 許可外の遷移は 409 {error:"invalid_transition"}、入力不足は 400

## Test Strategy (3-layer, Tecnos coverage tier)

### Unit

- TS-UNIT-PURCHASEKAIKEI-001: store の遷移ガード + 部門検証 + 仕訳対応表（借方/貸方/金額/department）— target ≥ 70% coverage for standard
- TS-UNIT-PURCHASEKAIKEI-002: 会計エンジン — 貸借一致チェック・試算表（全科目・残高 0 含む・貸借一致）・元帳（日付順・残高繰越）・部門/期間フィルタ

### Integration

- TS-INT-PURCHASEKAIKEI-001: 申請登録（部門含む）→一覧照会
- TS-INT-PURCHASEKAIKEI-002: 承認/却下（comment 必須）/再申請
- TS-INT-PURCHASEKAIKEI-003: 発注（approved のみ・採番）
- TS-INT-PURCHASEKAIKEI-004: 分割検収 → 支払予定計上 + 仕訳自動計上（entry id 記録）
- TS-INT-PURCHASEKAIKEI-005: 支払実行 → 仕訳自動計上・entryId 記録・二重支払 409
- TS-INT-PURCHASEKAIKEI-006: 会計 API — 試算表・元帳・科目一覧が購買操作を反映して返る

### E2E

- TS-E2E-PURCHASEKAIKEI-001: 申請→承認→発注→分割検収→支払→試算表/元帳照会のクリティカルジャーニー

## Evidence Pack (Final Gate 5 要件)

| Artifact | Status | Note |
|---|---|---|
| CI Pass | N/A | 研修ローカル実行のため CI 不使用（node --test で代替） |
| SAST Pass | DONE | node --test 20 件（手動確認） |
| SCA Pass | DONE | npm audit（express のみ・moderate 2 件は研修環境で受容） |
| Secrets Scan | DONE | シークレットなし（ローカル JSON のみ・キーなし） |
| AI Provenance | DONE | 本ファイル + ai-generated label（Claude Code 生成） |

## Approval boundary

- HUMAN-ONLY: APPROVAL.md / WI-*.approval.md（Gate 承認は人が実施。Gate 1・2 は 2026-09-10 に Liu Yutong が承認済み）
- 研修運用のため本プロジェクトでは承認者 = 受講者本人（Owner 兼任）

## Delivery scale

standard — size the work items and rollout plan for this caller-selected scale.

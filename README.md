# 購買会計システム（研修用）

Tecnos-STRIDE (SDD) フローで開発。**purchase-management（購買管理）** を土台に、
**会計機能（仕訳・残高試算表・総勘定元帳）を内蔵した独立アプリ**（v2・単体で完結、外部 API 不要）。

## 仕組み

| 購買側の操作 | 自動計上される仕訳 |
|---|---|
| 検収（数量 q・単価 p） | 借方: **5110 仕入高** / 貸方: **2110 買掛金**　金額 = q × p |
| 支払実行 | 借方: **2110 買掛金** / 貸方: **1120 普通預金**　金額 = 支払額 |

- 申請に**部門**（D10/D20/D90・既定 D90）を付け、仕訳の department に引き継ぐ。
- 仕訳は購買データと同じ JSON（`data/purchases.json` の `entries`）に蓄積され、同じ書き込み時に保存されるため**常に整合**する。
- 残高試算表・総勘定元帳は仕訳台帳から**その都度計算**（計算結果の実体を持たないので帳簿ずれが起きない）。
- 「会計」ビューで残高試算表（11 科目すべて・残高 0 含む・貸借一致）と総勘定元帳（残高繰越）を照会できる。

## 起動（1 つだけ）

```bash
npm install
npm start        # → http://localhost:3010（会計エンジン内蔵・これだけで完結）
```

`start.bat` / `stop.bat` でも可。

## 使い方

1. 「新規申請」から申請（申請者・品目・数量・単価は必須、部門を選択）
2. 「申請一覧」の「詳細」からアクション実行: 承認 / 却下（理由必須）/ 再申請 / 発注 / **検収（この時点で仕訳計上）**
3. 「支払予定」で支払実行（**この時点でもう 1 本仕訳を計上**）
4. 「会計」ビューで残高試算表・総勘定元帳を照会 — 検収・支払した仕訳がそのまま反映される

## 状態遷移

```
申請済み →(1 段承認)→ 承認済み → 発注済み →(分割検収・その都度仕訳)→ 全量検収済
    └→ 却下 →(再申請)→ 申請済み
検収ごとに支払予定(payable)を計上: 支払予定 →(支払実行・仕訳計上)→ 支払済み
```

## テスト

```bash
npm test         # node --test、22 テスト（unit + integration + E2E・外部依存なし）
```

## SDD 成果物 (specs/purchase-kaikei/)

basic_design.md / process.bpmn（scripts/gen-bpmn.js で生成）/ spec.md / plan.md / tasks.md /
contracts/openapi.yaml / tests/scenarios.yaml / state/state.yaml / implementation-details/
※ APPROVAL.md は HUMAN-ONLY（AI は編集禁止。Gate 1・2 は 2026-09-10 に Liu Yutong が承認済み）

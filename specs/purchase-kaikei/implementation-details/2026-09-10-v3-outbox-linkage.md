# Implementation Notes — FEAT-PURCHASEKAIKEI（v3 ブランチ）

日付: 2026-09-10 / 作成: AI agent (Claude Code)
ブランチ: `feature/kaikei-linkage`（main = v2 独立アプリのまま）

## v3 変更（kaikei-api ミラー連携の再設計）

v1（HTTP 連携・計上成功が遷移の完了条件）で明術になった問題:
1. kaikei-api 未起動で検収・支払・会計ビューが使えない（ダブル起動が必須）
2. kaikei-api のエラー応答で未分類例外 → Express 4 が uncaught でプロセスごと落ちる
3. 連携失敗と購買操作が強く結合している（アトミック性の担保が難しい）

### Outbox（送信予約）方式で解決

- **内蔵会計エンジンが常に正本**: 検収・支払は v2 どおり即座に仕訳を計上・永続化する。
  連携はその後の**ミラー送信**に降格され、購買操作を一切妨げない。
- **キュー**: 計上された仕訳は `pendingLinks`（data/purchases.json 内）に入る。
  送信成功で `kaikeiEntryId`（向こうの採番 id）を記録してキューから除去。
- **再送のきっかけ**: ① 次の検収・支払（ベストエフォート自動送信）② 会計画面の
  「未同期を再送信」ボタン（`POST /api/accounting/sync`）。kaikei 側の業務エラー
  （未知科目など再送しても届かないもの）はキューから破棄し `lastLinkError` に記録。
- **多重送信防止**: `_syncing` フラグで同期処理を直列化。
- v1 のクラッシュ問題の修正（未分類例外の安全網）は main で実施済みのまま本ブランチにも入る。

## 検証結果（実機・真の kaikei-api に対して）

1. **稼働中**: 検収 → 自動ミラー（pending 0・kaikei-api 側の元帳に「購買検収 PU-0014」が出現）
2. **障害中**: kaikei-api を kill → 検収は 200 で成功・仕訳はキュー保持（pending 1・操作可能）
3. **復帰**: kaikei-api 再起動 → 再送信 → sent 1・kaikei-api 側の元帳に「購買検収 PU-0015」が出現

- `npm test`: 25/25 pass（v2 の 22 + ミラー連携 3）
- SDD 成果物: spec v3（AC-007 追加）/ contracts（CT-007: /api/accounting/sync）/ tests/scenarios.yaml 同時改版

## 既知の制約

- 単一プロセス前提（fire-and-forget 送信のため、送信直後にプロセスを落とすと未送信のまま —
  キューは永続化されているので次回起動後の操作で再送される）
- 認証なし（研修用）

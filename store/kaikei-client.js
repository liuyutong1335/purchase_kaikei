'use strict';
// kaikei-api 連携クライアント（v3・feature/kaikei-linkage）
// v1 との違い: 連携は「ミラー送信」（後方同期）。失敗しても購買操作は止まらない。
// Kaikei-API-Kanri-DWH/shared/contract.md v0.1 §4（財務会計のみ）
class KaikeiUnavailableError extends Error {
  constructor(cause) {
    super(`kaikei_unavailable: kaikei-api に接続できません（${cause && cause.message ? cause.message : cause}）`);
    this.name = 'KaikeiUnavailableError';
    this.code = 'kaikei_unavailable';
  }
}

class KaikeiClient {
  constructor(baseUrl) {
    this.baseUrl = (baseUrl || process.env.KAIKEI_API_URL || 'http://localhost:8000').replace(/\/$/, '');
  }

  // 仕訳の登録。成功時は登録された仕訳（id を含む）を返す
  postEntry(body) {
    return this.#request('/api/entries', { method: 'POST', body: JSON.stringify(body) });
  }

  async #request(pathname, opts) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}${pathname}`, {
        headers: { 'Content-Type': 'application/json' },
        ...opts,
      });
    } catch (err) {
      throw new KaikeiUnavailableError(err);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.message || body.error || `kaikei-api HTTP ${res.status}`);
      err.code = body.error || 'kaikei_api_error';
      err.status = res.status;
      throw err;
    }
    return body;
  }
}

module.exports = { KaikeiClient, KaikeiUnavailableError };

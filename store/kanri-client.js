'use strict';
// kanri-dwh（管理会計 DWH・FastAPI port 8100）連携クライアント
// 突合・KPI 取得と ETL 起動（POST /api/etl）を丸投げする薄いクライアント。
// 連携は読み取り中心で、kanri-dwh が止まっていても購買操作・会計ビューには影響しない。
class KanriUnavailableError extends Error {
  constructor(cause) {
    super(`kanri_unavailable: kanri-dwh に接続できません（${cause && cause.message ? cause.message : cause}）`);
    this.name = 'KanriUnavailableError';
    this.code = 'kanri_unavailable';
  }
}

class KanriClient {
  constructor(baseUrl) {
    this.baseUrl = (baseUrl || process.env.KANRI_DWH_URL || 'http://localhost:8100').replace(/\/$/, '');
  }

  // ETL（取込）を起動する。kanri-dwh 側で CLI と同じ etl.run が走る（冪等）
  runEtl() {
    return this.#request('/api/etl', { method: 'POST' });
  }

  // KPI / 突合を取得する（name は reconcile / pl-by-department / sales-by-month /
  // expense-by-account / cash-trend。from・to は YYYY-MM・department は D10/D20/D90）
  kpi(name, query = {}) {
    const qs = new URLSearchParams(
      Object.entries(query).filter(([, v]) => v != null && v !== ''),
    ).toString();
    return this.#request(`/api/kpi/${name}${qs ? `?${qs}` : ''}`, {});
  }

  async #request(pathname, opts) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}${pathname}`, {
        headers: { 'Content-Type': 'application/json' },
        ...opts,
      });
    } catch (err) {
      throw new KanriUnavailableError(err);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.detail || body.message || body.error || `kanri-dwh HTTP ${res.status}`);
      err.code = res.status === 502 ? 'kanri_source_error' : 'kanri_api_error';
      err.status = res.status;
      throw err;
    }
    return body;
  }
}

module.exports = { KanriClient, KanriUnavailableError };

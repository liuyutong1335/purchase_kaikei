'use strict';
// CMP-PURCHASEKAIKEI-005: 内蔵会計エンジン（v2 — kaikei-api 連携の廃止に伴い新設）
// 仕訳台帳（entries）を蓄積し、残高試算表・総勘定元帳をその都度計算する。
// 計算結果の実体を持たないため、帳簿ずれが構造的に起きない。
// 科目マスタ（11 科目・kaikei-api と同じ体系）
const ACCOUNTS_MASTER = [
  { code: '1110', name: '現金', category: '資産', normal_side: 'debit' },
  { code: '1120', name: '普通預金', category: '資産', normal_side: 'debit' },
  { code: '1130', name: '売掛金', category: '資産', normal_side: 'debit' },
  { code: '2110', name: '買掛金', category: '負債', normal_side: 'credit' },
  { code: '2120', name: '借入金', category: '負債', normal_side: 'credit' },
  { code: '3110', name: '資本金', category: '純資産', normal_side: 'credit' },
  { code: '4110', name: '売上高', category: '収益', normal_side: 'credit' },
  { code: '5110', name: '仕入高', category: '費用', normal_side: 'debit' },
  { code: '5210', name: '給料', category: '費用', normal_side: 'debit' },
  { code: '5310', name: '通信費', category: '費用', normal_side: 'debit' },
  { code: '5410', name: '広告宣伝費', category: '費用', normal_side: 'debit' },
];

// 購買フローで使う科目
const ACCOUNT_CODES = { purchase: '5110', accountsPayable: '2110', bank: '1120' };

// エンジン内部の検証エラー（purchase-store の ValidationError とコードを揃える）
class JournalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'JournalError';
    this.code = 'validation_error';
  }
}

class JournalEngine {
  // entries: 仕訳台帳配列（data/purchases.json の entries。purchase-store が保持する）
  constructor(entries) {
    this.entries = entries;
  }

  // 仕訳 1 件を計上する。借方合計 = 貸方合計を検証し、連番 id を採番して返す
  post({ date, description, department, lines }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      throw new JournalError(`invalid date: ${date}`);
    }
    if (!lines || lines.length < 2) {
      throw new JournalError('journal entry needs at least one debit and one credit line');
    }
    let debit = 0;
    let credit = 0;
    for (const l of lines) {
      const master = ACCOUNTS_MASTER.find((a) => a.code === l.account_code);
      if (!master) {
        throw new JournalError(`unknown account_code: ${l.account_code}`);
      }
      if (!Number.isInteger(l.amount) || l.amount < 1) {
        throw new JournalError(`amount must be a positive integer: ${l.amount}`);
      }
      if (l.side === 'debit') debit += l.amount;
      else if (l.side === 'credit') credit += l.amount;
      else throw new JournalError(`side must be debit or credit: ${l.side}`);
    }
    if (debit !== credit) {
      throw new JournalError(`unbalanced: debit ${debit} != credit ${credit}`);
    }
    const id = (this.counters.entry += 1);
    const entry = { id, date, description, department, lines, createdAt: new Date().toISOString() };
    this.entries.push(entry);
    return entry;
  }

  // 内蔵エンジンは purchase-store の counters を共有する（採番は 1 台帳 1 系列のため）
  set counters(c) {
    this._counters = c;
    if (c.entry == null) c.entry = 0;
  }
  get counters() {
    return this._counters;
  }

  getAccounts() {
    return ACCOUNTS_MASTER.map((a) => ({ ...a }));
  }

  // 残高試算表: 全 11 科目（残高 0 を含む）を返す。借方合計 = 貸方合計が保たれる
  trialBalance({ from, to, department } = {}) {
    const sums = new Map(ACCOUNTS_MASTER.map((a) => [a.code, { debit: 0, credit: 0 }]));
    for (const e of this.#filtered(from, to, department)) {
      for (const l of e.lines) {
        const s = sums.get(l.account_code);
        if (s) s[l.side] += l.amount;
      }
    }
    let debitTotal = 0;
    let creditTotal = 0;
    const rows = ACCOUNTS_MASTER.map((a) => {
      const s = sums.get(a.code);
      const debitBalance = a.normal_side === 'debit' ? s.debit - s.credit : 0;
      const creditBalance = a.normal_side === 'credit' ? s.credit - s.debit : 0;
      debitTotal += s.debit;
      creditTotal += s.credit;
      return {
        account_code: a.code,
        account_name: a.name,
        category: a.category,
        normal_side: a.normal_side,
        debit_total: s.debit,
        credit_total: s.credit,
        debit_balance: a.normal_side === 'debit' ? s.debit - s.credit : 0,
        credit_balance: a.normal_side === 'credit' ? s.credit - s.debit : 0,
      };
    });
    return { rows, debit_total: debitTotal, credit_total: creditTotal, balanced: debitTotal === creditTotal };
  }

  // 総勘定元帳: 科目を含む仕訳を日付昇順 → id 昇順で並べ、残高（繰越）を付ける
  ledger(accountCode, { from, to, department } = {}) {
    const master = ACCOUNTS_MASTER.find((a) => a.code === accountCode);
    if (!master) {
      const err = new Error(`account not found: ${accountCode}`);
      err.code = 'not_found';
      throw err;
    }
    const rows = [];
    let balance = 0;
    for (const e of this.#filtered(from, to, department)) {
      const line = e.lines.find((l) => l.account_code === accountCode);
      if (!line) continue;
      balance += line.side === 'debit' ? line.amount : -line.amount;
      rows.push({
        date: e.date,
        entry_id: e.id,
        description: e.description,
        debit: line.side === 'debit' ? line.amount : 0,
        credit: line.side === 'credit' ? line.amount : 0,
        balance: master.normal_side === 'debit' ? balance : -balance,
      });
    }
    return { account: { ...master }, rows };
  }

  #filtered(from, to, department) {
    return this.entries
      .filter((e) => (!from || e.date >= from) && (!to || e.date <= to) && (!department || e.department === department))
      .sort((a, b) => (a.date === b.date ? a.id - b.id : a.date < b.date ? -1 : 1));
  }
}

module.exports = { JournalEngine, JournalError, ACCOUNTS_MASTER, ACCOUNT_CODES };

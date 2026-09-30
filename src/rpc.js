import { createHash } from 'node:crypto';
import { curveAddress, PROGRAM } from './address.js';

const READ_METHODS = new Set(['getMultipleAccounts', 'getAccountInfo',
  'getSignaturesForAddress', 'getTransaction']);
const TOKEN_PROGRAMS = new Set(['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb']);
const DISCRIMINATOR = createHash('sha256').update('account:BondingCurve').digest().subarray(0, 8);
const accountData = account => {
  if (!account || !Array.isArray(account.data) || account.data[1] !== 'base64') return null;
  return Buffer.from(account.data[0], 'base64');
};

export function decodeMint(account) {
  const data = accountData(account);
  if (!TOKEN_PROGRAMS.has(account?.owner) || !data || data.length < 82 || data[45] !== 1) {
    throw Error('invalid_mint_account');
  }
  if (data[44] > 18) throw Error('unsupported_mint_decimals');
  return data[44];
}

export function decodeCurve(account, decimals) {
  if (!account) return { error: 'curve_missing_or_migrated', complete: null };
  const data = accountData(account);
  if (account.owner !== PROGRAM || !data || data.length < 49 ||
      !data.subarray(0, 8).equals(DISCRIMINATOR)) return { error: 'invalid_curve_account', complete: null };
  const virtualToken = data.readBigUInt64LE(8), virtualSol = data.readBigUInt64LE(16);
  const result = { realSol: Number(data.readBigUInt64LE(32)) / 1e9,
    virtualSol: Number(virtualSol) / 1e9, complete: data[48] === 1 };
  if (data[48] > 1) return { ...result, error: 'invalid_curve_complete_flag' };
  // Current Pump layout appends creator (32), mayhem (1), cashback (1), quote_mint (32).
  // Older accounts omit trailing fields, interpreted by Pump as zero/default SOL quote.
  if (data.subarray(83, 115).some(byte => byte !== 0)) return { ...result, error: 'non_sol_quote' };
  if (result.complete) return { ...result, error: 'curve_complete_or_migrated' };
  if (!Number.isInteger(decimals) || !virtualToken || !virtualSol) {
    return { ...result, error: 'invalid_price_inputs' };
  }
  return { ...result, price: Number(virtualSol) / Number(virtualToken) * 10 ** decimals / 1e9 };
}

export class Rpc {
  #url;
  constructor({ apiKey, rps = 8, concurrency = 2, fetchImpl = fetch, log = () => {} }) {
    if (!apiKey) throw Error('HELIUS_API_KEY is required');
    this.#url = `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
    this.fetch = fetchImpl; this.log = log;
    this.interval = 1000 / Math.max(0.1, Number(rps) || 8);
    this.concurrency = Math.max(1, Math.floor(Number(concurrency) || 2));
    this.queue = []; this.active = 0; this.nextAt = 0; this.blockedUntil = 0;
    this.sequence = 0; this.decimals = new Map(); this.curves = new Map(); this.closed = false;
  }

  async call(method, params, options = {}) {
    return (await this.request(method, params, options)).result;
  }

  request(method, params, { priority = 10 } = {}) {
    if (!READ_METHODS.has(method)) return Promise.reject(Error('RPC method is not read-only allowed'));
    if (this.closed) return Promise.reject(Error('RPC closed'));
    if (this.queue.length > 10000) return Promise.reject(Error('RPC queue capacity exceeded'));
    return new Promise((resolve, reject) => {
      this.queue.push({ method, params, priority: typeof priority === 'number' ? priority : 10,
        sequence: ++this.sequence, attempt: 0, notBefore: 0, resolve, reject });
      this.pump();
    });
  }

  pump() {
    clearTimeout(this.timer);
    if (this.closed || !this.queue.length || this.active >= this.concurrency) return;
    const now = Date.now();
    const ready = this.queue.filter(job => job.notBefore <= now)
      .sort((a, b) => a.priority - b.priority || a.sequence - b.sequence)[0];
    const start = Math.max(this.nextAt, this.blockedUntil,
      ready ? now : Math.min(...this.queue.map(job => job.notBefore)));
    if (start > now) { this.timer = setTimeout(() => this.pump(), start - now); return; }
    this.queue.splice(this.queue.indexOf(ready), 1);
    this.active++; this.nextAt = now + this.interval;
    void this.run(ready).finally(() => { this.active--; this.pump(); });
    this.pump();
  }

  async run(job) {
    const requestedAt = Date.now();
    let retryAfter = 0;
    try {
      const response = await this.fetch(this.#url, { method: 'POST',
        headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ jsonrpc: '2.0', id: job.sequence, method: job.method, params: job.params }) });
      if (!response.ok) {
        const header = response.headers?.get('retry-after');
        if (header) retryAfter = /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
        const error = Error(`RPC HTTP ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        error.rateLimited = response.status === 429;
        throw error;
      }
      const payload = await response.json();
      if (payload.error) {
        const code = Number(payload.error.code);
        const error = Error(`RPC response error ${Number.isFinite(code) ? code : 'unknown'}`);
        error.retryable = [-32005, -32004, -32429, 429].includes(code);
        error.rateLimited = code === -32429 || code === 429;
        throw error;
      }
      if (!Object.hasOwn(payload, 'result')) throw Error('RPC response missing result');
      job.resolve({ result: payload.result, requestedAt, receivedAt: Date.now() });
    } catch (error) {
      const retryable = error.retryable !== false;
      if (retryable && job.attempt < 4 && !this.closed) {
        const backoff = Math.min(30000, 500 * 2 ** job.attempt + Math.random() * 200);
        const delay = Math.max(backoff, Math.min(120000, Math.max(0, retryAfter || 0)));
        job.notBefore = Date.now() + delay; job.attempt++;
        if (error.rateLimited) this.blockedUntil = Math.max(this.blockedUntil, job.notBefore);
        this.log(`Helius read retry ${job.attempt}/4 in ${Math.ceil(delay)}ms (${job.method})`);
        this.queue.push(job);
      } else {
        // Never pass through fetch errors or provider messages: either can contain the API URL/key.
        const safe = /^RPC (HTTP \d{3}|response error (-?\d+|unknown))$/.test(error.message || '')
          ? error.message : 'RPC read failed or timed out';
        job.reject(Error(safe));
      }
    }
  }

  async readCurves(mints) {
    const unique = [...new Set(mints)], results = new Map();
    // At most 50 curves + 50 uncached mint accounts in one RPC, under the 100-account limit.
    const jobs = [];
    for (let i = 0; i < unique.length; i += 50) jobs.push(this.readBatch(unique.slice(i, i + 50), results));
    await Promise.all(jobs);
    return results;
  }

  async readBatch(mints, results) {
    const startedAt = Date.now();
    try {
      const unknown = mints.filter(mint => !this.decimals.has(mint));
      const addresses = [...mints.map(mint => {
        if (!this.curves.has(mint)) this.curves.set(mint, curveAddress(mint));
        return this.curves.get(mint);
      }), ...unknown];
      const { result, requestedAt, receivedAt } = await this.request('getMultipleAccounts',
        [addresses, { encoding: 'base64', commitment: 'confirmed' }], { priority: 0 });
      if (!result || !Array.isArray(result.value) || result.value.length !== addresses.length) {
        throw Error('Invalid account response');
      }
      const mintErrors = new Map();
      unknown.forEach((mint, i) => {
        try { this.decimals.set(mint, decodeMint(result.value[mints.length + i])); }
        catch (error) { mintErrors.set(mint, error.message); }
      });
      mints.forEach((mint, i) => {
        const curve = decodeCurve(result.value[i], this.decimals.get(mint));
        if (mintErrors.has(mint)) { curve.error = mintErrors.get(mint); delete curve.price; }
        results.set(mint, { ...curve, requestedAt, receivedAt, slot: result.context?.slot ?? null });
      });
      // Mint decimals are immutable; bound cache memory during continuous runs.
      while (this.decimals.size > 100000) this.decimals.delete(this.decimals.keys().next().value);
      while (this.curves.size > 100000) this.curves.delete(this.curves.keys().next().value);
    } catch {
      for (const mint of mints) results.set(mint, { error: 'curve_read_failed', complete: null,
        requestedAt: startedAt, receivedAt: Date.now(), slot: null });
    }
  }

  close() {
    this.closed = true; clearTimeout(this.timer);
    for (const job of this.queue.splice(0)) job.reject(Error('RPC closed'));
  }
}

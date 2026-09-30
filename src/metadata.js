import { createHash } from 'node:crypto';
import { curveAddress, decode58, validAddress, PROGRAM } from './address.js';

const CREATE_TAGS = ['create', 'create_v2'].map(name =>
  createHash('sha256').update(`global:${name}`).digest().subarray(0, 8));
const keyText = key => typeof key === 'string' ? key : key?.pubkey;

// Inspect existing instructions only, to avoid confusing the oldest visible trade with creation.
export function isCreationTransaction(transaction, mint) {
  if (!transaction || transaction.meta?.err) return false;
  const message = transaction.transaction?.message;
  const keys = (message?.accountKeys || []).map(keyText);
  if (!keys.includes(mint)) return false;
  const instructions = [...(message?.instructions || []),
    ...(transaction.meta?.innerInstructions || []).flatMap(group => group.instructions || [])];
  return instructions.some(instruction => {
    const program = keyText(instruction.programId) || keys[instruction.programIdIndex];
    if (program !== PROGRAM || typeof instruction.data !== 'string') return false;
    const accounts = (instruction.accounts || []).map(account =>
      typeof account === 'number' ? keys[account] : keyText(account));
    if (!accounts.includes(mint)) return false;
    try {
      const tag = decode58(instruction.data).subarray(0, 8);
      return CREATE_TAGS.some(expected => tag.equals(expected));
    } catch { return false; }
  });
}

export class Metadata {
  constructor(rpc, { log = () => {}, maxPages = 3, pageSize = 1000 } = {}) {
    this.rpc = rpc; this.log = log; this.maxPages = maxPages; this.pageSize = pageSize;
    this.creations = new Map(); this.pending = new Map(); this.events = new Map();
  }

  setCreation(event, observedAt = Date.now()) {
    if (!validAddress(event?.mint)) return;
    if (!this.events.has(event.mint)) this.events.set(event.mint, {
      observedAt, signature: typeof event.signature === 'string' ? event.signature : null,
    });
    this.trim(this.events);
  }

  trim(map) { while (map.size > 100000) map.delete(map.keys().next().value); }

  async transaction(signature) {
    if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{70,90}$/.test(signature)) return null;
    if (this.rpc.transactionCache?.has(signature)) return this.rpc.transactionCache.get(signature);
    try {
      return await this.rpc.call('getTransaction', [signature,
        { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }],
      { priority: 20 });
    } catch { return null; }
  }

  async creation(mint) {
    const cached = this.creations.get(mint);
    if (cached && (cached.tokenCreatedAt || Date.now() - cached.cachedAt < 60000)) return cached;
    if (this.pending.has(mint)) return this.pending.get(mint);
    const promise = this.findCreation(mint).catch(() => ({ tokenCreatedAt: null, tokenAgeSource: 'unknown' }))
      .then(value => {
        const result = { ...value, cachedAt: Date.now() };
        this.creations.set(mint, result); this.trim(this.creations); return result;
      }).finally(() => this.pending.delete(mint));
    this.pending.set(mint, promise);
    return promise;
  }

  async findCreation(mint) {
    const event = this.events.get(mint);
    if (event?.signature) {
      const tx = await this.transaction(event.signature);
      if (isCreationTransaction(tx, mint) && Number.isFinite(tx.blockTime)) {
        return { tokenCreatedAt: tx.blockTime * 1000, tokenAgeSource: 'verified_new_token_transaction' };
      }
    }
    let before, oldest, exhausted = false;
    for (let page = 0; page < this.maxPages; page++) {
      const options = { limit: this.pageSize, commitment: 'confirmed' };
      if (before) options.before = before;
      const signatures = await this.rpc.call('getSignaturesForAddress', [curveAddress(mint), options], { priority: 30 });
      if (!Array.isArray(signatures)) break;
      if (signatures.length) oldest = signatures.at(-1);
      if (signatures.length < this.pageSize) { exhausted = true; break; }
      before = signatures.at(-1).signature;
    }
    if (exhausted && oldest && !oldest.err) {
      const tx = await this.transaction(oldest.signature);
      if (isCreationTransaction(tx, mint) && Number.isFinite(tx.blockTime)) {
        return { tokenCreatedAt: tx.blockTime * 1000, tokenAgeSource: 'verified_curve_creation_transaction' };
      }
    }
    return { tokenCreatedAt: null, tokenAgeSource: exhausted ? 'creation_not_verified' : 'history_scan_limit' };
  }

  async enrich(mint, signature, detectedAt) {
    const [leader, creation] = await Promise.all([this.transaction(signature), this.creation(mint)]);
    const leaderBlockTime = Number.isFinite(leader?.blockTime) ? leader.blockTime * 1000 : null;
    const reference = leaderBlockTime ?? detectedAt;
    const tokenCreatedAt = creation.tokenCreatedAt ?? null;
    const tokenAgeSeconds = tokenCreatedAt !== null && reference >= tokenCreatedAt
      ? (reference - tokenCreatedAt) / 1000 : null;
    return { leaderBlockTime, tokenCreatedAt, tokenAgeSeconds,
      tokenAgeSource: creation.tokenAgeSource,
      tokenAgeReference: leaderBlockTime === null ? 'local_detection' : 'leader_block_time',
      tokenCreationObservedAt: this.events.get(mint)?.observedAt ?? null,
      leaderTransactionStatus: leader ? (leader.meta?.err ? 'failed' : 'confirmed') : 'unknown' };
  }

  get(mint, signature, detectedAt) { return this.enrich(mint, signature, detectedAt); }
}

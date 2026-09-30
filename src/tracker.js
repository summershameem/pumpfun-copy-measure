import { Study } from './study.js';
import { validAddress } from './address.js';
import { decodeCurve } from './rpc.js';

// How often each followed token's curve is read (ms). 2000 keeps Helius credit use
// low; 1000 gives finer price paths at roughly double the read cost.
const PRICE_POLL_MS = Math.max(500, Number(process.env.PRICE_POLL_MS) || 2000);

export function normalize(raw) {
  if (!['buy', 'sell'].includes(raw.txType) || !validAddress(raw.mint) ||
      !validAddress(raw.traderPublicKey) || typeof raw.signature !== 'string' || !raw.signature) return null;
  const value = raw.solAmount == null || raw.solAmount === '' ? NaN : Number(raw.solAmount);
  return { ...raw, solAmount: Number.isFinite(value) && value >= 0 ? value : null,
    id: [raw.signature, raw.mint, raw.traderPublicKey, raw.txType,
      raw.eventIndex ?? raw.instructionIndex ?? '', raw.solAmount ?? '', raw.tokenAmount ?? ''].join(':') };
}

export class Tracker {
  constructor({ wallets, rpc, metadata, writer, journal, log }) {
    Object.assign(this, { rpc, metadata, writer, journal, log });
    this.wallets = new Set(wallets); this.tracked = new Map(); this.seen = new Map();
    this.stopped = false; this.nextCleanup = 0; this.coverageState = new Map();
  }
  tokens(now = Date.now()) {
    return new Set([...this.tracked].filter(([, token]) =>
      [...token.studies.values()].some(study => now <= study.end)).map(([mint]) => mint));
  }
  event(raw, at = Date.now()) {
    if (this.stopped) return;
    if (raw.txType === 'create') { this.metadata.setCreation(raw, at); return; }
    if (raw.txType === 'migration' || raw.txType === 'migrate') {
      for (const study of this.tracked.get(raw.mint)?.studies.values() ?? []) study.flag('curve_migrated');
      return;
    }
    const event = normalize(raw);
    if (!event || this.seen.has(event.id)) return;
    this.seen.set(event.id, at);
    let token = this.tracked.get(event.mint);
    for (const study of token?.studies.values() ?? []) study.event(event, at);
    if (event.txType !== 'buy' || !this.wallets.has(event.traderPublicKey)) return;
    // Account subscriptions can include PumpSwap trades; this experiment is curve-only.
    if (event.pool && event.pool !== 'pump') return;
    if (!token) {
      token = { studies: new Map(), pending: false, nextRead: at };
      this.tracked.set(event.mint, token);
    } else {
      // A new leader buy needs its entry price now, not at the next scheduled poll.
      token.nextRead = Math.min(token.nextRead, at);
    }
    const study = new Study(event, at); token.studies.set(event.id, study);
    const coverage = this.coverageState.get(event.mint);
    if (coverage) this.coverage(event.mint, coverage.status, at);
    this.journal.begin(study.row);
    this.log(`Leader buy ${event.traderPublicKey} token=${event.mint} SOL=${event.solAmount ?? 'unknown'}`);
    this.metadata.enrich(event.mint, event.signature, at).then(data => {
      if (!this.stopped && token.studies.has(event.id)) study.metadata(data);
    }).catch(() => study.flag('metadata_unavailable', false));
  }
  gap(reason) {
    this.log(`Observation gap: ${reason}`);
    for (const token of this.tracked.values()) for (const study of token.studies.values()) study.gap();
  }
  coverage(mint, status, at = Date.now()) {
    this.coverageState.set(mint, { status, at });
    for (const study of this.tracked.get(mint)?.studies.values() ?? []) {
      if (status === 'active' && !study.row.subscription_active_at) {
        study.row.subscription_active_at = new Date(at).toISOString();
        study.row.subscription_delay_ms = Math.max(0, at - study.start);
        if (at > study.start) study.flag('initial_subscription_blind_window', false);
        if (at - study.start > 2000) study.flag('subscription_late');
      } else if (status === 'capacity') {
        study.row.subscription_capacity_limited = true; study.flag('subscription_capacity');
      } else if (status === 'gap') study.flag('subscription_gap');
    }
  }
  curve(mint, account, { slot, at }) {
    const token = this.tracked.get(mint), decimals = this.rpc.decimals?.get(mint);
    if (!token || decimals === undefined || (slot && slot < (token.lastSlot ?? 0))) return;
    token.lastSlot = slot ?? token.lastSlot;
    const decoded = decodeCurve(account, decimals);
    const sample = { ...decoded, slot, requestedAt: at, receivedAt: at, fromAccount: true };
    if (Number.isFinite(decoded.realSol)) {
      // Deltas in whole lamports so repeated small buys sum exactly.
      const lamports = Math.round(decoded.realSol * 1e9);
      if (token.lastRealLamports !== undefined && lamports !== token.lastRealLamports)
        for (const study of token.studies.values()) study.copier((lamports - token.lastRealLamports) / 1e9, at);
      token.lastRealLamports = lamports;
    }
    for (const study of token.studies.values()) study.sample(sample);
  }
  tick(now = Date.now()) {
    if (this.stopped) return;
    const due = [];
    for (const [mint, token] of this.tracked) {
      for (const [id, study] of token.studies) {
        study.tick(now);
        if (now >= study.end + 5000) { this.finish(study); token.studies.delete(id); }
      }
      if (!token.studies.size) { this.tracked.delete(mint); this.coverageState.delete(mint); continue; }
      if (!token.pending && now >= token.nextRead) {
        token.pending = true; token.nextRead = now + PRICE_POLL_MS; due.push(mint);
      }
    }
    // One outstanding read per mint; batch many tokens without blocking the event loop.
    for (let i = 0; i < due.length; i += 50) {
      const mints = due.slice(i, i + 50);
      const identities = new Map(mints.map(mint => [mint, this.tracked.get(mint)]));
      this.rpc.readCurves(mints).then(samples => {
        if (this.stopped) return;
        for (const [mint, sample] of samples) {
          const token = this.tracked.get(mint);
          if (!token || token !== identities.get(mint)) continue;
          token.nextRead = Math.max(token.nextRead, sample.requestedAt + PRICE_POLL_MS);
          if (sample.slot && sample.slot < (token.lastSlot ?? 0)) continue;
          token.lastSlot = sample.slot ?? token.lastSlot;
          if (token.lastRealLamports === undefined && Number.isFinite(sample.realSol))
            token.lastRealLamports = Math.round(sample.realSol * 1e9);
          for (const study of token.studies.values()) study.sample(sample);
        }
      }).catch(() => {
        for (const mint of mints) if (this.tracked.get(mint) === identities.get(mint))
          for (const study of identities.get(mint).studies.values()) study.flag('rpc_read_failed');
      }).finally(() => {
        for (const mint of mints) {
          const token = this.tracked.get(mint);
          if (token && token === identities.get(mint)) token.pending = false;
        }
      });
    }
    if (now >= this.nextCleanup) {
      for (const [id, at] of this.seen) if (at < now - 600000) this.seen.delete(id);
      this.nextCleanup = now + 60000;
    }
  }
  finish(study, status) {
    const row = study.finish(status);
    this.writer.append(row); this.journal.done(row.id);
    this.log(`Saved ${row.token} ${row.data_quality} ${row.quality_notes || ''}`);
  }
  stop() {
    this.stopped = true;
    for (const token of this.tracked.values()) for (const study of token.studies.values()) this.finish(study, 'stopped_early');
    this.tracked.clear();
  }
}

export const WINDOWS = [5, 15, 30, 60, 120, 300, 600, 1200];
// A gap longer than this between price samples marks the row as incomplete.
// Keep it above PRICE_POLL_MS plus network latency (default: 2000 + 1500).
const SAMPLING_GAP_MS = Math.max(1000, Number(process.env.SAMPLING_GAP_MS) || 3500);
export const STAKE = 0.02, FEE = 0.005, NETWORK = 0.002, SLIP = 0.03;
export const MAX_DELAY = 2000;
const iso = ms => new Date(ms).toISOString();
export function netResult(entryPrice, rawExit) {
  const exitPrice = rawExit * (1 - SLIP);
  const proceeds = STAKE / entryPrice * exitPrice * (1 - FEE);
  const netPnl = proceeds - STAKE - STAKE * FEE - NETWORK;
  return { exitPrice, netPnl, netMultiple: 1 + netPnl / STAKE };
}

export class Study {
  constructor(event, at) {
    this.start = at; this.end = at + 1200000;
    this.entryTarget = at + 2000; this.entry = null;
    this.notes = new Set(); this.bad = new Set();
    this.triggers = {}; this.closed = new Set(); this.snapshots = new Set();
    this.lastSample = null; this.lastCopier = at; this.firstSell = null;
    this.row = {
      id: event.id, token: event.mint, leader_wallet: event.traderPublicKey,
      leader_signature: event.signature, detected_at: iso(at),
      leader_buy_sol: event.solAmount ?? '', entry_target_at: iso(this.entryTarget),
      feed: event.feed ?? 'pumpportal',
      log_notification_at: event.notificationAt ? iso(event.notificationAt) : '',
      transaction_decode_delay_ms: event.decodeDelayMs ?? '',
      curve_sol_at_leader_buy: event.curveRealSol ?? '',
      curve_virtual_sol_at_leader_buy: event.curveVirtualSol ?? '',
      curve_at_leader_buy_source: event.curveRealSol == null ? '' : 'helius_transaction_event',
      stake_sol: STAKE, buy_fee_sol: STAKE * FEE, network_fee_sol: NETWORK,
      leader_sold: false, price_samples: 0, ws_gap_count: 0,
    };
    if (event.solAmount == null) this.notes.add('leader_buy_size_unknown');
    for (const s of [5, 15, 60]) {
      this.row[`copier_count_${s}`] = 0; this.row[`copier_sol_${s}`] = 0;
    }
  }
  flag(note, invalid = true) { this.notes.add(note); if (invalid) this.bad.add(note); }
  gap() { this.row.ws_gap_count++; this.flag('websocket_gap'); }
  event(event, at) {
    if (at < this.start || at > this.end || event.id === this.row.id) return;
    if (event.traderPublicKey === this.row.leader_wallet) {
      if (event.txType === 'sell' && !this.firstSell) {
        this.firstSell = at;
        Object.assign(this.row, { leader_sold: true, leader_sell_at: iso(at),
          leader_sell_delay_seconds: (at - this.start) / 1000,
          leader_sell_signature: event.signature });
        this.trigger('rleader', Math.max(at, this.entryTarget), 'leader_sell');
      }
      // A further leader buy or sell in this token also moved the curve; net it out of the copier windows.
      if (event.solAmount) this.leaderFlow(event.txType === 'buy' ? event.solAmount : -event.solAmount,
        event.notificationAt ?? at);
    }
  }
  leaderFlow(sol, at) {
    for (const s of [5, 15, 60]) if (at <= this.start + s * 1000) {
      if (sol > 0) { this.row[`copier_count_${s}`] = Math.max(0, this.row[`copier_count_${s}`] - 1); }
      this.row[`copier_sol_${s}`] = Math.max(0, Math.round((this.row[`copier_sol_${s}`] - Math.abs(sol)) * 1e9) / 1e9);
    }
  }
  // Copier flow: each positive change in the curve's real SOL reserves between account updates is treated
  // as one buy of that size (trades landing in the same slot merge into one update); sells are negative.
  copier(deltaSol, at) {
    if (at < this.start || at > this.end) return;
    this.notes.add('copier_flow_from_curve_deltas');
    if (deltaSol <= 0) return;
    this.lastCopier = at;
    for (const s of [5, 15, 60]) if (at <= this.start + s * 1000) {
      this.row[`copier_count_${s}`]++;
      this.row[`copier_sol_${s}`] = Math.round((this.row[`copier_sol_${s}`] + deltaSol) * 1e9) / 1e9;
    }
  }
  metadata(data) {
    this.row.leader_block_time = data.leaderBlockTime ? iso(data.leaderBlockTime) : '';
    this.row.token_created_at = data.tokenCreatedAt ? iso(data.tokenCreatedAt) : '';
    this.row.token_age_seconds = data.tokenAgeSeconds ?? '';
    this.row.token_age_source = data.tokenAgeSource ?? 'unknown';
    this.row.token_age_reference = data.tokenAgeReference ?? '';
    this.row.leader_transaction_status = data.leaderTransactionStatus ?? 'unknown';
    if (data.leaderTransactionStatus === 'failed') this.flag('leader_transaction_failed');
    if (data.tokenAgeSeconds == null) this.flag('token_age_unknown', false);
  }
  trigger(rule, at, reason) {
    if (!this.triggers[rule]) this.triggers[rule] = { at, reason };
  }
  tick(at) {
    for (const [rule, seconds] of [['r30', 30], ['r60', 60], ['rzero', 120],
      ['rleader', 1200], ['rtarget', 120], ['r1200', 1200]]) {
      if (at >= this.start + seconds * 1000)
        this.trigger(rule, this.start + seconds * 1000, `timeout_${seconds}s`);
    }
    // Require a complete ten-second observation window, even if no copier buys.
    const zeroAt = Math.max(this.start + 10000, this.lastCopier + 10000);
    if (at >= zeroAt && zeroAt <= this.start + 120000)
      this.trigger('rzero', zeroAt, 'zero_copier_inflow_10s');
    if (!this.entry && at > this.entryTarget + MAX_DELAY + 5000)
      this.flag('entry_unavailable');
  }
  sample(sample) {
    const at = sample.requestedAt, received = sample.receivedAt;
    if (at < this.start || at > this.end + MAX_DELAY) return;
    if (sample.error || sample.complete || !(sample.price > 0)) {
      this.flag(sample.complete ? 'curve_complete_or_migrated' : 'curve_read_failed');
      return;
    }
    const price = sample.price;
    if (received - at > MAX_DELAY) { this.flag('rpc_response_late'); return; }
    if (this.lastSample && at - this.lastSample > SAMPLING_GAP_MS) this.flag('price_sampling_gap');
    this.lastSample = at; this.row.price_samples++;
    if (this.row.curve_sol_at_detection === undefined) {
      Object.assign(this.row, { curve_sol_at_detection: sample.realSol,
        curve_virtual_sol_at_detection: sample.virtualSol,
        curve_at_detection_source: 'first_helius_read_after_detection',
        curve_sample_delay_ms: at - this.start });
    }
    if (at <= this.end && (!this.row.peak_price || price > this.row.peak_price)) {
      this.row.peak_price = price; this.row.peak_at = iso(received);
    }
    if (!sample.fromAccount && !this.entry && at >= this.entryTarget && received <= this.entryTarget + MAX_DELAY) {
      this.entry = price * (1 + SLIP);
      Object.assign(this.row, { entry_at: iso(received), entry_delay_ms: received - this.entryTarget,
        entry_raw_price: price, entry_price: this.entry });
      if (this.firstSell && this.firstSell < received) this.flag('leader_sold_before_entry', false);
    }
    this.tick(at);
    for (const s of WINDOWS) {
      const target = this.start + s * 1000;
      if (!this.snapshots.has(s) && at >= target && received <= target + MAX_DELAY) {
        this.snapshots.add(s);
        this.row[`price_${s}`] = price;
        this.row[`multiple_${s}`] = this.entry ? price / this.entry : '';
        this.row[`sample_at_${s}`] = iso(received);
        this.row[`sample_delay_ms_${s}`] = received - target;
      }
    }
    if (!this.entry) return;
    if (at <= this.start + 120000 && price >= this.entry * 1.3)
      this.trigger('rtarget', at, 'observed_1.3x');
    for (const [rule, trigger] of Object.entries(this.triggers)) {
      if (this.closed.has(rule) || at < trigger.at) continue;
      // Pre-entry leader exit uses the first possible paper price, never a past price.
      const target = rule === 'rleader' ? Math.max(trigger.at, this.entryTarget) : trigger.at;
      if (received > target + MAX_DELAY) continue;
      const result = netResult(this.entry, price);
      Object.assign(this.row, { [`${rule}_net_multiple`]: result.netMultiple,
        [`${rule}_net_pnl_sol`]: result.netPnl, [`${rule}_exit_price`]: result.exitPrice,
        [`${rule}_exit_raw_price`]: price, [`${rule}_trigger_at`]: iso(trigger.at),
        [`${rule}_exit_at`]: iso(received), [`${rule}_delay_ms`]: received - trigger.at,
        [`${rule}_reason`]: trigger.reason });
      this.closed.add(rule);
    }
  }
  finish(status = 'complete') {
    this.row.status = status;
    if (status !== 'complete') this.flag(status);
    if (!this.entry) this.flag('entry_unavailable');
    if (this.snapshots.size !== WINDOWS.length) this.flag('snapshot_missing');
    if (this.closed.size !== 6) this.flag('exit_missing');
    if (this.row.feed === 'helius' && !this.row.subscription_active_at) this.flag('token_subscription_unavailable');
    if (!this.row.token_age_source) this.flag('metadata_unavailable', false);
    this.row.peak_multiple = this.entry && this.row.peak_price ? this.row.peak_price / this.entry : '';
    this.row.data_quality = this.bad.size ? 'incomplete' : 'ok';
    this.row.quality_notes = [...this.notes].join(';');
    return this.row;
  }
}

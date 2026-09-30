import test from 'node:test';
import assert from 'node:assert/strict';
import { Study, netResult } from '../src/study.js';

const START = 1700000000000;
const event = { id: 'buy1', signature: 'sig1', mint: 'mint', traderPublicKey: 'leader', solAmount: 2 };
const sample = (s, price = 1, extra = {}) => ({ price, realSol: 5, virtualSol: 35,
  requestedAt: START + s * 1000, receivedAt: START + s * 1000, ...extra });
// Copier flow now arrives as curve reserve deltas (positive = buy), not as decoded trades.
const other = (id, amount = 0.4) => ({ delta: amount });
function full(study, priceAt = () => 1, events = new Map()) {
  for (let s = 0; s <= 1202; s++) {
    for (const e of events.get(s) ?? []) {
      if (e.delta !== undefined) study.copier(e.delta, START + s * 1000);
      else study.event(e, START + s * 1000);
    }
    study.tick(START + s * 1000); study.sample(sample(s, priceAt(s)));
  }
  return study.finish();
}

test('flat market includes both slippages, both fees and round-trip network cost', () => {
  const expected = 0.97 / 1.03 * 0.995 - 0.005 - 0.002 / 0.02;
  assert.ok(Math.abs(netResult(1.03, 1).netMultiple - expected) < 1e-12);
  const row = full(new Study(event, START));
  for (const r of ['r30', 'r60', 'rzero', 'rleader', 'rtarget', 'r1200'])
    assert.ok(Math.abs(row[`${r}_net_multiple`] - expected) < 1e-12);
  assert.equal(row.rzero_trigger_at, new Date(START + 10000).toISOString());
  assert.equal(row.rleader_exit_at, new Date(START + 1200000).toISOString());
  assert.equal(row.entry_at, new Date(START + 2000).toISOString());
  assert.equal(row.data_quality, 'ok');
});

test('five exit rules remain independent and trailing flow resets on each reserve increase', () => {
  const study = new Study(event, START);
  const events = new Map([[4, [other('b1', 0.6)]], [7, [other('b2', 0.5)]],
    [20, [{ ...event, id: 'sell1', signature: 'sell1', txType: 'sell' }]]]);
  const row = full(study, s => s < 10 ? 1 : s < 25 ? 1.4 : s < 45 ? 0.9 : 1.1, events);
  assert.equal(row.rtarget_exit_raw_price, 1.4);
  assert.equal(row.rtarget_trigger_at, new Date(START + 10000).toISOString());
  assert.equal(row.rzero_trigger_at, new Date(START + 17000).toISOString());
  assert.equal(row.rleader_trigger_at, new Date(START + 20000).toISOString());
  assert.equal(row.r30_exit_raw_price, 0.9);
  assert.equal(row.r60_exit_raw_price, 1.1);
  assert.equal(row.copier_count_5, 1); assert.equal(row.copier_count_15, 2);
  assert.equal(row.copier_sol_15, 1.1);
  assert.equal(row.peak_price, 1.4);
  assert.equal(row.multiple_15, 1.4 / 1.03);
});

test('copier inflow through the deadline makes rule3 exit at +120s', () => {
  const events = new Map();
  for (let s = 9; s <= 117; s += 9) events.set(s, [other(`b${s}`)]);
  const row = full(new Study(event, START), () => 1, events);
  assert.equal(row.rzero_exit_at, new Date(START + 120000).toISOString());
  assert.equal(row.rzero_reason, 'timeout_120s');
});

test('leader sale before entry exits at first paper entry price without negative holding time', () => {
  const row = full(new Study(event, START), () => 1,
    new Map([[1, [{ ...event, id: 'sell', txType: 'sell' }]]]));
  assert.equal(row.rleader_exit_at, row.entry_at);
  assert.match(row.quality_notes, /leader_sold_before_entry/);
});

test('account updates cannot manufacture the required +2s RPC entry', () => {
  const study = new Study(event, START);
  study.sample(sample(2, 1, { fromAccount: true }));
  assert.equal(study.entry, null);
  study.sample(sample(2.5, 1));
  assert.equal(study.entry, 1.03);
});

test('late entries and missing or migrated curves never use a stale successful price', () => {
  const late = new Study(event, START);
  late.sample(sample(3.9, 1, { receivedAt: START + 5800 }));
  assert.equal(late.entry, null);
  const study = new Study(event, START);
  study.sample(sample(2));
  study.sample(sample(30, 100, { complete: true }));
  study.sample(sample(33, 2));
  const row = study.finish();
  assert.equal(row.r30_net_multiple, undefined);
  assert.equal(row.data_quality, 'incomplete');
  assert.match(row.quality_notes, /curve_complete/);
});

test('gaps are exposed and a 1.3x target uses entry including buy slippage', () => {
  const study = new Study(event, START); study.gap();
  const row = full(study, s => s === 20 ? 1.3 : 1);
  assert.equal(row.rtarget_reason, 'timeout_120s');
  assert.equal(row.data_quality, 'incomplete');
  assert.equal(row.ws_gap_count, 1);
});

test('leader repeat buy and sell are netted out of copier windows and never push counts negative', () => {
  const study = new Study(event, START);
  study.copier(0.5, START + 3000);
  study.event({ ...event, id: 'buy2', signature: 'buy2', txType: 'buy', solAmount: 0.5, notificationAt: START + 3000 }, START + 4000);
  assert.equal(study.row.copier_count_5, 0); assert.equal(study.row.copier_sol_5, 0);
  study.copier(-0.2, START + 6000);
  assert.equal(study.row.copier_count_15, 0); assert.equal(study.row.copier_sol_15, 0);
});

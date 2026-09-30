import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Tracker } from '../src/tracker.js';
import { Journal } from '../src/journal.js';
import { CsvWriter, parseCsv } from '../src/csv.js';
import { encode58, PROGRAM } from '../src/address.js';

const START = Date.UTC(2026, 0, 1);
const LEADER_A = '11111111111111111111111111111111';
const LEADER_B = PROGRAM;
const OTHER = 'So11111111111111111111111111111111111111112';
const mintAt = index => {
  const bytes = Buffer.alloc(32, 9);
  bytes.writeUInt32LE(index, 0);
  return encode58(bytes);
};
const trade = (signature, wallet, mint, solAmount = 1, txType = 'buy') => ({
  signature, traderPublicKey: wallet, mint, solAmount, txType, pool: 'pump',
});
const sample = at => ({ requestedAt: at, receivedAt: at + 20, price: 0.000001,
  realSol: 10, virtualSol: 40, complete: false });
// Drain RPC .then/.catch/.finally and metadata callbacks without wall-clock sleeps.
const settled = () => new Promise(resolve => setImmediate(resolve));

function harness(rpcOverride, metadataOverride) {
  let now = START;
  const rows = [], calls = [], begun = [], done = [], logs = [];
  const rpc = rpcOverride ?? { readCurves(mints) {
    calls.push({ mints: [...mints], at: now });
    return Promise.resolve(new Map(mints.map(mint => [mint, sample(now)])));
  } };
  const metadata = metadataOverride ?? { setCreation() {}, enrich() {
    return Promise.resolve({ leaderBlockTime: START, tokenCreatedAt: START - 10000,
      tokenAgeSeconds: 10, tokenAgeSource: 'test_verified', leaderTransactionStatus: 'confirmed' });
  } };
  const tracker = new Tracker({ wallets: [LEADER_A, LEADER_B], rpc, metadata,
    writer: { append(row) { rows.push(structuredClone(row)); } },
    journal: { begin(row) { begun.push(structuredClone(row)); }, done(id) { done.push(id); } },
    log(message) { logs.push(message); },
  });
  return { tracker, rows, calls, begun, done, logs,
    async tick(at) { now = at; tracker.tick(at); await settled(); } };
}

// Curve account with the given real SOL reserves, as delivered by accountSubscribe.
function curveAccount(realSol) {
  const data = Buffer.alloc(115);
  createHash('sha256').update('account:BondingCurve').digest().copy(data, 0, 0, 8);
  data.writeBigUInt64LE(1000000000000n, 8); data.writeBigUInt64LE(40000000000n, 16);
  data.writeBigUInt64LE(BigInt(Math.round(realSol * 1e9)), 32);
  return { owner: PROGRAM, data: [data.toString('base64'), 'base64'] };
}

test('overlapping leader buys share reads and preserve per-study flow and exits', async () => {
  const h = harness(), mint = mintAt(1);
  h.tracker.rpc.decimals = new Map([[mint, 6]]);
  const events = new Map([
    [0, trade('a-first', LEADER_A, mint, 0.1)],
    [3000, trade('b-first', LEADER_B, mint, 0.2)],
    [6000, trade('a-second', LEADER_A, mint, 0.3)],
    [20000, trade('a-sell', LEADER_A, mint, 0.2, 'sell')],
    [30000, trade('b-sell', LEADER_B, mint, 0.2, 'sell')],
  ]);
  // Copier flow is observed only through curve reserve changes; the curve moves just before each
  // leader trade is detected, and an anonymous copier adds 2 SOL at +4s.
  const curves = new Map([[2999, 10.2], [4000, 12.2], [5999, 12.5]]);
  for (let elapsed = 0; elapsed <= 1211000; elapsed += 1000) {
    const event = events.get(elapsed);
    if (event) {
      h.tracker.event(event, START + elapsed);
      h.tracker.event({ ...event }, START + elapsed + 1);
    }
    for (const [offset, realSol] of curves) {
      if (offset >= elapsed - 999 && offset <= elapsed)
        h.tracker.curve(mint, curveAccount(realSol), { slot: 100 + offset, at: START + offset });
    }
    await h.tick(START + elapsed);
  }
  assert.equal(h.begun.length, 3);
  assert.equal(h.rows.length, 3);
  assert.equal(new Set(h.done).size, 3);
  assert.equal(h.tracker.tracked.size, 0);
  const bySignature = Object.fromEntries(h.rows.map(row => [row.leader_signature, row]));
  assert.equal(bySignature['a-first'].copier_count_15, 2);
  assert.equal(bySignature['a-first'].copier_sol_15, 2.2);
  assert.equal(bySignature['b-first'].copier_count_15, 2);
  assert.equal(bySignature['b-first'].copier_sol_15, 2.3);
  assert.equal(bySignature['a-second'].copier_count_15, 0);
  assert.equal(bySignature['a-second'].copier_sol_15, 0);
  assert.equal(bySignature['a-first'].leader_sell_signature, 'a-sell');
  assert.equal(bySignature['a-second'].leader_sell_delay_seconds, 14);
  assert.equal(bySignature['b-first'].leader_sell_signature, 'b-sell');
  for (const row of h.rows) {
    assert.equal(row.data_quality, 'ok', row.quality_notes);
    assert.equal(row.status, 'complete');
    assert.equal(row.entry_delay_ms, 20);
    assert.equal(row.price_300, 0.000001);
    assert.ok(Number.isFinite(row.r30_net_multiple));
    assert.ok(Number.isFinite(row.rleader_net_multiple));
  }
  assert.ok(h.calls.every(call => call.mints.length === 1));
  assert.equal(new Set(h.calls.map(call => call.at)).size, h.calls.length);
});

test('103 simultaneous tokens batch reads and never stack pending reads per mint', async () => {
  const requests = [];
  const rpc = { readCurves(mints) {
    return new Promise(resolve => requests.push({ mints: [...mints], resolve }));
  } };
  const h = harness(rpc);
  for (let i = 0; i < 103; i++) h.tracker.event(trade(`many-${i}`, LEADER_A, mintAt(i)), START);
  await h.tick(START);
  assert.deepEqual(requests.map(request => request.mints.length), [50, 50, 3]);
  assert.equal(new Set(requests.flatMap(request => request.mints)).size, 103);
  await h.tick(START + 1000);
  await h.tick(START + 2000);
  assert.equal(requests.length, 3, 'pending reads must suppress new calls');
  for (const request of requests) {
    request.resolve(new Map(request.mints.map(mint => [mint, sample(START)])));
  }
  await settled();
  await h.tick(START + 2100);
  assert.deepEqual(requests.map(request => request.mints.length), [50, 50, 3, 50, 50, 3]);
  h.tracker.stop();
  assert.equal(h.rows.length, 103);
  assert.equal(h.done.length, 103);
  assert.ok(h.rows.every(row => row.status === 'stopped_early' && row.data_quality === 'incomplete'));
  for (const request of requests.slice(3)) request.resolve(new Map());
  await settled();
});

test('graceful stop saves pending studies once and ignores late work and events', async () => {
  let resolveRpc, resolveMetadata;
  const rpc = { readCurves() { return new Promise(resolve => { resolveRpc = resolve; }); } };
  const metadata = { setCreation() {}, enrich() {
    return new Promise(resolve => { resolveMetadata = resolve; });
  } };
  const h = harness(rpc, metadata), mint = mintAt(7);
  h.tracker.event(trade('before-stop', LEADER_A, mint), START);
  await h.tick(START);
  h.tracker.stop();
  h.tracker.stop();
  h.tracker.event(trade('after-stop', LEADER_A, mint), START + 1000);
  resolveRpc(new Map([[mint, sample(START + 2000)]]));
  resolveMetadata({ tokenAgeSeconds: 5, tokenAgeSource: 'test_verified' });
  await settled();
  await h.tick(START + 10000);
  assert.equal(h.begun.length, 1);
  assert.equal(h.done.length, 1);
  assert.equal(h.rows.length, 1);
  assert.equal(h.rows[0].status, 'stopped_early');
  assert.equal(h.rows[0].entry_price, undefined);
  assert.equal(h.rows[0].r30_net_multiple, undefined);
  assert.equal(h.tracker.tokens(START + 10000).size, 0);
});

test('journal recovers interruption, preserves unknown flow, and dedupes saved rows', () => {
  const directory = fs.mkdtempSync(path.join(process.cwd(), '.test-integration-'));
  const csvPath = path.join(directory, 'copy-log.csv');
  const journalPath = path.join(directory, 'pending.jsonl');
  const logs = [], log = message => logs.push(message);
  let writer, journal;
  try {
    writer = new CsvWriter(csvPath);
    journal = new Journal(journalPath, csvPath, writer, log);
    const interrupted = { id: 'interrupted', leader_wallet: LEADER_A, token: mintAt(1),
      detected_at: new Date(START).toISOString(), copier_count_15: 0, copier_sol_15: 0 };
    const completed = { id: 'completed', leader_wallet: LEADER_B, token: mintAt(2),
      data_quality: 'ok', status: 'complete', r30_net_multiple: 1.1 };
    journal.begin(interrupted);
    journal.begin(completed);
    writer.append(completed); // Process dies after CSV flush but before journal.done.
    journal.close(); journal = null;
    writer.close(); writer = null;
    fs.appendFileSync(journalPath, '{"row":'); // Simulate a torn final write.
    writer = new CsvWriter(csvPath);
    journal = new Journal(journalPath, csvPath, writer, log);
    const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
    assert.equal(rows.length, 2);
    assert.equal(rows.filter(row => row.id === 'completed').length, 1);
    const recovered = rows.find(row => row.id === 'interrupted');
    assert.equal(recovered.status, 'interrupted');
    assert.equal(recovered.data_quality, 'incomplete');
    assert.equal(recovered.copier_sol_15, '');
    assert.equal(recovered.copier_count_15, '');
    assert.equal(recovered.r30_net_multiple, '');
    assert.ok(logs.some(message => message.includes('torn final')));
    journal.close(); journal = null;
    journal = new Journal(journalPath, csvPath, writer, log);
    assert.equal(parseCsv(fs.readFileSync(csvPath, 'utf8')).length, 2);
  } finally {
    journal?.close(); writer?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

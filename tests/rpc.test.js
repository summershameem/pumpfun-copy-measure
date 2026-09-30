import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PROGRAM, curveAddress, encode58, decode58, programAddress, validAddress } from '../src/address.js';
import { Rpc, decodeCurve, decodeMint } from '../src/rpc.js';
import { Metadata, isCreationTransaction } from '../src/metadata.js';

const MINT = 'So11111111111111111111111111111111111111112';
const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
function account(data, owner = PROGRAM) { return { owner, data: [data.toString('base64'), 'base64'] }; }
function curve({ complete = false, quote = false } = {}) {
  const data = Buffer.alloc(151);
  createHash('sha256').update('account:BondingCurve').digest().copy(data, 0, 0, 8);
  data.writeBigUInt64LE(1_000_000_000_000n, 8);
  data.writeBigUInt64LE(30_000_000_000n, 16);
  data.writeBigUInt64LE(750_000_000_000n, 24);
  data.writeBigUInt64LE(4_000_000_000n, 32);
  data[48] = complete ? 1 : 0;
  data[83] = quote ? 1 : 0;
  return account(data);
}
function mintAccount() {
  const data = Buffer.alloc(82); data[44] = 6; data[45] = 1;
  return account(data, TOKEN);
}
const response = result => ({ ok: true, json: async () => ({ result }) });

test('native public address derivation matches official Pump global fixture', () => {
  assert.equal(programAddress([Buffer.from('global')]), '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf');
  assert.equal(curveAddress(MINT), '6PiyjiAPkp2KdZtqkyQYzVsD1Prv7t8v4TaYd8ip4YFd');
  assert.equal(validAddress(PROGRAM), true);
  assert.equal(validAddress('0'.repeat(44)), false);
  assert.equal(validAddress('1'.repeat(33)), false);
  assert.equal(validAddress('1'.repeat(32)), true);
  for (const bytes of [Buffer.alloc(32), Buffer.from([0, 0, 1, 255]), Buffer.from([255])]) {
    assert.deepEqual(decode58(encode58(bytes)), bytes);
  }
});

test('curve decoder uses actual mint decimals and fails closed for invalid/migrated/custom quotes', () => {
  assert.equal(decodeMint(mintAccount()), 6);
  const value = decodeCurve(curve(), 6);
  assert.equal(value.price, 0.00003);
  assert.equal(value.realSol, 4);
  assert.equal(value.virtualSol, 30);
  assert.equal(decodeCurve(curve(), 9).price, 0.03);
  assert.equal(decodeCurve(curve({ complete: true }), 6).price, undefined);
  assert.equal(decodeCurve(curve({ quote: true }), 6).error, 'non_sol_quote');
  assert.equal(decodeCurve(null, 6).price, undefined);
  assert.equal(decodeCurve({ ...curve(), owner: TOKEN }, 6).price, undefined);
  const legacy = Buffer.from(curve().data[0], 'base64').subarray(0, 49);
  assert.equal(decodeCurve(account(legacy), 6).price, value.price);
  assert.throws(() => decodeMint({ ...mintAccount(), owner: PROGRAM }), /invalid_mint/);
});

test('readCurves batches over 100 accounts and caches verified mint decimals', async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    const addresses = body.params[0], midpoint = addresses.length / 2;
    const values = calls.length <= 2
      ? addresses.map((_, i) => i < midpoint ? curve() : mintAccount())
      : addresses.map(() => curve());
    return response({ context: { slot: 123 }, value: values });
  };
  const rpc = new Rpc({ apiKey: 'test', rps: 10000, fetchImpl });
  const mints = Array.from({ length: 55 }, (_, i) => {
    const bytes = Buffer.alloc(32); bytes.writeUInt32LE(i + 1); return encode58(bytes);
  });
  const values = await rpc.readCurves(mints);
  assert.equal(values.size, 55);
  assert.deepEqual(calls.map(call => call.params[0].length), [100, 10]);
  for (const value of values.values()) {
    assert.equal(value.price, 0.00003); assert.equal(value.slot, 123);
    assert.ok(value.receivedAt >= value.requestedAt);
  }
  await rpc.readCurves(mints.slice(0, 1));
  assert.equal(calls[2].params[0].length, 1);
  rpc.close();
});

test('RPC allows only named read methods and sanitizes provider failures', async () => {
  const rpc = new Rpc({ apiKey: 'test-secret', fetchImpl: async () => ({
    ok: false, status: 401, headers: { get: () => null },
  }) });
  await assert.rejects(rpc.call('notAllowed', []), /not read-only allowed/);
  await assert.rejects(rpc.call('getAccountInfo', [MINT]), { message: 'RPC HTTP 401' });
  rpc.close();
});

test('429 retry waits, retries once, and records the successful attempt time', async () => {
  const attempts = [];
  const rpc = new Rpc({ apiKey: 'test', rps: 10000, fetchImpl: async () => {
    attempts.push(Date.now());
    return attempts.length === 1
      ? { ok: false, status: 429, headers: { get: () => '0' } } : response('ok');
  } });
  const value = await rpc.request('getAccountInfo', [MINT]);
  assert.equal(value.result, 'ok');
  assert.equal(attempts.length, 2);
  assert.ok(attempts[1] - attempts[0] >= 450);
  assert.equal(value.requestedAt, attempts[1]);
  rpc.close();
});

function creationTransaction(blockTime = 100) {
  const data = createHash('sha256').update('global:create_v2').digest().subarray(0, 8);
  return { blockTime, meta: { err: null }, transaction: { message: {
    accountKeys: [MINT, PROGRAM], instructions: [{ programId: PROGRAM,
      accounts: [MINT], data: encode58(data) }],
  } } };
}

test('metadata verifies creation instead of assuming oldest truncated history means birth', async () => {
  let transactions = 0;
  const rpc = { call: async method => {
    if (method === 'getTransaction') { transactions++; return creationTransaction(); }
    return [{ signature: '2'.repeat(88) }, { signature: '3'.repeat(88) }];
  } };
  const metadata = new Metadata(rpc, { maxPages: 2, pageSize: 2 });
  const partial = await metadata.creation(MINT);
  assert.equal(partial.tokenCreatedAt, null);
  assert.equal(partial.tokenAgeSource, 'history_scan_limit');
  assert.equal(transactions, 0);
  assert.equal(isCreationTransaction(creationTransaction(), MINT), true);
  assert.equal(isCreationTransaction({ ...creationTransaction(), meta: { err: {} } }, MINT), false);
});

test('metadata returns chain-referenced token age and leader status', async () => {
  const creationSignature = '2'.repeat(88), leaderSignature = '3'.repeat(88);
  const metadata = new Metadata({ call: async (_method, [signature]) =>
    signature === creationSignature ? creationTransaction(100) : { blockTime: 115, meta: { err: null } } });
  metadata.setCreation({ mint: MINT, signature: creationSignature }, 100100);
  const result = await metadata.enrich(MINT, leaderSignature, 116000);
  assert.equal(result.tokenAgeSeconds, 15);
  assert.equal(result.leaderBlockTime, 115000);
  assert.equal(result.leaderTransactionStatus, 'confirmed');
});

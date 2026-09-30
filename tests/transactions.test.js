import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encode58, decode58, PROGRAM } from '../src/address.js';
import { decodeTransaction } from '../src/transactions.js';

const address = number => encode58(Buffer.alloc(32, number));
const tag = name => createHash('sha256').update(name).digest().subarray(0, 8);
const SYSTEM = '11111111111111111111111111111111';
function fixture(direction = 'buy', name = direction) {
  const mint = address(3), user = address(7), curve = address(4), associatedUser = address(6);
  const accounts = [address(1), address(2), mint, curve, address(5), associatedUser,
    user, SYSTEM, address(8)];
  const keys = [...accounts, PROGRAM];
  const token = (index, owner, amount, tokenMint = mint) => ({ accountIndex: index, owner,
    mint: tokenMint, uiTokenAmount: { amount: String(amount), decimals: 6 } });
  const before = direction === 'buy' ? 0n : 100000000n, after = direction === 'buy' ? 100000000n : 0n;
  const preBalances = keys.map(() => 2000000), postBalances = [...preBalances];
  preBalances[3] = 30000000000; postBalances[3] = direction === 'buy' ? 31000000000 : 29000000000;
  preBalances[6] = 100000000000; postBalances[6] = direction === 'buy' ? 98990000000 : 100990000000;
  const instruction = { programId: PROGRAM, accounts,
    data: encode58(Buffer.concat([tag(`global:${name}`), Buffer.alloc(16)])) };
  const tx = { transaction: { message: { accountKeys: keys.map(pubkey => ({ pubkey })),
    instructions: [instruction] } }, meta: { err: null, preBalances, postBalances,
    preTokenBalances: [token(5, user, before)], postTokenBalances: [token(5, user, after)],
    innerInstructions: [], logMessages: [] } };
  return { tx, mint, user, curve, associatedUser, instruction, keys, token };
}
function eventData(f, { sol = 950000000n, tokens = 100000000n, buy = true } = {}) {
  const data = Buffer.alloc(129); tag('event:TradeEvent').copy(data);
  decode58(f.mint).copy(data, 8); data.writeBigUInt64LE(sol, 40);
  data.writeBigUInt64LE(tokens, 48); data[56] = Number(buy); decode58(f.user).copy(data, 57);
  data.writeBigInt64LE(1700000000n, 89); data.writeBigUInt64LE(40000000000n, 97);
  data.writeBigUInt64LE(1000000000000n, 105); data.writeBigUInt64LE(10000000000n, 113);
  return data;
}
const decode = f => decodeTransaction(f.tx, 'signature', 1234);

test('scoped buy fallback uses curve SOL, never wallet balance including fees', () => {
  const f = fixture(); const events = decode(f);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { signature: 'signature', detectedAt: 1234, mint: f.mint,
    traderPublicKey: f.user, txType: 'buy', eventIndex: '0', pool: 'pump',
    solAmount: 1, tokenAmount: 100, amountSource: 'scoped_balance_delta' });
});

test('sell has positive size, direction from token loss and fee-independent curve proceeds', () => {
  const f = fixture('sell'); const [event] = decode(f);
  assert.equal(event.txType, 'sell'); assert.equal(event.solAmount, 1); assert.equal(event.tokenAmount, 100);
});

test('failed transaction, unrelated program and unrecognized Pump instructions yield no trades', () => {
  const f = fixture(); f.tx.meta.err = { InstructionError: [0, 'Custom'] }; assert.deepEqual(decode(f), []);
  f.tx.meta.err = null; f.instruction.programId = SYSTEM; assert.deepEqual(decode(f), []);
  f.instruction.programId = PROGRAM; f.instruction.data = encode58(tag('global:create'));
  assert.deepEqual(decode(f), []);
});

test('real Pump log stack validates event source and exact event size beats fallback', () => {
  const f = fixture();
  f.tx.meta.logMessages = [`Program ${PROGRAM} invoke [1]`, `Program ${SYSTEM} invoke [2]`,
    `Program data: ${eventData(f, { sol: 999000000000n }).toString('base64')}`,
    `Program ${SYSTEM} success`, `Program data: ${eventData(f).toString('base64')}`,
    `Program ${PROGRAM} success`];
  const [event] = decode(f);
  assert.equal(event.solAmount, 0.95); assert.equal(event.curveRealSol, 10);
  assert.equal(event.curveVirtualSol, 40); assert.equal(event.amountSource, 'pump_trade_event');
});

test('Anchor event CPI decodes and duplicate log/CPI event is only emitted once', () => {
  const f = fixture(); const data = eventData(f);
  f.tx.meta.innerInstructions = [{ index: 0, instructions: [{ programId: PROGRAM,
    accounts: [address(10)], data: encode58(Buffer.concat([
      Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]), data])) }] }];
  assert.equal(decode(f)[0].solAmount, 0.95);
  f.tx.meta.logMessages = [`Program ${PROGRAM} invoke [1]`, `Program data: ${data.toString('base64')}`,
    `Program ${PROGRAM} success`];
  assert.equal(decode(f).length, 1);
});

test('unrelated token transfers and other owners never become copy leaders', () => {
  const f = fixture(), otherUser = address(19), otherMint = address(20);
  f.tx.transaction.message.accountKeys.push({ pubkey: address(21) }, { pubkey: address(22) });
  f.tx.meta.preTokenBalances.push(f.token(10, otherUser, 0), f.token(11, f.user, 0, otherMint));
  f.tx.meta.postTokenBalances.push(f.token(10, otherUser, 1000000000), f.token(11, f.user, 500000000, otherMint));
  const events = decode(f); assert.equal(events.length, 1);
  assert.equal(events[0].traderPublicKey, f.user); assert.equal(events[0].mint, f.mint);
});

test('owner balances aggregate exactly across duplicate token accounts', () => {
  const f = fixture(), huge = 900719925474099300n;
  f.tx.transaction.message.accountKeys.push({ pubkey: address(21) });
  f.tx.meta.preTokenBalances[0].uiTokenAmount.amount = String(huge);
  f.tx.meta.postTokenBalances[0].uiTokenAmount.amount = String(huge + 5n);
  f.tx.meta.preTokenBalances.push(f.token(10, f.user, 100));
  f.tx.meta.postTokenBalances.push(f.token(10, f.user, 98));
  assert.equal(decode(f)[0].tokenAmount, 0.000003);
  f.tx.meta.postTokenBalances[1].uiTokenAmount.amount = '95';
  assert.deepEqual(decode(f), [], 'a transfer between own accounts is not a buy');
});

test('inner Pump instructions and raw v0 lookup table account indices are decoded', () => {
  const f = fixture('buy', 'buy_exact_sol_in');
  const pump = { programIdIndex: 9, accounts: f.keys.slice(0, 9).map((_, index) => index),
    data: f.instruction.data };
  f.tx.transaction.message.accountKeys = f.keys.slice(0, 7);
  f.tx.meta.loadedAddresses = { writable: [SYSTEM, f.keys[8]], readonly: [PROGRAM] };
  f.tx.transaction.message.instructions = [{ programId: SYSTEM, accounts: [] }];
  f.tx.meta.innerInstructions = [{ index: 0, instructions: [pump] }];
  assert.equal(decode(f)[0].eventIndex, '0.0');
});

test('multiple identical-owner instructions require individual events, not repeated aggregate fills', () => {
  const f = fixture(); f.tx.transaction.message.instructions.push({ ...f.instruction });
  assert.deepEqual(decode(f), []);
  f.tx.meta.logMessages = [`Program ${PROGRAM} invoke [1]`,
    `Program data: ${eventData(f, { sol: 500000000n, tokens: 50000000n }).toString('base64')}`,
    `Program ${PROGRAM} success`, `Program ${PROGRAM} invoke [1]`,
    `Program data: ${eventData(f, { sol: 450000000n, tokens: 50000000n }).toString('base64')}`,
    `Program ${PROGRAM} success`];
  assert.deepEqual(decode(f).map(event => event.solAmount), [0.5, 0.45]);
});

test('creation rent and missing lamport balances produce unknown SOL instead of zero', () => {
  const f = fixture(); f.tx.meta.preBalances[3] = 0;
  assert.equal(decode(f)[0].solAmount, null);
  delete f.tx.meta.preBalances; assert.equal(decode(f)[0].solAmount, null);
});

test('v2 account positions are recognized and non-SOL quotes are excluded', () => {
  const f = fixture('buy', 'buy_v2');
  const accounts = Array.from({ length: 27 }, (_, i) => address(i + 30));
  accounts[1] = f.mint; accounts[2] = SYSTEM; accounts[10] = f.curve;
  accounts[13] = f.user; accounts[14] = f.associatedUser; f.instruction.accounts = accounts;
  assert.equal(decode(f)[0].mint, f.mint);
  accounts[2] = address(60); assert.deepEqual(decode(f), []);
});

test('buy and sell sharing a curve do not turn net lamport change into an exact buy size', () => {
  const f = fixture();
  f.tx.transaction.message.instructions.push({ ...f.instruction,
    data: encode58(Buffer.concat([tag('global:sell'), Buffer.alloc(16)])) });
  assert.deepEqual(decode(f), [], 'ambiguous buy/sell aggregation requires exact events');
});

test('new or closed associated token accounts obtain ownership from the available side', () => {
  const buy = fixture(); buy.tx.meta.preTokenBalances = [];
  assert.equal(decode(buy)[0].tokenAmount, 100);
  const sell = fixture('sell'); sell.tx.meta.postTokenBalances = [];
  assert.equal(decode(sell)[0].tokenAmount, 100);
});

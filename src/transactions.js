import { createHash } from 'node:crypto';
import { decode58, encode58, PROGRAM } from './address.js';

// Read-only decoding. Layouts come from pump-fun/pump-public-docs/idl/pump.json.
const discriminator = name => createHash('sha256').update(name).digest().subarray(0, 8);
const TRADE = discriminator('event:TradeEvent');
const EVENT_CPI = Buffer.from([228, 69, 165, 46, 81, 203, 154, 29]);
const SOL_QUOTES = new Set(['11111111111111111111111111111111',
  'So11111111111111111111111111111111111111112']);
const INSTRUCTIONS = ['buy', 'buy_exact_sol_in', 'buy_v2', 'buy_exact_quote_in_v2',
  'sell', 'sell_v2'].map(name => ({ name, tag: discriminator(`global:${name}`),
  direction: name.startsWith('buy') ? 'buy' : 'sell', v2: name.endsWith('_v2') }));
const keyText = key => typeof key === 'string' ? key : key?.pubkey;
const groupKey = (owner, mint) => `${owner}:${mint}`;

function accountKeys(tx) {
  const keys = (tx.transaction?.message?.accountKeys || []).map(keyText);
  // jsonParsed normally already expands lookup-table keys; raw v0 messages do not.
  for (const key of [...(tx.meta?.loadedAddresses?.writable || []),
    ...(tx.meta?.loadedAddresses?.readonly || [])]) if (!keys.includes(key)) keys.push(key);
  return keys;
}

function instructions(tx, keys) {
  const inner = new Map((tx.meta.innerInstructions || []).map(group => [group.index, group.instructions]));
  const result = [];
  const add = (instruction, index) => {
    const program = keyText(instruction.programId) || keys[instruction.programIdIndex];
    if (program !== PROGRAM || typeof instruction.data !== 'string') return;
    try {
      result.push({ data: decode58(instruction.data), index,
        accounts: (instruction.accounts || []).map(account =>
          typeof account === 'number' ? keys[account] : keyText(account)) });
    } catch { /* Malformed or parsed instructions are not evidence of a trade. */ }
  };
  for (const [index, instruction] of (tx.transaction?.message?.instructions || []).entries()) {
    add(instruction, String(index));
    for (const [position, child] of (inner.get(index) || []).entries()) add(child, `${index}.${position}`);
  }
  return result;
}

function balanceChanges(tx, keys) {
  const accounts = new Map(), groups = new Map();
  for (const [side, balances] of [['pre', tx.meta.preTokenBalances], ['post', tx.meta.postTokenBalances]]) {
    for (const balance of balances || []) {
      const ui = balance.uiTokenAmount;
      if (!/^\d+$/.test(ui?.amount ?? '') || !Number.isInteger(ui.decimals) ||
        ui.decimals < 0 || ui.decimals > 18) continue;
      let record = accounts.get(balance.accountIndex);
      if (!record) { record = { pre: 0n, post: 0n }; accounts.set(balance.accountIndex, record); }
      if ((record.mint && record.mint !== balance.mint) ||
        (record.owner && balance.owner && record.owner !== balance.owner) ||
        (record.decimals !== undefined && record.decimals !== ui.decimals)) record.invalid = true;
      record.mint = balance.mint; record.owner ||= balance.owner;
      record.decimals = ui.decimals; record[side] = BigInt(ui.amount);
    }
  }
  const byAddress = new Map();
  for (const [index, record] of accounts) {
    if (record.invalid || !record.owner || !record.mint) continue;
    record.delta = record.post - record.pre; byAddress.set(keys[index], record);
    const key = groupKey(record.owner, record.mint), group = groups.get(key);
    if (group) {
      if (group.decimals !== record.decimals) group.invalid = true;
      group.delta += record.delta;
    } else groups.set(key, { delta: record.delta, decimals: record.decimals });
  }
  return { groups, byAddress };
}

function parseEvent(data) {
  // The original TradeEvent prefix is stable; ignore later versioned extensions.
  if (data.length < 129 || !data.subarray(0, 8).equals(TRADE) || data[56] > 1) return null;
  return { mint: encode58(data.subarray(8, 40)), solAmount: Number(data.readBigUInt64LE(40)) / 1e9,
    rawTokens: data.readBigUInt64LE(48), txType: data[56] ? 'buy' : 'sell',
    traderPublicKey: encode58(data.subarray(57, 89)),
    curveVirtualSol: Number(data.readBigUInt64LE(97)) / 1e9,
    curveRealSol: Number(data.readBigUInt64LE(113)) / 1e9,
    fingerprint: data.subarray(8, 129).toString('hex') };
}

function loggedEvents(tx) {
  const stack = [], result = [];
  for (const line of tx.meta.logMessages || []) {
    const invoke = /^Program (\w+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) { stack.length = Math.max(0, Number(invoke[2]) - 1); stack.push(invoke[1]); continue; }
    const end = /^Program (\w+) (?:success|failed:.*)$/.exec(line);
    if (end) { const index = stack.lastIndexOf(end[1]); if (index >= 0) stack.length = index; continue; }
    const match = /^Program data: ([A-Za-z0-9+/]+={0,2})$/.exec(line);
    if (match && stack.at(-1) === PROGRAM) {
      const event = parseEvent(Buffer.from(match[1], 'base64'));
      if (event) result.push(event);
    }
  }
  return result;
}

function exactEvents(tx, items) {
  const logs = loggedEvents(tx), cpi = [];
  for (const instruction of items) if (instruction.data.subarray(0, 8).equals(EVENT_CPI)) {
    const event = parseEvent(instruction.data.subarray(8)); if (event) cpi.push(event);
  }
  // One trade may appear in both logs and Anchor's event CPI. Preserve genuine repeats.
  const counts = new Map();
  for (const event of logs) counts.set(event.fingerprint, (counts.get(event.fingerprint) || 0) + 1);
  for (const event of cpi) {
    const count = counts.get(event.fingerprint) || 0;
    if (count) counts.set(event.fingerprint, count - 1); else logs.push(event);
  }
  return logs;
}

function matchingTrades(items, balances) {
  const trades = [];
  for (const item of items) {
    const schema = INSTRUCTIONS.find(value => item.data.subarray(0, 8).equals(value.tag));
    if (!schema) continue;
    const { accounts } = item, mint = accounts[schema.v2 ? 1 : 2];
    const user = accounts[schema.v2 ? 13 : 6], associatedUser = accounts[schema.v2 ? 14 : 5];
    if (schema.v2 && !SOL_QUOTES.has(accounts[2])) continue;
    const account = balances.byAddress.get(associatedUser);
    const balance = balances.groups.get(groupKey(user, mint));
    if (!account || account.owner !== user || account.mint !== mint || !balance || balance.invalid) continue;
    trades.push({ mint, user, direction: schema.direction, balance, index: item.index,
      curve: accounts[schema.v2 ? 10 : 3], associatedUser, accounts, used: false,
      eligible: schema.direction === 'buy' ? balance.delta > 0n : balance.delta < 0n });
  }
  return trades;
}

function curveAmount(tx, keys, trade, allTrades) {
  if (allTrades.filter(other => other.curve === trade.curve).length !== 1) return null;
  const index = keys.indexOf(trade.curve), pre = tx.meta.preBalances?.[index], post = tx.meta.postBalances?.[index];
  // No curve creation/closure rent and no precision-losing JSON lamport values.
  if (!Number.isSafeInteger(pre) || !Number.isSafeInteger(post) || pre <= 0 || post <= 0) return null;
  const change = BigInt(post) - BigInt(pre);
  if ((trade.direction === 'buy' && change <= 0n) || (trade.direction === 'sell' && change >= 0n)) return null;
  return Number(change < 0n ? -change : change) / 1e9;
}

export function decodeTransaction(tx, signature, detectedAt = Date.now()) {
  if (!tx?.meta || tx.meta.err || !tx.transaction?.message) return [];
  const keys = accountKeys(tx), items = instructions(tx, keys), balances = balanceChanges(tx, keys);
  const trades = matchingTrades(items, balances), result = [];
  const append = (trade, fields) => result.push({ signature, detectedAt, mint: trade.mint,
    traderPublicKey: trade.user, txType: trade.direction, eventIndex: trade.index, pool: 'pump', ...fields });
  for (const event of exactEvents(tx, items)) {
    const trade = trades.find(value => value.eligible && !value.used && value.mint === event.mint &&
      value.user === event.traderPublicKey && value.direction === event.txType);
    if (!trade || !event.rawTokens) continue;
    trade.used = true;
    append(trade, { solAmount: event.solAmount,
      tokenAmount: Number(event.rawTokens) / 10 ** trade.balance.decimals,
      curveRealSol: event.curveRealSol, curveVirtualSol: event.curveVirtualSol,
      amountSource: 'pump_trade_event' });
  }
  for (const trade of trades) {
    if (!trade.eligible || trade.used ||
      trades.filter(other => other.user === trade.user && other.mint === trade.mint).length !== 1) continue;
    const amount = trade.balance.delta < 0n ? -trade.balance.delta : trade.balance.delta;
    append(trade, { solAmount: curveAmount(tx, keys, trade, trades),
      tokenAmount: Number(amount) / 10 ** trade.balance.decimals, amountSource: 'scoped_balance_delta' });
  }
  return result;
}

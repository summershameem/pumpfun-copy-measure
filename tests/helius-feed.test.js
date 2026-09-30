import test from 'node:test';
import assert from 'node:assert/strict';
import { HeliusFeed } from '../src/helius-feed.js';
import { encode58 } from '../src/address.js';

class FakeSocket extends EventTarget {
  constructor() { super(); this.readyState = 0; this.sent = []; }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
  send(data) { this.sent.push(JSON.parse(data)); }
  frame(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
}
const address = n => { const bytes = Buffer.alloc(32); bytes.writeUInt32LE(n); return encode58(bytes); };
const flush = () => new Promise(resolve => setImmediate(resolve));
function setup(leaderCount = 23, mints = [101, 102, 103]) {
  const wanted = new Set(mints.map(address)), coverage = [], gaps = [], events = [], curves = [];
  const rpc = { call: async () => ({ meta: { err: null } }) };
  const feed = new HeliusFeed({ apiKey: 'secret', wallets: Array.from({ length: leaderCount }, (_, i) => address(i + 1)),
    tokens: () => wanted, onEvent: (...args) => events.push(args), onGap: (...args) => gaps.push(args),
    onCoverage: (...args) => coverage.push(args), onCurve: (...args) => curves.push(args), rpc,
    decodeTransaction: () => [{ txType: 'buy', mint: address(101) }], WebSocketImpl: FakeSocket });
  feed.start(); feed.socket.open();
  return { feed, wanted, coverage, gaps, events, curves, rpc };
}
function ackSubscriptions(feed) {
  for (const [id, request] of [...feed.requests]) {
    if (request.kind === 'subscribe') feed.socket.frame({ id, result: id + 1000 });
  }
}

test('25 cap includes pending subscriptions; one curve subscription per token, coverage on its ACK', () => {
  const { feed, coverage } = setup();
  try {
    assert.equal(feed.slots.size, 25);
    assert.equal(feed.requests.size, 25);
    assert.equal(feed.socket.sent.length, 25);
    assert.ok(feed.socket.sent.every(message => message.method !== 'logsSubscribe' ||
      message.params[0].mentions.length === 1));
    // No per-token logs subscriptions: copier flow is derived from curve reserve deltas.
    assert.equal(feed.socket.sent.filter(message => message.method === 'accountSubscribe').length, 2);
    const curve = [...feed.requests].find(([, request]) => request.entry.mint === address(101));
    assert.equal(feed.coverage.get(address(101)), 'pending');
    feed.socket.frame({ id: curve[0], result: 2001 });
    assert.equal(feed.coverage.get(address(101)), 'active');
    assert.equal(feed.coverage.get(address(103)), 'capacity');
    assert.equal(coverage.filter(([mint, status]) => mint === address(101) && status === 'active').length, 1);
  } finally { feed.stop(); }
});

test('expired token releases no capacity until its unsubscribe acknowledgment; FIFO next token wins', () => {
  const { feed, wanted } = setup();
  try {
    ackSubscriptions(feed);
    wanted.delete(address(101)); feed.reconcile();
    const unsubscribe = [...feed.requests].filter(([, request]) => request.kind === 'unsubscribe');
    assert.equal(unsubscribe.length, 1); assert.equal(feed.slots.size, 25);
    assert.equal(feed.slots.has(`curve:${address(103)}`), false);
    feed.socket.frame({ id: unsubscribe[0][0], result: true });
    assert.equal(feed.slots.size, 25);
    assert.equal(feed.slots.has(`curve:${address(101)}`), false);
    assert.equal(feed.slots.has(`curve:${address(103)}`), true);
    assert.ok([...feed.requests.values()].every(request => request.entry.mint === address(103)));
  } finally { feed.stop(); }
});

test('expired subscribe awaiting ACK stays occupied and unsubscribes as soon as acknowledged', () => {
  const { feed, wanted } = setup();
  try {
    wanted.delete(address(101)); feed.reconcile();
    assert.equal(feed.slots.size, 25);
    ackSubscriptions(feed);
    assert.equal(feed.slots.size, 25);
    assert.equal([...feed.requests.values()].filter(request => request.kind === 'unsubscribe').length, 1);
  } finally { feed.stop(); }
});

test('connection drop marks gaps and fresh connection resubscribes within cap', () => {
  const { feed, gaps } = setup();
  try {
    ackSubscriptions(feed); feed.socket.close();
    assert.equal(feed.slots.size, 0);
    assert.ok(gaps.some(([reason]) => reason === 'websocket_disconnected'));
    assert.equal(feed.coverage.get(address(101)), 'gap');
    clearTimeout(feed.retryTimer); feed.connect(); feed.socket.open();
    assert.equal(feed.slots.size, 25);
    assert.equal(feed.socket.sent.length, 25);
  } finally { feed.stop(); }
});

test('same signature across wallet/token logs fetches once; decoded event records honest detection time', async () => {
  const { feed, events, rpc, curves } = setup(1, [101]);
  try {
    ackSubscriptions(feed);
    let reads = 0;
    rpc.call = async () => { reads++; return { meta: { err: null } }; };
    const logs = [...feed.slots.values()].filter(entry => entry.type !== 'curve');
    for (const entry of logs) feed.socket.frame({ method: 'logsNotification', params: {
      subscription: entry.subscription, result: { context: { slot: 1 }, value: { signature: 'test-signature', err: null } },
    } });
    await flush();
    assert.equal(reads, 1); assert.equal(events.length, 1);
    assert.equal(events[0][0].decodeDelayMs, events[0][1] - events[0][0].notificationAt);
    assert.ok(rpc.transactionCache.has('test-signature'));
    const curve = [...feed.slots.values()].find(entry => entry.type === 'curve');
    feed.socket.frame({ method: 'accountNotification', params: { subscription: curve.subscription,
      result: { context: { slot: 20 }, value: { data: ['AAAA', 'base64'] } } } });
    assert.equal(curves.length, 1); assert.equal(curves[0][2].slot, 20);
    feed.socket.frame({ method: 'logsNotification', params: { subscription: logs[0].subscription,
      result: { value: { signature: 'failed', err: { failed: true } } } } });
    await flush(); assert.equal(reads, 1);
  } finally { feed.stop(); }
});

test('rejected subscriptions conservatively close; rate errors impose 30s reconnect floor', () => {
  const { feed, gaps } = setup(1, []);
  try {
    const [id] = feed.requests.keys();
    feed.socket.frame({ id, error: { code: 429, message: 'do-not-log-secret' } });
    assert.equal(feed.socket, null);
    assert.equal(feed.minimumRetry, 30000);
    assert.ok(gaps.some(([reason]) => reason === 'subscription_rejected'));
  } finally { feed.stop(); }
});

test('transaction queue bounds work and records dropped coverage', () => {
  const { feed, gaps } = setup(1, []);
  try {
    feed.pending = 1000; feed.readTransaction('overflow', Date.now());
    assert.equal(feed.seen.has('overflow'), false);
    assert.ok(gaps.some(([reason]) => reason === 'transaction_queue_overflow'));
  } finally { feed.stop(); }
});

test('leader log notifications without the Pump program are not fetched', async () => {
  const { feed, rpc } = setup(1, [101]);
  try {
    ackSubscriptions(feed);
    let reads = 0; rpc.call = async () => { reads++; return { meta: { err: null } }; };
    const leader = [...feed.slots.values()].find(entry => entry.type === 'leader');
    feed.socket.frame({ method: 'logsNotification', params: { subscription: leader.subscription,
      result: { value: { signature: 'sig-raydium', err: null, logs: ['Program 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8 invoke [1]'] } } } });
    feed.socket.frame({ method: 'logsNotification', params: { subscription: leader.subscription,
      result: { value: { signature: 'sig-pump', err: null, logs: ['Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [1]'] } } } });
    await flush(); await flush();
    assert.equal(reads, 1); assert.equal(feed.skipped, 1);
  } finally { feed.stop(); }
});

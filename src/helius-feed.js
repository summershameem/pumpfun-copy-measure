import { curveAddress, PROGRAM } from './address.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export class HeliusFeed {
  #url;
  constructor({ apiKey, wallets, tokens, onEvent, onGap, onCoverage = () => {},
    onCurve = () => {}, rpc, log = () => {}, decodeTransaction, WebSocketImpl = globalThis.WebSocket }) {
    this.wallets = [...new Set(wallets)];
    if (!apiKey || this.wallets.length > 24) throw Error('Helius feed requires API key and at most 24 leaders');
    this.#url = `wss://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(apiKey)}`;
    Object.assign(this, { tokens, onEvent, onGap, onCoverage, onCurve, rpc, log, decodeTransaction, WebSocketImpl });
    this.slots = new Map(); this.requests = new Map(); this.coverage = new Map();
    this.waiting = new Map(); this.seen = new Map(); this.pending = 0;
    this.sequence = 0; this.failures = 0; this.stopped = false;
    this.rpc.transactionCache ??= new Map();
  }

  start() { this.stopped = false; this.connect(); }
  connect() {
    if (this.stopped) return;
    let ws;
    try { ws = new this.WebSocketImpl(this.#url); }
    catch { this.log('Helius WebSocket connection failed'); this.scheduleReconnect(); return; }
    this.socket = ws; this.openedAt = 0; this.minimumRetry = 0;
    this.connectTimer = setTimeout(() => this.fail('websocket_connect_timeout'), 20000);
    ws.addEventListener('open', () => {
      if (ws !== this.socket || this.stopped) return;
      clearTimeout(this.connectTimer); this.openedAt = Date.now();
      this.log('Helius WebSocket connected; subscription limit 25');
      this.reconcile(); this.tick = setInterval(() => this.reconcile(), 100);
    });
    ws.addEventListener('message', event => {
      if (ws !== this.socket || this.stopped) return;
      try { this.message(JSON.parse(String(event.data)), Date.now()); }
      catch { this.fail('websocket_invalid_message'); }
    });
    ws.addEventListener('error', () => {
      if (ws === this.socket) this.fail('websocket_transport_error');
    });
    ws.addEventListener('close', () => {
      if (ws !== this.socket) return;
      clearTimeout(this.connectTimer); clearInterval(this.tick);
      this.socket = null; this.slots.clear(); this.requests.clear();
      if (this.stopped) return;
      this.onGap('websocket_disconnected', Date.now());
      for (const mint of this.tokens()) this.report(mint, 'gap');
      if (this.openedAt && Date.now() - this.openedAt > 60000) this.failures = 0;
      this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.stopped) return;
    const delay = Math.max(this.minimumRetry || 0,
      Math.min(60000, 1000 * 2 ** Math.min(this.failures++, 6))) + Math.random() * 500;
    this.log(`Helius WebSocket reconnect in ${Math.ceil(delay / 1000)}s`);
    clearTimeout(this.retryTimer); this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  fail(reason, rateLimited = false) {
    if (!this.socket || this.stopped || this.socket.readyState > 1) return;
    this.minimumRetry = Math.max(this.minimumRetry || 0, rateLimited ? 30000 : 0);
    this.log(`Helius feed gap: ${reason}`); this.onGap(reason, Date.now());
    this.socket.close();
  }

  report(mint, status) {
    if (this.coverage.get(mint) === status) return;
    this.coverage.set(mint, status); this.onCoverage(mint, status, Date.now());
  }

  send(method, params, entry, kind) {
    const id = ++this.sequence;
    this.requests.set(id, { entry, kind, sentAt: Date.now() });
    try { this.socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params })); }
    catch { this.fail('websocket_send_failed'); }
  }

  subscribe(key, type, address, mint = null) {
    if (this.slots.size >= 25 || this.slots.has(key)) return;
    const entry = { key, type, address, mint, state: 'pending', subscription: null };
    this.slots.set(key, entry); // Reserve before sending, including requests without an ACK.
    this.send(type === 'curve' ? 'accountSubscribe' : 'logsSubscribe',
      type === 'curve' ? [address, { encoding: 'base64', commitment: 'confirmed' }]
        : [{ mentions: [address] }, { commitment: 'confirmed' }], entry, 'subscribe');
  }

  unsubscribe(entry) {
    if (entry.state !== 'active') return;
    entry.state = 'closing';
    this.send(entry.type === 'curve' ? 'accountUnsubscribe' : 'logsUnsubscribe',
      [entry.subscription], entry, 'unsubscribe');
    // The slot remains occupied until a successful unsubscribe ACK.
  }

  reconcile() {
    if (this.stopped || this.socket?.readyState !== 1) return;
    if ([...this.requests.values()].some(request => Date.now() - request.sentAt > 20000)) {
      this.fail('subscription_ack_timeout'); return;
    }
    const wanted = this.tokens();
    for (const entry of this.slots.values()) {
      if (entry.mint && !wanted.has(entry.mint)) this.unsubscribe(entry);
    }
    for (const mint of this.waiting.keys()) {
      if (!wanted.has(mint)) { this.waiting.delete(mint); this.coverage.delete(mint); }
    }
    for (const mint of wanted) if (!this.waiting.has(mint)) this.waiting.set(mint, true);
    for (const wallet of this.wallets) this.subscribe(`leader:${wallet}`, 'leader', wallet);
    for (const mint of this.waiting.keys()) {
      const curve = this.slots.get(`curve:${mint}`);
      if (curve) { this.report(mint, curve.state === 'active' ? 'active' : 'pending'); continue; }
      if (this.slots.size + 1 > 25) { this.report(mint, 'capacity'); continue; }
      this.report(mint, 'pending');
      // Copier flow comes from curve reserve deltas; no per-token logs subscription, no per-trade reads.
      this.subscribe(`curve:${mint}`, 'curve', curveAddress(mint), mint);
    }
  }

  message(message, at) {
    if (Object.hasOwn(message, 'id')) {
      const request = this.requests.get(message.id);
      if (!request) return;
      this.requests.delete(message.id);
      if (message.error || (request.kind === 'subscribe' && !Number.isSafeInteger(message.result)) ||
          (request.kind === 'unsubscribe' && message.result !== true)) {
        const code = Number(message.error?.code);
        this.fail('subscription_rejected', [429, -32429, -32005].includes(code)); return;
      }
      const entry = request.entry;
      if (request.kind === 'unsubscribe') this.slots.delete(entry.key);
      else {
        entry.subscription = message.result; entry.state = 'active';
        if (entry.mint && !this.tokens().has(entry.mint)) this.unsubscribe(entry);
      }
      this.reconcile(); return;
    }
    const params = message.params;
    if (!params) return;
    const entry = [...this.slots.values()].find(item => item.subscription === params.subscription);
    if (!entry || entry.state !== 'active') return;
    if (entry.mint && !this.tokens().has(entry.mint)) return;
    const result = params.result;
    if (entry.type === 'curve') {
      if (message.method === 'accountNotification') this.onCurve(entry.mint, result?.value,
        { slot: result?.context?.slot ?? null, at });
    } else if (message.method === 'logsNotification' && result?.value && !result.value.err) {
      // Leaders trade everywhere; only fetch transactions whose logs show the Pump program.
      const logs = Array.isArray(result.value.logs) ? result.value.logs : null;
      if (logs && !logs.some(line => typeof line === 'string' && line.includes(PROGRAM))) {
        this.skipped = (this.skipped ?? 0) + 1; return;
      }
      this.readTransaction(result.value.signature, at);
    }
  }

  readTransaction(signature, at) {
    if (typeof signature !== 'string' || this.seen.has(signature)) return;
    if (this.pending >= 1000) { this.onGap('transaction_queue_overflow', at); return; }
    this.seen.set(signature, at); this.pending++;
    while (this.seen.size > 10000) this.seen.delete(this.seen.keys().next().value);
    void this.fetchTransaction(signature, at).finally(() => { this.pending--; });
  }

  async fetchTransaction(signature, at) {
    try {
      let transaction = this.rpc.transactionCache.get(signature);
      for (let attempt = 0; !transaction && attempt < 3 && !this.stopped; attempt++) {
        if (attempt) await sleep(500);
        transaction = await this.rpc.call('getTransaction', [signature,
          { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }], { priority: 1 });
      }
      if (this.stopped) return;
      if (!transaction) { this.onGap('confirmed_transaction_unavailable', at); return; }
      this.rpc.transactionCache.set(signature, transaction);
      while (this.rpc.transactionCache.size > 10000)
        this.rpc.transactionCache.delete(this.rpc.transactionCache.keys().next().value);
      if (transaction.meta?.err) return;
      const decodedAt = Date.now();
      for (const event of this.decodeTransaction(transaction, signature, decodedAt))
        this.onEvent({ ...event, notificationAt: at, decodeDelayMs: decodedAt - at }, decodedAt);
    } catch {
      if (!this.stopped) { this.log('Helius transaction read/decode failed'); this.onGap('transaction_read_failed', at); }
    }
  }

  stop() {
    this.stopped = true; clearTimeout(this.retryTimer); clearTimeout(this.connectTimer);
    clearInterval(this.tick); this.socket?.close(); this.slots.clear(); this.requests.clear();
  }
}

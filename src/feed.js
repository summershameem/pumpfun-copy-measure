// One native Node WebSocket; the only outbound messages are data subscriptions.
export class Feed {
  constructor({ wallets, tokens, onEvent, onGap, onCoverage = () => {}, log, apiKey = '' }) {
    Object.assign(this, { wallets, tokens, onEvent, onGap, onCoverage, log, apiKey });
    this.stopped = false; this.failures = 0; this.current = new Set();
  }
  start() { this.connect(); }
  connect() {
    if (this.stopped) return;
    const url = new URL('wss://pumpportal.fun/api/data');
    if (this.apiKey) url.searchParams.set('api-key', this.apiKey);
    this.socket = new WebSocket(url);
    const ws = this.socket;
    this.lastMessage = Date.now(); this.openedAt = 0;
    this.connectTimer = setTimeout(() => ws.close(), 20000);
    ws.addEventListener('open', () => {
      clearTimeout(this.connectTimer); this.openedAt = Date.now();
      this.log('WebSocket connected; subscribing to leader and token data');
      this.current.clear(); this.queue = [{ method: 'subscribeNewToken' },
        { method: 'subscribeMigration' }];
      for (let i = 0; i < this.wallets.length; i += 100)
        this.queue.push({ method: 'subscribeAccountTrade', keys: this.wallets.slice(i, i + 100) });
      this.flushTimer = setInterval(() => this.flush(), 100);
    });
    ws.addEventListener('message', message => {
      this.lastMessage = Date.now();
      let event;
      try { event = JSON.parse(String(message.data)); } catch { return; }
      if (event.error || event.errors || /error|insufficient|unauthor|invalid|rate limit|fund|api.?key|required/i.test(event.message ?? '')) {
        // Server text may echo credentials. Report a classification, never the payload.
        this.log('Feed rejected a request: check PumpPortal data access/key/balance or rate limits');
        this.onGap('feed_rejected'); ws.close(); return;
      }
      if (event.txType || event.mint) this.onEvent(event, Date.now());
    });
    ws.addEventListener('error', () => { this.log('WebSocket transport error'); ws.close(); });
    ws.addEventListener('close', () => {
      clearTimeout(this.connectTimer); clearInterval(this.flushTimer);
      this.current.clear();
      if (this.stopped) return;
      this.onGap('websocket_disconnected');
      if (this.openedAt && Date.now() - this.openedAt > 60000) this.failures = 0;
      const delay = Math.min(60000, 1000 * 2 ** Math.min(this.failures++, 6)) + Math.random() * 500;
      this.log(`WebSocket disconnected; retry in ${(delay / 1000).toFixed(1)}s`);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    });
  }
  flush() {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    if (Date.now() - this.lastMessage > 90000) {
      this.log('WebSocket silent for 90s; reconnecting'); this.socket.close(); return;
    }
    if (!this.queue.length) {
      const wanted = this.tokens();
      const add = [...wanted].filter(x => !this.current.has(x)).slice(0, 100);
      const remove = [...this.current].filter(x => !wanted.has(x)).slice(0, 100);
      if (remove.length) {
        this.queue.push({ method: 'unsubscribeTokenTrade', keys: remove });
        remove.forEach(x => this.current.delete(x));
      }
      if (add.length) {
        this.queue.push({ method: 'subscribeTokenTrade', keys: add });
        add.forEach(x => this.current.add(x));
      }
    }
    const message = this.queue.shift();
    if (message) {
      this.socket.send(JSON.stringify(message));
      if (message.method === 'subscribeTokenTrade')
        message.keys.forEach(mint => this.onCoverage(mint, 'active', Date.now()));
    }
  }
  stop() {
    this.stopped = true; clearTimeout(this.retryTimer); clearTimeout(this.connectTimer);
    clearInterval(this.flushTimer); this.socket?.close();
  }
}

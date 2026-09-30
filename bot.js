import fs from 'node:fs';
import { Rpc } from './src/rpc.js';
import { Metadata } from './src/metadata.js';
import { validAddress } from './src/address.js';
import { CsvWriter } from './src/csv.js';
import { Journal, acquireLock } from './src/journal.js';
import { Tracker } from './src/tracker.js';
import { Feed } from './src/feed.js';
import { HeliusFeed } from './src/helius-feed.js';
import { decodeTransaction } from './src/transactions.js';

const log = message => console.log(`[${new Date().toISOString()}] ${message}`);
let feed, tracker, writer, journal, unlock, timer, stopped = false;
function stop(code = 0) {
  if (stopped) return; stopped = true; clearInterval(timer); feed?.stop();
  try { tracker?.stop(); journal?.close(); writer?.close(); unlock?.(); }
  catch { log('Could not finish output. Preserve pending.jsonl and copy-log.csv for recovery.'); code = 1; }
  log('Paper recorder stopped'); process.exit(code);
}
try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node.js 24 or later is required');
  const apiKey = process.env.HELIUS_API_KEY?.trim();
  if (!apiKey || apiKey === 'replace_with_your_helius_key') throw new Error('Set HELIUS_API_KEY in .env');
  const wallets = [...new Set(fs.readFileSync('wallets.txt', 'utf8').split(/\r?\n/)
    .map(line => line.replace(/#.*/, '').trim()).filter(Boolean))];
  if (!wallets.length) throw new Error('Add leader public addresses to wallets.txt');
  if (wallets.some(wallet => !validAddress(wallet))) throw new Error('wallets.txt contains an invalid public address');
  const source = process.env.FEED || 'helius';
  if (!['helius', 'pumpportal'].includes(source)) throw new Error('FEED must be helius or pumpportal');
  if (source === 'helius' && wallets.length > 23)
    throw new Error('Helius mode supports at most 23 leaders: reserve 2 of 25 subscription slots for a token');
  if (source === 'pumpportal' && !process.env.PUMPPORTAL_API_KEY?.trim())
    throw new Error('PumpPortal alternative requires PUMPPORTAL_API_KEY');
  const rps = Number(process.env.HELIUS_RPS || 8), concurrency = Number(process.env.HELIUS_CONCURRENCY || 2);
  if (!(rps >= 1 && rps <= 100) || !(concurrency >= 1 && concurrency <= 16 && Number.isInteger(concurrency)))
    throw new Error('Use HELIUS_RPS=1..100 and integer HELIUS_CONCURRENCY=1..16');
  unlock = acquireLock('run.lock'); writer = new CsvWriter('copy-log.csv');
  journal = new Journal('pending.jsonl', 'copy-log.csv', writer, log);
  const rpc = new Rpc({ apiKey, rps, concurrency, log });
  const metadata = new Metadata(rpc, { log });
  tracker = new Tracker({ wallets, rpc, metadata, writer, journal, log });
  const callbacks = { wallets, tokens: () => tracker.tokens(),
    onEvent: (event, at) => tracker.event({ ...event, feed: source }, at),
    onGap: reason => tracker.gap(reason), log,
    onCoverage: (mint, status, at) => tracker.coverage(mint, status, at) };
  feed = source === 'helius' ? new HeliusFeed({ ...callbacks, apiKey, rpc, decodeTransaction,
    onCurve: (mint, account, context) => tracker.curve(mint, account, context) })
    : new Feed({ ...callbacks, apiKey: process.env.PUMPPORTAL_API_KEY.trim() });
  log(`Paper-only recorder: ${wallets.length} leaders; stake=0.02 SOL; no transaction submission`);
  log(`Feed=${source}; Helius HTTP limit=${rps}/s; token subscription capacity=${25 - wallets.length}`);
  timer = setInterval(() => tracker.tick(), 100); feed.start();
  process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
  process.on('uncaughtException', () => { log('Fatal runtime error; flushing observations'); stop(1); });
  process.on('unhandledRejection', () => { log('Unhandled runtime failure; flushing observations'); stop(1); });
} catch (error) { log(error.message); stop(1); }

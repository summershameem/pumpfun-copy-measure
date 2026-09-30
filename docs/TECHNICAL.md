# Technical reference: Solana copy-trade measurement (paper only)

Node.js 24, native APIs, zero npm dependencies, no framework. This program only
subscribes to data and reads public accounts/transactions. It contains no wallet,
private-key handling, signing, order construction, or transaction submission.

## Run on a Mac

Install Node.js 24 if needed, then in Terminal:

```sh
unzip solana-copy-measure.zip
cd solana-copy-measure
node --version
cp .env.example .env
nano .env
nano wallets.txt
node --test
node --env-file=.env bot.js
```

Put your Helius API key in `.env` as `HELIUS_API_KEY=...`. Leave `FEED=helius`.
Replace the comments in `wallets.txt` with leader public addresses, one per line.
Blank lines, duplicates and `#` comments are handled. The wallet list is read at
startup; restart to change it. Never put a private key or seed phrase in a file.

Stop with **Control-C**. Score from a second Terminal in the same directory:

```sh
node score.js
node score.js copy-log.csv
node score.js copy-log.csv --include-incomplete
```

`npm start`, `npm test`, and `npm run score` are equivalent shortcuts. There is no
`npm install` step. Keep the Mac awake and its clock synchronized while measuring.
For a run that prevents idle sleep:

```sh
caffeinate -i node --env-file=.env bot.js
```

## Primary Helius feed and its limits

One connection to `wss://mainnet.helius-rpc.com/?api-key=...` uses:

* One `logsSubscribe` per leader, with `mentions: [leader]`.
* For each followed token, one `accountSubscribe` on its derived Pump bonding
  curve. There is no per-token logs subscription and no per-trade read for
  follower activity: copier flow is derived from the curve's real SOL reserve
  changes between account updates (positive delta = one buy of that size,
  negative = sell; trades landing in the same slot merge into one update). A
  leader's own further buys and sells in the token are netted out when their
  transactions are decoded. Rows carry the note `copier_flow_from_curve_deltas`.
* Confirmed commitment throughout. Each unique log signature is read with
  `getTransaction`, `encoding: jsonParsed`, `maxSupportedTransactionVersion: 1`.

Transactions must invoke the Pump program, a recognized buy/sell instruction,
and have matching owner/mint token-balance changes. Both outer and inner
instructions are inspected. Pump TradeEvent data supplies precise SOL amounts
and post-trade curve reserves when present. Otherwise a scoped balance-delta
fallback is used; ambiguous SOL amounts stay blank. Failed transactions,
unrelated token transfers, and non-SOL quote pairs are not trades in this study.
Net-zero buy/sell round trips within one transaction cannot be identified from
net token-balance changes and are omitted. Their individual events are not guessed.

**At most 25 subscriptions are occupied at once**, counting requests awaiting
acknowledgment and subscriptions awaiting unsubscribe acknowledgment. With `L`
leaders the concurrent token capacity is `25 - L`: 5 leaders allow 20 tokens;
15 allow 10; 24 allow 1. Startup rejects more than 24 leaders so a token can be
observed. Tokens waiting for capacity are admitted in arrival order.

A leader buying many tokens still creates independent paper observations and
batched price reads for every detected buy. Overflow observations receive
`subscription_capacity` and cannot enter the default clean-data statistics.
Tracking every token completely is impossible beyond the requested 25-slot cap.
There is no second socket or hidden subscription to evade that limit.

Token subscriptions end 300 seconds after detection; another leader buy in the
same token extends that token's lease to the latest observation's end. Both
subscriptions are explicitly removed. Up to 5 seconds of HTTP-only completion
grace lets final in-flight samples arrive and the CSV row finish.

HTTP reads are globally spaced to at most `HELIUS_RPS=8` starts/second, with
`HELIUS_CONCURRENCY=2`. Prices have priority over transaction decoding and age
lookups. Up to 50 curves plus 50 uncached mint accounts share one
`getMultipleAccounts` request. There is at most one outstanding price read per
token and approximately one read/second/token. Account notifications also update
prices without additional HTTP calls. Mint decimals are read and cached.

HTTP 429/temporary failures use bounded exponential backoff, jitter, and
`Retry-After`; WebSocket reconnects restore subscriptions. A 1,000-transaction
pending limit prevents an unbounded decode backlog; dropped work flags a data
gap. Heavy traffic may exceed the configured throughput or monthly provider
credits despite staying inside the subscription cap. Delays and missing data
are recorded, not filled from stale prices.

## Time, prices, and copier flow

All `+Ns` clocks start at **detection**, meaning the time a fetched transaction
has been decoded into a leader buy. `log_notification_at` and
`transaction_decode_delay_ms` expose the latency before detection. Leader sell
triggers likewise occur when that sell has been decoded. UTC timestamps use
the local clock; `leader_block_time` is separately obtained from Helius.

At detection +2 seconds, the first subsequent eligible **HTTP curve read** sets
the paper entry; account notifications cannot set the entry. Raw spot price is
`virtual SOL / virtual whole tokens`. The paid paper entry price is that spot
price times **1.03**. An entry is never backdated to the target time.

Reads and snapshots accept at most 2 seconds of total lateness from their target,
and at most 2 seconds HTTP response latency. Otherwise values remain missing.
Each snapshot/exit records actual observation time and delay. Peak means the
maximum observed curve price during the 300-second window, including account
updates when subscribed; it is not a claim of the true intra-update high.

Copier buys mean **other-wallet buy events**, excluding the focal leader's own
buys but including other selected leaders. Counts are events, not unique wallets.
Sells are not subtracted from inflow. The 5/15/60-second bins are cumulative and
use local decoded-event observation times. Duplicate account/token deliveries
of the same trade are removed. No chain-time event is retroactively inserted.

The mint is only known after transaction decoding, so the initial token
subscription handshake creates a blind window. Its duration is exposed in
`subscription_delay_ms` and noted in `quality_notes`; above 2 seconds it marks
the row incomplete. Even shorter handshakes can miss early copiers, so flow is
observed flow, a lower bound, not exhaustive chain history. Disconnects and
subscription-cap gaps also lose events and are flagged; there is no invented
replay. Use these measurements with that coverage limitation in mind.

`curve_sol_at_leader_buy` comes from the actual transaction's Pump event when
available; it is real curve reserve SOL, excluding synthetic reserves.
`curve_sol_at_detection` is the first Helius state read after detection, with
its delay and source recorded. Virtual SOL is provided in separate fields.
These states are different and are never silently substituted for one another.

Token age is calculated from a verified Pump creation transaction and the
leader transaction's block time, or detection time if block time is unavailable.
Creation lookup checks at most 3 pages of 1,000 curve signatures and verifies
the creation instruction. An unverified or truncated history leaves age blank;
the oldest visible trade is never treated as token birth.

## Independent paper exits and costs

Every leader buy represents a new independent 0.02 SOL paper stake, including
repeat buys. No portfolio/capital constraint is imposed. All exit prices receive
a **3% sell slippage penalty**. Each rule runs independently:

| CSV prefix | Trigger |
| --- | --- |
| `r30` | Detection +30s |
| `r60` | Detection +60s |
| `rzero` | No other-wallet buy inflow for a complete trailing 10s, or +120s |
| `rleader` | First decoded sale by the focal leader, or +1200s |
| `rtarget` | First observed raw price >= 1.3 × paid entry price, or +120s |

Zero-flow monitoring begins at +10s; without any copiers it exits then. Every
positive copier buy restarts the ten-second silence clock. A leader sale before
the paper entry causes that rule to exit at the first available entry price.
Any partial leader sale triggers a complete paper exit. Threshold exits use the
observed crossing price rather than pretending a fill exactly at 1.3x.

Event triggers are recorded immediately when decoded; fills use the first
eligible subsequent account update or HTTP sample. Actual delay is recorded.
The simulation cannot promise an instantaneous real-world fill, model queue
position, or measure unobserved price impact. It applies the requested fixed
slippage model. Completed/migrated curves are marked incomplete; prices do not
continue on PumpSwap, and a completed curve is never priced as a flat market.

For paid entry `B` and raw exit `P`:

```text
tokens          = 0.02 / B
sell proceeds   = tokens * (P * 0.97) * 0.995
buy fee         = 0.02 * 0.005 = 0.0001 SOL
network fees    = 0.002 SOL total per round trip
net PnL         = sell proceeds - 0.02 - 0.0001 - 0.002
net multiple    = 1 + net PnL / 0.02
```

This is stake-normalized return, with buy fees paid on top of the stake and
subtracted from the outcome. It is not proceeds divided by total cash outlay.
A completely unchanged raw price returns **0.832038835x** after the specified
costs. Fees are exactly the supplied assumptions; provider data billing is not
included. The model does not claim to reproduce every current protocol fee.

## Files, output, recovery, and scoring

`copy-log.csv` gets one append-only row per detected leader buy when its window
finishes (about +305s), or on graceful stop. Each detection is immediately
fsynced to `pending.jsonl` before waiting for measurements. CSV rows and journal
completion markers are also fsynced. Keep both files together.

Control-C saves unfinished observations with `stopped_early`. After a crash,
remove `run.lock` only once the old process is no longer running, then restart:

```sh
rm run.lock
node --env-file=.env bot.js
```

The journal recovers previously detected buys as `interrupted` rows unless
their IDs already exist in the CSV. It does not reconstruct missing market
history. A torn final journal line is ignored. CSV corruption or incompatible
headers causes a clear startup error instead of mixing schemas. Never run two
writers against the same files; `run.lock` prevents accidental concurrent runs.

The CSV contains identity/timing, token age/source, real and virtual reserve
SOL, entry prices, copier counts and SOL, six price/multiple snapshots, leader
sale information, peak, coverage/quality, and all five exit outcomes. Snapshot
`multiple_N` is raw price divided by paid entry; rule net multiples include all
costs. `src/rows.js` is the complete ordered column list. Unknown numeric values
are blank, never zero. Counts and amounts on interrupted/gapped rows may be
partial and should not be interpreted as complete windows.

`score.js` prints one row per wallet/rule plus overall rows, with leader-buy
count, incomplete count, valid outcome count, median/mean net multiple, strict
hit rate `>1.0x`, and mean copier SOL in 15s. It repeats the table for the strict
cohort `copier_sol_15 > 1`. By default numeric statistics require
`data_quality=ok`; buy counts still include incomplete observations.
`--include-incomplete` includes available finite outcomes, but never converts
missing outcomes to zero. Per-rule valid counts expose differing denominators.

## Optional PumpPortal alternative

Set `FEED=pumpportal` and `PUMPPORTAL_API_KEY=...` in `.env`, then run the same
command. It uses one socket, `subscribeAccountTrade` for leaders and
`subscribeTokenTrade` for leased tokens, plus free new-token/migration events.
Helius still supplies prices and transaction/age metadata. The alternative is
disabled without a key; nothing creates or funds a PumpPortal wallet.
PumpPortal's current docs describe account/token streams as metered. The
subscription timestamp in this mode is the send time because its subscription
acknowledgments do not provide the Helius-style per-subscription IDs.

## Validation and references

`node --test` uses synthetic transactions, fake sockets/RPCs, and deterministic
price paths. Tests cover cost math, all exits, overlaps, 103-token batching,
subscription capacity/ACK release/reconnect, transaction attribution, RPC
backoff, CSV scoring, and journal recovery. No live API key is required for tests;
the delivered build has not been authenticated against your Helius account.

* [Helius WebSockets](https://www.helius.dev/docs/api-reference/rpc/websocket/logssubscribe)
* [Pump program layout](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md)
* [Pump instruction and event IDL](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump.json)
* [PumpPortal data API](https://pumpportal.fun/data-api/real-time/)

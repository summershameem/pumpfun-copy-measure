# pumpfun-copy-measure

A bot that measures whether copy-trading pump.fun "leader" wallets would make
money, without trading. It watches the leaders, paper-trades every buy they
make at realistic retail speed and cost, records what the price did afterwards
under six different exit rules, and scores the result.

**It never trades.** There is no wallet, no private key, no signing and no
transaction submission anywhere in the code. It only reads public data.

**What it found (September 2026, 15 leaders, about a day of data):** every
exit rule loses on average, holding longer loses more, and the most-copied
wallets are the worst to follow. Full tables in [docs/FINDINGS.md](docs/FINDINGS.md).

```
All leader buys, 20-minute windows, 54 complete observations
  Sell at +30 s             median 0.72x   mean 0.71x   hit 14.8%
  Sell at +60 s             median 0.69x   mean 0.72x   hit 18.5%
  Sell when the leader sells median 0.59x   mean 0.63x   hit  5.6%
  Sell at 1.3x target        median 0.64x   mean 0.71x   hit 27.8%
  Hold 20 minutes            median 0.25x   mean 0.32x   hit  0.0%
```

## Contents

1. [What it does, in plain words](#1-what-it-does-in-plain-words)
2. [Free or paid: what you need](#2-free-or-paid-what-you-need)
3. [Setup for beginners, step by step](#3-setup-for-beginners-step-by-step)
4. [Running it](#4-running-it)
5. [Reading the results](#5-reading-the-results)
6. [Choosing leader wallets](#6-choosing-leader-wallets)
7. [Settings](#7-settings)
8. [Troubleshooting](#8-troubleshooting)
9. [Limits and honest caveats](#9-limits-and-honest-caveats)
10. [How it works inside](#10-how-it-works-inside)

## 1. What it does, in plain words

Copy-trading services promise that if you buy whatever a successful wallet
buys, seconds after they do, you share their gains. This bot tests that claim
the only fair way: by pretending to do it, thousands of times, and keeping score.

For each leader wallet you list, the bot:

1. Watches the Solana blockchain for that wallet's pump.fun buys.
2. Notes the price about 2 seconds after the buy (a realistic delay for a
   copier), and pretends to buy 0.02 SOL with 3% slippage and the usual fees.
3. Keeps reading the token's price every 2 seconds for 20 minutes, and counts
   how much SOL other people ("copiers") put in after the leader.
4. Records what the pretend position would have been worth under six exit rules:
   sell after 30 seconds; after 60 seconds; when copier money stops flowing in;
   when the leader sells; at a 1.3x profit target; or hold 20 minutes.
5. Writes one row per leader buy to `copy-log.csv`.

`node score.js` then turns that file into a table per wallet and per rule.

## 2. Free or paid: what you need

You need one thing: a Helius API key. Helius is a company that runs Solana
nodes and lets programs read the chain through them.

### The free way (this is how the findings above were produced)

- Sign up at https://dashboard.helius.dev (email or Google). Free.
- The free plan gives 1,000,000 credits a month and one websocket with 25
  subscriptions. Every read the bot makes costs one credit.
- With 15 leaders and 20-minute windows, the bot uses about 90,000 credits a
  day, so the free plan covers roughly a week of continuous running per month.
  Enough to get a clear answer.
- The 25-subscription limit is the real constraint: one subscription per leader
  plus one per token being watched. 15 leaders leaves room for 10 tokens at a
  time, which is fine at normal activity; at busy moments some leader buys are
  flagged `subscription_capacity` rather than recorded.

Nothing else costs money. Node.js is free, the code has no dependencies.

### If you want to pay, what actually helps

- **Helius Developer plan (about $49 a month)** raises credits to 10,000,000
  and the subscription cap, so you can watch 40 to 60 leaders continuously for
  a month with 1-second price sampling (`PRICE_POLL_MS=1000`). That gives finer
  price paths and many more observations. This is the only upgrade that changes
  the measurement's quality.
- **PumpPortal data key** (`FEED=pumpportal`): an alternative feed that pushes
  pump.fun trades directly. It is supported but was not needed; Helius alone
  gave complete data. Only worth it if your Helius quota is the bottleneck.
- Don't pay for a "copy-trading bot" service to answer this question. The
  point of this tool is that the answer, measured honestly, is negative.

### What is not needed

- No Solana wallet, no SOL, no private key.
- No paid RPC beyond Helius free.
- No cloud server: it runs on a laptop that stays awake.

## 3. Setup for beginners, step by step

These steps assume a Mac. Windows and Linux are the same apart from the
"keep awake" command.

**Step 1. Install Node.js.** Go to https://nodejs.org and download the LTS
version (24 or newer). Run the installer. Then open Terminal (press Cmd+Space,
type "Terminal", Enter) and check:

```sh
node --version
```

You should see `v24` or higher.

**Step 2. Get the code.** Either click "Code" then "Download ZIP" on GitHub
and unzip it into your Desktop, or in Terminal:

```sh
cd ~/Desktop
git clone https://github.com/summershameem/pumpfun-copy-measure.git
cd pumpfun-copy-measure
```

If you downloaded the zip instead, `cd` into the unzipped folder.

**Step 3. Get a Helius key.** Sign up at https://dashboard.helius.dev, open
"API Keys", copy the key (a long string of letters, numbers and dashes).

**Step 4. Create your settings file.** In Terminal, inside the project folder:

```sh
cp .env.example .env
```

Then open `.env` in any text editor (TextEdit is fine: `open -e .env`) and
replace `replace_with_your_helius_key` with your key. Save. Leave the other
lines as they are. Never share this file or commit it; it is ignored by git.

**Step 5. Add leader wallets.** Copy the example list and edit it:

```sh
cp wallets.example.txt wallets.txt
open -e wallets.txt
```

One public address per line. The example file holds the 15 wallets used in the
2026 measurement; replace them with the wallets you want to test. See section 6
for how to pick them. Public addresses only. If anything asks you for a private
key or seed phrase, it is not this program.

**Step 6. Check everything works.** Still in the folder:

```sh
node --test
```

You should see `pass 45` and `fail 0`. This runs entirely offline.

## 4. Running it

Start the recorder and keep the Mac awake while it runs:

```sh
caffeinate -i node --env-file=.env bot.js
```

(On Windows or Linux, just `node --env-file=.env bot.js` and set your machine
not to sleep.)

You'll see lines like:

```
Paper-only recorder: 15 leaders; stake=0.02 SOL; no transaction submission
Helius WebSocket connected; subscription limit 25
Leader buy 5hAg... token=3PvM... SOL=1.283950617
Saved 3PvM... ok initial_subscription_blind_window;copier_flow_from_curve_deltas
```

`Leader buy` means a leader bought and the bot started watching. `Saved ... ok`
means a complete observation was written about 20 minutes later. `Saved ...
incomplete` means something interrupted it (the reasons follow); those rows are
kept but excluded from the main score.

Leave it running for at least a day. Stop it with Control-C; it saves whatever
it was tracking before exiting.

Check the Helius dashboard's credit counter after the first hour. Expect a few
thousand credits an hour. If it's far more, see Troubleshooting.

## 5. Reading the results

Open a second Terminal window in the same folder and run:

```sh
node score.js
```

You get two tables: all leader buys, and only those where copiers put in more
than 1 SOL in the first 15 seconds (the "hyped" subset). Each table has an
OVERALL block and one block per wallet, with a row per exit rule:

- **buys**: how many leader buys were seen for that wallet.
- **incomplete**: how many rows were excluded (see quality notes).
- **valid N**: rows scored for that rule.
- **median x / mean x**: the net multiple of the stake after fees and slippage.
  1.00 is break-even. 0.70 means the paper copier kept 70% of its stake.
- **hit >1.0x**: the share of rows that ended above break-even.
- **mean copier SOL +15s**: how much other people's SOL arrived in the first 15
  seconds. This is the "following" a wallet actually has.

Useful extra views:

```sh
node score.js copy-log.csv --include-incomplete   # count the interrupted rows too
node score.js some-other-log.csv                  # score a different file
```

Judge a wallet on at least 20 valid rows before believing anything about it.
Under 10 is noise.

## 6. Choosing leader wallets

The bot is only as interesting as the wallets you feed it. Sources that worked:

- Wallet-tracking sites and Telegram groups that publish "top trader" lists for
  pump.fun. Take the addresses, not the advice.
- The top holders and early buyers of tokens that ran, read off Solscan.
- Wallets that copy-trading services offer to mirror. Measuring those is the
  whole point.

Mix them. In the 2026 run the highest-inflow wallet turned out to be a bot with
a fixed buy ladder, and it was the worst one to follow. You only learn that by
measuring.

## 7. Settings

All in `.env`:

| Setting | Default | What it does |
|---|---|---|
| `HELIUS_API_KEY` | required | Your key |
| `FEED` | `helius` | `pumpportal` switches to the paid feed |
| `HELIUS_RPS` | `4` | Max reads per second. 4 is safe on free tier |
| `HELIUS_CONCURRENCY` | `1` | Reads in flight at once |
| `PRICE_POLL_MS` | `2000` | Price sample interval. 1000 doubles read cost |
| `SAMPLING_GAP_MS` | `3500` | A longer gap between samples flags the row incomplete |

The paper trade's stake, fees and slippage are constants in `src/study.js`
(0.02 SOL, 0.5% each side, 0.002 SOL network, 3% slippage). Change them there
if you want to model a different copier.

## 8. Troubleshooting

**Credits disappearing fast.** Version 1 fetched every transaction the leaders
touched (Raydium swaps, transfers, everything) and burned 600,000 credits a day.
The current version only fetches pump.fun transactions. If you still see heavy
use: reduce the leader list, keep `PRICE_POLL_MS` at 2000, and check no second
copy of the bot is running (`run.lock` guards against that).

**`Helius read retry 1/4`.** Normal. Helius asks for a pause and the read is
retried a second later. Only a problem if you see `4/4` failures repeatedly.

**`transaction_queue_overflow`.** Your leaders are too active for the read
budget. Fewer leaders, or raise `HELIUS_RPS` to 8 on a paid plan.

**`Observation gap: websocket_disconnected`.** Helius dropped the connection;
the bot reconnects in 2 seconds and flags the rows that were affected.

**Rows all `incomplete` with `price_sampling_gap`.** Your `SAMPLING_GAP_MS` is
too tight for your `PRICE_POLL_MS`. Keep the gap at least 1,500 ms above the poll.

**`curve_complete_or_migrated`.** The token graduated to a DEX during the
window. That's information, not an error: the bot stops watching because the
bonding curve no longer sets the price.

**Score table is empty.** The bot needs to run for at least one full window
(20 minutes) after a leader buy before the first row is complete.

## 9. Limits and honest caveats

- It measures one copier profile: 2 seconds behind, 0.02 SOL, 3% slippage,
  taker fees. Faster copiers (same-block bots) are a different question.
- Copier flow is derived from the bonding curve's reserve changes, so trades
  landing in the same slot merge into one. The totals are exact; the count is a
  floor.
- Tokens that leave the curve mid-window are recorded as incomplete rather
  than guessed at.
- One day of one wallet list is a snapshot. The 2026 result was consistent
  across two runs and every rule, which is why it's stated with confidence,
  but re-run before trusting it for a different set of wallets.
- It cannot tell you why a wallet is profitable; only whether following it
  would have been.

## 10. How it works inside

Node.js 24, no dependencies. One websocket to Helius with a `logsSubscribe`
per leader; each pump.fun transaction those logs mention is fetched and
decoded. When a leader buy is seen, the token's bonding curve account is
subscribed and polled; price comes from the curve's reserves, copier flow from
the change in its SOL reserve between updates. Exits are evaluated on the
sampled path and written as one CSV row. Details, decoding rules, quality
flags and the full column list are in [docs/TECHNICAL.md](docs/TECHNICAL.md).

Tests: `node --test` (45 tests, offline).

## Licence

MIT. Use it, change it, publish your own findings.

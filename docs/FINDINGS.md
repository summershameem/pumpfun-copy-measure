# Findings: does copying pump.fun leader wallets pay? (September 2026)

Paper measurement only. No real trades were placed. Fifteen leader wallets
(see `wallets.example.txt`) were watched for about a day in two runs: a
5-minute observation window per leader buy, then a 20-minute window.

**Setup assumed for the paper copier:** buy 0.02 SOL about 2 seconds after the
leader's buy is seen, 0.5% fee each side, 0.002 SOL network cost per round
trip, 3% slippage on each fill. Every row records the price path and the SOL
that other wallets put into the token after the leader ("copier flow").

Numbers are net multiples of the stake: 1.00x means break-even after all costs.
"hit" is the share of observations that ended above 1.00x.

## Run 1: 5-minute windows (62 leader buys, 37 complete)

| Exit rule | median | mean | hit >1.0x |
|---|---:|---:|---:|
| Sell at +30 s | 0.76x | 0.77x | 10.8% |
| Sell at +60 s | 0.76x | 0.88x | 21.6% |
| Sell when copier flow stops (max 120 s) | 0.82x | 0.85x | 13.5% |
| Sell when the leader sells (max 300 s) | 0.61x | 0.70x | 10.8% |
| Sell at 1.3x target (else 120 s) | 0.78x | 0.83x | 37.8% |

Mean copier inflow in the first 15 seconds after a leader buy: about 10 SOL.
The copiers are real; the paper copier is simply behind them.

## Run 2: 20-minute windows (148 leader buys, 54 complete)

| Exit rule | median | mean | hit >1.0x |
|---|---:|---:|---:|
| Sell at +30 s | 0.72x | 0.71x | 14.8% |
| Sell at +60 s | 0.69x | 0.72x | 18.5% |
| Sell when copier flow stops (max 120 s) | 0.63x | 0.68x | 14.8% |
| Sell when the leader sells (max 1200 s) | 0.59x | 0.63x | 5.6% |
| Sell at 1.3x target (else 120 s) | 0.64x | 0.71x | 27.8% |
| Hold 20 minutes | 0.25x | 0.32x | 0.0% |

## What the numbers say

1. Every exit rule loses money on median and on average. The best rule (take
   profit at 1.3x) hits its target about a third of the time and still averages
   0.7 to 0.8x because the misses fall hard.
2. Holding longer makes it worse. At 20 minutes the median token had lost three
   quarters of its value; not one of 54 was above break-even.
3. Following the leader out is the worst timed exit: by the time the leader's
   sell is seen, it has already been sold into the copiers.
4. The most-copied wallet (highest copier inflow) was the worst one to follow.
   Its buys arrive in a fixed size ladder, which is a bot, not a trader with a
   following; the followers are its exit liquidity.
5. About 40% of observations were incomplete: the token graduated off the
   bonding curve mid-window, the leader sold before a copier could even enter,
   or a websocket gap interrupted sampling. Those are flagged, not silently
   dropped, and `node score.js --include-incomplete` shows them.

## Conclusion

At retail speed (a few seconds behind the leader, on a laptop over a home
connection), copying pump.fun leaders has a strongly negative expectation.
The edge, if any, belongs to whoever is in the same block as the leader. The
copiers who follow seconds later are the product.

## Cost of running the measurement

Helius free tier (1,000,000 credits a month). Version 1 of the recorder burned
about 600,000 credits a day by fetching every transaction the leaders touched.
The final version filters to pump.fun transactions, reads prices every 2
seconds in one batched call, and used about 90,000 credits a day with 15
leaders and 20-minute windows, so the free tier covers about a week of
continuous measurement.

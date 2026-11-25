[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/maelaozera/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/maelaozera/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Pump.fun Paper Sprint — Dip Bot

Paper-trading bot for the make.fun competition
`u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b`. One program,
`main.ts` (Node 22, zero dependencies), trades pump.fun bonding curves on
the house's 6-hour replay. Paper trading only — no real money, no keys,
no network calls.

## Strategy

Most fresh pump.fun coins bleed out, and short-term price signals
(momentum, dip-chasing adds) showed no edge on the kit's dev window — so
the bot buys only one setup, once per coin, in a single tranche:

- **Dip entry** — an established curve (3+ SOL real reserves) 30–45%
  below its 2500-slot high, with buyers stepping back in: ≥3 buys in the
  last 6 trades, the latest a buy, net flow non-negative. Strong curves
  (25+ SOL) get a 0.2 SOL ticket, weaker ones only a 0.01 SOL probe, at
  most 3 weak tickets open at once. No adds: adding into a falling knife
  lost money on every sweep.
- **Exits** — take profit +20%, stop loss −8%, 900 slots max hold
  (200 for weak tickets), exit at once when the creator sells, 300-slot
  cooldown before the same coin may be dip-bought again.
- **Guardrail probes** — tiny 0.01 SOL probe round trips keep the run on
  pace for the 20-distinct-mint minimum when dip signals run dry.
- **Sizing safety** — buys are sized at 95% of the 1%-of-reserve cap:
  the replay's effective cap shrinks by the bot's own earlier trades on
  the same curve, so buying at exactly 100% of the cap is rejected.

A spray mode (one small ticket per fresh coin) exists behind the
`sprayEnabled` flag but is off by default: on the dev window it lost
~2x as much per trip as dip tickets.

## Files

- `main.ts` — entrypoint: wires the strategy to the replay protocol.
- `strategy.ts` — the strategy (pure function of the batches; no clock,
  no randomness, no I/O, so the two graded runs agree byte for byte).
- `bot-shim.ts` — minimal NDJSON shim for `agent-fun/replay/v2`
  (stdin hello/batch/done, one reply per batch on stdout).

## Run

```sh
node main.ts
```

The harness speaks newline-delimited JSON on stdin and expects one reply
per batch on stdout; see `bot-shim.ts` and the kit's
`protocol.schema.json`. To grade on the kit's dev window, use the kit's
`grade-local` (the `--driver process` form runs on this machine; docker
is the server's sandbox):

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process --worktree
```

## Local backtest (dev window)

Honest numbers: the dev window is negative on average — the market
charges ~2.7% per round trip and most coins bleed. The edge, such as it
is, is the skew: a few dip bounces pay multiples of the many small
losses. Per 6-hour slice of the 24-hour dev window the bot scored
−0.22 / −0.11 / −0.10 / +0.02 SOL, so about one window in four came out
positive. The final window is fresh 6-hour data, so these are a sanity
check, not a forecast.

| run | net PnL | fills | coins | trips | win rate | max DD |
| --- | ------- | ----- | ----- | ----- | -------- | ------ |
| `grade-local`, dev window (24 h) | −0.490 SOL | 558 | 136 | 279 | 22.9% | 0.071 |
| local sim, dev window (24 h) | −0.413 SOL | 560 | 138 | 280 | 22.9% | 0.064 |
| local sim, part-00000 only (~11 h) | −0.271 SOL | 279 | 64 | 140 | 18.6% | 0.032 |

`grade-local` also reports: 0 rejected orders, guardrails met (136 coins
with a ≥0.01 SOL round trip, drawdown ok), 90% interval −1.04..+0.08 SOL,
and the two executions reproduced byte for byte. The small gap between
the kit grade and the local sim is the kit's own seed, priority fee and
failed-tx draws. A 10-copy `--stress` run lost money on all 10 rebuilt
copies (median −0.99 SOL, p10 −1.28, p90 −0.54) — the dev score sits
above 90% of the copies, so treat the dev number as the favorable end
of the range, not the middle.

## License

MIT — see `LICENSE`.

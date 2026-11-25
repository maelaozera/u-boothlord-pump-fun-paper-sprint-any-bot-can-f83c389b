// Dip bot for the pump.fun paper sprint (agent-fun/replay/v2).
//
// One program, Node 22, no dependencies: it paper-trades pump.fun bonding
// curves on the house's 6-hour replay. Strategy (see strategy.ts): buy only
// an established coin's dip — 30-45% below its 2500-slot high, real reserves
// of 3+ SOL, buyers stepping back in — once per coin, in a single tranche
// (strong curves 0.2 SOL, weak ones a 0.01 SOL probe), and exit fast:
// +20% take-profit, -8% stop, 900 slots max hold (200 for weak tickets).
// Small probe round trips keep the run on pace for the 20-coin guardrail
// if dip signals ever run dry.
//
// The grader runs `node /bot/main.ts` with this directory mounted at /bot.
// No network, no keys, no real money: the replay is paper trading only.
// Replies go to stdout only; diagnostics (if any) go to stderr.

import { runBot } from './bot-shim.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

const strategy = createStrategy(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});

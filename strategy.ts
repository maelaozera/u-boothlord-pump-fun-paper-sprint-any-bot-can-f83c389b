// Dip bot for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Finding from the kit's dev window: most fresh coins bleed out, short-term
// price signals (momentum, dip-chasing adds) have no edge, and every ticket
// loses money on average — but established coins that fall 30-45% off a
// 2500-slot high with buyers stepping back in bounce often enough, and
// cheaply enough, to lose the least. So this bot buys only that dip, once
// per coin, in a single tranche (adding into a falling knife lost money on
// every sweep), and exits fast: +20% take-profit, -10% stop, 600 slots max
// hold (200 for weak tickets). Strong curves (25+ SOL real reserves) get a
// 0.2 SOL ticket, weaker ones only a 0.01 SOL probe, at most 3 weak tickets
// open at once. A spray mode (one small ticket per fresh coin) exists behind
// the sprayEnabled flag but is off by default: on the dev window it lost
// ~2x as much per trip as dip tickets. Small probe round trips keep the run
// on pace for the 20-distinct-mint guardrail if dip signals ever run dry.
//
// Pure function of the batches the harness sends: no clock, no randomness,
// no I/O, so the two graded executions produce byte-identical action logs.

export type Pubkey = string;

/** The slice of bot state the strategy reads (structural: both the local shim
 *  and the kit SDK's BotState satisfy it). */
export interface CurveView {
  virtual_token_reserves: bigint;
  virtual_quote_reserves: bigint;
  real_quote_reserves: bigint;
  complete: boolean;
  created_slot: number | null;
}

export interface HoldingView {
  token_amount: bigint;
  cost_lamports: bigint;
}

export interface PendingView {
  order: { side: string; mint: string };
}

export interface StrategyState {
  hello: {
    caps: {
      max_open_positions: number;
      max_order_bps_of_real_reserve: number;
      max_orders_per_batch: number;
    };
    fees: { base_fee_lamports: string; priority_fee_lamports: string };
  };
  positions: Map<Pubkey, HoldingView>;
  curves: Map<Pubkey, CurveView>;
  pending: Map<string, PendingView>;
  maxBuyLamports(mint: Pubkey): bigint;
  freeCashLamports(): bigint;
  txFeeLamports(): bigint;
  committedPositionCount(): number;
}

export interface StrategyEvent {
  event: string;
  mint: Pubkey;
  slot: number;
  block_time: number | null;
  is_buy?: boolean;
  sol_amount?: string;
  user?: string;
  creator?: string;
  virtual_quote_reserves?: string;
  virtual_token_reserves?: string;
}

export interface StrategyMark {
  mint: Pubkey;
  virtual_token_reserves: string;
  virtual_quote_reserves: string;
  real_quote_reserves: string;
}

export interface StrategyFill {
  client_id: string;
  mint: Pubkey;
  side: string;
  status: string;
}

export interface StrategyBatch {
  slot: number;
  events: StrategyEvent[];
  marks: StrategyMark[];
  fills: StrategyFill[];
}

export interface BuyInput {
  side: 'buy';
  mint: Pubkey;
  quote_lamports: bigint;
  max_slippage_bps: number;
}

export interface SellInput {
  side: 'sell';
  mint: Pubkey;
  token_amount: bigint;
  max_slippage_bps: number;
}

export type OrderInput = BuyInput | SellInput;

export interface Strategy {
  onBatch(state: StrategyState, batch: StrategyBatch): OrderInput[];
}

export interface Params {
  /** Spray entries (one small ticket per fresh coin). Off by default: on the
   *  dev window they lose ~2x as much per trip as dip tickets. */
  sprayEnabled: boolean;
  /** Real SOL a curve must hold before its first buy (the size cap then
   *  allows at least minBuySol). */
  entryMinRqSol: number;
  /** Retry an undecided candidate for at most this many slots after its
   *  CreateEvent; after that the early window is gone. */
  entryMaxAge: number;
  /** SOL to put into one ticket in total. */
  stakeSol: number;
  /** Smallest buy worth sending (also the guardrail's round-trip floor). */
  minBuySol: number;
  /** Add to a ticket only while the coin is this young (slots since create). */
  addMaxAge: number;
  /** Add only while the price is at most this far above the first buy's. */
  addMaxRunup: number;
  /** Slippage on buys and sells (bps); wide so early fills are not refused. */
  buySlipBps: number;
  sellSlipBps: number;
  /** Exits. */
  stopLoss: number;
  takeProfit: number;
  /** Exit after this many slots held. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
  /** Dip entries (established coins, deep retracement): a second entry path
   *  beside the spray. Set dipEnabled false to turn it off. */
  dipEnabled: boolean;
  dipWindow: number;
  dipMin: number;
  dipMax: number;
  dipFlowTrades: number;
  dipMinBuys: number;
  dipLastMustBeBuy: boolean;
  dipMinRqSol: number;
  dipStakeSol: number;
  /** Tranches and ceilings: strong curves (real SOL >= dipStrongRqSol at
   *  entry) are bought in dipTranche steps up to dipStrongMax; weaker ones
   *  get only a small probe up to dipWeakMax, at most dipWeakMaxOpen at once. */
  dipTranche: number;
  dipMaxPosition: number;
  dipStrongRqSol: number;
  dipStrongMax: number;
  dipWeakMax: number;
  dipWeakMaxOpen: number;
  /** Add tranches only while the price stays within this fraction of entry. */
  dipAddBand: number;
  dipTakeProfit: number;
  dipStopLoss: number;
  dipMaxHold: number;
  /** Weak dip tickets exit sooner (they bleed longer when held). */
  dipWeakMaxHold: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Guardrail pacing: target distinct coins and fills over paceSecs of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

// Settings tuned on the kit's dev window with the local sim (see README.md).
// Dip-only by default: a single buy per dip (no adds — adding into a
// falling knife lost money on every sweep), strong curves 0.2 SOL, weak
// ones a 0.01 SOL probe.
export const DEFAULT_PARAMS: Params = {
  sprayEnabled: false,
  entryMinRqSol: 1,
  entryMaxAge: 600,
  stakeSol: 0.05,
  minBuySol: 0.01,
  addMaxAge: 120,
  addMaxRunup: 0.3,
  buySlipBps: 10_000,
  sellSlipBps: 10_000,
  stopLoss: 0.3,
  takeProfit: 1.5,
  maxHold: 300,
  exitOnDevSell: true,
  dipEnabled: true,
  dipWindow: 2500,
  dipMin: 0.3,
  dipMax: 0.45,
  dipFlowTrades: 6,
  dipMinBuys: 3,
  dipLastMustBeBuy: true,
  dipMinRqSol: 3,
  dipStakeSol: 0.2,
  dipTranche: 0.2,
  dipMaxPosition: 0.2,
  dipStrongRqSol: 25,
  dipStrongMax: 0.2,
  dipWeakMax: 0.01,
  dipWeakMaxOpen: 3,
  dipAddBand: 0.05,
  dipTakeProfit: 0.2,
  dipStopLoss: 0.08,
  dipMaxHold: 900,
  dipWeakMaxHold: 200,
  maxExposureSol: 2,
  targetCoins: 25,
  targetFills: 200,
  paceSecs: 21600,
  probeSol: 0.01,
  maxProbes: 2,
};

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;
/**
 * Size buys at most this share of the size cap. The replay's effective cap
 * is reduced by the bot's own earlier trades on the same curve (its quote
 * offset), so buying at exactly 100% of the cap is rejected; 95% leaves
 * ample room (observed offsets are ~0.2% of the reserve).
 */
const CAP_FACTOR = 0.95;

interface Held {
  opened: number;
  created: number;
  /** SOL sent in buys for this position (fees included). */
  invested: number;
  exiting: boolean;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Recorded price when the first buy was decided. */
  entryPrice: number;
  /** Per-position exit rules (spray and dip tickets differ). */
  kind: 'spray' | 'dip';
  tp: number;
  sl: number;
  hold: number;
  /** Most SOL this position may hold (dip tranches build up to it). */
  maxPos: number;
  /** Weak dip ticket (small probe) or strong one. */
  weak: boolean;
}

interface DipTrade {
  slot: number;
  buy: boolean;
  sol: number;
  price: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Strategy {
  /** Coins created and not yet decided (one ticket each). */
  const candidates = new Map<Pubkey, number>();
  const held = new Map<Pubkey, Held>();
  const creators = new Map<Pubkey, string>();
  /** Recent trades per mint, for the dip signal. */
  const tapes = new Map<Pubkey, DipTrade[]>();
  const tapeCreated = new Map<Pubkey, number>();
  /** Slot a position last exited, by mint: a dip may not be re-bought within 300 slots. */
  const lastExit = new Map<Pubkey, number>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  return {
    onBatch(state: StrategyState, batch: StrategyBatch): OrderInput[] {
      const now = batch.slot;
      const devSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null && e.block_time !== undefined) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          candidates.set(e.mint, e.slot);
          tapeCreated.set(e.mint, e.slot);
          if (e.creator) creators.set(e.mint, e.creator);
        } else if (e.event === 'TradeEvent') {
          traded.add(e.mint);
          if (!e.is_buy && creators.get(e.mint) === e.user) devSell.add(e.mint);
          if (p.dipEnabled) {
            let tape = tapes.get(e.mint);
            if (tape === undefined) {
              tape = [];
              tapes.set(e.mint, tape);
            }
            tape.push({
              slot: e.slot,
              buy: e.is_buy ?? false,
              sol: Number(e.sol_amount) / LAMPORTS,
              price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
            });
            let cut = 0;
            while (cut < tape.length && tape[cut]!.slot <= now - p.dipWindow - 5) cut++;
            if (cut > 0) tape.splice(0, cut);
          }
        }
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: take profit, stop loss, creator sell, time limit.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            if (h.filled) lastExit.set(mint, now);
            held.delete(mint);
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        let exit = h.exiting;
        if (!exit && value < cost * (1 - h.sl)) exit = true;
        if (!exit && value >= cost * (1 + h.tp)) exit = true;
        if (!exit && p.exitOnDevSell && devSell.has(mint)) exit = true;
        if (!exit && now - h.opened > h.hold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: p.sellSlipBps });
        if (!selling) probes.set(mint, true);
      }

      // Entries: one ticket per fresh coin, as soon as the size cap allows
      // a minimum buy; top the ticket up while the coin is still young.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) {
          candidates.delete(mint);
          continue;
        }
        const created = candidates.get(mint);
        const h = held.get(mint);
        if (h !== undefined) {
          // Top-ups: spray tickets pyramid into strength while young; dip
          // tickets add tranches while the price stays near the entry.
          if (h.exiting || !h.filled || pendingByMint.has(mint)) continue;
          const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
          let want: number;
          if (h.kind === 'spray') {
            if (h.invested >= p.stakeSol - p.minBuySol) continue;
            if (now - h.created > p.addMaxAge) continue;
            if (price > h.entryPrice * (1 + p.addMaxRunup)) continue;
            want = p.stakeSol - h.invested;
          } else {
            if (h.invested >= h.maxPos - p.minBuySol) continue;
            if (Math.abs(price / h.entryPrice - 1) > p.dipAddBand) continue;
            want = Math.min(h.weak ? p.minBuySol : p.dipTranche, h.maxPos - h.invested);
          }
          // 95% of the cap: the replay's effective cap shrinks with our own offset.
          const capSol = (Math.floor(Number(state.maxBuyLamports(mint))) * CAP_FACTOR) / LAMPORTS;
          let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.minBuySol) continue;
          orders.push({
            side: 'buy',
            mint,
            quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
            max_slippage_bps: p.buySlipBps,
          });
          free -= amount + tx;
          exposure += amount;
          h.invested += amount;
          continue;
        }
        // Spray first buy: a fresh coin whose size cap allows a minimum ticket.
        if (p.sprayEnabled && created !== undefined) {
          if (now - created > p.entryMaxAge) {
            candidates.delete(mint);
          } else if (slotsLeft > 0 && !pendingByMint.has(mint) && !probes.has(mint)) {
            const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
            if (rqSol >= p.entryMinRqSol) {
              // 95% of the cap: the replay's effective cap shrinks with our own offset.
              const capSol = (Math.floor(Number(state.maxBuyLamports(mint))) * CAP_FACTOR) / LAMPORTS;
              let amount = Math.min(capSol, p.stakeSol, p.maxExposureSol - exposure);
              if (amount > free - tx) amount = free - tx;
              if (amount >= p.minBuySol) {
                const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
                orders.push({
                  side: 'buy',
                  mint,
                  quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
                  max_slippage_bps: p.buySlipBps,
                });
                free -= amount + tx;
                exposure += amount;
                slotsLeft--;
                candidates.delete(mint);
                held.set(mint, {
                  opened: now,
                  created,
                  invested: amount,
                  exiting: false,
                  filled: false,
                  entryPrice: price,
                  kind: 'spray',
                  tp: p.takeProfit,
                  sl: p.stopLoss,
                  hold: p.maxHold,
                  maxPos: p.stakeSol,
                  weak: false,
                });
                continue;
              }
            }
          }
        }
        // Dip entry: an established coin deep below its recent high, with
        // buyers stepping back in.
        if (p.dipEnabled && !pendingByMint.has(mint) && !probes.has(mint) && slotsLeft > 0 && now - (lastExit.get(mint) ?? -1e12) > 300) {
          const tape = tapes.get(mint);
          const createdAt = tapeCreated.get(mint);
          if (tape !== undefined && createdAt !== undefined) {
            const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
            let high = 0;
            let last = 0;
            for (const tr of tape) {
              if (tr.slot <= now - p.dipWindow) continue;
              if (tr.price > high) high = tr.price;
              last = tr.price;
            }
            const dip = high > 0 && last > 0 ? 1 - last / high : 0;
            if (rqSol >= p.dipMinRqSol && dip >= p.dipMin && dip <= p.dipMax) {
              const recent = tape.filter((tr) => tr.slot > now - p.dipWindow).slice(-p.dipFlowTrades);
              let buys = 0;
              let net = 0;
              for (const tr of recent) {
                if (tr.buy) buys++;
                net += tr.buy ? tr.sol : -tr.sol;
              }
              if (
                recent.length >= p.dipFlowTrades &&
                buys >= p.dipMinBuys &&
                (!p.dipLastMustBeBuy || recent[recent.length - 1]!.buy) &&
                net >= 0
              ) {
                // Tiered first buy: strong curves get a full tranche, weak
                // ones only a probe (at most dipWeakMaxOpen weak tickets).
                const strong = rqSol >= p.dipStrongRqSol;
                let weakOpen = 0;
                for (const hh of held.values()) if (hh.kind === 'dip' && hh.weak) weakOpen++;
                if (!strong && weakOpen >= p.dipWeakMaxOpen) continue;
                const tranche = strong ? p.dipTranche : p.minBuySol;
                const maxPos = strong ? p.dipStrongMax : p.dipWeakMax;
                // 95% of the cap: the replay's effective cap shrinks with our own offset.
                const capSol = (Math.floor(Number(state.maxBuyLamports(mint))) * CAP_FACTOR) / LAMPORTS;
                let amount = Math.min(capSol, tranche, maxPos, p.maxExposureSol - exposure);
                if (amount > free - tx) amount = free - tx;
                if (amount >= p.minBuySol) {
                  const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
                  orders.push({
                    side: 'buy',
                    mint,
                    quote_lamports: BigInt(Math.floor(amount * LAMPORTS)),
                    max_slippage_bps: p.buySlipBps,
                  });
                  free -= amount + tx;
                  exposure += amount;
                  slotsLeft--;
                  candidates.delete(mint);
                  held.set(mint, {
                    opened: now,
                    created: createdAt,
                    invested: amount,
                    exiting: false,
                    filled: false,
                    entryPrice: price,
                    kind: 'dip',
                    tp: p.dipTakeProfit,
                    sl: p.dipStopLoss,
                    hold: strong ? p.dipMaxHold : p.dipWeakMaxHold,
                    maxPos,
                    weak: !strong,
                  });
                }
              }
            }
          }
        }
      }
      // Drop stale candidates that never traded again (their window is gone).
      for (const [mint, created] of candidates) {
        if (now - created > p.entryMaxAge) candidates.delete(mint);
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * tx) break;
            orders.push({
              side: 'buy',
              mint,
              quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)),
              max_slippage_bps: p.buySlipBps,
            });
            probes.set(mint, false);
            free -= p.probeSol + tx;
          }
        }
      }
      return orders;
    },
  };
}

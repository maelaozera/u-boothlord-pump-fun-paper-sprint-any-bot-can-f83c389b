// Minimal NDJSON wire shim for agent-fun/replay/v2 (Node 22, zero dependencies).
//
// The grader runs `node /bot/main.ts`: this file owns the wire — it reads one
// JSON line at a time from stdin (hello, batch..., done), keeps `state` current
// (account, positions, every curve's latest reserves, the orders still in
// flight), calls the strategy's onBatch and writes exactly one reply per batch,
// echoing the batch's seq, before it reads the next line.
//
// Amounts may be bigint, u64 decimal strings or safe integers; the shim writes
// them as decimal strings and fills in client_id when the strategy leaves it
// out. An order the harness would treat as a protocol violation (malformed
// mint, amount, bps or client_id, a client_id starting with `_`, an unknown
// key, a reply line over the limit, more orders than max_orders_per_batch)
// throws here, so a broken bot fails on your machine and not in grading.
// Orders the market refuses (position and size caps, cash, slippage) are not
// errors: they come back in a later batch's fills with status "rejected".
//
// stdout carries replies only: diagnostics go to stderr (console.error).
// Deterministic by construction: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream.

import type { OrderInput, Strategy, StrategyBatch } from './strategy.ts';

export const PROTOCOL = 'agent-fun/replay/v2';
export const MAX_HARNESS_LINE_BYTES = 1_048_576;
export const MAX_BOT_LINE_BYTES = 65_536;
export const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const BPS = 10_000n;

export type U64 = string;
export type Pubkey = string;

export interface Hello {
  type: 'hello';
  protocol: typeof PROTOCOL;
  seed: U64;
  universe: {
    program: typeof PUMP_PROGRAM_ID;
    quote: 'SOL';
    mayhem: 'excluded';
    exclude_cashback: true;
    sample: { hash: 'sha256'; modulus: number; residue: number };
  };
  capital: { lamports: U64 };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
    shorts: false;
    leverage: false;
  };
  latency_slots: number;
  fees: {
    protocol_bps_fallback: number;
    creator_bps_fallback: number;
    base_fee_lamports: U64;
    priority_fee_lamports: U64;
    failed_tx_bps: number;
  };
}

export interface Curve {
  mint: Pubkey;
  created_slot: number | null;
  virtual_token_reserves: bigint;
  virtual_quote_reserves: bigint;
  real_token_reserves: bigint;
  real_quote_reserves: bigint;
  reserves_slot: number;
  trades: number;
  complete: boolean;
}

export interface Holding {
  token_amount: bigint;
  cost_lamports: bigint;
}

export interface PendingOrder {
  order: { side: string; mint: string; quote_lamports?: U64; token_amount?: U64; client_id: string };
  seq: number;
  decided_slot: number;
}

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

export class OrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderError';
  }
}

const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const CLIENT_ID_RE = /^[A-Za-z0-9-][A-Za-z0-9_-]{0,63}$/;

/** Everything the strategy knows, kept current by runBot before each callback. */
export class BotState {
  readonly hello: Hello;
  seq = -1;
  slot = -1;
  cash: bigint;
  readonly positions = new Map<Pubkey, Holding>();
  readonly curves = new Map<Pubkey, Curve>();
  readonly pending = new Map<string, PendingOrder>();
  #used = new Set<string>();
  #next = 1;

  constructor(hello: Hello) {
    this.hello = hello;
    this.cash = BigInt(hello.capital.lamports);
  }

  clientId(): string {
    const id = this.#freeId(null);
    this.#used.add(id);
    return id;
  }

  /** Base + priority fee every sent order pays, filled or not. */
  txFeeLamports(): bigint {
    return BigInt(this.hello.fees.base_fee_lamports) + BigInt(this.hello.fees.priority_fee_lamports);
  }

  /** The size cap on this mint now: the most this batch's buys on it may spend together. */
  maxBuyLamports(mint: Pubkey): bigint {
    const c = this.curves.get(mint);
    if (c === undefined || c.complete) return 0n;
    return (c.real_quote_reserves * BigInt(this.hello.caps.max_order_bps_of_real_reserve)) / BPS;
  }

  /** Mints held plus mints with a buy pending: what counts against max_open_positions. */
  committedPositionCount(): number {
    const mints = new Set<Pubkey>(this.positions.keys());
    for (const p of this.pending.values()) if (p.order.side === 'buy') mints.add(p.order.mint);
    return mints.size;
  }

  /** Cash minus what pending orders will take if they fill (buy amounts and every tx fee). */
  freeCashLamports(): bigint {
    const tx = this.txFeeLamports();
    let free = this.cash;
    for (const p of this.pending.values()) {
      free -= tx;
      if (p.order.side === 'buy') free -= BigInt(p.order.quote_lamports ?? '0');
    }
    return free;
  }

  /** Fold a batch in: its fills, account, marks and events (in that order). */
  applyBatch(batch: StrategyBatch & { fills: any[]; account: any }): void {
    this.slot = batch.slot;
    for (const f of batch.fills) this.pending.delete(f.client_id);
    this.#setAccount(batch.account);
    for (const m of batch.marks) {
      const c = this.curves.get(m.mint);
      if (c !== undefined && m.slot < c.reserves_slot) continue;
      const curve = c ?? this.#newCurve(m.mint, null, m.slot);
      curve.virtual_token_reserves = BigInt(m.virtual_token_reserves);
      curve.virtual_quote_reserves = BigInt(m.virtual_quote_reserves);
      curve.real_token_reserves = BigInt(m.real_token_reserves);
      curve.real_quote_reserves = BigInt(m.real_quote_reserves);
      curve.reserves_slot = m.slot;
    }
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const curve = this.#newCurve(e.mint, e.slot, e.slot);
        curve.virtual_token_reserves = BigInt(e.virtual_token_reserves);
        curve.virtual_quote_reserves = BigInt(e.virtual_quote_reserves);
        curve.real_token_reserves = BigInt(e.real_token_reserves);
        curve.real_quote_reserves = 0n;
      } else if (e.event === 'TradeEvent') {
        const curve = this.curves.get(e.mint) ?? this.#newCurve(e.mint, null, e.slot);
        curve.virtual_token_reserves = BigInt(e.virtual_token_reserves);
        curve.virtual_quote_reserves = BigInt(e.virtual_quote_reserves);
        curve.real_token_reserves = BigInt(e.real_token_reserves);
        curve.real_quote_reserves = BigInt(e.real_quote_reserves);
        curve.reserves_slot = e.slot;
        curve.trades += 1;
      } else {
        const curve = this.curves.get(e.mint) ?? this.#newCurve(e.mint, null, e.slot);
        curve.complete = true;
      }
    }
  }

  /** Validate what onBatch returned and turn it into wire orders (assigning missing client_ids). */
  toOrders(result: unknown): { side: string; client_id: string; mint: string; quote_lamports?: U64; token_amount?: U64; max_slippage_bps: number }[] {
    if (result === undefined || result === null) return [];
    if (!Array.isArray(result)) {
      throw new OrderError(`batch ${this.slot}: onBatch must return an array of orders`);
    }
    const cap = this.hello.caps.max_orders_per_batch;
    if (result.length > cap) {
      throw new OrderError(
        `batch ${this.slot}: onBatch returned ${result.length} orders, over max_orders_per_batch (${cap})`,
      );
    }
    const checked = result.map((o: unknown, i: number) => checkOrder(o, `batch ${this.slot} order ${i}`));
    const taken = new Set<string>();
    for (const o of checked) if (o.client_id !== undefined) taken.add(o.client_id);
    return checked.map((o) => {
      const client_id = o.client_id ?? this.#freeId(taken);
      taken.add(client_id);
      return o.side === 'buy'
        ? { side: 'buy', client_id, mint: o.mint, quote_lamports: o.amount, max_slippage_bps: o.max_slippage_bps }
        : { side: 'sell', client_id, mint: o.mint, token_amount: o.amount, max_slippage_bps: o.max_slippage_bps };
    });
  }

  /** Record orders as sent on the current batch: they stay pending until their fill arrives. */
  recordOrders(orders: readonly { side: string; client_id: string; mint: string; quote_lamports?: U64; token_amount?: U64 }[]): void {
    for (const order of orders) {
      this.#used.add(order.client_id);
      this.pending.set(order.client_id, { order: order as PendingOrder['order'], seq: this.seq, decided_slot: this.slot });
    }
  }

  #freeId(taken: Set<string> | null): string {
    for (;;) {
      const id = `o${this.#next++}`;
      if (!this.#used.has(id) && (taken === null || !taken.has(id))) return id;
    }
  }

  #newCurve(mint: Pubkey, created: number | null, slot: number): Curve {
    const curve: Curve = {
      mint,
      created_slot: created,
      virtual_token_reserves: 0n,
      virtual_quote_reserves: 0n,
      real_token_reserves: 0n,
      real_quote_reserves: 0n,
      reserves_slot: slot,
      trades: 0,
      complete: false,
    };
    this.curves.set(mint, curve);
    return curve;
  }

  #setAccount(account: { cash_lamports: U64; positions: { mint: Pubkey; token_amount: U64; cost_lamports: U64 }[] }): void {
    this.cash = BigInt(account.cash_lamports);
    this.positions.clear();
    for (const p of account.positions) {
      const tokens = BigInt(p.token_amount);
      if (tokens > 0n) this.positions.set(p.mint, { token_amount: tokens, cost_lamports: BigInt(p.cost_lamports) });
    }
  }
}

function toU64(value: unknown, what: string): U64 {
  if (typeof value === 'bigint') {
    if (value < 0n || value > 18_446_744_073_709_551_615n) throw new OrderError(`${what}: not a u64: ${value}`);
    return value.toString();
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new OrderError(`${what}: not a u64: ${value}`);
    return String(value);
  }
  if (typeof value === 'string' && U64_RE.test(value)) return value;
  throw new OrderError(`${what}: not a u64: ${String(value)}`);
}

function checkOrder(o: unknown, what: string): { side: string; client_id: string | undefined; mint: string; amount: U64; max_slippage_bps: number } {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new OrderError(`${what}: order must be an object`);
  const obj = o as Record<string, unknown>;
  const side = obj.side;
  if (side !== 'buy' && side !== 'sell') throw new OrderError(`${what}: side must be buy or sell`);
  const allowed = side === 'buy'
    ? new Set(['side', 'client_id', 'mint', 'quote_lamports', 'max_slippage_bps'])
    : new Set(['side', 'client_id', 'mint', 'token_amount', 'max_slippage_bps']);
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) throw new OrderError(`${what}: unknown key ${k}`);
  }
  const mint = obj.mint;
  if (typeof mint !== 'string' || !PUBKEY_RE.test(mint)) throw new OrderError(`${what}: malformed mint`);
  const amount = toU64(side === 'buy' ? obj.quote_lamports : obj.token_amount, `${what}: amount`);
  const bps = obj.max_slippage_bps;
  if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new OrderError(`${what}: max_slippage_bps must be an integer 0..10000`);
  }
  const client_id = obj.client_id;
  if (client_id !== undefined) {
    if (typeof client_id !== 'string' || !CLIENT_ID_RE.test(client_id)) {
      throw new OrderError(`${what}: malformed client_id`);
    }
  }
  return { side, client_id: client_id as string | undefined, mint, amount, max_slippage_bps: bps };
}


export interface BotHandlers {
  onHello?(state: BotState): void;
  onBatch(state: BotState, batch: StrategyBatch): OrderInput[];
  onDone?(state: BotState, done: { reason: string }): void;
}

/**
 * Drive a strategy over stdin/stdout. Reads hello, then one batch at a time,
 * replying to each before reading the next. Exits 0 on done; throws (exit 1)
 * on any protocol violation so a broken bot fails loudly on your machine.
 */
export async function runBot(handlers: BotHandlers): Promise<void> {
  let state: BotState | null = null;
  let sawHello = false;
  let sawDone = false;
  let buffer = '';

  const writeReply = (line: string): void => {
    if (Buffer.byteLength(line, 'utf8') > MAX_BOT_LINE_BYTES) {
      throw new OrderError(`reply line over ${MAX_BOT_LINE_BYTES} bytes`);
    }
    process.stdout.write(line + '\n');
  };

  const handleLine = (raw: string): void => {
    if (raw.length === 0) return;
    if (Buffer.byteLength(raw, 'utf8') > MAX_HARNESS_LINE_BYTES) {
      throw new ProtocolError('harness line over the 1 MiB limit');
    }
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      throw new ProtocolError('harness line is not JSON');
    }
    if (typeof msg !== 'object' || msg === null || typeof msg.type !== 'string') {
      throw new ProtocolError('harness message must be an object with a type');
    }
    if (msg.type === 'hello') {
      if (sawHello) throw new ProtocolError('second hello');
      if (msg.protocol !== PROTOCOL) throw new ProtocolError(`unsupported protocol ${msg.protocol}`);
      state = new BotState(msg as Hello);
      sawHello = true;
      handlers.onHello?.(state);
      return;
    }
    if (!sawHello || state === null) throw new ProtocolError(`${msg.type} before hello`);
    if (msg.type === 'batch') {
      if (sawDone) throw new ProtocolError('batch after done');
      if (typeof msg.seq !== 'number' || typeof msg.slot !== 'number') {
        throw new ProtocolError('batch needs numeric seq and slot');
      }
      state.seq = msg.seq;
      const batch: StrategyBatch = {
        slot: msg.slot,
        events: msg.events ?? [],
        marks: msg.marks ?? [],
        fills: msg.fills ?? [],
      };
      state.applyBatch({ ...batch, account: msg.account });
      const orders = state.toOrders(handlers.onBatch(state, batch));
      state.recordOrders(orders);
      writeReply(JSON.stringify({ type: 'reply', seq: msg.seq, orders }));
      return;
    }
    if (msg.type === 'done') {
      sawDone = true;
      handlers.onDone?.(state, { reason: msg.reason ?? 'end_of_data' });
      return;
    }
    throw new ProtocolError(`unknown harness message type ${msg.type}`);
  };

  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      handleLine(line);
      if (sawDone) return;
      idx = buffer.indexOf('\n');
    }
  }
  if (buffer.length > 0) handleLine(buffer);
  if (!sawHello) throw new ProtocolError('no hello received');
}

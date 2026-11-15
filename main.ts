// ============================================================
// BTC Race Bot v12 — Hybrid: deep-dip + scalp + hourly guarantee
// make.fun btc-race-24h-20261115-0828
// ============================================================
//
// THREE LAYERS, checked in order (top priority first):
//
//   LAYER 1 — DEEP-DIP (the profit engine):
//     Price falls 2.0% below the high of the last 7 hours (420 bars)
//     AND bounces hard (close above the previous bar's high and above
//     the previous close). That is the capitulation point — the
//     snap-back after it is what pays. FULL size, TP 0.7% / SL 1.0%,
//     no max hold (a snap-back needs time, so deep-dip only exits on
//     TP or SL). Rare (a few trades a day) but it is where the money is.
//
//   LAYER 2 — SCALP (the frequency engine):
//     Price below its 20-bar average (oversold) + a bullish bar
//     (close above open) + starting to bounce (close above the
//     previous close). This signal fires hundreds of times a day in
//     any market. Position is TINY (1% of cash) so its losses can
//     never eat the deep-dip profit. TP 0.35% / SL 0.35%, forced exit
//     after 15 bars.
//
//   LAYER 3 — HOURLY GUARANTEE (the fallback):
//     If 60 bars (1 hour) pass with no entry at all and the bot holds
//     nothing, force one small scalp entry (same size and TP/SL as
//     layer 2). Every hour gets at least one trade, no hour is empty.
//
// Timing rule: at most 1 hour without a trade (the guarantee); at
// least as fast as the next bar after a position closes (no cooldown
// between trades — as soon as a position closes, the next bar can
// enter again if a signal is there).
//
// Why the layers are ordered this way: deep-dip is checked first
// because it is the only layer with a full-size position, so it must
// never be crowded out by a scalp signal on the same bar. The scalp
// layer exists to keep the bot active between dips, and the hourly
// guarantee exists so a quiet market never leaves an hour empty.
// The dev window is only a rehearsal — the live 24h window is a new
// market, so the bot is judged on its rules, not on one past window.
//
// Deterministic: a pure function of the bars seen (float64, IEEE 754),
// no clock, no environment, no randomness. Decisions are made on a
// bar's close and fill at the next bar's open, exactly as the
// bars-replay harness models them.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// ---------- Layer 1: deep-dip ----------
const REF_N = 420; // bars for the 7-hour high
const DEEP_DIP_PCT = 2.0; // dip (%) below the 7h high
const DEEP_TP_PCT = 0.7; // deep-dip take profit (%) above entry
const DEEP_SL_PCT = 1.0; // deep-dip stop loss (%) below entry

// ---------- Layers 2 & 3: scalp ----------
const SMA_N = 20; // bars for the mean (oversold reference)
const SCALP_TP_PCT = 0.35; // scalp take profit (%) above entry
const SCALP_SL_PCT = 0.35; // scalp stop loss (%) below entry
const SCALP_MAX_HOLD = 15; // bars; scalp is forced out if TP/SL not hit
const SCALP_SIZE_DIV = 100n; // scalp uses 1/100 of cash (1%)

// ---------- Layer 3: hourly guarantee ----------
const ENTRY_GAP = 60; // bars (1 hour); force an entry if this gap is passed

const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on

// ---------- State ----------
const closes: number[] = [];
const highs: number[] = [];
const lows: number[] = [];
const opens: number[] = [];
let entry = 0; // close (raw units) that triggered the current buy
let entryBar = 0; // bar index of the current entry
let isScalp = false; // true if the current position is a scalp trade
let lastEntryBar = -1000; // bar index of the most recent entry (any layer)

await runBars({
  onBatch(state: BarsState, batch) {
    for (const bar of batch.bars) {
      closes.push(Number(bar.c));
      highs.push(Number(bar.h));
      lows.push(Number(bar.l));
      opens.push(Number(bar.o));
    }
    if (state.warmingUp) return [];
    const i = closes.length - 1;
    if (i < SMA_N + 1) return [];

    // ===== MANAGE THE OPEN POSITION =====
    const held = state.positions.get('CBBTC');
    if (held !== undefined) {
      const tpPct = isScalp ? SCALP_TP_PCT : DEEP_TP_PCT;
      const slPct = isScalp ? SCALP_SL_PCT : DEEP_SL_PCT;
      const tpHit = highs[i] >= entry * (1 + tpPct / 100);
      const slHit = lows[i] <= entry * (1 - slPct / 100);
      const timedOut = isScalp && i - entryBar >= SCALP_MAX_HOLD;
      if (tpHit || slHit || timedOut) {
        const sell: SellInput = { side: 'sell', symbol: 'CBBTC', qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // ===== LAYER 1: DEEP-DIP (priority, active after 420 bars) =====
    if (i >= REF_N) {
      let refHigh = -Infinity;
      for (let k = i - REF_N + 1; k <= i; k++) if (highs[k] > refHigh) refHigh = highs[k];
      const deepDip = closes[i] <= refHigh * (1 - DEEP_DIP_PCT / 100);
      const strongBounce = closes[i] > highs[i - 1] && closes[i] > closes[i - 1];
      if (deepDip && strongBounce) {
        entry = closes[i];
        entryBar = i;
        isScalp = false;
        lastEntryBar = i;
        const buy: BuyInput = { side: 'buy', symbol: 'CBBTC', notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [buy];
      }
    }

    // ===== LAYER 2: FREQUENT SCALP =====
    let sma = 0;
    for (let k = i - SMA_N + 1; k <= i; k++) sma += closes[k];
    sma /= SMA_N;
    const oversold = closes[i] < sma;
    const bullish = closes[i] > opens[i];
    const bouncing = closes[i] > closes[i - 1];
    const scalpSignal = oversold && bullish && bouncing;

    // ===== LAYER 3: HOURLY GUARANTEE =====
    // If 1 hour passed with no entry, force one small scalp.
    const gapDue = i - lastEntryBar >= ENTRY_GAP;

    if (!scalpSignal && !gapDue) return [];

    entry = closes[i];
    entryBar = i;
    isScalp = true;
    lastEntryBar = i;
    const scalpCash = state.cash / SCALP_SIZE_DIV;
    const buy: BuyInput = { side: 'buy', symbol: 'CBBTC', notional_quote_units: scalpCash, max_slippage_bps: MAX_SLIPPAGE_BPS };
    return [buy];
  },
});

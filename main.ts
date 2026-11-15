// ============================================================
// BTC Race Bot — Capitulation Dip (deep-dip only)
// make.fun btc-race-24h-20261115-0828
// ============================================================
//
// IDEA: in a crash regime, small -2% dips are just steps of the
// bleed — buying them catches falling knives. Only TRUE
// capitulation dips (4%+ below the 7-hour high) followed by a
// strong bounce are worth a full-size entry. No scalp layer, no
// hourly guarantee: in a falling market, frequency is the enemy
// and patience is the edge. One clean setup per capitulation,
// TP/SL symmetric at 1%, exits only on TP/SL.
//
// Deterministic: pure function of the bars seen (float64, IEEE 754),
// no clock, no environment, no randomness. Decisions are made on a
// bar's close and fill at the next bar's open, exactly as the
// bars-replay harness models them.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

// ---------- Capitulation dip ----------
const REF_N = 420; // bars for the 7-hour high
const DEEP_DIP_PCT = 5.0; // dip (%) below the 7h high — capitulation only
const DEEP_TP_PCT = 1.0; // take profit (%) above entry
const DEEP_SL_PCT = 1.0; // stop loss (%) below entry

const MAX_SLIPPAGE_BPS = 100; // 1% past the close the order was decided on
const MIN_BARS = 21; // minimum bars before any decision (needs a previous bar for the bounce check)

// ---------- State ----------
const closes: number[] = [];
const highs: number[] = [];
const lows: number[] = [];
const opens: number[] = [];
let entry = 0; // close (raw units) that triggered the current buy

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
    if (i < MIN_BARS) return [];

    // ===== MANAGE THE OPEN POSITION =====
    const held = state.positions.get('CBBTC');
    if (held !== undefined) {
      const tpHit = highs[i] >= entry * (1 + DEEP_TP_PCT / 100);
      const slHit = lows[i] <= entry * (1 - DEEP_SL_PCT / 100);
      if (tpHit || slHit) {
        const sell: SellInput = { side: 'sell', symbol: 'CBBTC', qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [sell];
      }
      return [];
    }

    // ===== CAPITULATION DIP (only after 420 bars of history) =====
    if (i >= REF_N) {
      let refHigh = -Infinity;
      for (let k = i - REF_N + 1; k <= i; k++) if (highs[k] > refHigh) refHigh = highs[k];
      const deepDip = closes[i] <= refHigh * (1 - DEEP_DIP_PCT / 100);
      const strongBounce = closes[i] > highs[i - 1] && closes[i] > closes[i - 1];
      if (deepDip && strongBounce) {
        entry = closes[i];
        const buy: BuyInput = { side: 'buy', symbol: 'CBBTC', notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS };
        return [buy];
      }
    }

    return [];
  },
});

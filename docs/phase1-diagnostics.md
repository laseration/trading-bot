# Phase 1 Diagnostics

Phase 1 adds read-only audits and deterministic unit tests. It does not enable live trading, change strategy thresholds, alter MT5 order placement, or edit environment files.

## Candidate Audit

Run:

```sh
npm run audit:candidates
```

The audit reads existing runtime logs when present:

- `logs/decision-history.jsonl`
- `logs/eurusd-bias-diagnostics.jsonl`
- `logs/trade-history.csv`
- `logs/trade-events.csv`
- `logs/signal-results.json`

It prints candidate funnel counts, rejection reasons, hard blocks, score buckets, by-symbol/session/regime/setup counts, and reconciliation coverage. Missing files are reported as missing and produce `no data` sections instead of failing.

`missing execution identity` means a tracked entered signal has no usable `orderId` or `positionId` in its execution record and no unique matching entry row in `trade-events.csv`. Those records cannot be safely reconciled to an exit without risking a false match.

## Backtest Realism Audit

Run:

```sh
npm run audit:backtest
```

This prints informational warnings about the current backtest path. A `mock backtest` warning means the default backtest uses generated/mock bars and is suitable for smoke checks, not for market-realistic performance claims.

The audit also calls out that the current backtest PnL path does not model spread, slippage, commission, intrabar SL/TP execution, live news/session execution realism, or true out-of-sample walk-forward portfolio validation.

## Tests

Run all unit tests:

```sh
npm test
```

Run the existing startup import check:

```sh
npm run check
```

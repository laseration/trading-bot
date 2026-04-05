# Trading Bot

This repository is a small Node.js trading bot prototype with a live loop and a simple backtest entrypoint.

## Current Architecture

- `src/index.js` starts the live loop and logs the active configuration at startup.
- `src/bot.js` runs one bot cycle: fetches a price, generates a signal, applies risk limits, places trades, and records logs.
- `src/config.js` holds runtime settings such as interval, moving-average periods, risk settings, paper trading mode, and commission.
- `src/strategy.js` generates `BUY`, `SELL`, or `HOLD` from moving-average crossovers.
- `src/risk.js` calculates position size from equity, price, and risk limits.
- `src/broker.js` is an in-memory paper broker that tracks cash, position, and equity.
- `src/dataFeed.js` supplies mock price data for both the live loop and backtests.
- `src/logger.js` writes runtime outputs under `logs/`.
- `src/backtest.js` runs a simple historical simulation using the existing config, strategy, risk, and mock data feed.

## How To Run

This repo does not currently use a `package.json`; run files directly with Node.

Run the live bot:

```bash
node src/index.js
```

Run the backtest:

```bash
node src/backtest.js
```

## Runtime Output

Runtime files are written under `logs/`:

- `logs/bot.log`
- `logs/trade-history.csv`
- `logs/equity-history.csv`

These files are ignored by Git so local runs do not create noisy diffs.

## Notes

- The data feed is mocked, so both live runs and backtests currently operate on generated prices rather than exchange data.
- The broker is in-memory, so account state resets when the process restarts.
- The backtest starts with `10000` cash to match the current broker implementation.

## MT5 Bridge

The bot can now use Telegram as the signal source and `MT5` as the quote, validation, and execution source.

Bridge setup:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r bridge/requirements.txt
python bridge/mt5_bridge.py
```

Key env vars:

- `TELEGRAM_ENABLED=true`
- `TELEGRAM_BOT_TOKEN=...`
- `TELEGRAM_SIGNAL_CHAT_ID=...`
- `MT5_BRIDGE_ENABLED=true`
- `MT5_BRIDGE_BASE_URL=http://127.0.0.1:5001`
- `MT5_LOGIN=...`
- `MT5_PASSWORD=...`
- `MT5_SERVER=...`
- `MT5_TERMINAL_PATH=...`

Runtime flow:

- Telegram tells the bot what to do
- MT5 provides the current broker quote
- MT5 validates and executes the order

## Telegram Forwarder

If your trading bot cannot be added directly to the source signal channels, use a separate Telegram user-account forwarder to repost messages into one private destination chat that the bot can read.

Forwarder setup:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r bridge/requirements.txt
python bridge/telegram_forwarder.py
```

Forwarder env vars:

- `TELEGRAM_FORWARDER_API_ID=...`
- `TELEGRAM_FORWARDER_API_HASH=...`
- `TELEGRAM_FORWARDER_SOURCE_CHATS=source_one,source_two`
- `TELEGRAM_FORWARDER_DESTINATION_CHAT=private_destination`
- `TELEGRAM_FORWARDER_SESSION=bridge/telegram_forwarder`

Forwarder flow:

- Your Telegram user account reads the source channels
- The forwarder reposts text messages into one private destination chat
- Your Telegram bot is added only to that private destination
- `TELEGRAM_SIGNAL_CHAT_ID` should point to the private destination chat

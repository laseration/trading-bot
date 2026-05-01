# Trading Bot

This repository is a Node.js trading bot with MT5-backed execution, hybrid strategy gating, Telegram ingestion/publishing, reconciliation, and log-driven analysis tooling.

## Current Architecture

- `src/index.js` starts the live loop and logs the active configuration at startup.
- `src/bot.js` runs one bot cycle: fetches a price, generates a signal, applies risk limits, places trades, and records logs.
- `src/telegram.js` polls the private Telegram destination chat, normalizes source-channel signals and trade updates, and feeds them into the live bot.
- `src/telegram/` contains the branded publishing layer for premium signal posts, trade updates, and weekly summaries.
- `src/signals/` tracks published signals plus later TP / SL / closed updates for reporting.
- `src/images/` generates dark branded PNG cards for signals, results, and weekly reports.
- `src/config.js` holds runtime settings such as interval, moving-average periods, risk settings, paper trading mode, and commission.
- `src/strategy.js` generates `BUY`, `SELL`, or `HOLD` from the configured strategy set and feeds the hybrid approval layer.
- `src/risk.js` calculates position size from equity, price, and risk limits.
- `src/broker.js` is an in-memory paper broker that tracks cash, position, and equity.
- `src/dataFeed.js` supplies mock price data for both the live loop and backtests.
- `src/logger.js` writes runtime outputs under `logs/`.
- `src/backtest.js` runs a simple historical simulation using the existing config, strategy, risk, and mock data feed.

## How To Run

Install dependencies:

```bash
npm install
```

Env modes:

- Put shared settings in `.env.shared`
- Put demo MT5 credentials in `.env.demo`
- Put live MT5 credentials in `.env.live`
- Start in a specific mode with `TRADING_ENV=demo` or `TRADING_ENV=live`
- On Windows, the easiest options are:

```powershell
npm run start:demo
npm run start:live
```

- The bridge and forwarder support the same mode switch:

```powershell
npm run bridge:demo
npm run bridge:live
npm run forwarder:demo
npm run forwarder:live
```

- If `TRADING_ENV` is not set, the app falls back to the legacy `.env` file

Run the live bot:

```bash
npm start
```

Run the backtest:

```bash
npm run backtest
npm run backtest:news
```

Generate or post the weekly summary:

```bash
npm run weekly-summary
npm run reconcile-results
node src/postWeeklySummary.js --dry-run
```

## Runtime Output

Runtime files are written under `logs/`:

- `logs/bot.log`
- `logs/trade-history.csv`
- `logs/equity-history.csv`
- `logs/signal-results.json`

These files are ignored by Git so local runs do not create noisy diffs. Force-add only selected log files when you intentionally want to share analysis snapshots.

## Strategy Safety Notes

- `EURUSD` bias is `TRENDING`-only by default.
- `RANGING` and `UNSTABLE` EURUSD bias entries are blocked unless explicitly enabled by env.
- `ASIA` is blocked for EURUSD bias, `LONDON` is allowed only for qualified trend setups, and `NEWYORK` is stricter than London by default.
- `GBPUSD` can be enabled as a conservative demo strategy symbol with `MT5_ENABLE_GBPUSD_STRATEGY=true`; it is trend-continuation-only (`setupType=trend_continuation`) and rejects ranging/unstable conditions.
- If stop distance is missing, the bot sizes the trade at `0` and skips execution.

## Notes

- The data feed is mocked, so both live runs and backtests currently operate on generated prices rather than exchange data.
- The broker is in-memory, so account state resets when the process restarts.
- The backtest starts with `10000` cash to match the current broker implementation.

## MT5 Bridge

The bot can now use Telegram as the signal source and `MT5` as the quote, validation, and execution source.

This bridge now uses a native `MQL5` Expert Advisor inside `MT5`, plus a lightweight Python HTTP shim in this repo. The Node bot still talks to the same `/health`, `/quote`, `/account`, and `/order` HTTP endpoints.

Bridge setup:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r bridge/requirements.txt
python bridge/mt5_bridge.py
```

MT5 setup:

- Copy `bridge/mql5/TradingBotBridgeEA.mq5` into your terminal `MQL5/Experts/` folder
- Compile it in `MetaEditor`
- Either attach `TradingBotBridgeEA` to one open chart manually, or launch MT5 with the helper below so the chart and EA are opened automatically
- Keep `AutoTrading` enabled while the bot is running

Optional helper on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File bridge/install_mt5_native_bridge.ps1
powershell -ExecutionPolicy Bypass -File bridge/start_mt5_native_bridge.ps1
```

The startup helper creates a temporary MT5 config file plus a preset file, launches the configured terminal with `TradingBotBridgeEA` attached to `EURUSD` on `M1` by default, and waits for the EA heartbeat before returning. By default it injects the `.env` login credentials into startup; if you want to rely only on the terminal's saved login/session, set `MT5_STARTUP_USE_EXPLICIT_LOGIN=false`. You can override the startup chart with:

- `MT5_STARTUP_SYMBOL=...`
- `MT5_STARTUP_PERIOD=...`

If you want the Node bot to bring MT5 up automatically on startup, enable:

- `MT5_AUTO_START_HTTP_BRIDGE=true`
- `MT5_AUTO_START_TERMINAL=true`

With those enabled, `src/index.js` will start the local Python MT5 bridge if needed, compile/install `TradingBotBridgeEA`, launch MetaTrader with the bridge EA attached, and wait for the heartbeat before the normal startup checks continue.

Key env vars:

- `PAPER_TRADING_MODE=true`
- `TRADING_ENV=demo` or `TRADING_ENV=live`
- `TELEGRAM_ENABLED=true`
- `TELEGRAM_BOT_TOKEN=...`
- `TELEGRAM_SIGNAL_CHAT_ID=...`
- `TELEGRAM_POST_BOT_TOKEN=...`
- `TELEGRAM_POST_CHANNEL_ID=...`
- `TELEGRAM_BRAND_LOGO_PATH="C:\Users\User\Pictures\My Brand\logo.png"`
- `MT5_BRIDGE_ENABLED=true`
- `MT5_AUTO_START_HTTP_BRIDGE=true`
- `MT5_AUTO_START_TERMINAL=true`
- `MT5_BRIDGE_BASE_URL=http://127.0.0.1:5001`
- `MT5_BRIDGE_TIMEOUT_MS=60000`
- `MT5_MAX_QUOTE_AGE_MS=120000`
- `MT5_REQUIRE_CONNECTED=true`
- `MT5_LOGIN=...`
- `MT5_PASSWORD=...`
- `MT5_SERVER=...`
- `MT5_TERMINAL_PATH=...`
- `MT5_PORTABLE=true`
- `MT5_NATIVE_BRIDGE_DIR=%APPDATA%\MetaQuotes\Terminal\Common\Files\trading-bot-bridge`

Live MT5 trading:

- Leave `PAPER_TRADING_MODE=true` while testing end-to-end message flow without broker execution
- Set `PAPER_TRADING_MODE=false` only when you want the bot to place real MT5 orders
- On startup the bot now rejects MT5 mode if the terminal is disconnected or its latest quote timestamp is older than `MT5_MAX_QUOTE_AGE_MS`

If your installed desktop terminal is already tied to the wrong broker server, use a separate portable MT5 copy for the bridge:

- Copy the MT5 installation folder to a writable location such as `runtime/mt5-portable`
- Point `MT5_TERMINAL_PATH` at that copied `terminal64.exe`
- Set `MT5_PORTABLE=true`
- Launch that copy once and log into the correct broker server before starting the bridge

Runtime flow:

- Telegram tells the bot what to do
- The Python bridge writes requests into the shared MT5 common-files bridge folder
- `TradingBotBridgeEA` running inside `MT5` reads the request, performs the native MT5 action, and writes the response
- The Python bridge returns that result over HTTP to the Node bot

## Telegram Publishing Layer

The existing trading bot remains the only component that reads source-channel messages and decides what is actionable. A second Telegram bot token is used only for publishing branded content into your own channel.

Publishing flow:

- Source channels are forwarded into one private destination chat
- `src/telegram.js` reads that private destination chat with the existing listener bot
- The bot normalizes signal fields such as symbol, direction, entry, stop loss, take profits, timeframe, and trade-update actions
- `src/index.js` passes actionable signals into `runBot(profile, ...)`
- After `runBot(...)` returns, `src/telegram/publishingService.js` posts the branded signal card and caption to `TELEGRAM_POST_CHANNEL_ID`
- Later TP / SL / close updates are matched back to the tracked signal and published as branded channel updates

Tracked result fields are stored in `logs/signal-results.json`, including:

- unique signal id
- symbol and direction
- entry, stop loss, and TP ladder
- source chat metadata
- posted / entered / TP / SL / closed / cancelled status history
- final outcome and pips-or-points result when calculable

Automatic reconciliation:

- `src/signals/reconcileSignalResults.js` periodically scans the bot trade log plus MT5 history when available
- newly detected exits are converted into synthetic trade-update events
- those events mark signals as `closed`, `sl_hit`, `win`, or `loss` and can publish branded result updates automatically
- you can force a one-off catch-up pass with `npm run reconcile-results`

Weekly report flow:

- `src/signals/performanceAggregator.js` aggregates tracked outcomes across the requested time window
- `src/telegram/formatWeeklySummary.js` builds the HTML summary text
- `src/images/generateWeeklyReportCard.js` renders the branded PNG card
- `src/postWeeklySummary.js` can post the report or print it locally with `--dry-run`
- the weekly text summary now includes a trade-by-trade breakdown as well as totals

Brand logo notes:

- Set `TELEGRAM_BRAND_LOGO_PATH` to a full local file path on the machine running the bot
- PNG with transparency works best for a clean circular badge

## News Trading

News trading is optional and uses the same execution and branded publishing path as Telegram signals.

Flow:

- `src/newsAnalyzer.js` polls configured news APIs on its own interval
- Each article is scored for sentiment, macro tone, and symbol relevance
- Only signals above the configured confidence threshold and within allowed risk levels are emitted
- `src/index.js` feeds those news signals into the same `runBot(...)` and `publishSignal(...)` pipeline used by Telegram

Key env vars:

- `NEWS_TRADING_ENABLED=false`
- `NEWS_API_KEY=...`
- `ALPHA_VANTAGE_API_KEY=...`
- `NEWS_POLL_INTERVAL_MS=300000`
- `NEWS_SENTIMENT_THRESHOLD=0.7`
- `NEWS_RELEVANCE_THRESHOLD=0.45`
- `NEWS_SYMBOLS=EURUSD,GBPUSD,USDJPY,XAUUSD`
- `NEWS_STOP_LOSS_PCT=0.0035`
- `NEWS_REWARD_RISK_RATIO=2`
- `NEWS_ALLOWED_RISK_LEVELS=LOW,MEDIUM`
- `NEWS_BACKTEST_FILE=runtime/news-backtest-sample.json`

Backtesting:

- `npm run backtest:news`
- `node src/backtestNews.js --file=runtime/news-backtest-sample.json`
- `node src/backtestNews.js --file=runtime/news-backtest-sample.json --publish`

Notes:

- News signals are deduplicated in `logs/news-state.json`
- News-driven setups use market entry plus auto-generated SL / TP ladder
- High-risk news setups are skipped before execution and before branded posting
- Commodity symbols such as `XAUUSD` and `CL-OIL` can run through the same flow when your MT5 broker is streaming live ticks
- On Windows, quote the value if the path contains spaces
- Supported formats depend on `sharp`; PNG is the safest default
- If the logo path is missing or invalid, card generation continues without the logo

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
- `TELEGRAM_FORWARDER_SOURCE_1_NAME=CryptoRobotFreemium`
- `TELEGRAM_FORWARDER_SOURCE_1_CHAT=-1001234567890`
- `TELEGRAM_FORWARDER_SOURCE_2_NAME=SecondSource`
- `TELEGRAM_FORWARDER_SOURCE_2_CHAT=@secondsource`
- `TELEGRAM_FORWARDER_DESTINATION_CHAT=private_destination`
- `TELEGRAM_FORWARDER_SESSION=bridge/telegram_forwarder`

Forwarder flow:

- Your Telegram user account reads the source channels
- The forwarder reposts text messages into one private destination chat
- Your Telegram bot is added only to that private destination
- `TELEGRAM_SIGNAL_CHAT_ID` should point to the private destination chat

Source scoring:

- Tracked signal results already store the source channel name and id
- Weekly summaries now include the best source and a small source scoreboard
- You can optionally gate branded reposts by historical source quality with:
- `SOURCE_PERFORMANCE_LOOKBACK_DAYS=30`
- `SOURCE_PERFORMANCE_MIN_SETTLED_SIGNALS=5`
- `SOURCE_PERFORMANCE_MIN_WIN_RATE_TO_PUBLISH=55`

If `SOURCE_PERFORMANCE_MIN_WIN_RATE_TO_PUBLISH` is left blank, the bot keeps publishing normally and only reports source quality.

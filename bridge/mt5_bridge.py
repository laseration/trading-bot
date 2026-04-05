#!/usr/bin/env python3
import atexit
import json
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import MetaTrader5 as mt5
except ImportError:
    mt5 = None


HOST = os.getenv("MT5_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.getenv("MT5_BRIDGE_PORT", "5001"))
TIMEOUT_MS = int(os.getenv("MT5_TIMEOUT_MS", "60000"))
TERMINAL_PATH = os.getenv("MT5_TERMINAL_PATH", "").strip()
LOGIN = os.getenv("MT5_LOGIN", "").strip()
PASSWORD = os.getenv("MT5_PASSWORD", "").strip()
SERVER = os.getenv("MT5_SERVER", "").strip()
PORTABLE = os.getenv("MT5_PORTABLE", "false").lower() == "true"
DEFAULT_DEVIATION = int(os.getenv("MT5_DEVIATION_POINTS", "20"))
DEFAULT_MAGIC = int(os.getenv("MT5_MAGIC", "5151001"))
COMMENT_PREFIX = os.getenv("MT5_COMMENT_PREFIX", "trading-bot")
SUCCESS_SEND_RETCODES = set()
MT5_LOCK = threading.Lock()


class BridgeError(Exception):
    def __init__(self, message, status=400, details=None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.details = details


def mt5_constants():
    if mt5 is None:
        return {}

    return {
        "TRADE_RETCODE_DONE": getattr(mt5, "TRADE_RETCODE_DONE", None),
        "TRADE_RETCODE_DONE_PARTIAL": getattr(mt5, "TRADE_RETCODE_DONE_PARTIAL", None),
        "TRADE_RETCODE_PLACED": getattr(mt5, "TRADE_RETCODE_PLACED", None),
        "POSITION_TYPE_BUY": getattr(mt5, "POSITION_TYPE_BUY", 0),
        "POSITION_TYPE_SELL": getattr(mt5, "POSITION_TYPE_SELL", 1),
        "ORDER_TYPE_BUY": getattr(mt5, "ORDER_TYPE_BUY", 0),
        "ORDER_TYPE_SELL": getattr(mt5, "ORDER_TYPE_SELL", 1),
        "ORDER_FILLING_FOK": getattr(mt5, "ORDER_FILLING_FOK", 0),
        "ORDER_FILLING_IOC": getattr(mt5, "ORDER_FILLING_IOC", 1),
        "ORDER_FILLING_RETURN": getattr(mt5, "ORDER_FILLING_RETURN", 2),
        "ORDER_TIME_GTC": getattr(mt5, "ORDER_TIME_GTC", 0),
        "TRADE_ACTION_DEAL": getattr(mt5, "TRADE_ACTION_DEAL", 1),
    }


CONSTANTS = mt5_constants()

SUCCESS_SEND_RETCODES = {
    CONSTANTS.get("TRADE_RETCODE_DONE"),
    CONSTANTS.get("TRADE_RETCODE_DONE_PARTIAL"),
    CONSTANTS.get("TRADE_RETCODE_PLACED"),
}


def to_plain(value):
    if hasattr(value, "_asdict"):
        return {key: to_plain(item) for key, item in value._asdict().items()}

    if isinstance(value, dict):
        return {key: to_plain(item) for key, item in value.items()}

    if isinstance(value, (list, tuple)):
        return [to_plain(item) for item in value]

    return value


def last_error():
    if mt5 is None:
      return {"message": "MetaTrader5 package is not installed"}

    code, message = mt5.last_error()
    return {"code": code, "message": message}


def require_mt5():
    if mt5 is None:
        raise BridgeError(
            "MetaTrader5 package is not installed in this Python environment",
            status=500,
        )


def ensure_connection():
    require_mt5()

    terminal_info = mt5.terminal_info()
    account_info = mt5.account_info()

    if terminal_info is not None and account_info is not None:
        return

    kwargs = {
        "timeout": TIMEOUT_MS,
        "portable": PORTABLE,
    }

    if LOGIN:
        kwargs["login"] = int(LOGIN)
    if PASSWORD:
        kwargs["password"] = PASSWORD
    if SERVER:
        kwargs["server"] = SERVER

    ok = mt5.initialize(TERMINAL_PATH, **kwargs) if TERMINAL_PATH else mt5.initialize(**kwargs)

    if not ok:
        raise BridgeError("mt5.initialize failed", status=500, details=last_error())


def ensure_symbol(symbol):
    if not symbol:
        raise BridgeError("Missing symbol")

    ensure_connection()
    info = mt5.symbol_info(symbol)

    if info is None:
        raise BridgeError(f"MT5 symbol not found: {symbol}", status=404, details=last_error())

    if not info.visible and not mt5.symbol_select(symbol, True):
        raise BridgeError(f"MT5 could not select symbol: {symbol}", status=400, details=last_error())

    tick = mt5.symbol_info_tick(symbol)

    if tick is None:
        raise BridgeError(f"MT5 did not return a live tick for {symbol}", status=503, details=last_error())

    return info, tick


def get_price_from_tick(tick, side):
    bid = float(getattr(tick, "bid", 0) or 0)
    ask = float(getattr(tick, "ask", 0) or 0)
    last = float(getattr(tick, "last", 0) or 0)

    if side == "BUY" and ask > 0:
        return ask

    if side == "SELL" and bid > 0:
        return bid

    if last > 0:
        return last

    if ask > 0:
        return ask

    if bid > 0:
        return bid

    raise BridgeError("MT5 tick did not contain a usable price", status=503)


def get_mid_price(tick):
    bid = float(getattr(tick, "bid", 0) or 0)
    ask = float(getattr(tick, "ask", 0) or 0)
    last = float(getattr(tick, "last", 0) or 0)

    if bid > 0 and ask > 0:
        return (bid + ask) / 2

    if last > 0:
        return last

    if ask > 0:
        return ask

    if bid > 0:
        return bid

    raise BridgeError("MT5 tick did not contain a usable mid price", status=503)


def volume_decimals(step):
    step_text = f"{step:.8f}".rstrip("0").rstrip(".")

    if "." not in step_text:
        return 0

    return len(step_text.split(".")[1])


def normalize_volume(raw_qty, info):
    try:
        qty = float(raw_qty)
    except (TypeError, ValueError):
        raise BridgeError("Invalid order quantity")

    if qty <= 0:
        raise BridgeError("Order quantity must be greater than 0")

    volume_min = float(getattr(info, "volume_min", 0.01) or 0.01)
    volume_max = float(getattr(info, "volume_max", qty) or qty)
    volume_step = float(getattr(info, "volume_step", volume_min) or volume_min)
    decimals = volume_decimals(volume_step)

    qty = min(max(qty, volume_min), volume_max)
    steps = round(qty / volume_step)
    normalized = round(steps * volume_step, decimals)

    if normalized < volume_min:
        raise BridgeError(
            f"Normalized volume {normalized} is below broker minimum {volume_min}",
            status=400,
        )

    return normalized


def fill_mode(info):
    filling_mode = getattr(info, "filling_mode", CONSTANTS["ORDER_FILLING_RETURN"])

    if filling_mode in {
        CONSTANTS["ORDER_FILLING_FOK"],
        CONSTANTS["ORDER_FILLING_IOC"],
        CONSTANTS["ORDER_FILLING_RETURN"],
    }:
        return filling_mode

    return CONSTANTS["ORDER_FILLING_RETURN"]


def market_request(symbol, side, qty, info, *, position_ticket=None, deviation=None, magic=None, comment=None):
    tick = mt5.symbol_info_tick(symbol)

    if tick is None:
        raise BridgeError(f"MT5 did not return a live tick for {symbol}", status=503, details=last_error())

    request = {
        "action": CONSTANTS["TRADE_ACTION_DEAL"],
        "symbol": symbol,
        "volume": qty,
        "type": CONSTANTS["ORDER_TYPE_BUY"] if side == "BUY" else CONSTANTS["ORDER_TYPE_SELL"],
        "price": get_price_from_tick(tick, side),
        "deviation": int(deviation if deviation is not None else DEFAULT_DEVIATION),
        "magic": int(magic if magic is not None else DEFAULT_MAGIC),
        "comment": str(comment or f"{COMMENT_PREFIX}:{symbol}:{side}")[:31],
        "type_time": CONSTANTS["ORDER_TIME_GTC"],
        "type_filling": fill_mode(info),
    }

    if position_ticket is not None:
        request["position"] = int(position_ticket)

    return request


def validate_request(request):
    check = mt5.order_check(request)

    if check is None:
        raise BridgeError("MT5 order_check returned None", status=400, details=last_error())

    retcode = getattr(check, "retcode", None)

    if retcode not in {0}:
        raise BridgeError("MT5 order_check rejected the order", status=400, details=to_plain(check))

    return check


def send_request(request):
    check = validate_request(request)
    result = mt5.order_send(request)

    if result is None:
        raise BridgeError("MT5 order_send returned None", status=400, details=last_error())

    retcode = getattr(result, "retcode", None)

    if retcode not in SUCCESS_SEND_RETCODES:
        raise BridgeError("MT5 order_send failed", status=400, details=to_plain(result))

    return check, result


def positions_for_symbol(symbol):
    positions = mt5.positions_get(symbol=symbol)

    if positions is None:
        return []

    return list(positions)


def net_position(symbol):
    positions = positions_for_symbol(symbol)
    buy_volume = 0.0
    sell_volume = 0.0

    for position in positions:
        if position.type == CONSTANTS["POSITION_TYPE_BUY"]:
            buy_volume += float(position.volume)
        elif position.type == CONSTANTS["POSITION_TYPE_SELL"]:
            sell_volume += float(position.volume)

    return round(buy_volume - sell_volume, 8), positions


def close_opposite_positions(symbol, side, target_qty, info, *, deviation=None, magic=None, comment=None):
    target_type = CONSTANTS["POSITION_TYPE_SELL"] if side == "BUY" else CONSTANTS["POSITION_TYPE_BUY"]
    positions = [position for position in positions_for_symbol(symbol) if position.type == target_type]
    remaining = target_qty
    executions = []

    for position in sorted(positions, key=lambda item: item.time):
        if remaining <= 0:
            break

        close_qty = normalize_volume(min(remaining, float(position.volume)), info)
        request = market_request(
            symbol,
            side,
            close_qty,
            info,
            position_ticket=position.ticket,
            deviation=deviation,
            magic=magic,
            comment=comment,
        )
        check, result = send_request(request)
        result_dict = to_plain(result)
        executions.append(
            {
                "kind": "close",
                "ticket": position.ticket,
                "qty": close_qty,
                "validatedPrice": request["price"],
                "fillPrice": float(result_dict.get("price") or request["price"]),
                "check": to_plain(check),
                "result": result_dict,
            }
        )
        remaining = round(remaining - close_qty, 8)

    return remaining, executions


def execute_order(payload):
    symbol = str(payload.get("symbol", "")).strip().upper()
    side = str(payload.get("side", "")).strip().upper()

    if side not in {"BUY", "SELL"}:
        raise BridgeError("Order side must be BUY or SELL")

    info, tick = ensure_symbol(symbol)
    qty = normalize_volume(payload.get("qty"), info)
    deviation = payload.get("deviation")
    magic = payload.get("magic")
    comment = payload.get("comment") or f"{COMMENT_PREFIX}:{symbol}:{side}"
    expected_price = payload.get("expectedPrice")

    remaining, executions = close_opposite_positions(
        symbol,
        side,
        qty,
        info,
        deviation=deviation,
        magic=magic,
        comment=comment,
    )

    if remaining > 0:
        request = market_request(
            symbol,
            side,
            remaining,
            info,
            deviation=deviation,
            magic=magic,
            comment=comment,
        )
        check, result = send_request(request)
        result_dict = to_plain(result)
        executions.append(
            {
                "kind": "open",
                "qty": remaining,
                "validatedPrice": request["price"],
                "fillPrice": float(result_dict.get("price") or request["price"]),
                "check": to_plain(check),
                "result": result_dict,
            }
        )

    position, positions = net_position(symbol)
    account = mt5.account_info()

    if account is None:
        raise BridgeError("MT5 account is not available after order", status=500, details=last_error())

    last_execution = executions[-1] if executions else None

    return {
        "symbol": symbol,
        "side": side,
        "qty": qty,
        "expectedPrice": float(expected_price) if expected_price is not None else None,
        "validatedPrice": last_execution["validatedPrice"] if last_execution else get_mid_price(tick),
        "fillPrice": last_execution["fillPrice"] if last_execution else get_mid_price(tick),
        "position": position,
        "cash": float(account.margin_free),
        "balance": float(account.balance),
        "equity": float(account.equity),
        "marginFree": float(account.margin_free),
        "executions": executions,
        "positions": [to_plain(position_item) for position_item in positions],
    }


def quote_for_symbol(symbol):
    _, tick = ensure_symbol(symbol)

    return {
        "symbol": symbol,
        "bid": float(getattr(tick, "bid", 0) or 0),
        "ask": float(getattr(tick, "ask", 0) or 0),
        "last": float(getattr(tick, "last", 0) or 0),
        "price": float(get_mid_price(tick)),
        "time": int(getattr(tick, "time", 0) or 0),
    }


def account_snapshot(symbol):
    ensure_connection()
    account = mt5.account_info()

    if account is None:
        raise BridgeError("MT5 account is not available", status=500, details=last_error())

    position = 0.0
    positions = []

    if symbol:
        position, positions = net_position(symbol)

    return {
        "symbol": symbol,
        "cash": float(account.margin_free),
        "balance": float(account.balance),
        "equity": float(account.equity),
        "marginFree": float(account.margin_free),
        "position": position,
        "positions": [to_plain(position_item) for position_item in positions],
    }


def health_payload():
    ensure_connection()
    account = mt5.account_info()
    terminal = mt5.terminal_info()

    return {
        "status": "ok",
        "mt5PackageInstalled": mt5 is not None,
        "terminal": to_plain(terminal),
        "account": to_plain(account),
        "version": list(mt5.version()) if mt5 is not None else None,
    }


def read_json(handler):
    content_length = int(handler.headers.get("Content-Length", "0") or 0)

    if content_length <= 0:
        return {}

    body = handler.rfile.read(content_length)

    try:
        return json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise BridgeError("Invalid JSON body", status=400, details={"error": str(exc)})


def write_json(handler, status, payload):
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def handle_request(method, path, payload):
    if method == "GET" and path == "/health":
        return health_payload()

    if method == "POST" and path == "/quote":
        return quote_for_symbol(str(payload.get("symbol", "")).strip().upper())

    if method == "POST" and path == "/account":
        return account_snapshot(str(payload.get("symbol", "")).strip().upper())

    if method == "POST" and path == "/order":
        return execute_order(payload)

    raise BridgeError(f"Unsupported route: {method} {path}", status=404)


class BridgeHandler(BaseHTTPRequestHandler):
    def log_message(self, format_string, *args):
        return

    def do_GET(self):
        self._respond("GET")

    def do_POST(self):
        self._respond("POST")

    def _respond(self, method):
        path = self.path.split("?", 1)[0]

        try:
            payload = {} if method == "GET" else read_json(self)
            with MT5_LOCK:
                response = handle_request(method, path, payload)
            write_json(self, 200, response)
        except BridgeError as exc:
            write_json(self, exc.status, {"error": exc.message, "details": exc.details})
        except Exception as exc:
            write_json(self, 500, {"error": str(exc)})


def shutdown_mt5():
    if mt5 is not None:
        mt5.shutdown()


def main():
    atexit.register(shutdown_mt5)
    server = ThreadingHTTPServer((HOST, PORT), BridgeHandler)
    print(f"MT5 bridge listening on http://{HOST}:{PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()

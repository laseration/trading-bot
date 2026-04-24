#!/usr/bin/env python3
import atexit
import errno
import json
import os
import re
import socket
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


REPO_ROOT = os.path.dirname(os.path.dirname(__file__))
INITIAL_ENV_KEYS = set(os.environ.keys())
RUNTIME_DIR = os.path.join(REPO_ROOT, "runtime")
LOCK_PATH = os.path.join(RUNTIME_DIR, "mt5-bridge.lock.json")


def load_env_file(file_path, override=True):
    if not os.path.exists(file_path):
        return

    with open(file_path, "r", encoding="utf-8") as env_file:
        for raw_line in env_file:
            line = raw_line.strip()

            if not line or line.startswith("#") or "=" not in line:
                continue

            key, value = line.split("=", 1)
            key = key.strip()

            if not key:
                continue

            if not override and key in os.environ:
                continue

            if override and key in INITIAL_ENV_KEYS and key in os.environ:
                continue

            value = value.strip()

            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]

            os.environ[key] = value


def resolve_env_mode():
    return str(os.getenv("TRADING_ENV") or os.getenv("BOT_ENV") or "").strip().lower()


load_env_file(os.path.join(REPO_ROOT, ".env.shared"))
env_mode = resolve_env_mode()

if env_mode:
    load_env_file(os.path.join(REPO_ROOT, f".env.{env_mode}"))
else:
    load_env_file(os.path.join(REPO_ROOT, ".env"))


def default_native_bridge_dir():
    appdata = os.getenv("APPDATA", "").strip()

    if appdata:
        return os.path.join(
            appdata,
            "MetaQuotes",
            "Terminal",
            "Common",
            "Files",
            "trading-bot-bridge",
        )

    return os.path.join(
        os.path.dirname(os.path.dirname(__file__)),
        "runtime",
        "mt5-native-bridge",
    )


def is_process_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False

    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def acquire_lock():
    os.makedirs(RUNTIME_DIR, exist_ok=True)

    payload = json.dumps({
        "pid": os.getpid(),
        "startedAt": time.time(),
        "env": resolve_env_mode(),
    }, indent=2).encode("utf-8")

    while True:
        try:
            fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            with os.fdopen(fd, "wb") as lock_file:
                lock_file.write(payload)
            return
        except FileExistsError:
            try:
                with open(LOCK_PATH, "r", encoding="utf-8") as lock_file:
                    existing = json.load(lock_file)
            except Exception:
                existing = None

            if existing and existing.get("pid") != os.getpid() and is_process_alive(int(existing.get("pid", 0))):
                raise RuntimeError(f"Another MT5 bridge instance is already running (pid {existing['pid']})")

            try:
                os.remove(LOCK_PATH)
            except OSError:
                time.sleep(0.1)


def safe_remove(path, retries=10, delay_ms=50):
    for attempt in range(retries):
        try:
            os.remove(path)
            return True
        except FileNotFoundError:
            return True
        except PermissionError:
            if attempt == retries - 1:
                return False
            time.sleep(delay_ms / 1000)
        except OSError as exc:
            if exc.errno in {errno.EACCES, errno.EPERM}:
                if attempt == retries - 1:
                    return False
                time.sleep(delay_ms / 1000)
                continue
            raise

    return False


def release_lock():
    try:
        if not os.path.exists(LOCK_PATH):
            return

        with open(LOCK_PATH, "r", encoding="utf-8") as lock_file:
            existing = json.load(lock_file)

        if not existing or int(existing.get("pid", 0)) == os.getpid():
            os.remove(LOCK_PATH)
    except Exception:
        return


HOST = os.getenv("MT5_BRIDGE_HOST", "127.0.0.1")
PORT = int(os.getenv("MT5_BRIDGE_PORT", "5001"))
TIMEOUT_MS = int(os.getenv("MT5_BRIDGE_TIMEOUT_MS", "5000"))
POLL_INTERVAL_MS = int(os.getenv("MT5_NATIVE_BRIDGE_POLL_MS", "50"))
HEARTBEAT_STALE_MS = int(os.getenv("MT5_NATIVE_BRIDGE_HEARTBEAT_STALE_MS", "5000"))
BRIDGE_ROOT = os.path.abspath(
    os.path.expandvars(
        os.path.expanduser(
            os.getenv("MT5_NATIVE_BRIDGE_DIR", default_native_bridge_dir()),
        ),
    ),
)
REQUESTS_DIR = os.path.join(BRIDGE_ROOT, "requests")
RESPONSES_DIR = os.path.join(BRIDGE_ROOT, "responses")
STATUS_DIR = os.path.join(BRIDGE_ROOT, "status")
HEARTBEAT_PATH = os.path.join(STATUS_DIR, "heartbeat.txt")


class BridgeError(Exception):
    def __init__(self, message, status=400, details=None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.details = details


def ensure_dirs():
    os.makedirs(REQUESTS_DIR, exist_ok=True)
    os.makedirs(RESPONSES_DIR, exist_ok=True)
    os.makedirs(STATUS_DIR, exist_ok=True)


def escape_value(value):
    text = "" if value is None else str(value)
    return text.replace("\\", "\\\\").replace("\r", "\\r").replace("\n", "\\n")


def unescape_value(value):
    result = []
    index = 0

    while index < len(value):
        char = value[index]

        if char == "\\" and index + 1 < len(value):
            next_char = value[index + 1]

            if next_char == "n":
                result.append("\n")
                index += 2
                continue

            if next_char == "r":
                result.append("\r")
                index += 2
                continue

            if next_char == "\\":
                result.append("\\")
                index += 2
                continue

        result.append(char)
        index += 1

    return "".join(result)


def write_key_values(path, fields):
    with open(path, "w", encoding="utf-8", newline="\n") as output_file:
        for key, value in fields.items():
            output_file.write(f"{key}={escape_value(value)}\n")


def parse_key_values(text):
    values = {}

    for raw_line in text.splitlines():
        line = raw_line.strip().lstrip("\ufeff")

        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        values[key.strip()] = unescape_value(value)

    return values


def read_key_values(path):
    if not os.path.exists(path):
        return None

    retries = 5
    delay_ms = 50

    for attempt in range(retries):
        try:
            with open(path, "r", encoding="utf-8") as input_file:
                return parse_key_values(input_file.read())
        except FileNotFoundError:
            return None
        except PermissionError:
            if attempt == retries - 1:
                raise
            time.sleep(delay_ms / 1000)
        except OSError as exc:
            if exc.errno not in {errno.EACCES, errno.EPERM} or attempt == retries - 1:
                raise
            time.sleep(delay_ms / 1000)

    return None


def try_read_key_values(path):
    try:
        return read_key_values(path)
    except FileNotFoundError:
        return None
    except PermissionError:
        return None
    except OSError as exc:
        if exc.errno in {errno.EACCES, errno.EPERM}:
            return None
        raise


INT_PATTERN = re.compile(r"^-?\d+$")
FLOAT_PATTERN = re.compile(r"^-?(?:\d+\.\d+|\d+|\.\d+)(?:[eE][-+]?\d+)?$")


def coerce_value(value):
    if not isinstance(value, str):
        return value

    lowered = value.lower()

    if lowered == "true":
        return True

    if lowered == "false":
        return False

    if INT_PATTERN.fullmatch(value):
        try:
            return int(value)
        except ValueError:
            return value

    if FLOAT_PATTERN.fullmatch(value):
        try:
            return float(value)
        except ValueError:
            return value

    return value


def normalize_values(payload):
    return {key: coerce_value(value) for key, value in payload.items()}


def read_heartbeat():
    heartbeat = read_key_values(HEARTBEAT_PATH)

    if not heartbeat:
        return None

    heartbeat = normalize_values(heartbeat)
    timestamp_epoch = heartbeat.get("timestampEpoch")

    if timestamp_epoch is None:
        timestamp_epoch = os.path.getmtime(HEARTBEAT_PATH)
        heartbeat["timestampEpoch"] = timestamp_epoch

    heartbeat["ageMs"] = max(
        0,
        int((time.time() - float(timestamp_epoch)) * 1000),
    )
    return heartbeat


def readiness_details():
    heartbeat = read_heartbeat()
    return {
        "bridgeRoot": BRIDGE_ROOT,
        "requestsDir": REQUESTS_DIR,
        "responsesDir": RESPONSES_DIR,
        "statusDir": STATUS_DIR,
        "heartbeatPath": HEARTBEAT_PATH,
        "heartbeat": heartbeat,
    }


def ensure_native_agent_ready():
    ensure_dirs()
    heartbeat = read_heartbeat()

    if not heartbeat:
        raise BridgeError(
            "MT5 native bridge agent heartbeat was not found",
            status=503,
            details=readiness_details(),
        )

    if heartbeat.get("status") == "stopped":
        raise BridgeError(
            "MT5 native bridge agent is stopped",
            status=503,
            details=readiness_details(),
        )

    if int(heartbeat.get("ageMs", HEARTBEAT_STALE_MS + 1)) > HEARTBEAT_STALE_MS:
        raise BridgeError(
            "MT5 native bridge agent heartbeat is stale",
            status=503,
            details=readiness_details(),
        )

    return heartbeat


def request_native(action, payload=None):
    ensure_native_agent_ready()
    payload = payload or {}
    request_id = uuid.uuid4().hex
    request_path = os.path.join(REQUESTS_DIR, f"{request_id}.req")
    temp_path = os.path.join(REQUESTS_DIR, f"{request_id}.tmp")
    response_path = os.path.join(RESPONSES_DIR, f"{request_id}.res")

    if os.path.exists(response_path):
        safe_remove(response_path)

    fields = {
        "id": request_id,
        "action": action,
        "createdAtMs": int(time.time() * 1000),
    }

    for key, value in payload.items():
        if value is None:
            continue

        if isinstance(value, str):
            fields[key] = value.replace("\r", "").replace("\n", "\\n")
        else:
            fields[key] = value

    write_key_values(temp_path, fields)
    os.replace(temp_path, request_path)

    deadline = time.monotonic() + (TIMEOUT_MS / 1000)

    while time.monotonic() < deadline:
        response = try_read_key_values(response_path)

        if response is not None:
            safe_remove(response_path, retries=5, delay_ms=25)

            response = normalize_values(response)

            if response.get("status") == "error":
                raise BridgeError(
                    response.get("error", "MT5 native bridge agent returned an error"),
                    status=int(response.get("httpStatus", 400)),
                    details=response,
                )

            return response

        time.sleep(POLL_INTERVAL_MS / 1000)

    raise BridgeError(
        "Timed out waiting for MT5 native bridge agent response",
        status=504,
        details={
            **readiness_details(),
            "requestId": request_id,
            "requestPath": request_path,
            "responsePath": response_path,
            "timeoutMs": TIMEOUT_MS,
        },
    )


def health_payload():
    heartbeat = ensure_native_agent_ready()
    response = request_native("health")
    response["heartbeat"] = heartbeat
    return response


def quote_for_symbol(symbol):
    if not symbol:
        raise BridgeError("Missing symbol")

    return request_native("quote", {"symbol": str(symbol).strip()})


def account_snapshot(symbol):
    return request_native("account", {"symbol": str(symbol or "").strip()})


def list_symbols(filter_text=""):
    response = request_native("symbols", {"filter": str(filter_text or "").strip().upper()})
    raw_symbols = response.get("symbols", "")
    response["symbols"] = [symbol for symbol in str(raw_symbols).split("|") if symbol]
    return response


def symbol_info(symbol):
    if not symbol:
        raise BridgeError("Missing symbol")

    return request_native("symbol_info", {"symbol": str(symbol).strip()})


def history_snapshot(symbol="", from_epoch=None, to_epoch=None, limit=50):
    response = request_native(
        "history",
        {
            "symbol": str(symbol or "").strip(),
            "fromEpoch": from_epoch,
            "toEpoch": to_epoch,
            "limit": limit,
        },
    )
    deals = []

    for key, value in sorted(response.items()):
        if not key.startswith("deal"):
            continue

        parts = str(value).split("|")

        if len(parts) < 11:
            continue

        deals.append(
            {
                "ticket": coerce_value(parts[0]),
                "symbol": parts[1],
                "entry": coerce_value(parts[2]),
                "type": coerce_value(parts[3]),
                "volume": coerce_value(parts[4]),
                "price": coerce_value(parts[5]),
                "profit": coerce_value(parts[6]),
                "time": coerce_value(parts[7]),
                "comment": parts[8],
                "magic": coerce_value(parts[9]),
                "positionId": coerce_value(parts[10]),
            }
        )

    response["deals"] = deals
    return response


def bars_snapshot(symbol="", timeframe="M15", count=250):
    response = request_native(
        "bars",
        {
            "symbol": str(symbol or "").strip(),
            "timeframe": str(timeframe or "M15").strip().upper(),
            "count": count,
        },
    )
    bars = []

    for key, value in sorted(response.items()):
      if not key.startswith("bar"):
        continue

      parts = str(value).split("|")

      if len(parts) < 6:
        continue

      bars.append(
          {
              "time": coerce_value(parts[0]),
              "open": coerce_value(parts[1]),
              "high": coerce_value(parts[2]),
              "low": coerce_value(parts[3]),
              "close": coerce_value(parts[4]),
              "tickVolume": coerce_value(parts[5]),
          }
      )

    response["bars"] = bars
    return response


def execute_order(payload):
    symbol = str(payload.get("symbol", "")).strip()
    side = str(payload.get("side", "")).strip().upper()

    if not symbol:
        raise BridgeError("Missing symbol")

    if side not in {"BUY", "SELL"}:
        raise BridgeError("Order side must be BUY or SELL")

    return request_native(
        "order",
        {
            "symbol": symbol,
            "side": side,
            "qty": payload.get("qty"),
            "expectedPrice": payload.get("expectedPrice"),
            "deviation": payload.get("deviation"),
            "magic": payload.get("magic"),
            "comment": payload.get("comment"),
            "signalSource": payload.get("signalSource"),
            "rawSignal": payload.get("rawSignal"),
            "stopLoss": payload.get("stopLoss"),
            "takeProfit": payload.get("takeProfit"),
        },
    )


def modify_position(payload):
    symbol = str(payload.get("symbol", "")).strip()

    if not symbol:
        raise BridgeError("Missing symbol")

    return request_native(
        "modify",
        {
            "symbol": symbol,
            "side": payload.get("side"),
            "stopLoss": payload.get("stopLoss"),
            "takeProfit": payload.get("takeProfit"),
        },
    )


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


def is_port_bound(host, port):
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(0.5)

    try:
        return sock.connect_ex((host, port)) == 0
    finally:
        sock.close()


def handle_request(method, path, payload):
    if method == "GET" and path == "/health":
        return health_payload()

    if method == "POST" and path == "/quote":
        return quote_for_symbol(payload.get("symbol"))

    if method == "POST" and path == "/account":
        return account_snapshot(payload.get("symbol"))

    if method == "POST" and path == "/symbols":
        return list_symbols(payload.get("filter"))

    if method == "POST" and path == "/symbol-info":
        return symbol_info(payload.get("symbol"))

    if method == "POST" and path == "/history":
        return history_snapshot(
            payload.get("symbol"),
            payload.get("fromEpoch"),
            payload.get("toEpoch"),
            payload.get("limit", 50),
        )

    if method == "POST" and path == "/bars":
        return bars_snapshot(
            payload.get("symbol"),
            payload.get("timeframe", "M15"),
            payload.get("count", 250),
        )

    if method == "POST" and path == "/order":
        return execute_order(payload)

    if method == "POST" and path == "/modify":
        return modify_position(payload)

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
            response = handle_request(method, path, payload)
            write_json(self, 200, response)
        except BridgeError as exc:
            write_json(self, exc.status, {"error": exc.message, "details": exc.details})
        except Exception as exc:
            write_json(self, 500, {"error": str(exc)})


def main():
    try:
        acquire_lock()
    except RuntimeError as exc:
        # Another bridge instance is already active or in startup.
        print(str(exc), file=sys.stderr)
        return

    atexit.register(release_lock)
    ensure_dirs()
    try:
        server = ThreadingHTTPServer((HOST, PORT), BridgeHandler)
    except OSError as exc:
        if exc.errno in {errno.EADDRINUSE, 10048} and is_port_bound(HOST, PORT):
            print(f"MT5 native bridge already listening on http://{HOST}:{PORT}", file=sys.stderr)
            return
        raise

    print(f"MT5 native bridge listening on http://{HOST}:{PORT}")
    print(f"Bridge root: {BRIDGE_ROOT}")
    server.serve_forever()


if __name__ == "__main__":
    main()

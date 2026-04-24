#!/usr/bin/env python3
import asyncio
import atexit
import json
import os
import sys
import time

from telethon import TelegramClient, events
from telethon.utils import get_display_name


REPO_ROOT = os.path.dirname(os.path.dirname(__file__))
INITIAL_ENV_KEYS = set(os.environ.keys())
RUNTIME_DIR = os.path.join(REPO_ROOT, "runtime")
LOCK_PATH = os.path.join(RUNTIME_DIR, "telegram-forwarder.lock.json")


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
                raise RuntimeError(f"Another Telegram forwarder instance is already running (pid {existing['pid']})")

            try:
                os.remove(LOCK_PATH)
            except OSError:
                time.sleep(0.1)


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


load_env_file(os.path.join(REPO_ROOT, ".env.shared"))
env_mode = resolve_env_mode()

if env_mode:
    load_env_file(os.path.join(REPO_ROOT, f".env.{env_mode}"))
else:
    load_env_file(os.path.join(REPO_ROOT, ".env"))


def env_flag(name, default=False):
    raw = os.getenv(name)

    if raw is None:
        return default

    return raw.strip().lower() in {"1", "true", "yes", "on"}


def env_int(name, default=0):
    raw = os.getenv(name, "").strip()

    if not raw:
        return default

    try:
        return int(raw)
    except ValueError:
        raise RuntimeError(f"Environment variable {name} must be an integer")


def read_required_env(name):
    value = os.getenv(name, "").strip()

    if not value:
        raise RuntimeError(f"Missing required environment variable: {name}")

    return value


def parse_chat_ref(value):
    text = str(value).strip()

    if not text:
        raise RuntimeError("Encountered an empty chat reference")

    if text.lstrip("-").isdigit():
        return int(text)

    return text


def read_chat_list(name):
    raw = os.getenv(name, "")
    values = [item.strip() for item in raw.split(",") if item.strip()]

    if not values:
      raise RuntimeError(f"Missing required environment variable: {name}")

    return [parse_chat_ref(value) for value in values]


def read_numbered_source_chats():
    source_configs = []

    for key, value in os.environ.items():
        if not key.startswith("TELEGRAM_FORWARDER_SOURCE_") or not key.endswith(("_CHAT", "_CHAT_ID")):
            continue

        parts = key.split("_")

        if len(parts) < 5:
            continue

        try:
            index = int(parts[3])
        except ValueError:
            continue

        chat_value = value.strip()

        if not chat_value:
            continue

        name = os.getenv(f"TELEGRAM_FORWARDER_SOURCE_{index}_NAME", "").strip()
        source_configs.append(
            {
                "index": index,
                "chat_ref": parse_chat_ref(chat_value),
                "name": name,
            }
        )

    return sorted(source_configs, key=lambda item: item["index"])


def format_source_label(entity):
    title = getattr(entity, "title", "") or getattr(entity, "username", "")

    if title:
        return title

    return get_display_name(entity) or str(getattr(entity, "id", "unknown"))


def render_message(source_label, text):
    parts = [f"[SOURCE] {source_label}"] if INCLUDE_SOURCE_LABEL else []

    if text:
        parts.append(text)

    return "\n\n".join(parts).strip()


API_ID = int(read_required_env("TELEGRAM_FORWARDER_API_ID"))
API_HASH = read_required_env("TELEGRAM_FORWARDER_API_HASH")
SESSION = os.getenv(
    "TELEGRAM_FORWARDER_SESSION",
    os.path.join(os.path.dirname(__file__), "telegram_forwarder"),
)
PHONE = os.getenv("TELEGRAM_FORWARDER_PHONE", "").strip() or None
NUMBERED_SOURCE_CHATS = read_numbered_source_chats()
SOURCE_CHATS = [item["chat_ref"] for item in NUMBERED_SOURCE_CHATS] if NUMBERED_SOURCE_CHATS else read_chat_list("TELEGRAM_FORWARDER_SOURCE_CHATS")
DESTINATION_CHAT = parse_chat_ref(read_required_env("TELEGRAM_FORWARDER_DESTINATION_CHAT"))
INCLUDE_SOURCE_LABEL = env_flag("TELEGRAM_FORWARDER_INCLUDE_SOURCE_LABEL", default=True)
BACKFILL_MESSAGES = max(0, env_int("TELEGRAM_FORWARDER_BACKFILL_MESSAGES", default=0))


async def repost_text_message(client, destination, source_label, message, prefix="Reposted"):
    text = (message.raw_text or "").strip()

    if not text:
        print(f"Skipping non-text message from {source_label} message_id={message.id}")
        return False

    outgoing_text = render_message(source_label, text)
    await client.send_message(destination, outgoing_text)
    print(f"{prefix} message_id={message.id} from {source_label}")
    return True


async def main():
    acquire_lock()
    atexit.register(release_lock)
    client = TelegramClient(SESSION, API_ID, API_HASH)
    await client.connect()

    if not await client.is_user_authorized():
        if not PHONE:
            raise RuntimeError(
                "TELEGRAM_FORWARDER_PHONE is required for the first Telegram login",
            )

        await client.start(phone=PHONE)

    source_entities = []
    source_labels = {}
    numbered_labels = {item["chat_ref"]: item["name"] for item in NUMBERED_SOURCE_CHATS if item["name"]}

    for chat_ref in SOURCE_CHATS:
        entity = await client.get_entity(chat_ref)
        source_entities.append(entity)
        source_labels[entity.id] = numbered_labels.get(chat_ref) or format_source_label(entity)

    destination = await client.get_entity(DESTINATION_CHAT)
    destination_label = format_source_label(destination)

    print("Telegram forwarder started")
    print(f"Destination: {destination_label}")
    print(
        "Sources: "
        + ", ".join(source_labels[entity.id] for entity in source_entities)
    )

    if BACKFILL_MESSAGES > 0:
        for entity in source_entities:
            source_label = source_labels[entity.id]
            messages = await client.get_messages(entity, limit=BACKFILL_MESSAGES)

            for message in reversed(messages):
                await repost_text_message(
                    client,
                    destination,
                    source_label,
                    message,
                    prefix="Backfilled",
                )

    @client.on(events.NewMessage(chats=source_entities))
    async def handle_new_message(event):
        source_label = source_labels.get(event.chat_id, str(event.chat_id))
        await repost_text_message(client, destination, source_label, event.message)

    await client.run_until_disconnected()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Telegram forwarder stopped")
    except Exception as exc:
        print(f"Telegram forwarder failed: {exc}", file=sys.stderr)
        sys.exit(1)

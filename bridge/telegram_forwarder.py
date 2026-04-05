#!/usr/bin/env python3
import asyncio
import os
import sys

from telethon import TelegramClient, events
from telethon.utils import get_display_name


ENV_FILE = os.path.join(os.path.dirname(os.path.dirname(__file__)), ".env")


def load_env_file(file_path):
    if not os.path.exists(file_path):
        return

    with open(file_path, "r", encoding="utf-8") as env_file:
        for raw_line in env_file:
            line = raw_line.strip()

            if not line or line.startswith("#") or "=" not in line:
                continue

            key, value = line.split("=", 1)
            key = key.strip()

            if not key or key in os.environ:
                continue

            value = value.strip()

            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]

            os.environ[key] = value


load_env_file(ENV_FILE)


def env_flag(name, default=False):
    raw = os.getenv(name)

    if raw is None:
        return default

    return raw.strip().lower() in {"1", "true", "yes", "on"}


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
SOURCE_CHATS = read_chat_list("TELEGRAM_FORWARDER_SOURCE_CHATS")
DESTINATION_CHAT = parse_chat_ref(read_required_env("TELEGRAM_FORWARDER_DESTINATION_CHAT"))
INCLUDE_SOURCE_LABEL = env_flag("TELEGRAM_FORWARDER_INCLUDE_SOURCE_LABEL", default=True)


async def main():
    client = TelegramClient(SESSION, API_ID, API_HASH)
    await client.start()

    source_entities = []
    source_labels = {}

    for chat_ref in SOURCE_CHATS:
        entity = await client.get_entity(chat_ref)
        source_entities.append(entity)
        source_labels[entity.id] = format_source_label(entity)

    destination = await client.get_entity(DESTINATION_CHAT)
    destination_label = format_source_label(destination)

    print("Telegram forwarder started")
    print(f"Destination: {destination_label}")
    print(
        "Sources: "
        + ", ".join(source_labels[entity.id] for entity in source_entities)
    )

    @client.on(events.NewMessage(chats=source_entities))
    async def handle_new_message(event):
        text = (event.raw_text or "").strip()

        if not text:
            print(
                f"Skipping non-text message from {source_labels.get(event.chat_id, event.chat_id)} "
                f"message_id={event.message.id}"
            )
            return

        source_label = source_labels.get(event.chat_id, str(event.chat_id))
        outgoing_text = render_message(source_label, text)
        await client.send_message(destination, outgoing_text)
        print(f"Reposted message_id={event.message.id} from {source_label}")

    await client.run_until_disconnected()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Telegram forwarder stopped")
    except Exception as exc:
        print(f"Telegram forwarder failed: {exc}", file=sys.stderr)
        sys.exit(1)

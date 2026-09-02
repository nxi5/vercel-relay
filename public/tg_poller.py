#!/usr/bin/env python3
"""
tg_poller.py — Telegram <-> Hermes bridge, runs INSIDE the Daytona sandbox.
- Long-polls getUpdates from the user's own bot (token belongs to the user)
- Sends every text message to `hermes -z "<text>"` (local CLI, no API needed)
- Sends the reply back via sendMessage
- ALL network goes through the Vercel relay (DPI only whitelists *.vercel.app)
Env:
  TG_TOKEN, TG_CHAT_ID   (user's bot token + allowed chat id)
  RELAY_BASE             e.g. https://free-hermes.vercel.app
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error

TG_TOKEN = os.environ["TG_TOKEN"]
TG_CHAT_ID = os.environ["TG_CHAT_ID"]
RELAY_BASE = os.environ["RELAY_BASE"].rstrip("/")

API = f"{RELAY_BASE}/telegram/bot{TG_TOKEN}"
HERMES = "/opt/hv/bin/hermes" if os.path.exists("/opt/hv/bin/hermes") else "hermes"


def tg(method: str, payload: dict | None = None, timeout: int = 40):
    """Call the Telegram Bot API through the relay."""
    url = f"{API}/{method}"
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:200]
        print(f"[tg] {method} HTTP {e.code}: {body}", flush=True)
        return {"ok": False, "error": body}
    except Exception as e:
        print(f"[tg] {method} failed: {e}", flush=True)
        return {"ok": False, "error": str(e)}


def ask_hermes(text: str) -> str:
    """Run a one-shot hermes turn and capture stdout."""
    try:
        p = subprocess.run(
            [HERMES, "-z", text],
            capture_output=True, text=True, timeout=240, cwd="/tmp",
        )
        out = (p.stdout or "").strip()
        return out if out else f"(hermes returned nothing; stderr: {(p.stderr or '')[:150]})"
    except subprocess.TimeoutExpired:
        return "(hermes timed out)"
    except Exception as e:
        return f"(hermes error: {e})"


def send_message(chat_id, text: str):
    # Telegram hard cap 4096 chars
    for i in range(0, len(text), 4000):
        tg("sendMessage", {"chat_id": chat_id, "text": text[i:i + 4000]})


def main():
    print(f"[tg] poller starting, relay={RELAY_BASE}", flush=True)
    # sanity: whoami through the relay
    me = tg("getMe")
    if not me.get("ok"):
        print(f"[tg] getMe failed — token bad or relay down: {me}", flush=True)
        sys.exit(1)
    print(f"[tg] polling as @{me['result'].get('username')}", flush=True)

    offset = 0
    while True:
        try:
            res = tg("getUpdates", {"offset": offset, "timeout": 30}, timeout=45)
            if not res.get("ok"):
                time.sleep(5)
                continue
            for upd in res.get("result", []):
                offset = upd["update_id"] + 1
                msg = upd.get("message") or upd.get("edited_message") or {}
                chat = msg.get("chat", {})
                text = (msg.get("text") or "").strip()
                if not text or str(chat.get("id")) != str(TG_CHAT_ID):
                    continue
                print(f"[tg] <- {chat.get('username')}: {text[:60]}", flush=True)
                # ack immediately so the user sees life
                tg("sendChatAction", {"chat_id": chat["id"], "action": "typing"})
                reply = ask_hermes(text)
                send_message(chat["id"], reply)
                print(f"[tg] -> replied {len(reply)} chars", flush=True)
        except KeyboardInterrupt:
            sys.exit(0)
        except Exception as e:
            print(f"[tg] loop error: {e}", flush=True)
            time.sleep(5)


if __name__ == "__main__":
    main()

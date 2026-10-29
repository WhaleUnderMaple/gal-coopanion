#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""LunaTranslator text bridge.

Reads LunaTranslator's original-text WebSocket (`/api/ws/text/origin`) and turns it
into a small, clean HTTP API that a desktop-pet plugin can poll:

    GET /health
    GET /current                    -> current line
    GET /history?limit=N            -> last N lines
    GET /history?since=SEQ&limit=N  -> lines newer than SEQ
    GET /wait?since=SEQ&timeout=S   -> long-poll until a new line arrives

Why a bridge at all:
  * Luna's raw payload puts the speaker name *after* the line and may repeat it:
        「……台词」\n【 Name 】【 Name 】
    This bridge splits name/text, collapses duplicated name markers, and drops
    repeated pushes of the same line.
  * It keeps a bounded history on disk so a restart does not lose context.

Configuration: `config.json` next to this file (see config.example.json).
"""
from __future__ import annotations

import json
import os
import re
import time
import threading
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import websockets

HERE = os.path.dirname(os.path.abspath(__file__))
NAME_RE = re.compile(r"【\s*([^】]{1,16}?)\s*】")


def load_config() -> dict:
    path = os.path.join(HERE, "config.json")
    cfg = {
        "httpPort": 18996,
        "bind": "127.0.0.1",
        "luna": {"host": "127.0.0.1", "port": 2333},
        "historyLimit": 500,
        "historyFile": "luna-history.json",
        "logFile": "luna-bridge.log",
    }
    try:
        with open(path, encoding="utf-8") as f:
            user = json.load(f)
        for k, v in user.items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
    except FileNotFoundError:
        pass
    except Exception as exc:  # 不静默：配置写坏了要能看见
        print(f"[bridge] config.json 读取失败，用默认值：{exc!r}")
    return cfg


CFG = load_config()
LUNA_WS = f"ws://{CFG['luna']['host']}:{CFG['luna']['port']}/api/ws/text/origin"
PORT = int(CFG["httpPort"])
BIND = str(CFG.get("bind", "127.0.0.1"))
HISTORY_LIMIT = int(CFG.get("historyLimit", 500))
HISTORY_FILE = os.path.join(HERE, str(CFG.get("historyFile", "luna-history.json")))
LOG = os.path.join(HERE, str(CFG.get("logFile", "luna-bridge.log")))

STATE_LOCK = threading.Lock()
SEQ = 0
CURRENT = {"seq": 0, "name": None, "text": "", "raw": "", "ts": 0}
HISTORY: list[dict] = []
NEW_EVENT = threading.Event()


def log(msg: str) -> None:
    line = "%s %s\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line)
    except Exception:
        pass


def parse(raw: str) -> dict:
    """Split Luna's raw payload into {name, text} and drop duplicated name markers."""
    names: list[str] = []
    for m in NAME_RE.finditer(raw):
        n = m.group(1).strip()
        if n and n not in names:
            names.append(n)
    body = NAME_RE.sub("", raw)
    text = "\n".join(ln.strip() for ln in body.splitlines() if ln.strip())
    return {"name": names[0] if names else None, "text": text, "raw": raw,
            "ts": round(time.time(), 3)}


def load_history() -> list[dict]:
    try:
        with open(HISTORY_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def save_history(items: list[dict]) -> None:
    try:
        with open(HISTORY_FILE, "w", encoding="utf-8") as f:
            json.dump(items[-HISTORY_LIMIT:], f, ensure_ascii=False)
    except Exception as exc:
        log("history save failed: %r" % (exc,))


def is_continuation(prev: dict, cur: dict) -> bool:
    """True when `cur` looks like a longer/partial re-send of `prev`."""
    if not prev or not cur:
        return False
    if (prev.get("name") or "") != (cur.get("name") or ""):
        return False
    a = (prev.get("text") or "").strip()
    b = (cur.get("text") or "").strip()
    if not a or not b:
        return False
    if a == b:
        return True
    short, long_ = (a, b) if len(a) <= len(b) else (b, a)
    if not (long_.startswith(short) or long_.endswith(short)):
        return False
    if short[-1] in "」』。！？!?…":
        return False
    if len(short) >= len(long_) * 0.85:
        return False
    return True


def snapshot(since: int = 0, limit: int = 30) -> list[dict]:
    with STATE_LOCK:
        if not HISTORY:
            return []
        if since <= 0:
            return [dict(x) for x in HISTORY[-limit:]]
        return [dict(x) for x in HISTORY if x["seq"] > since][:limit]


async def pump() -> None:
    global SEQ
    backoff = 1.0
    while True:
        try:
            async with websockets.connect(LUNA_WS, open_timeout=10, ping_interval=20) as ws:
                log("connected %s" % LUNA_WS)
                backoff = 1.0
                async for msg in ws:
                    raw = msg if isinstance(msg, str) else msg.decode("utf-8", "replace")
                    if not raw.strip():
                        continue
                    item = parse(raw)
                    if not item["text"] and not item["name"]:
                        continue
                    with STATE_LOCK:
                        if item["raw"] == CURRENT.get("raw"):
                            continue
                        if HISTORY and is_continuation(HISTORY[-1], item):
                            item["seq"] = HISTORY[-1]["seq"]
                            HISTORY[-1] = item
                            CURRENT.update(item)
                        else:
                            SEQ += 1
                            item["seq"] = SEQ
                            CURRENT.update(item)
                            HISTORY.append(item)
                            del HISTORY[:-HISTORY_LIMIT]
                    save_history(HISTORY)
                    NEW_EVENT.set()
        except Exception as exc:
            log("ws error %r (retry in %.0fs)" % (exc, backoff))
            await asyncio.sleep(backoff)
            backoff = min(30.0, backoff * 2)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # 安静
        pass

    def _json(self, code: int, obj: dict) -> None:
        data = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        try:
            self._do_GET()
        except Exception as exc:
            log("http error %s: %r" % (self.path, exc))
            try:
                self._json(200, {"ok": False, "error": str(exc)[:300]})
            except Exception:
                pass

    def _do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path == "/health":
            with STATE_LOCK:
                self._json(200, {"ok": True, "seq": SEQ, "luna": LUNA_WS})
            return
        if u.path == "/current":
            with STATE_LOCK:
                self._json(200, {"ok": True, "line": dict(CURRENT)})
            return
        if u.path == "/history":
            since = int((q.get("since") or ["0"])[0])
            limit = max(1, min(200, int((q.get("limit") or ["30"])[0])))
            self._json(200, {"ok": True, "lines": snapshot(since, limit)})
            return
        if u.path == "/wait":
            since = int((q.get("since") or ["0"])[0])
            timeout = min(120.0, float((q.get("timeout") or ["45"])[0]))
            end = time.time() + timeout
            while time.time() < end:
                lines = snapshot(since, 30)
                if lines:
                    self._json(200, {"ok": True, "lines": lines})
                    return
                NEW_EVENT.clear()
                NEW_EVENT.wait(min(1.0, max(0.05, end - time.time())))
            self._json(200, {"ok": True, "lines": [], "timeout": True})
            return
        self._json(404, {"ok": False, "error": "not found"})


def serve() -> None:
    ThreadingHTTPServer((BIND, PORT), Handler).serve_forever()


def main() -> None:
    HISTORY.extend(load_history())
    if HISTORY:
        globals()["SEQ"] = HISTORY[-1].get("seq", 0)
        CURRENT.update(HISTORY[-1])
    log("bridge starting; http %s:%d -> %s (history %d)" % (BIND, PORT, LUNA_WS, len(HISTORY)))
    threading.Thread(target=serve, daemon=True).start()
    asyncio.run(pump())


if __name__ == "__main__":
    main()

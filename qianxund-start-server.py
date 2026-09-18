#!/usr/bin/env python3
"""qianxund-start-server.py — 千寻引擎常驻启动器。

浏览器侧边栏无法直接启动本地进程（不能跑 shell / launchctl），因此这里提供
一个**长期运行的轻量 HTTP 服务**（默认 127.0.0.1:8766），专门负责拉起
qianxund（127.0.0.1:8765）。按钮点「启动引擎」→ fetch 本服务 /api/start →
spawn qianxund.py。

本服务自己由 launchd 托管（com.qianxund-start，KeepAlive）——它极轻，
几乎不会挂；因此 qianxund 意外离线时，按钮总能通过它拉起引擎。

端点：
  GET  /api/status   → {engine_alive: bool, qianxund: {pid, uptime_s}}
  POST /api/start    → 拉起 qianxund（若已在线返回 already_running）
  POST /api/stop     → 杀掉 qianxund（调试用）
安全：只监听 127.0.0.1；start/stop 需要 X-Api-Token（默认 qianxund-ctl，可环境变量覆盖）。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

HERE = Path(__file__).resolve().parent
QIANXUND = HERE / "qianxund.py"
ENGINE_HEALTH = "http://127.0.0.1:8765/health"
DEFAULT_PORT = int(os.environ.get("QIANXUND_START_PORT", "8766"))
DEFAULT_TOKEN = os.environ.get("QIANXUND_START_TOKEN", "qianxund-ctl")

# qianxund 启动参数（与 launchd plist 一致；如并发/批大小调整，改这里）
QIANXUND_ARGS = [
    sys.executable or "/opt/homebrew/bin/python3",
    str(QIANXUND),
    "serve",
    "--port", "8765",
    "--concurrent", "6",
    "--batch-size", "8",
]

def engine_alive() -> bool:
    import urllib.request
    try:
        with urllib.request.urlopen(ENGINE_HEALTH, timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False

def engine_uptime() -> int | None:
    import urllib.request
    try:
        with urllib.request.urlopen(ENGINE_HEALTH, timeout=2) as resp:
            d = json.loads(resp.read() or b"{}")
            return d.get("uptime_s")
    except Exception:
        return None

def start_engine() -> dict:
    if engine_alive():
        return {"ok": True, "started": False, "message": "already_running",
                "uptime_s": engine_uptime()}
    # 优先走 launchd 托管：若 com.qianxund 未 load 但 plist 存在，先 load 再 kickstart。
    # 这样引擎回到 KeepAlive 自愈管理，而不是无托管的 spawn 进程。
    plist = Path.home() / "Library" / "LaunchAgents" / "com.qianxund.plist"
    launchd = subprocess.run(
        ["launchctl", "list"],
        capture_output=True, text=True, timeout=5,
    ).stdout
    has_task = ("com.qianxund\n" in launchd or "com.qianxund\t" in launchd
                or "com.qianxund " in launchd)
    if plist.exists() and not has_task:
        subprocess.run(["launchctl", "load", str(plist)],
                       capture_output=True, timeout=5)
        has_task = True
    if has_task:
        subprocess.run(
            ["launchctl", "kickstart", f"gui/{os.getuid()}/com.qianxund"],
            capture_output=True, timeout=5,
        )
        return {"ok": True, "started": True, "message": "via launchd kickstart"}
    # launchd 不可用：直接 spawn 独立进程
    log = open("/tmp/qianxund.log", "ab")
    try:
        proc = subprocess.Popen(
            QIANXUND_ARGS,
            cwd=str(HERE),
            stdout=log,
            stderr=log,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
        return {"ok": True, "started": True, "pid": proc.pid,
                "message": "spawned"}
    except Exception as e:
        return {"ok": False, "started": False, "error": str(e)}

def stop_engine() -> dict:
    # 找当前 qianxund 进程并 kill
    try:
        out = subprocess.run(
            ["pgrep", "-f", "qianxund.py serve"],
            capture_output=True, text=True, timeout=5,
        )
        pids = [int(p) for p in out.stdout.split() if p.strip()]
        for pid in pids:
            subprocess.run(["kill", "-9", str(pid)], capture_output=True, timeout=5)
        return {"ok": True, "killed": pids}
    except Exception as e:
        return {"ok": False, "error": str(e)}

class Handler(BaseHTTPRequestHandler):
    server_version = "qianxund-ctl/1.0"

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Api-Token")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

    def _check_token(self) -> bool:
        return self.headers.get("X-Api-Token", "") == DEFAULT_TOKEN

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/status":
            self._send(200, {
                "engine_alive": engine_alive(),
                "uptime_s": engine_uptime(),
            })
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        path = urlparse(self.path).path
        if not self._check_token():
            self._send(401, {"error": "bad token"})
            return
        if path == "/api/start":
            self._send(200, start_engine())
        elif path == "/api/stop":
            self._send(200, stop_engine())
        else:
            self._send(404, {"error": "not found"})

def serve(port: int):
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    srv.daemon_threads = True
    print(f"qianxund-ctl listening on http://127.0.0.1:{port}", flush=True)
    srv.serve_forever()

if __name__ == "__main__":
    serve(DEFAULT_PORT)
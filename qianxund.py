#!/usr/bin/env python3
"""qianxund.py — 千寻融合守护进程（qianxun 引擎 + Web 看板 + REST/MCP）

把 backtestd 的人机界面（实时 Web 看板 + REST API + MCP 桥）直驱到
qianxun 引擎（httpx 客户端 + BatchScheduler + SQLite），消灭重复调度代码。

特性（来自 qianxun 引擎 + backtestd 界面）：
  · Multi-Simulation 批量提交（一次 POST 一个数组，BoundedSemaphore 并发名额）
  · pause / resume / cancel + 断点续跑 + 孤儿提交处理 + 去重
  · 每日配额解析（x-ratelimit 头）
  · Web live 看板 GET /ui + REST API /api/* + MCP 桥
  · AI 批次协议（batch_no = B+日期-序号）+ 方向雷达联动

用法：
    python3 qianxund.py serve [--port 8765] [--host 127.0.0.1] [--token X]
                             [--concurrent N] [--batch-size M] [--db 路径]
    python3 qianxund.py test        # 快速自检（不调 BRAIN）

凭据：优先环境变量 WQ_USERNAME/WQ_PASSWORD，否则读同目录 credential.txt。
      永不写日志。默认只监听本机；--host 0.0.0.0 跨机时须 --token。
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from loguru import logger

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from qianxun_engine.api.config import BrainConfig     # noqa: E402
from qianxun_engine.api.client import APIClient, BrainClientError  # noqa: E402
from qianxun_engine.storage.database import Storage, expression_key  # noqa: E402
from qianxun_engine.scheduler.runner import BatchScheduler  # noqa: E402

DEFAULT_DB = HERE / "data" / "alpha_machine.db"

# --------------------------------------------------------------- 凭据 ----
def load_credentials():
    """返回 (username, password)。优先级: 环境变量 > 同目录 credential.txt > credential.json。"""
    u = os.environ.get("WQ_USERNAME", "").strip()
    p = os.environ.get("WQ_PASSWORD", "").strip()
    if u and p:
        return u, p
    for path in (HERE / "credential.txt", HERE / "credential.json"):
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(data, list) and len(data) >= 2:
                    return data[0], data[1]
                if isinstance(data, dict):
                    return data.get("user") or data.get("username"), data.get("password")
            except Exception:
                continue
    return "", ""


def make_config() -> BrainConfig:
    u, p = load_credentials()
    return BrainConfig(username=u, password=p)


def make_client() -> APIClient:
    cfg = make_config()
    client = APIClient(cfg)
    client.authenticate()
    return client


# ------------------------------------------------------------- 全局态 ----
_ACTIVE = {}          # batch_no -> {"scheduler", "client", "started_at", "thread"}
_ACTIVE_LOCK = threading.Lock()
PENDING_CMDS = []     # [{command, payload, id}] 供 UI/AI 命令队列


def _backfill_alpha_details(client, st, tid, batch_no):
    """调度完成后回填 alpha 指标到 alphas 表（看板/analyze 展示用）。

    限流意识：平台详情约 30 条/分钟，串行拉取并轻度 sleep。"""
    sims = st.list_completed_simulations(tid)
    n = 0
    for i, s in enumerate(sims, 1):
        aid = s.get("alpha_id")
        if not aid:
            continue
        try:
            detail = client.get_alpha_details(aid)
            alpha = client.parse_alpha_metrics(detail)
            if alpha.get("alpha_id"):
                st.upsert_alpha(alpha, batch_no=batch_no)
                n += 1
        except Exception as e:
            print(f"[qxd:{batch_no}] backfill {aid} failed: {e}", flush=True)
        if i % 25 == 0:
            time.sleep(1)  # 平台限流缓冲
    print(f"[qxd:{batch_no}] backfill done: {n} alpha", flush=True)


class DaemonState:
    """daemon 运行期状态（进程内存），与 SQLite 持久化互补。"""
    def __init__(self, storage: Storage, concurrent=3, batch_size=10):
        self.storage = storage
        self.concurrent = concurrent
        self.batch_size = batch_size
        self.boot_ts = time.time()
        self.last_ratelimit: dict | None = None

    def run_batch(self, name, settings, expressions, producer="", cmd_id=None):
        """提交一个新批次（thread 里跑 scheduler）。返回 batch_no。"""
        settings = _normalize_settings(settings)
        client = make_client()
        st = self.storage
        # 去重：统一表达式为 dict 形式，再算指纹
        done = st.completed_expression_keys()
        norm = []
        for e in expressions:
            if isinstance(e, str):
                norm.append({"expression": e, "decay": settings.get("decay", 1)})
            else:
                norm.append(e)
        todo = [(e["expression"], e.get("decay", settings.get("decay", 1)), settings)
                for e in norm
                if expression_key(e["expression"], settings) not in done]
        if not todo:
            return None, "全部表达式已回测过，无需提交"
        batch_no = st.next_batch_no()
        tid = st.create_task_run(
            name=name or f"AI batch {batch_no}", kind="ai_batch",
            config={"producer": producer, **settings}, total=len(todo), batch_no=batch_no,
        )
        st.create_ai_batch(batch_no=batch_no, producer=producer,
                           region=str(settings.get("region", "")),
                           expression_count=len(todo),
                           note=f"qianxund 提交（跳过 {len(expressions)-len(todo)}）")
        sched = BatchScheduler(
            client, st, progress_cb=self._mk_cb(batch_no),
            max_concurrent_batches=self.concurrent, batch_size=self.batch_size,
        )

        def _worker():
            try:
                sched.run(tid, todo)
                sched.join()
                st.update_ai_batch_status(batch_no, "completed")
                _backfill_alpha_details(client, st, tid, batch_no)
            except Exception as e:
                st.update_ai_batch_status(batch_no, "failed")
                print(f"[qxd:{batch_no}] run failed: {e}", flush=True)
            finally:
                # 同步平台配额/限流重置到 daemon 状态(看板显示)
                q = getattr(sched, "sim_quota", None)
                if q:
                    self.last_ratelimit = q
                with _ACTIVE_LOCK:
                    _ACTIVE.pop(batch_no, None)

        t = threading.Thread(target=_worker, daemon=True)
        with _ACTIVE_LOCK:
            _ACTIVE[batch_no] = {"sched": sched, "client": client,
                                 "started_at": time.time(), "thread": t,
                                 "tid": tid, "name": name or batch_no,
                                 "producer": producer, "cmd_id": cmd_id}
        st.update_ai_batch_status(batch_no, "running")
        t.start()
        return batch_no, None

    def resume_batch(self, batch_no):
        """断点续跑：按批次号找回 task_run 补跑 pending simulation。"""
        st = self.storage
        import sqlite3
        with st._lock:
            row = st._conn.execute(
                "SELECT id FROM task_runs WHERE batch_no=?", (batch_no,)
            ).fetchone()
        if not row:
            return f"批次 {batch_no} 无对应任务"
        tid = row["id"]
        client = make_client()
        sched = BatchScheduler(client, st, progress_cb=self._mk_cb(batch_no),
                               max_concurrent_batches=self.concurrent,
                               batch_size=self.batch_size)
        st.update_ai_batch_status(batch_no, "running")

        def _worker():
            try:
                sched.continue_run(tid)
                sched.join()
                st.update_ai_batch_status(batch_no, "completed")
            except Exception as e:
                st.update_ai_batch_status(batch_no, "failed")
                print(f"[qxd:{batch_no}] resume failed: {e}", flush=True)
            finally:
                with _ACTIVE_LOCK:
                    _ACTIVE.pop(batch_no, None)

        t = threading.Thread(target=_worker, daemon=True)
        with _ACTIVE_LOCK:
            _ACTIVE[batch_no] = {"sched": sched, "client": client,
                                 "started_at": time.time(), "thread": t,
                                 "tid": tid, "name": batch_no, "producer": "续跑", "cmd_id": None}
        t.start()
        return None

    def cancel_batch(self, batch_no):
        st = self.storage
        with _ACTIVE_LOCK:
            a = _ACTIVE.get(batch_no)
        if a:
            a["sched"].cancel()
            st.update_ai_batch_status(batch_no, "cancelled")
            return True
        # 未运行：直接标取消
        st.update_ai_batch_status(batch_no, "cancelled")
        return False

    def pause_batch(self, batch_no):
        with _ACTIVE_LOCK:
            a = _ACTIVE.get(batch_no)
        if a:
            a["sched"].pause()
            return True
        return False

    def resume_control(self, batch_no):
        with _ACTIVE_LOCK:
            a = _ACTIVE.get(batch_no)
        if a:
            a["sched"].resume()
            return True
        return False

    def _mk_cb(self, batch_no):
        def cb(event: str, payload: dict) -> None:
            if event in ("sim_completed", "sim_failed"):
                print(f"[qxd:{batch_no}] {event}: {payload}", flush=True)
            if event == "batch_done":
                pass
        return cb    # ---- 看板展示数据 ----
    def jobs_view(self):
        batches = self.storage.list_ai_batches(limit=200)
        out = []
        for b in batches:
            bn = b["batch_no"]
            # 关联 task_run 拿进度
            with self.storage._lock:
                row = self.storage._conn.execute(
                    "SELECT id, status, total, success, failed FROM task_runs WHERE batch_no=? ORDER BY id DESC LIMIT 1",
                    (bn,),
                ).fetchone()
            tid = row["id"] if row else None
            state = "RUNNING" if bn in _ACTIVE else _map_status(b["status"])
            sims = self.storage.list_simulations_with_alpha(tid) if tid else []
            done = sum(1 for s in sims if s.get("sim_status") == "completed")
            total = (row["total"] if row else 0) or len(sims)
            out.append({
                "round": b["batch_no"],
                "id": bn,
                "name": f"{b['region']} {b['expression_count']}个",
                "state": state,
                "done": done,
                "total": total or b["expression_count"],
                "created_at": _to_ts(b["created_at"]),
                "producer": b.get("producer", ""),
                "status": b["status"],
            })
        out.sort(key=lambda x: x.get("created_at") or 0, reverse=True)
        return out

    def job_detail(self, batch_no):
        st = self.storage
        with st._lock:
            row = st._conn.execute(
                "SELECT id, status, total, success, failed, created_at FROM task_runs WHERE batch_no=? ORDER BY id DESC LIMIT 1",
                (batch_no,),
            ).fetchone()
        if not row:
            return None
        tid = row["id"]
        sims = st.list_simulations_with_alpha(tid)
        results = []
        for s in sims:
            results.append({
                "idx": s.get("sim_id"),
                "status": s.get("sim_status"),
                "alpha_id": s.get("alpha_id"),
                "expression": s.get("expression", ""),
                "metrics": {k: s.get(k) for k in
                            ("sharpe", "fitness", "returns", "turnover", "margin", "check_status")},
                "error": s.get("last_error"),
            })
        by_status = {}
        for r in results:
            by_status[r["status"]] = by_status.get(r["status"], 0) + 1
        b = st.get_ai_batch(batch_no) or {}
        state = "RUNNING" if batch_no in _ACTIVE else _map_status(b.get("status", row["status"]))
        return {
            "id": batch_no, "name": b.get("region", "") or batch_no, "round": batch_no,
            "state": state, "done": (row["success"] or 0) + (row["failed"] or 0),
            "total": row["total"] or len(sims), "created_at": _to_ts(row["created_at"]),
            "by_status": by_status, "results": results,
            "batch_status": b.get("status"),
        }


def _map_status(s):
    return {None: "QUEUED", "pending": "QUEUED", "running": "RUNNING",
            "paused": "RUNNING", "completed": "COMPLETE", "failed": "ERROR",
            "cancelled": "STOPPED"}.get(s, "QUEUED")


def _to_ts(iso):
    try:
        from datetime import datetime
        return datetime.fromisoformat(iso).timestamp()
    except Exception:
        return time.time()


DEFAULT_SETTINGS = {
    "instrumentType": "EQUITY", "region": "USA", "universe": "TOP3000", "delay": 1,
    "decay": 1, "neutralization": "SUBINDUSTRY", "truncation": 0.08,
    "pasteurization": "ON", "testPeriod": "P0Y", "unitHandling": "VERIFY",
    "nanHandling": "ON", "language": "FASTEXPR", "visualization": False,
}


def _normalize_settings(settings: dict) -> dict:
    merged = dict(DEFAULT_SETTINGS)
    merged.update({k: v for k, v in settings.items() if v is not None})
    return merged


# ------------------------------------------------------------- HTTP ----
UISTATE = None  # DaemonState 实例, serve() 时注入


class Handler(BaseHTTPRequestHandler):
    server_version = "qianxund/1.0"

    def log_message(self, fmt, *args):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _html(self, html: str):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(html.encode("utf-8"))))
        self.end_headers()
        self.wfile.write(html.encode("utf-8"))

    def _auth_ok(self):
        token = getattr(self.server, "api_token", None)
        if not token:
            return True
        return self.headers.get("X-Api-Token") == token

    def _body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except Exception:
            return None

    def _route(self, method):
        parsed = urlparse(self.path)
        path = parsed.path
        q = parse_qs(parsed.query)
        if path in ("/", "/index.html"):
            return self._redirect("/ui")
        if path == "/favicon.ico":
            self.send_response(204); self.end_headers(); return
        if path == "/health":
            return self._send(200, {"ok": True, "uptime_s": round(time.time() - UISTATE.boot_ts),
                                    "jobs": len(UISTATE.storage.list_ai_batches(limit=500)),
                                    "concurrent": UISTATE.concurrent, "batch_size": UISTATE.batch_size,
                                    "slots": UISTATE.concurrent, "per_slot": 1,
                                    "total_concurrency": UISTATE.concurrent * 1})
        if path == "/ui":
            html = (HERE / "backtestd_ui.html").read_text(encoding="utf-8") \
                if (HERE / "backtestd_ui.html").exists() else "<h1>ui missing</h1>"
            return self._html(html)
        if path == "/api/config":
            if method == "GET":
                return self._send(200, {"concurrent": UISTATE.concurrent, "batch_size": UISTATE.batch_size,
                                        "slots": UISTATE.concurrent, "per_slot": 1,
                                        "total_concurrency": UISTATE.concurrent,
                                        "max_job": 5000})
            if method == "POST":
                body = self._body()
                if body and "concurrent" in body:
                    UISTATE.concurrent = max(1, int(body["concurrent"]))
                if body and "batch_size" in body:
                    UISTATE.batch_size = max(1, min(10, int(body["batch_size"])))
                return self._send(200, {"concurrent": UISTATE.concurrent, "batch_size": UISTATE.batch_size,
                                        "slots": UISTATE.concurrent, "per_slot": 1,
                                        "total_concurrency": UISTATE.concurrent})
        if path == "/api/quota":
            rl = UISTATE.last_ratelimit
            return self._send(200, {"date": time.strftime("%Y-%m-%d"),
                                    "submitted_today": 0,
                                    "quota": rl})
        # /api/active-alphas —— 拉 BRAIN 当前 ACTIVE 状态的 alpha_ids（5 min 缓存）
        # 用于把本地 SELF_CORRELATION 对比基线与 BRAIN 严格对齐：
        # BRAIN SELF_CORRELATION 比的是 ACTIVE 组合，本地缓存里的非 ACTIVE alpha 应排除。
        if path == "/api/active-alphas" and method == "GET":
            now = time.time()
            cached = _ACTIVE_CACHE.get("ids")
            if cached is not None and now - cached[0] < _ACTIVE_CACHE_TTL:
                return self._send(200, {**cached[1], "cache_hit": True})
            try:
                client = make_client()
                ids = client.get_active_alphas()
                payload = {
                    "count": len(ids),
                    "ids": ids,
                    "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                }
                _ACTIVE_CACHE["ids"] = (now, payload)
                return self._send(200, {**payload, "cache_hit": False})
            except Exception as cause:
                logger.warning("active_alphas fetch failed: {}", cause)
                return self._send(502, {"error": f"BRAIN active_alphas failed: {cause}"})
        if path == "/api/jobs":
            if method == "GET":
                return self._send(200, {"jobs": UISTATE.jobs_view()})
            if method == "POST":
                body = self._body()
                if body is None or "settings" not in body or "expressions" not in body:
                    return self._send(400, {"error": "need {settings, expressions}"})
                exprs = body["expressions"]
                if not isinstance(exprs, list) or not exprs:
                    return self._send(400, {"error": "expressions must be non-empty list"})
                name = body.get("name") or None
                producer = body.get("producer") or "qianxund"
                cap = body.get("cap")
                if isinstance(cap, int) and cap >= 0:
                    exprs = exprs[:cap]
                try:
                    batch_no, err = UISTATE.run_batch(name, body["settings"], exprs, producer=producer)
                except Exception as e:
                    return self._send(500, {"error": f"run failed: {e}"})
                if batch_no is None:
                    return self._send(200, {"id": None, "skipped": True, "message": err})
                return self._send(201, {"id": batch_no, "round": batch_no,
                                        "total": len(exprs), "name": name or batch_no})
        # /api/jobs/<batch>/resume —— 断点续跑(在普通 job 路由之前匹配,避免被吞)
        m = re.match(r"^/api/jobs/(B?[0-9]{8}-[0-9]+)/resume$", path)
        if m:
            if method == "POST":
                err = UISTATE.resume_batch(m.group(1))
                return self._send(200, {"ok": err is None, "error": err})
            return self._send(405, {"error": "method not allowed"})
        # /api/alphas/<alpha_id>/check —— BRAIN check 代理（来自 consultant.get_check_submission）
        # 浏览器端不可直连 BRAIN（auth/CORS/Retry-After），所以走这里统一处理。
        m = re.match(r"^/api/alphas/(.+)/check$", path)
        if m:
            if method != "GET":
                return self._send(405, {"error": "method not allowed"})
            alpha_id = m.group(1)
            now = time.time()
            cached = _CHECK_CACHE.get(alpha_id)
            if cached is not None and now - cached[0] < _CHECK_CACHE_TTL:
                return self._send(200, cached[1])
            try:
                client = make_client()
                result = client.get_alpha_check(alpha_id)
                _CHECK_CACHE[alpha_id] = (now, result)
                return self._send(200, result)
            except Exception as cause:
                logger.warning("alpha_check[/{}] failed: {}", alpha_id, cause)
                return self._send(502, {"error": f"BRAIN check failed: {cause}"})
        # /api/alphas/<id>/correlations/prod —— BRAIN prod corr 代理（来自 wq-alpha-research.fetch_prod_corr）
        # 用于侧边栏在 SELF_CORRELATION 还是 PENDING 时就能快速看到 prod corr 死区线
        m = re.match(r"^/api/alphas/(.+)/correlations/prod$", path)
        if m:
            if method != "GET":
                return self._send(405, {"error": "method not allowed"})
            alpha_id = m.group(1)
            now = time.time()
            cached = _CORR_PROD_CACHE.get(alpha_id)
            if cached is not None and now - cached[0] < _CORR_PROD_CACHE_TTL:
                return self._send(200, cached[1])
            try:
                client = make_client()
                result = client.get_alpha_correlations_prod(alpha_id)
                _CORR_PROD_CACHE[alpha_id] = (now, result)
                return self._send(200, result)
            except Exception as cause:
                logger.warning("alpha_corr_prod[/{}] failed: {}", alpha_id, cause)
                return self._send(502, {"error": f"BRAIN corr_prod failed: {cause}"})
        # /api/alphas/<id>/pnl —— BRAIN PnL 代理（用于本地核对 SELF_CORRELATION）
        # 浏览器自己用 JS 算 Pearson（参考 xiegengcai 的 self_correlation.py 设计）
        m = re.match(r"^/api/alphas/(.+)/pnl$", path)
        if m:
            if method != "GET":
                return self._send(405, {"error": "method not allowed"})
            alpha_id = m.group(1)
            try:
                client = make_client()
                # APIClient.get_alpha_pnl 返回 list[{"date","pnl"}]，统一封装为
                # {"records": [...]} 让前端能用同一套 schema 处理（与
                # wq-alpha-research.fetch_prod_corr 一致）。
                result = client.get_alpha_pnl(alpha_id)
                return self._send(200, {"records": result})
            except Exception as cause:
                logger.warning("alpha_pnl[/{}] failed: {}", alpha_id, cause)
                return self._send(502, {"error": f"BRAIN pnl failed: {cause}"})
        # /api/pnl-cache —— 列出本地已缓存的 alpha 数量 + 元信息
        if path == "/api/pnl-cache" and method == "GET":
            try:
                PNL_CACHE_DIR.mkdir(parents=True, exist_ok=True)
                items: list[dict] = []
                total_bytes = 0
                for fp in sorted(PNL_CACHE_DIR.glob("*.json")):
                    aid = fp.stem
                    size = fp.stat().st_size
                    total_bytes += size
                    # 读 region / downloaded_at
                    region = None
                    downloaded_at = None
                    try:
                        meta = json.loads(fp.read_text(encoding="utf-8"))
                        region = meta.get("region")
                        downloaded_at = meta.get("downloaded_at")
                    except Exception:
                        pass
                    items.append({
                        "alpha_id": aid,
                        "size_bytes": size,
                        "region": region,
                        "downloaded_at": downloaded_at,
                    })
                return self._send(200, {
                    "count": len(items),
                    "total_bytes": total_bytes,
                    "cache_dir": str(PNL_CACHE_DIR),
                    "items": items,
                })
            except Exception as cause:
                logger.warning("pnl_cache list failed: {}", cause)
                return self._send(500, {"error": f"list cache failed: {cause}"})
        # /api/pnl-cache/<id> —— 读本地 PnL，缺失则拉 BRAIN 并落盘
        # 缓存策略：BRAIN 能返回 PnL 的 alpha 都缓存（说明存在 + 有权限）。
        # ACTIVE 过滤已在前端完成（/api/active-alphas 提供），无需重复判断。
        # 早期用 qianxund 本地 DB 的 submitted_at 判定会漏掉 BRAIN 浏览器提交的 alpha。
        m = re.match(r"^/api/pnl-cache/(.+)$", path)
        if m:
            if method != "GET":
                return self._send(405, {"error": "method not allowed"})
            alpha_id = m.group(1)
            cached = _read_pnl_cache(alpha_id)
            if cached is not None:
                return self._send(200, {
                    **cached,
                    "cache_hit": True,
                    "eligible": True,
                })
            try:
                client = make_client()
                records = client.get_alpha_pnl(alpha_id)
                region = None
                try:
                    details = client.get_alpha_details(alpha_id)
                    region = (details.get("settings") or {}).get("region")
                except Exception:
                    pass
                payload = {
                    "alpha_id": alpha_id,
                    "region": region,
                    "downloaded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "source": "brain:/recordsets/daily-pnl",
                    "records": records,
                }
                # 有 records 就缓存（证明 alpha 存在 + PnL 可拉）
                if len(records) > 0:
                    _write_pnl_cache(alpha_id, payload)
                    return self._send(200, {**payload, "cache_hit": False, "eligible": True})
                # BRAIN 返回空 records（罕见）—— 不缓存，仅返回
                return self._send(200, {**payload, "cache_hit": False, "eligible": False,
                                          "reason": "empty records"})
            except Exception as cause:
                logger.warning("pnl_cache[/{}] fetch failed: {}", alpha_id, cause)
                return self._send(502, {"error": f"BRAIN pnl failed: {cause}"})
        # /api/pnl-cache-backfill —— 启动批量回填 ACTIVE alpha 的 PnL（异步任务）
        # body: {"region": "GBR"} 过滤；不传或空 = 全部 region
        if path == "/api/pnl-cache-backfill" and method == "POST":
            body = self._body() or {}
            region = body.get("region") or None
            # 复用 ACTIVE 缓存，避免每起一个 job 都打 BRAIN
            active = _ACTIVE_CACHE.get("ids")
            if active is None or time.time() - active[0] > _ACTIVE_CACHE_TTL:
                try:
                    client = make_client()
                    ids = client.get_active_alphas()
                    _ACTIVE_CACHE["ids"] = (time.time(), {"count": len(ids), "ids": ids, "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
                except Exception as cause:
                    return self._send(502, {"error": f"active_alphas failed: {cause}"})
            else:
                ids = active[1]["ids"]
            # region 过滤
            if region is not None:
                # 没 region 元信息（cache.items 才带 region）→ 这里只按 alpha_id 字符串过滤不了
                # 简单处理：返回错误，让前端按 cache.list 的 region 过滤
                # 实际更常见的用法是不带 region，所以这里返 hint 即可
                # 不过 ACTIVE 列表本身也不带 region，所以放弃 region 过滤
                return self._send(400, {"error": "region filter not yet supported; use empty body for all"})
            # 跳过已缓存的
            existing = set()
            for fp in PNL_CACHE_DIR.glob("*.json"):
                existing.add(fp.stem)
            targets = [aid for aid in ids if aid not in existing]
            if not targets:
                return self._send(200, {"status": "noop", "message": "all ACTIVE alphas already cached", "count": 0})
            job_id = _new_backfill_job_id()
            _PNL_BACKFILL_JOBS[job_id] = {
                "status": "running",
                "total": len(targets),
                "done": 0,
                "errors": [],
                "region": region,
            }
            t = threading.Thread(
                target=_run_backfill,
                args=(job_id, targets, region),
                daemon=True,
                name=f"pnl-backfill-{job_id}",
            )
            _PNL_BACKFILL_JOBS[job_id]["thread"] = t
            t.start()
            logger.info("backfill[{}] started: {}/{} targets", job_id, len(targets), len(ids))
            return self._send(202, {
                "job_id": job_id,
                "total": len(targets),
                "skipped_cached": len(ids) - len(targets),
                "poll_url": f"/api/pnl-cache-backfill/{job_id}",
            })
        # /api/pnl-cache-backfill/<job_id> —— 轮询进度
        m = re.match(r"^/api/pnl-cache-backfill/(.+)$", path)
        if m and method == "GET":
            job_id = m.group(1)
            job = _PNL_BACKFILL_JOBS.get(job_id)
            if job is None:
                return self._send(404, {"error": "job not found", "job_id": job_id})
            # 脱敏：返回进度但拿掉 thread 对象
            safe = {k: v for k, v in job.items() if k != "thread"}
            return self._send(200, safe)

        # /api/pnl-cache-clear —— 一键清空本地缓存（带安全确认：X-Clear-Token 头）
        if path == "/api/pnl-cache-clear" and method == "POST":
            token = self.headers.get("X-Clear-Token", "")
            if token != "yes-i-know":
                return self._send(400, {"error": "X-Clear-Token header required"})
            count = 0
            try:
                PNL_CACHE_DIR.mkdir(parents=True, exist_ok=True)
                for fp in PNL_CACHE_DIR.glob("*.json"):
                    fp.unlink()
                    count += 1
                for fp in PNL_CACHE_DIR.glob("*.json.tmp"):
                    fp.unlink()
                return self._send(200, {"cleared": count})
            except Exception as cause:
                return self._send(500, {"error": str(cause)})
        # /api/jobs/<batch>[/result|/log]
        m = re.match(r"^/api/jobs/(B?[0-9]{8}-[0-9]+)(/result|/log)?$", path)
        if m:
            batch_no, sub = m.group(1), m.group(2) or ""
            d = UISTATE.job_detail(batch_no)
            if d is None:
                return self._send(404, {"error": "no such batch"})
            if method == "POST":
                body = self._body()
                action = (body or {}).get("action")
                if action == "cancel":
                    UISTATE.cancel_batch(batch_no)
                    return self._send(200, {"ok": True, "state": d["state"]})
                if action == "pause":
                    UISTATE.pause_batch(batch_no)
                    return self._send(200, {"ok": True})
                if action == "resume":
                    UISTATE.resume_control(batch_no)
                    return self._send(200, {"ok": True})
                return self._send(400, {"error": "unknown action"})
            if method == "GET":
                if sub == "/result":
                    return self._send(200, d)
                return self._send(200, {"job": d, "log_tail": _brief_log(d)})
        m = re.match(r"^/api/(pause|resume|cancel)/(B?[0-9]{8}-[0-9]+)$", path)
        if m:
            action, batch_no = m.group(1), m.group(2)
            {"pause": UISTATE.pause_batch, "resume": UISTATE.resume_control,
             "cancel": UISTATE.cancel_batch}[action](batch_no)
            return self._send(200, {"ok": True})
        return self._send(404, {"error": "not found"})

    def _redirect(self, location):
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self): self._route("GET")
    def do_POST(self): self._route("POST")


def _brief_log(d):
    lines = []
    for r in d.get("results", [])[:50]:
        st = r.get("status")
        mark = "✓" if st == "completed" else ("✗" if st in ("failed", "cancelled") else "…")
        lines.append({"line": f"{mark} [{st}] {r.get('expression','')[:70]} alpha={r.get('alpha_id','')}"})
    return [{"n": i, "line": l["line"]} for i, l in enumerate(lines)]


def serve(port, host, token, concurrent, batch_size, db):
    global UISTATE
    st = Storage(db)
    UISTATE = DaemonState(st, concurrent=concurrent, batch_size=batch_size)
    # 迁移旧 backtestd 库：如果给出的是 backtest_data/backtestd.db 之类一律不管，
    # 只用 qianxun schema 的 db。
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    server.api_token = token if token and token != "off" else None
    server.boot_ts = time.time()
    print(f"qianxund listening on http://{host}:{port}  (ui=/ui, concurrent={concurrent}, "
          f"batch_size={batch_size}, db={db}, token={'on' if server.api_token else 'off'})",
          flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("shutting down", flush=True)


# /api/alphas/<id>/check 简单 TTL 缓存：避免侧边栏反复轮询同一 alpha 把 BRAIN 打爆。
# BRAIN 的 check 结果对同一 alpha 是相对稳定的（参数没改就不变），缓存 60s 足够。
_CHECK_CACHE: dict[str, tuple[float, dict]] = {}
_CHECK_CACHE_TTL = 60.0

# /api/alphas/<id>/correlations/prod 同款缓存：论坛/技能都提示首次常空响应，
# 前端按需点击才会触发，60s 足够（prod corr 在 alpha 参数不变时是稳定的）。
_CORR_PROD_CACHE: dict[str, tuple[float, dict]] = {}
_CORR_PROD_CACHE_TTL = 60.0

# /api/active-alphas 缓存：ACTIVE 状态变化缓慢，5 min 足够。
_ACTIVE_CACHE: dict[str, tuple[float, dict]] = {}
_ACTIVE_CACHE_TTL = 300.0

# PnL 缓存批量回填任务状态（短生命周期，进程重启即清空）：
#   - job_id: 任务唯一 ID
#   - status: "running" | "done" | "error"
#   - total/done/errors: 进度
#   - region: 过滤 region（None=全 region）
#   - thread: 后台 Thread 实例（防止 GC 提前回收）
_PNL_BACKFILL_JOBS: dict[str, dict] = {}
_PNL_BACKFILL_LOCK = threading.Lock()
_PNL_BACKFILL_COUNTER: dict[str, int] = {"n": 0}


def _new_backfill_job_id() -> str:
    """生成短 ID：bf-<UTC-date>-<3位序号>。同日多次回填序号递增。"""
    with _PNL_BACKFILL_LOCK:
        _PNL_BACKFILL_COUNTER["n"] += 1
        seq = _PNL_BACKFILL_COUNTER["n"]
    return f"bf-{time.strftime('%Y%m%d')}-{seq:03d}"


def _run_backfill(job_id: str, target_ids: list[str], region: str | None) -> None:
    """后台线程：并发拉 PnL 并写本地缓存。进度写回 _PNL_BACKFILL_JOBS[job_id]。"""
    job = _PNL_BACKFILL_JOBS[job_id]
    job["started_at"] = time.time()

    def fetch_one(aid: str) -> None:
        try:
            # 已缓存就跳过（秒级）—— 多次重试可累积
            if _read_pnl_cache(aid) is not None:
                job["done"] += 1
                return
            client = make_client()
            records = client.get_alpha_pnl(aid)
            if records:
                payload = {
                    "alpha_id": aid,
                    "region": region,
                    "downloaded_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    "source": "brain:/recordsets/daily-pnl",
                    "records": records,
                }
                _write_pnl_cache(aid, payload)
            job["done"] += 1
        except Exception as cause:
            err_str = str(cause)
            job["errors"].append(f"{aid}: {err_str[:80]}")
            job["done"] += 1
            # 429 退避：5s 经验值（BRAIN rate limit ~30 req/min/账号）
            if "429" in err_str or "rate limit" in err_str.lower():
                time.sleep(5.0)
            # 400 captcha：BRAIN 反爬触发，需人工解。停止任务，让用户处理。
            elif "400" in err_str and "captcha" in err_str.lower():
                job["status"] = "captcha_blocked"
                job["stopped_reason"] = f"BRAIN captcha at {aid}; please solve in browser and retry"
                logger.warning("backfill[{}] stopped: captcha at {}", job_id, aid)
                raise SystemExit(0)
            else:
                time.sleep(0.2)
            return
        # 常态间隔：1.0s/req 走 60 req/min 上限，比 30 req/min 安全些
        time.sleep(1.0)

    # 1 worker 串行 + 429 退避 + captcha 暂停：
    # 多次实测：1 worker + 5s 429 退避 = 36/61 = 59% 成功。
    # captcha 检测可让用户及时处理而不浪费后续请求。
    try:
        with ThreadPoolExecutor(max_workers=1) as pool:
            list(pool.map(fetch_one, target_ids))
    except SystemExit:
        pass  # captcha 暂停，正常退出

    job["finished_at"] = time.time()
    # 如果没错误，标 done；否则标 partial（前端能区分"完全成功" vs "部分失败"）
    if job["errors"]:
        job["status"] = "partial"
    else:
        job["status"] = "done"
    logger.info(
        "backfill[{}] done: {}/{}, errors={}",
        job_id, job["done"], job["total"], len(job["errors"]),
    )

# PnL 持久化缓存（永久落盘）：
# BRAIN 的 PnL 是单调追加日频数据，老数据不会变。本地缓存后所有 self-corr
# 计算离线完成——彻底免去 rate limit 和网络抖动。
# 路径：~/.dsh/qianxun/pnl/<alpha_id>.json（每个 alpha 一个文件，约 80-120KB）
# 设计参考 xiegengcai.self_correlation.py 的 save_obj/load_obj 思路。
DSH_HOME = Path(os.environ.get("DSH_HOME", str(Path.home() / ".dsh")))
PNL_CACHE_DIR: Path = DSH_HOME / "qianxun" / "pnl"
# alpha_id -> 文件路径（懒计算）
_PNL_FILE: dict[str, Path] = {}


def _pnl_path(alpha_id: str) -> Path:
    """PnL 缓存文件路径（按 alpha_id 命名，不区分 region——区域信息存文件内）。"""
    if alpha_id not in _PNL_FILE:
        # 防御：alpha_id 不能含路径分隔符，防止 ../ 逃逸
        safe = re.sub(r"[^A-Za-z0-9_\-]", "_", alpha_id)
        _PNL_FILE[alpha_id] = PNL_CACHE_DIR / f"{safe}.json"
    return _PNL_FILE[alpha_id]


def _read_pnl_cache(alpha_id: str) -> dict | None:
    """读本地 PnL 缓存，损坏或缺失返回 None。"""
    p = _pnl_path(alpha_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as cause:
        logger.warning("pnl_cache read failed for {}: {}", alpha_id, cause)
        return None


def _is_submitted_locally(alpha_id: str) -> bool:
    """查 qianxund 本地 `simulations` 表，看 alpha 是否已被提交到 BRAIN。
    `submitted_at IS NOT NULL` 即视为已提交。
    注意：这是 qianxund 视角的"已提交"，不包含直接走 BRAIN 浏览器提交、绕过 qianxund 的 alpha。
    """
    try:
        st = UISTATE.storage if UISTATE is not None else None
        if st is None:
            return False
        row = st._conn.execute(
            "SELECT 1 FROM simulations WHERE alpha_id = ? AND submitted_at IS NOT NULL AND submitted_at != '' LIMIT 1",
            (alpha_id,),
        ).fetchone()
        return row is not None
    except Exception as cause:
        logger.warning("_is_submitted_locally({}) failed: {}", alpha_id, cause)
        return False


def _write_pnl_cache(alpha_id: str, payload: dict) -> Path:
    """原子写 PnL 缓存：先写 .tmp 再 rename，防止崩溃产生半截文件。"""
    PNL_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    target = _pnl_path(alpha_id)
    tmp = target.with_suffix(".json.tmp")
    try:
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, target)
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
    return target


def self_test():
    import tempfile
    print("self-test: storage + jobs_view (no BRAIN calls)")
    tmp = Path(tempfile.mkdtemp()) / "test.db"
    st = Storage(tmp)
    UISTATE = DaemonState(st, concurrent=2, batch_size=5)
    # 建一个假批次直接写库
    bn = st.next_batch_no()
    tid = st.create_task_run(name="selftest", kind="ai_batch",
                             config={"producer": "t"}, total=2, batch_no=bn)
    st.create_ai_batch(batch_no=bn, producer="t", region="GBR", expression_count=2)
    st.bulk_create_simulations(tid, [("rank(close)", 1, {"region": "GBR"}),
                                     ("rank(volume)", 1, {"region": "GBR"})])
    # 模拟完成一条
    sims = st.list_simulations_with_alpha(tid)
    assert len(sims) == 2, "expect 2 sims"
    rows = UISTATE.jobs_view()
    assert len(rows) >= 1
    print("self-test OK")
    return 0


def main():
    args = sys.argv[1:]
    cmd = args[0] if args else "serve"
    if cmd in ("self-test", "test"):
        sys.exit(self_test())
    if cmd != "serve":
        print(__doc__)
        sys.exit(2)
    port = int(os.environ.get("QIANXUND_PORT", "8765"))
    host = "127.0.0.1"
    token = None
    concurrent = int(os.environ.get("QIANXUND_CONCURRENT", "3"))
    batch_size = int(os.environ.get("QIANXUND_BATCH_SIZE", "10"))
    db = os.environ.get("QIANXUND_DB", str(DEFAULT_DB))
    i = 1
    while i < len(args):
        if args[i] == "--port" and i + 1 < len(args): port = int(args[i+1]); i += 2
        elif args[i] == "--host" and i + 1 < len(args): host = args[i+1]; i += 2
        elif args[i] == "--token" and i + 1 < len(args): token = args[i+1]; i += 2
        elif args[i] == "--concurrent" and i + 1 < len(args): concurrent = max(1, int(args[i+1])); i += 2
        elif args[i] == "--batch-size" and i + 1 < len(args): batch_size = max(1, min(10, int(args[i+1]))); i += 2
        elif args[i] == "--db" and i + 1 < len(args): db = args[i+1]; i += 2
        else: i += 1
    serve(port, host, token, concurrent, batch_size, db)


if __name__ == "__main__":
    main()

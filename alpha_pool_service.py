#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""alpha_pool_service.py — Alpha 自选池 + 提交闸（纯 stdlib 的隔离扩展）。

被 qianxund.py 以 try/except 隔离方式 import；本模块任何异常都不影响千寻主看板
（与 osmosis_service / arc_service 同样的隔离扩展模式）。

它解决两个问题：浏览器不能直连 BRAIN（认证 + CORS + Retry-After 都由引擎处理），
所以「按 alpha_id 查基本面 / 相关性 / 提交状态」和「真的提交」都必须由持有凭据的
引擎代劳。

## 接口契约（全部挂在 /api/alpha-pool* 下）

  GET  /api/alpha-pool                 读池子（纯本地，不打 BRAIN）
  POST /api/alpha-pool                 改池子（纯本地）：{action, alpha_id?|ids?, note?}
                                       action: add | remove | clear | set | note
  POST /api/alpha-pool/sync            刷数据（打 BRAIN）：{ids?, deadline_s?}
  GET  /api/alpha-pool/active-stats    账号当日新增 active（打 BRAIN，吃 5min 缓存）
  POST /api/alpha-pool/submit          ⚠️ 真提交（打 BRAIN）：{ids, confirm}
  POST /api/alpha-pool/submit/poll     只续查、不再 POST：{ids, confirm}
  GET  /api/alpha-pool/submit/<job_id> 查提交任务进度

## 每个 item 的形状（前端按这个渲染表格）

  {
    "alpha_id": "YPbZLxMA",
    "status": "active" | "unsubmit" | "<brain 小写原值>" | "unknown",
    "brain_status": "ACTIVE" | "UNSUBMITTED" | null,
    "metrics": {"sharpe":…, "fitness":…, "returns":…, "turnover":…, "margin":…},
    "self_corr": 0.6906, "self_corr_result": "PASS",
    "prod_corr": 0.7755, "prod_corr_result": "FAIL",
    "region": "GLB", "expression": "…", "date_created": "…",
    "note": "用户自己写的备注",
    "submit": {"state": "submitted", "at": "…", "fails": ["LOW_SHARPE"], "error": null},
    "added_at": "…", "updated_at": "…",
    "source": "brain" | "db" | "cache",
    "errors": ["…"],
  }

status 语义（用户要的二值）：
  active   = 在 BRAIN 的 ACTIVE 组合里（/users/self/alphas?status=ACTIVE）
  unsubmit = 不在 ACTIVE 里（BRAIN status=UNSUBMITTED / 其他非 ACTIVE 状态）
  unknown  = 两个来源都没拿到（BRAIN 挂了 / 账号里查不到这个 id）

## 当日 active 口径

用户口径：每天本地 12:00 重置。实现 = 「上一次 12:00 那一刻的 ACTIVE 集合」当基准线，
当日新增 = 当前 ACTIVE 集合 − 基准线；跨过 12:00 后第一次观察时重置基准线。
局限：基准线只能在有人调接口时滚动，长时间不开页面期间的进出无法回溯——重开后会把
当时看到的集合当新基准，**宁可漏算也不会多算**。

## 提交红线（重要，别绕过）

本仓库所有 skill 都写着「永不自动调用提交端点，提交必须由用户对精确 alpha_id 明确
授权」。本模块是给**人**用的那个按钮，因此：

  · 每次提交都必须带 confirm="yes-i-know" 字面量，缺了直接 400；
  · 单次最多 5 个 id，且串行提交（这个接口 429 极凶，并发就是自找限流）；
  · 提交任务只存在内存 + 把结论写回池子条目，**引擎重启会丢在跑的任务**；
  · agent / 调度器 / 任何自动化都**不得**调用本端点——这是人类专属闸门。

## 提交协议（按官方论坛实测的两段式 long-poll 实现）

  第一段 POST /alphas/{id}/submit
    201 → 进队列成功，转第二段
    400 → 已经在提交队列里（重复 POST），直接转第二段
    403 → 没通过 check，提交被拒（响应体里带 is.checks 明细）
  第二段 GET /alphas/{id}/submit 轮询
    200 + Retry-After → 平台还在算，睡 Retry-After 再来
    200 无 Retry-After → 提交成功
    403 → 判失败（需要改进）
    404 → 超时

  这个接口很慢（论坛实测单条几十分钟到几小时），所以第二段带自己的时间预算，
  超预算就标 pending，让用户点「续查」接着轮询（不重复 POST）。

落盘：<engine>/data/alpha_pool.json，写入是原子的（临时文件 + os.replace）。
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import re
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse

from loguru import logger

# ---------------------------------------------------------------- 状态 ----

_client_factory: Callable[[], Any] | None = None
_active_ids_getter: Callable[[bool], list[str] | None] | None = None
POOL_PATH: Path = Path(__file__).resolve().parent / "data" / "alpha_pool.json"
DB_PATH: Path = Path(__file__).resolve().parent / "data" / "alpha_machine.db"

_STORE_VERSION = 2
_METRIC_KEYS = ("sharpe", "fitness", "returns", "turnover", "margin")
_ID_RE = re.compile(r"^[A-Za-z0-9]{4,16}$")
# 一次 sync 请求默认最多占用多久（秒）；到点就返回已完成的部分，前端显示「部分」，
# 再点一次即可继续（已刷好的条目会被跳过）。避免前端 fetch 长时间悬着。
_DEFAULT_DEADLINE_S = 90.0
# BRAIN 对 check/detail 没有模拟那么紧的并发限制，但 2 路已经够快且足够礼貌。
_SYNC_WORKERS = 2
# 两次 BRAIN 调用之间的小间隔，压一压 429 概率。
_THROTTLE_S = 0.3

# ---- 提交闸（人类专属）----
# 必须逐字带上这个 token 才会真的提交，防止任何自动化误触。
_SUBMIT_CONFIRM = "yes-i-know"
# 单次最多提交几个。提交不可逆且占额度，不允许「一键 50 条」。
_SUBMIT_MAX_IDS = 5
# 单条 alpha 在第二段轮询里的时间预算（秒）。到点标 pending，用户可「续查」。
_SUBMIT_POLL_BUDGET_S = 20 * 60.0
# 本地 12:00 作为「当日」的分界（用户口径：每天中午 12 点重置）。
_RESET_HOUR = 12
# 备注长度上限（防止有人往 JSON 里塞小说）
_NOTE_MAX = 500

_lock = threading.RLock()
_state: dict[str, Any] = {
    "version": _STORE_VERSION,
    "ids": [],
    "added_at": {},
    "items": {},
    "updated_at": None,
    "synced_at": None,
    "active": {},   # 当日 active 基准线，见 _r_active_stats
}


def configure(*, client_factory: Callable[[], Any] | None = None,
              pool_path: Path | str | None = None,
              db_path: Path | str | None = None,
              active_ids_getter: Callable[[bool], list[str] | None] | None = None) -> None:
    """注入依赖。在处理请求前调用一次。

    client_factory:     无参，返回千寻的 APIClient（未登录也行，首次调用会自己登录）
    pool_path:          池子落盘文件，默认 <engine>/data/alpha_pool.json
    db_path:            引擎 sqlite 路径（作为 BRAIN 不可用时的本地兜底数据源）
    active_ids_getter:  force -> list[str] | None；复用宿主的 ACTIVE 5 分钟缓存。
                        返回 None 表示这次没拿到（不要把 None 当成「空集合」，
                        否则 BRAIN 一抖动就把全池标成 unsubmit）。
    """
    global _client_factory, _active_ids_getter, POOL_PATH, DB_PATH
    if client_factory is not None:
        _client_factory = client_factory
    if active_ids_getter is not None:
        _active_ids_getter = active_ids_getter
    if pool_path is not None:
        POOL_PATH = Path(pool_path)
    if db_path is not None:
        DB_PATH = Path(db_path)
    POOL_PATH.parent.mkdir(parents=True, exist_ok=True)
    _load()


# ---------------------------------------------------------------- 工具 ----

def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _iso(ts: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


def normalize_alpha_id(raw: Any) -> str | None:
    """BRAIN alpha_id 是 8 位大小写混合字母数字（如 mLmOw2op），不要 upper/lower。"""
    if not isinstance(raw, str):
        return None
    s = raw.strip()
    return s if _ID_RE.match(s) else None


def parse_alpha_ids(raw: Any) -> list[str]:
    """把前端传的 ids 字段归一化成去重保序的 alpha_id 列表。

    接受 list[str]，也接受单个字符串（按逗号/空白/分号切），方便「一次粘一坨」。
    """
    out: list[str] = []
    seen: set[str] = set()
    chunks: list[Any] = []
    if isinstance(raw, str):
        chunks = re.split(r"[\s,;]+", raw)
    elif isinstance(raw, list):
        chunks = raw
    for chunk in chunks:
        aid = normalize_alpha_id(chunk)
        if aid is not None and aid not in seen:
            seen.add(aid)
            out.append(aid)
    return out


def _noon_boundary(now_ts: float | None = None) -> float:
    """返回「最近一次已经过去的本地 12:00」的时间戳。

    用户口径：当日 active 每天中午 12 点重置。所以 12:00 之前的「当日」指的是昨天
    那一次 12:00——这样 11:59 看到的计数和 12:00 之后立刻看到的计数不会同属一天。
    """
    now = _dt.datetime.fromtimestamp(now_ts if now_ts is not None else time.time())
    today_noon = now.replace(hour=_RESET_HOUR, minute=0, second=0, microsecond=0)
    if now >= today_noon:
        return today_noon.timestamp()
    return (today_noon - _dt.timedelta(days=1)).timestamp()


def _next_noon(now_ts: float | None = None) -> float:
    """下一次 12:00（给前端做 tooltip：还有多久重置）。"""
    return _noon_boundary(now_ts) + 24 * 3600.0


def _load() -> None:
    with _lock:
        # 先归零再读：文件不存在（首次启动）或读坏了，都要回到干净的空池，
        # 绝不能留下上一次的进程内状态（否则会「读不到文件却还显示老名单」）。
        _state["version"] = _STORE_VERSION
        _state["ids"] = []
        _state["added_at"] = {}
        _state["items"] = {}
        _state["updated_at"] = None
        _state["synced_at"] = None
        _state["active"] = {}
        if not POOL_PATH.exists():
            return
        try:
            data = json.loads(POOL_PATH.read_text(encoding="utf-8"))
        except Exception as cause:  # noqa: BLE001 - 坏文件不该让扩展整块失效
            logger.warning("alpha_pool 读取失败，按空池继续：{}", cause)
            return
        if not isinstance(data, dict):
            return
        _state["ids"] = [a for a in parse_alpha_ids(data.get("ids"))]
        _state["added_at"] = {k: v for k, v in (data.get("added_at") or {}).items()
                              if isinstance(v, str)}
        _state["items"] = {k: v for k, v in (data.get("items") or {}).items()
                           if isinstance(v, dict)}
        _state["updated_at"] = data.get("updated_at")
        _state["synced_at"] = data.get("synced_at")
        active = data.get("active")
        _state["active"] = active if isinstance(active, dict) else {}


def _save_locked() -> None:
    """原子落盘。调用方必须已持有 _lock。"""
    payload = json.dumps(_state, ensure_ascii=False, indent=1)
    tmp = POOL_PATH.with_suffix(POOL_PATH.suffix + ".tmp")
    tmp.write_text(payload, encoding="utf-8")
    os.replace(tmp, POOL_PATH)


def _blank_item(alpha_id: str) -> dict:
    return {"alpha_id": alpha_id, "status": "unknown", "metrics": {}, "note": ""}


def _snapshot() -> dict:
    with _lock:
        ids = list(_state["ids"])
        items_map = _state["items"]
        items = [dict(items_map.get(a) or _blank_item(a)) for a in ids]
        return {
            "ok": True,
            "count": len(ids),
            "ids": ids,
            "items": items,
            "updated_at": _state["updated_at"],
            "synced_at": _state["synced_at"],
            "pool_path": str(POOL_PATH),
        }


# ---------------------------------------------------------------- 改池子 ----

def _r_mutate(body: dict) -> tuple[int, dict]:
    action = (body.get("action") or "").strip()
    if action not in ("add", "remove", "clear", "set", "note"):
        return 400, {"ok": False,
                     "error": f"未知 action：{action!r}（add/remove/clear/set/note）"}
    if action == "note":
        return _r_set_note(body)
    with _lock:
        if action == "clear":
            _state["ids"] = []
            _state["added_at"] = {}
            _state["items"] = {}
        else:
            incoming = parse_alpha_ids(body.get("ids") if body.get("ids") is not None
                                       else body.get("alpha_id"))
            if action in ("add", "set") and not incoming:
                return 400, {"ok": False, "error": "没有解析出合法 alpha_id（4-16 位字母数字）"}
            if action == "set":
                kept = set(incoming)
                _state["ids"] = list(incoming)
                # 保留仍在池里的条目缓存，丢掉已移出的
                _state["items"] = {k: v for k, v in _state["items"].items() if k in kept}
                _state["added_at"] = {k: v for k, v in _state["added_at"].items()
                                      if k in kept}
            elif action == "add":
                existing = set(_state["ids"])
                for aid in incoming:
                    if aid not in existing:
                        _state["ids"].append(aid)
                        existing.add(aid)
            else:  # remove
                drop = set(incoming)
                _state["ids"] = [a for a in _state["ids"] if a not in drop]
                for aid in drop:
                    _state["items"].pop(aid, None)
                    _state["added_at"].pop(aid, None)
        now = _now_iso()
        _state["updated_at"] = now
        for aid in _state["ids"]:
            _state["added_at"].setdefault(aid, now)
            item = _state["items"].setdefault(aid, _blank_item(aid))
            item.setdefault("metrics", {})
            item.setdefault("note", "")
            item.setdefault("added_at", _state["added_at"][aid])
        try:
            _save_locked()
        except Exception as cause:  # noqa: BLE001
            logger.warning("alpha_pool 落盘失败：{}", cause)
            return 500, {"ok": False, "error": f"落盘失败：{cause}"}
    return 200, _snapshot()


def _r_set_note(body: dict) -> tuple[int, dict]:
    """设置某条 alpha 的备注（用户自己写的，纯本地，不打 BRAIN）。"""
    alpha_id = normalize_alpha_id(body.get("alpha_id") or body.get("ids"))
    if alpha_id is None:
        return 400, {"ok": False, "error": "缺 alpha_id 或格式不对"}
    note = body.get("note")
    note = "" if note is None else str(note)
    if len(note) > _NOTE_MAX:
        return 400, {"ok": False, "error": f"备注最长 {_NOTE_MAX} 字"}
    with _lock:
        if alpha_id not in _state["ids"]:
            return 404, {"ok": False, "error": f"{alpha_id} 不在池子里"}
        item = _state["items"].setdefault(alpha_id, _blank_item(alpha_id))
        item["note"] = note
        _state["updated_at"] = _now_iso()
        try:
            _save_locked()
        except Exception as cause:  # noqa: BLE001
            return 500, {"ok": False, "error": f"落盘失败：{cause}"}
    return 200, _snapshot()


# ---------------------------------------------------------------- 当日 active ----

def _r_active_stats(force: bool = False) -> tuple[int, dict]:
    """账号当日新增 ACTIVE 数（每天本地 12:00 为界）。"""
    ids: list[str] | None = None
    if _active_ids_getter is not None:
        try:
            ids = _active_ids_getter(force)
        except Exception as cause:  # noqa: BLE001
            logger.warning("alpha_pool 取 ACTIVE 列表失败：{}", cause)
            ids = None

    now = time.time()
    boundary = _noon_boundary(now)
    with _lock:
        active = dict(_state["active"] or {})
        stale = ids is None
        if ids is not None:
            baseline_ids = active.get("baseline_ids")
            baseline_at = active.get("baseline_reset_at_ts")
            # 基准线缺失，或已经跨过了一个新的 12:00 → 用当前集合重打基准线
            if (not isinstance(baseline_ids, list)
                    or not isinstance(baseline_at, (int, float))
                    or float(baseline_at) < boundary):
                baseline_ids = list(ids)
            active = {
                "baseline_ids": baseline_ids,
                "baseline_reset_at_ts": boundary,
                "baseline_reset_at": _iso(boundary),
                "observed_ids": list(ids),
                "observed_at": _now_iso(),
                "total": len(ids),
            }
            _state["active"] = active
            try:
                _save_locked()
            except Exception as cause:  # noqa: BLE001
                logger.warning("alpha_pool active 基准线落盘失败：{}", cause)
        # 拿不到当前集合时用上次观察值 + stale 标记（不假装是 0）
        observed = active.get("observed_ids") or []
        baseline = active.get("baseline_ids") or []
        baseline_set = set(baseline)
        fresh = [a for a in observed if a not in baseline_set]
        return 200, {
            "ok": not stale,
            "stale": stale,
            "active_count": active.get("total") if active else None,
            "daily_new": len(fresh),
            "daily_new_ids": fresh,
            "baseline_reset_at": active.get("baseline_reset_at"),
            "baseline_count": len(baseline),
            "observed_at": active.get("observed_at"),
            "reset_hour": _RESET_HOUR,
            "next_reset_at": _iso(_next_noon(now)),
        }


# ---------------------------------------------------------------- 打 BRAIN ----

def _db_fallback(alpha_id: str) -> dict | None:
    """从引擎自己的 alphas 表取一份兜底数据（不打 BRAIN，零成本）。

    BRAIN 限流/抖动时表格不至于空着；同时补 prod_corr（引擎库的 check_pc）。
    """
    if not DB_PATH.exists():
        return None
    try:
        con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=3.0)
        try:
            con.row_factory = sqlite3.Row
            row = con.execute(
                "select sharpe, fitness, returns, turnover, margin, region, expression,"
                " date_created, check_pc from alphas where alpha_id = ? limit 1",
                (alpha_id,),
            ).fetchone()
        finally:
            con.close()
    except Exception as cause:  # noqa: BLE001
        logger.debug("alpha_pool db fallback 失败 {}：{}", alpha_id, cause)
        return None
    if row is None:
        return None
    out: dict[str, Any] = {
        "metrics": {k: row[k] for k in _METRIC_KEYS},
        "region": row["region"],
        "expression": row["expression"],
        "date_created": row["date_created"],
    }
    if row["check_pc"] is not None:
        out["prod_corr"] = row["check_pc"]
    return out


def _check_entries(client: Any, alpha_id: str) -> dict:
    """拉 BRAIN /alphas/<id>/check，抽出 SELF_CORRELATION / PROD_CORRELATION。"""
    payload = client.get_alpha_check(alpha_id)
    checks = ((payload or {}).get("is") or {}).get("checks") or []
    out: dict[str, Any] = {}
    for chk in checks:
        if not isinstance(chk, dict):
            continue
        name = str(chk.get("name") or "").upper()
        if name == "SELF_CORRELATION":
            out["self_corr"] = chk.get("value")
            out["self_corr_result"] = chk.get("result")
        elif name == "PROD_CORRELATION":
            out["prod_corr"] = chk.get("value")
            out["prod_corr_result"] = chk.get("result")
    return out


def _refresh_one(alpha_id: str, active_ids: set[str] | None, active_ok: bool,
                 previous: dict | None) -> dict:
    """刷单个 alpha。任何单点失败都写进 item['errors']，不抛给调用方。"""
    item: dict[str, Any] = dict(previous or {})
    item["alpha_id"] = alpha_id
    errors: list[str] = []
    source: set[str] = set()

    client = None
    try:
        client = _client()
    except Exception as cause:  # noqa: BLE001
        errors.append(f"client: {cause}")

    brain_status: str | None = None
    if client is not None:
        try:
            detail = client.get_alpha_details(alpha_id) or {}
            is_ = detail.get("is") or {}
            item["metrics"] = {k: is_.get(k) for k in _METRIC_KEYS}
            brain_status = detail.get("status")
            item["brain_status"] = brain_status
            item["region"] = (detail.get("settings") or {}).get("region")
            item["expression"] = (detail.get("regular") or {}).get("code")
            item["date_created"] = detail.get("dateCreated")
            source.add("brain")
        except Exception as cause:  # noqa: BLE001
            errors.append(f"details: {cause}")
        time.sleep(_THROTTLE_S)
        try:
            corr = _check_entries(client, alpha_id)
            if corr:
                item.update(corr)
                source.add("brain-check")
            else:
                errors.append("check: 响应里没有 SELF_CORRELATION / PROD_CORRELATION（可能仍 PENDING）")
        except Exception as cause:  # noqa: BLE001
            errors.append(f"check: {cause}")

    # 本地兜底：BRAIN 没给出来的字段用引擎库补，避免整行空着
    if client is None or item.get("metrics") in (None, {}) or \
            all(v is None for v in (item.get("metrics") or {}).values()):
        fallback = _db_fallback(alpha_id)
        if fallback is not None:
            if not item.get("metrics") or all(v is None for v in item["metrics"].values()):
                item["metrics"] = fallback["metrics"]
            for key in ("region", "expression", "date_created"):
                if not item.get(key):
                    item[key] = fallback.get(key)
            if item.get("prod_corr") is None and fallback.get("prod_corr") is not None:
                item["prod_corr"] = fallback["prod_corr"]
            source.add("db")
    elif item.get("prod_corr") is None:
        fallback = _db_fallback(alpha_id)
        if fallback is not None and fallback.get("prod_corr") is not None:
            item["prod_corr"] = fallback["prod_corr"]
            source.add("db")

    # ---- status 归一（用户要的二值）----
    live = (brain_status or "").upper()
    if active_ok and active_ids is not None and alpha_id in active_ids:
        item["status"] = "active"
    elif live == "ACTIVE":
        item["status"] = "active"
    elif live == "UNSUBMITTED":
        item["status"] = "unsubmit"
    elif live:
        # 平台还有别的态，原样小写透出
        item["status"] = live.lower()
    elif active_ok and active_ids is not None:
        item["status"] = "unsubmit"
    else:
        item["status"] = item.get("status") or "unknown"

    item["metrics"] = {k: item.get("metrics", {}).get(k) for k in _METRIC_KEYS}
    item["note"] = item.get("note") or ""
    item["source"] = "+".join(sorted(source)) or item.get("source") or "cache"
    item["updated_at"] = _now_iso()
    item["errors"] = errors
    return item


def _r_sync(body: dict) -> tuple[int, dict]:
    with _lock:
        pool_ids = list(_state["ids"])
    requested = parse_alpha_ids(body.get("ids")) if body.get("ids") is not None else []
    targets = requested or pool_ids
    if not targets:
        return 200, {**_snapshot(), "refreshed": 0, "partial": False,
                     "message": "池子为空，先添加 alpha_id"}

    deadline_s = body.get("deadline_s")
    try:
        deadline_s = float(deadline_s) if deadline_s is not None else _DEFAULT_DEADLINE_S
    except (TypeError, ValueError):
        deadline_s = _DEFAULT_DEADLINE_S
    deadline = time.time() + max(5.0, min(deadline_s, 600.0))

    # ACTIVE 集合：复用宿主的 5 分钟缓存（打 BRAIN 但可命中缓存）。
    # 关键：拿不到时 active_ids 为 None 且 active_ok=False —— 绝不能把「没拿到」
    # 当成「空集合」，否则 BRAIN 一抖动就把整池标成 unsubmit（假红灯）。
    active_ids: set[str] | None = None
    active_ok = False
    if _active_ids_getter is not None:
        try:
            got = _active_ids_getter(False)
            if got is not None:
                active_ids = set(got)
                active_ok = True
        except Exception as cause:  # noqa: BLE001
            logger.warning("alpha_pool 取 ACTIVE 列表失败：{}", cause)

    refreshed = 0
    timed_out = False
    done_ids: set[str] = set()
    extra_items: dict[str, dict] = {}
    pool_id_set = set(pool_ids)
    # 刻意不用 `with ThreadPoolExecutor(...)`：它的隐式 shutdown(wait=True) 会
    # 阻塞到所有任务跑完，把 deadline 彻底架空。超时后 cancel_futures 只取消
    # 还没开跑的，已在飞的那一两个让它自己跑完（结果照样落盘，下次不用重刷）。
    pool = ThreadPoolExecutor(max_workers=_SYNC_WORKERS)
    futures = {}
    try:
        for aid in targets:
            with _lock:
                previous = dict(_state["items"].get(aid) or {})
            futures[pool.submit(_refresh_one, aid, active_ids, active_ok, previous)] = aid
        for fut in as_completed(futures):
            aid = futures[fut]
            try:
                item = fut.result()
            except Exception as cause:  # noqa: BLE001 - 兜底，_refresh_one 内部已吞异常
                logger.warning("alpha_pool 刷新 {} 异常：{}", aid, cause)
                continue
            done_ids.add(aid)
            refreshed += 1
            with _lock:
                # 只把结果写回池子里的 id；显式指定的池外 id 只回给本次响应。
                if aid in pool_id_set:
                    item["note"] = item.get("note") or ""
                    _state["items"][aid] = item
                    _state["synced_at"] = item["updated_at"]
                    try:
                        _save_locked()
                    except Exception as save_err:  # noqa: BLE001
                        logger.warning("alpha_pool 增量落盘失败：{}", save_err)
                else:
                    extra_items[aid] = item
            if time.time() > deadline:
                timed_out = True
                break
    finally:
        pool.shutdown(wait=False, cancel_futures=True)

    payload = _snapshot()
    if extra_items:
        payload["items"] = list(payload["items"]) + list(extra_items.values())
    payload.update({
        "refreshed": refreshed,
        "partial": timed_out or refreshed < len(targets),
        "remaining": [a for a in targets if a not in done_ids],
        "active_ok": active_ok,
        "active_count": len(active_ids) if active_ids is not None else None,
    })
    return 200, payload


# ---------------------------------------------------------------- 提交闸 ----

_SUBMIT_JOBS: dict[str, dict] = {}
_SUBMIT_LOCK = threading.Lock()
_SUBMIT_COUNTER = {"n": 0}


def _new_submit_job_id() -> str:
    with _SUBMIT_LOCK:
        _SUBMIT_COUNTER["n"] += 1
        seq = _SUBMIT_COUNTER["n"]
    return f"sub-{time.strftime('%Y%m%d')}-{seq:03d}"


def _raw_request(client: Any, method: str, url: str) -> Any:
    """发一个不经 `_request_with_retry` 封装的请求。

    提交协议里 400 / 403 是**正常状态**（重复提交 / 没通过 check），而
    `_request_with_retry` 对非 429/5xx 的 4xx 会 `raise_for_status()`，
    拿不到状态码就没法写状态机。所以这里直连底层 httpx client，
    429 退避由调用方自己处理（提交接口的限流语义和模拟不一样）。
    """
    http = client._ensure_authed()
    return http.request(method, url)


def _resp_checks(resp: Any) -> list[dict]:
    """从响应体里抠出 is.checks（提交被拒时平台会把 FAIL 明细放在这里）。"""
    try:
        data = resp.json()
    except Exception:  # noqa: BLE001
        return []
    checks = ((data or {}).get("is") or {}).get("checks") or []
    return [c for c in checks if isinstance(c, dict)]


def _resp_body(resp: Any, limit: int = 300) -> str:
    try:
        return (resp.text or "")[:limit]
    except Exception:  # noqa: BLE001
        return ""


def _fails_of(resp: Any) -> list[str]:
    return [str(c.get("name")) for c in _resp_checks(resp)
            if str(c.get("result") or "").upper() == "FAIL"]


def _submit_one(client: Any, alpha_id: str, budget_s: float, *, do_post: bool) -> dict:
    """按官方论坛实测的两段式协议提交一个 alpha。返回状态字典，不抛异常。"""
    url = f"/alphas/{alpha_id}/submit"

    if do_post:
        # ---- 第一段：POST 入队 ----
        posted = False
        last_note = ""
        for _ in range(3):
            try:
                resp = _raw_request(client, "POST", url)
            except Exception as cause:  # noqa: BLE001
                last_note = f"POST 网络异常：{cause}"
                time.sleep(3)
                continue
            code = resp.status_code
            if code == 201:
                posted = True
                break
            if code == 400:
                # 已经在提交队列里（重复 POST）——不算错，继续走轮询判最终结果。
                posted = True
                last_note = "平台返回 400：该 alpha 已在提交队列中，转为轮询"
                break
            if code == 403:
                return {"state": "blocked", "http": 403, "fails": _fails_of(resp),
                        "checks": _resp_checks(resp),
                        "error": "平台拒绝提交：有 check 未通过",
                        "body": _resp_body(resp)}
            if code == 429:
                retry = resp.headers.get("Retry-After")
                try:
                    wait = float(retry) if retry else 30.0
                except (TypeError, ValueError):
                    wait = 30.0
                last_note = f"POST 被限流（429），等 {wait:.0f}s 再试"
                time.sleep(max(1.0, min(wait, 60.0)))
                continue
            last_note = f"POST 意外状态 {code}：{_resp_body(resp, 120)}"
            time.sleep(3)
        if not posted:
            return {"state": "failed",
                    "error": f"POST 三次都没拿到 201/400。{last_note}"}

    # ---- 第二段：GET 轮询（预算从 POST 结束才开始算，避免被 POST 的退避吃掉）----
    deadline = time.time() + max(5.0, budget_s)
    polls = 0
    while time.time() < deadline:
        try:
            resp = _raw_request(client, "GET", url)
        except Exception as cause:  # noqa: BLE001
            polls += 1
            if time.time() >= deadline:
                return {"state": "pending", "polls": polls,
                        "error": f"轮询中网络异常且超出预算：{cause}"}
            time.sleep(5)
            continue
        code = resp.status_code
        if code == 200:
            retry = resp.headers.get("Retry-After")
            if retry:
                # 平台还在算（这条能拖几十分钟到几小时）→ 按平台给的节奏睡
                try:
                    wait = float(retry)
                except (TypeError, ValueError):
                    wait = 30.0
                polls += 1
                time.sleep(max(1.0, min(wait, max(1.0, deadline - time.time()))))
                continue
            return {"state": "submitted", "http": 200, "polls": polls}
        if code == 403:
            return {"state": "failed", "http": 403, "fails": _fails_of(resp),
                    "checks": _resp_checks(resp),
                    "error": "提交判定失败（需要改进）",
                    "body": _resp_body(resp)}
        if code == 404:
            return {"state": "timeout", "http": 404,
                    "error": "提交轮询 404（超时/会话丢失）"}
        if code == 429:
            retry = resp.headers.get("Retry-After")
            try:
                wait = float(retry) if retry else 30.0
            except (TypeError, ValueError):
                wait = 30.0
            polls += 1
            time.sleep(max(1.0, min(wait, 60.0)))
            continue
        polls += 1
        time.sleep(5)
    return {"state": "pending", "polls": polls,
            "error": "本次轮询超出时间预算，尚未判出结果；点「续查」可接着轮询（不会重复 POST）"}


def _record_submit_result(alpha_id: str, result: dict) -> None:
    """把提交结论写回池子条目（持久化）。"""
    with _lock:
        if alpha_id not in _state["ids"]:
            return
        item = _state["items"].setdefault(alpha_id, _blank_item(alpha_id))
        item["submit"] = {
            "state": result.get("state"),
            "at": _now_iso(),
            "fails": result.get("fails") or [],
            "error": result.get("error"),
        }
        if result.get("state") == "submitted":
            # 提交成功后 BRAIN 会把它算进 ACTIVE；本地先乐观置 active，
            # 下次 sync 会被 BRAIN 的权威状态覆盖。
            item["submitted_at"] = _now_iso()
            item["status"] = "active"
        _state["updated_at"] = _now_iso()
        try:
            _save_locked()
        except Exception as cause:  # noqa: BLE001
            logger.warning("alpha_pool 提交结论落盘失败：{}", cause)


def _run_submit_job(job_id: str, ids: list[str], *, do_post: bool) -> None:
    """后台线程：串行跑完 ids。串行是故意的——提交接口 429 极凶，并发就是自找限流。"""
    job = _SUBMIT_JOBS.get(job_id)
    if job is None:
        return
    budget = float(job.get("budget_s") or _SUBMIT_POLL_BUDGET_S)
    hard_deadline = float(job.get("hard_deadline") or 0)
    try:
        client = _client()
    except Exception as cause:  # noqa: BLE001
        with _SUBMIT_LOCK:
            for aid in ids:
                job["items"][aid] = {"state": "failed", "error": f"client: {cause}",
                                     "updated_at": _now_iso()}
            job["running"] = False
            job["finished_at"] = _now_iso()
        return
    for aid in ids:
        if hard_deadline > 0 and time.time() > hard_deadline:
            with _SUBMIT_LOCK:
                for rest in ids:
                    job["items"].setdefault(rest, {
                        "state": "pending",
                        "error": "整个任务超出总时间预算，这条还没开始；可点「续查」继续",
                        "updated_at": _now_iso(),
                    })
            break
        try:
            result = _submit_one(client, aid, budget, do_post=do_post)
        except Exception as cause:  # noqa: BLE001 - 单个 id 失败不能拖死整个任务
            result = {"state": "failed", "error": f"{type(cause).__name__}: {cause}"}
        result["updated_at"] = _now_iso()
        with _SUBMIT_LOCK:
            job["items"][aid] = result
        _record_submit_result(aid, result)
        logger.info("alpha_submit[{}] {} -> {}", job_id, aid, result.get("state"))
    with _SUBMIT_LOCK:
        job["running"] = False
        job["finished_at"] = _now_iso()


def _start_submit_job(ids: list[str], *, do_post: bool, budget_s: float,
                      hard_budget_s: float) -> dict:
    job_id = _new_submit_job_id()
    job = {
        "job_id": job_id,
        "mode": "submit" if do_post else "poll",
        "ids": ids,
        "items": {},
        "running": True,
        "started_at": _now_iso(),
        "finished_at": None,
        "budget_s": budget_s,
        "hard_deadline": time.time() + hard_budget_s,
    }
    _SUBMIT_JOBS[job_id] = job
    thread = threading.Thread(target=_run_submit_job, args=(job_id, ids),
                              kwargs={"do_post": do_post},
                              daemon=True, name=f"alpha-submit-{job_id}")
    job["thread"] = thread
    thread.start()
    return job


def _r_submit(body: dict, *, poll_only: bool = False) -> tuple[int, dict]:
    if (str(body.get("confirm") or "").strip()) != _SUBMIT_CONFIRM:
        return 400, {"ok": False,
                     "error": f"拒绝提交：必须带 confirm={_SUBMIT_CONFIRM!r}。"
                              "这是防自动化误触的闸门，agent / 脚本不得代为提交。"}
    ids = parse_alpha_ids(body.get("ids") if body.get("ids") is not None
                          else body.get("alpha_id"))
    if not ids:
        return 400, {"ok": False, "error": "没有解析出合法 alpha_id"}
    if len(ids) > _SUBMIT_MAX_IDS:
        return 400, {"ok": False,
                     "error": f"一次最多提交 {_SUBMIT_MAX_IDS} 个（提交不可逆，防手滑）；"
                              f"这次给了 {len(ids)} 个"}
    # 提交后要能在表格里追踪 → 自动把 id 补进自选池（纯本地动作，不额外打 BRAIN）
    with _lock:
        now = _now_iso()
        existing = set(_state["ids"])
        added: list[str] = []
        for aid in ids:
            if aid not in existing:
                _state["ids"].append(aid)
                existing.add(aid)
                added.append(aid)
            _state["added_at"].setdefault(aid, now)
            item = _state["items"].setdefault(aid, _blank_item(aid))
            item["submit"] = {"state": "queued", "at": now, "fails": [], "error": None}
        if added:
            _state["updated_at"] = now
        try:
            _save_locked()
        except Exception as cause:  # noqa: BLE001
            logger.warning("alpha_pool 提交前入池落盘失败：{}", cause)
    job = _start_submit_job(ids, do_post=not poll_only, budget_s=_SUBMIT_POLL_BUDGET_S,
                            hard_budget_s=_SUBMIT_POLL_BUDGET_S * len(ids) + 60.0)
    logger.warning("alpha_submit[{}] {} 开始（{}）：{}", job["job_id"],
                   "续查" if poll_only else "提交", len(ids), ids)
    return 202, {
        "ok": True,
        "job_id": job["job_id"],
        "mode": job["mode"],
        "ids": ids,
        "auto_added": added,
        "poll_url": f"/api/alpha-pool/submit/{job['job_id']}",
    }


def _r_submit_status(job_id: str) -> tuple[int, dict]:
    with _SUBMIT_LOCK:
        job = _SUBMIT_JOBS.get(job_id)
        if job is None:
            return 404, {"ok": False, "error": f"没有这个提交任务：{job_id}"}
        # 脱敏：不把 thread 对象序列化出去
        safe = {k: v for k, v in job.items() if k != "thread"}
    return 200, {"ok": True, **safe}


# ---------------------------------------------------------------- 路由 ----

def route(method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
    """处理一个 /api/alpha-pool* 请求，返回 (http_status, payload)。

    body 由宿主 Handler 用 self._body() 解析后传入（POST 才有），本模块不碰 socket。
    """
    parsed = urlparse(path)
    p = parsed.path.rstrip("/") or parsed.path
    q = parse_qs(parsed.query)
    body = body if isinstance(body, dict) else {}
    try:
        if p == "/api/alpha-pool" and method == "GET":
            return 200, _snapshot()
        if p == "/api/alpha-pool" and method == "POST":
            return _r_mutate(body)
        if p == "/api/alpha-pool/active-stats" and method == "GET":
            force = (q.get("force") or ["0"])[0] in ("1", "true", "yes")
            return _r_active_stats(force=force)
        if p == "/api/alpha-pool/sync" and method == "POST":
            return _r_sync(body)
        if p == "/api/alpha-pool/submit" and method == "POST":
            return _r_submit(body)
        if p == "/api/alpha-pool/submit/poll" and method == "POST":
            return _r_submit(body, poll_only=True)
        m = re.match(r"^/api/alpha-pool/submit/([A-Za-z0-9\-]+)$", p)
        if m and method == "GET":
            return _r_submit_status(m.group(1))
        return 404, {"ok": False, "error": f"未知 alpha-pool 接口：{method} {p}"}
    except Exception as cause:  # noqa: BLE001 - 任何内部异常都以 500 结构化返回
        logger.exception("alpha_pool route error: {} {}", method, path)
        return 500, {"ok": False, "error": f"alpha-pool 内部错误：{type(cause).__name__}: {cause}"}


def _client() -> Any:
    if _client_factory is None:
        raise RuntimeError("alpha_pool_service 未配置：请先调用 configure(client_factory=...)")
    return _client_factory()

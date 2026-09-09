#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""osmosis_service.py — Osmosis 分配 Web 化的服务层（纯 stdlib，零第三方依赖）。

被 qianxund.py 以 try/except 隔离方式 import；任何本模块异常都不影响
千寻主看板。核心职责：
  · 用 /usr/bin/python3（带 pandas）子进程运行 osmosis_runner.py，
    与守护进程的 Python 3.14 运行时完全隔离；
  · 任务注册表 + 实时日志缓冲 + 取消 + JSON 结果解析 + 断电续读；
  · 安全边界：ACTION / WRITE_TO_PLATFORM / CONFIRM_BEFORE_WRITE 一律由
    service/runner 控制，外部 payload 传入的这些键会被剥除；写平台
    (allocate/clear) 必须带 confirm=True（对应 Web 端二次确认）。

qianxund.py 侧只需把这些路由薄薄接上：
  GET  /osmosis                          → osmosis_ui.html（由 qianxund 提供）
  GET  /api/osmosis/env                  → probe_env()
  GET  /api/osmosis/jobs                 → list_jobs()
  POST /api/osmosis/jobs                 → start_job(body)
  GET  /api/osmosis/jobs/<id>            → get_job(id)（含全量日志）
  GET  /api/osmosis/jobs/<id>/log?after= → job_log(id, after)
  POST /api/osmosis/jobs/<id>/cancel     → cancel_job(id)
  GET  /api/osmosis/report/<filename>    → report_file(filename)
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import threading
import time
import uuid
from collections import deque
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
RUNS_DIR = HERE / "osmosis_runs"
RUNS_DIR.mkdir(parents=True, exist_ok=True)
STATE_FILE = RUNS_DIR / "jobs.json"
LOG_KEEP = 4000

# runner 必须跑在有 pandas 的解释器里；按顺序探测。
RUNNER_PY_CANDIDATES = ["/usr/bin/python3", "/usr/bin/python3.9"]
RUNNER_SCRIPT = HERE / "osmosis_runner.py"
RESULT_MARKER = "@@RESULT@@"

# 外部不允许触碰的 allocator 配置键（runner 按模式自行决定）。
FORBIDDEN_SETTING_KEYS = {
    "action", "write_to_platform", "confirm_before_write",
    "retry_bad_request_patch",
}

WRITE_MODES = {"allocate", "clear"}
MODES = ("preview", "allocate", "clear", "verify")

_JOBS: dict[str, dict] = {}
_JOBS_LOCK = threading.Lock()
_RUN_SEMA = threading.Semaphore(1)          # 同一时间只跑一个分配任务（BRAIN 限流友好）
_ENV_CACHE: dict | None = None
_ENV_LOCK = threading.Lock()

# 由 qianxund 注入：cred_getter() -> (username, password)（读 credential.txt）。
# 凭据只经环境变量传给 runner 子进程，不落日志、不进任何持久化文件。
_CRED_GETTER = None


def configure(cred_getter=None) -> None:
    """qianxund 启动时注入凭据读取函数（可选）。"""
    global _CRED_GETTER
    if cred_getter is not None:
        _CRED_GETTER = cred_getter


def _runner_env() -> dict:
    env = dict(os.environ)
    env.pop("BRAIN_EMAIL", None)
    env.pop("BRAIN_USERNAME", None)
    env.pop("BRAIN_PASSWORD", None)
    if _CRED_GETTER is not None:
        try:
            cred = _CRED_GETTER()
            if cred and len(cred) == 2 and cred[0] and cred[1]:
                env["BRAIN_EMAIL"] = str(cred[0])
                env["BRAIN_PASSWORD"] = str(cred[1])
        except Exception:
            pass
    return env


# --------------------------------------------------------------- helpers ----
def _now() -> float:
    return time.time()


def _runner_python() -> str | None:
    for cand in RUNNER_PY_CANDIDATES:
        if Path(cand).exists():
            return cand
    return None


def _sanitize_settings(settings: dict | None) -> dict:
    clean: dict = {}
    for key, value in (settings or {}).items():
        if str(key).lower() in FORBIDDEN_SETTING_KEYS:
            continue
        clean[str(key)] = value
    return clean


def _public(job: dict, with_log: bool = False) -> dict:
    out = {k: v for k, v in job.items()
           if k not in ("_proc", "_stop", "log") and not k.startswith("_")}
    if with_log:
        out["log"] = list(job.get("log", []))
    else:
        out["log_lines"] = len(job.get("log", []))
    return out


def _save_state() -> None:
    try:
        with _JOBS_LOCK:
            data = [_public(j) for j in _JOBS.values()]
        STATE_FILE.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    except Exception:
        pass


def _load_state() -> None:
    if not STATE_FILE.exists():
        return
    try:
        for job in json.loads(STATE_FILE.read_text(encoding="utf-8")):
            jid = str(job.get("id") or "")
            if not jid:
                continue
            if job.get("state") in ("queued", "running"):
                job["state"] = "error"
                job["error"] = "daemon 重启时任务中断"
            job["log"] = []            # 日志是内存态，重启后清空（状态与 result 保留）
            _JOBS[jid] = job
    except Exception:
        pass


def _append_log(job: dict, line: str) -> None:
    buf = job["log"]
    buf.append({"n": len(buf) + 1, "line": line.rstrip("\n")})
    if len(buf) > LOG_KEEP:
        del buf[: len(buf) - LOG_KEEP]


# ------------------------------------------------------------ subprocess ----
def _pump_stderr(job: dict, proc: subprocess.Popen) -> None:
    try:
        for raw in iter(proc.stderr.readline, ""):
            if job.get("_stop"):
                break
            if raw:
                _append_log(job, raw)
    except Exception:
        pass


def _finalize(job: dict, code: int) -> None:
    job["exit_code"] = code
    job["finished_at"] = _now()
    if job.get("_stop"):
        job["state"] = "cancelled"
    elif code == 0 and job.get("result_ok"):
        job["state"] = "done"
    else:
        job["state"] = "error"
        if not job.get("error"):
            tail = " ".join(l["line"] for l in job["log"][-6:])[:300]
            job["error"] = f"runner 退出码 {code}" + (f": {tail}" if tail else "")
    _save_state()


def _execute(job: dict, payload: dict) -> None:
    py = _runner_python()
    if not py:
        job["state"] = "error"
        job["error"] = "未找到带 pandas 的解释器（探测过: " + ", ".join(RUNNER_PY_CANDIDATES) + "）"
        _save_state()
        return
    payload_file = RUNS_DIR / f"{job['id']}.payload.json"
    try:
        payload_file.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:
        job["state"] = "error"
        job["error"] = f"payload 写入失败: {exc}"
        _save_state()
        return

    cmd = [py, str(RUNNER_SCRIPT), "run", "--payload", str(payload_file)]
    _append_log(job, "$ " + " ".join(cmd))
    try:
        proc = subprocess.Popen(
            cmd, cwd=str(HERE), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            env=_runner_env(),
        )
    except Exception as exc:
        job["state"] = "error"
        job["error"] = f"runner 启动失败: {exc}"
        _save_state()
        return

    job["_proc"] = proc
    job["state"] = "running"
    job["started_at"] = _now()
    job["pid"] = proc.pid
    _save_state()

    t_err = threading.Thread(target=_pump_stderr, args=(job, proc), daemon=True,
                             name=f"osmosis-err-{job['id']}")
    t_err.start()

    result = None
    try:
        for raw in iter(proc.stdout.readline, ""):
            if not raw:
                continue
            line = raw.strip()
            if line.startswith(RESULT_MARKER):
                try:
                    result = json.loads(line[len(RESULT_MARKER):].strip())
                except Exception:
                    result = None
            else:
                _append_log(job, raw)
    except Exception as exc:
        _append_log(job, f"[service] stdout 读取异常: {exc}")

    try:
        t_err.join(timeout=5)
    except Exception:
        pass
    code = proc.wait()

    if result is not None:
        job["result"] = result
        job["result_ok"] = bool(result.get("ok"))
        if not result.get("ok"):
            job["error"] = str(result.get("error") or "runner 报告失败")[:400]
        eff = result.get("effective") or {}
        if eff.get("region"):
            job["scope"] = f"{eff['region']}/D{eff.get('delay', '?')}"
    else:
        job["result_ok"] = False
        job["error"] = "runner 未输出结果行（异常崩溃？）"
    _finalize(job, code)


# -------------------------------------------------------------- public ----
def probe_env(force: bool = False) -> dict:
    """探测 runner 运行时（pandas / allocator / 凭据存在性）。结果缓存。"""
    global _ENV_CACHE
    with _ENV_LOCK:
        if _ENV_CACHE is not None and not force:
            return _ENV_CACHE
        py = _runner_python()
        info: dict = {"python": py, "runner_script": RUNNER_SCRIPT.exists()}
        if not py or not RUNNER_SCRIPT.exists():
            info.update({"ok": False, "error": "runner 或解释器缺失"})
            _ENV_CACHE = info
            return info
        try:
            proc = subprocess.run(
                [py, str(RUNNER_SCRIPT), "selfcheck"], cwd=str(HERE),
                capture_output=True, text=True, timeout=120, env=_runner_env(),
            )
            result = None
            for line in (proc.stdout or "").splitlines():
                if line.startswith(RESULT_MARKER):
                    try:
                        result = json.loads(line[len(RESULT_MARKER):].strip())
                    except Exception:
                        result = None
            if result:
                info.update(result)
                info["ok"] = bool(result.get("ok"))
            else:
                info.update({"ok": False, "exit_code": proc.returncode,
                             "error": (proc.stderr or "")[-300:]})
        except Exception as exc:
            info.update({"ok": False, "error": str(exc)[:300]})
        _ENV_CACHE = info
        return info


def start_job(body: dict) -> tuple[int, dict]:
    """启动一个 osmosis 任务。返回 (http_status, payload)。"""
    mode = str((body or {}).get("mode", "preview")).lower().strip()
    if mode not in MODES:
        return 400, {"error": f"mode 必须是 {'/'.join(MODES)}"}
    confirm = bool(body.get("confirm"))
    if mode in WRITE_MODES and not confirm:
        return 400, {"error": f"mode={mode} 属于写平台操作，必须 confirm=true（Web 二次确认）"}

    settings = _sanitize_settings(body.get("settings"))
    env = probe_env()
    if not env.get("ok"):
        return 503, {"error": "runner 运行时不可用", "env": env}

    jid = "os-" + datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:5]
    region = str(settings.get("region") or env.get("defaults", {}).get("region") or "USA")
    delay = settings.get("delay", env.get("defaults", {}).get("delay", 1))
    job: dict = {
        "id": jid, "mode": mode, "state": "queued",
        "scope": f"{region.upper()}/D{delay}",
        "region": region.upper(), "delay": delay,
        "confirm": confirm, "created_at": _now(),
        "settings_echo": {k: settings[k] for k in sorted(settings)},
        "log": deque(maxlen=LOG_KEEP),
        "result": None, "error": None,
    }
    with _JOBS_LOCK:
        _JOBS[jid] = job
    _append_log(job, f"[service] 任务创建 mode={mode} scope={job['scope']} confirm={confirm}")

    payload = {"mode": mode, "settings": settings, "confirm": confirm}

    def _work():
        acquired = _RUN_SEMA.acquire(timeout=0.1)
        if not acquired:
            job["state"] = "error"
            job["error"] = "已有 osmosis 任务在运行（单任务并发设计，BRAIN 限流友好）"
            _save_state()
            return
        try:
            _execute(job, payload)
        finally:
            _RUN_SEMA.release()

    threading.Thread(target=_work, daemon=True, name=f"osmosis-{jid}").start()
    return 202, {"job": _public(job)}


def list_jobs() -> dict:
    with _JOBS_LOCK:
        jobs = [_public(j) for j in _JOBS.values()]
    jobs.sort(key=lambda x: x.get("created_at") or 0, reverse=True)
    return {"jobs": jobs, "running": sum(1 for j in jobs if j.get("state") in ("queued", "running"))}


def get_job(job_id: str) -> dict | None:
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            return None
        return {"job": _public(job, with_log=True)}


def job_log(job_id: str, after: int = 0) -> dict | None:
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            return None
        buf = job["log"]
        lines = [l for l in buf if l["n"] > after][-800:]
        return {"lines": lines, "after": buf[-1]["n"] if buf else after,
                "state": job["state"]}


def cancel_job(job_id: str) -> dict | None:
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            return None
        if job.get("state") not in ("queued", "running"):
            return {"ok": False, "error": f"任务状态 {job['state']} 不可取消"}
        job["_stop"] = True
        proc = job.get("_proc")
        if proc is not None and proc.poll() is None:
            try:
                proc.terminate()
            except Exception:
                pass
        _append_log(job, "[service] 收到取消请求")
        return {"ok": True}


def report_file(filename: str) -> Path | None:
    """安全返回 osmosis_report_*.csv 路径（防路径穿越）。"""
    if not re.fullmatch(r"osmosis_report_[A-Za-z0-9_\-]+\.csv", filename):
        return None
    path = HERE / filename
    return path if path.exists() else None


def status_summary() -> dict:
    env = probe_env()
    with _JOBS_LOCK:
        running = sum(1 for j in _JOBS.values() if j.get("state") in ("queued", "running"))
        total = len(_JOBS)
    return {"env_ok": bool(env.get("ok")), "running": running, "total_jobs": total,
            "modes": list(MODES), "write_modes": sorted(WRITE_MODES)}


_load_state()

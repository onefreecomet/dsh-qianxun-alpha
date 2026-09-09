#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""osmosis_runner.py — Osmosis 分配器的隔离子进程 runner。

设计（与 qianxund 主守护完全隔离）：
  · 本文件由 osmosis_service.py 用 /usr/bin/python3 (3.9, 带 pandas) 启动，
    qianxund 自身跑在 homebrew Python 3.14（无 pandas），两边零共享。
  · 原版 osmosis_allocator.py 一行不改，通过 importlib 动态加载，
    只在运行期覆盖其全局配置（区域/点数/阈值/模式）。
  · allocator 的所有 print 重定向到 stderr（作为任务日志）；
    stdout 只在最后输出一行 @@RESULT@@ {json}，父进程按此标记解析。
  · 安全默认：mode=preview 永不写平台。allocate/clear 需 service 层
    显式传 confirm=true（Web 端二次确认按钮），且 runner 内部不再有
    input() 交互 —— CONFIRM_BEFORE_WRITE 由 runner 按模式设置。

用法（由 osmosis_service.py 调起，也可手工测试）:
    /usr/bin/python3 osmosis_runner.py selfcheck
    /usr/bin/python3 osmosis_runner.py run --payload '<json文件路径>'
payload 结构:
    {"mode": "preview|allocate|clear|verify",
     "settings": {"region": "USA", "delay": 1, ...可选覆盖...},
     "confirm": false}
"""
from __future__ import annotations

import argparse
import importlib.util
import io
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ALLOCATOR_PATH = HERE / "osmosis_allocator.py"
RESULT_MARKER = "@@RESULT@@"

# allocator 只许向 stderr 写日志；stdout 保留给结果 JSON。
_real_stdout = sys.stdout
sys.stdout = sys.stderr  # type: ignore[assignment]


def load_allocator():
    """动态加载 osmosis_allocator（原文件零修改）。"""
    if not ALLOCATOR_PATH.exists():
        raise RuntimeError(f"allocator 快照缺失: {ALLOCATOR_PATH}")
    spec = importlib.util.spec_from_file_location("osmosis_allocator", ALLOCATOR_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["osmosis_allocator"] = mod
    spec.loader.exec_module(mod)
    return mod


def emit_result(obj: dict) -> None:
    """向真实 stdout 输出一行结果标记。"""
    line = RESULT_MARKER + " " + json.dumps(obj, ensure_ascii=False)
    _real_stdout.write(line + "\n")
    _real_stdout.flush()


def credentials_status(alloc) -> dict:
    """探测凭据可用性（绝不回显任何值）。"""
    try:
        cands = alloc.credential_file_candidates()
        for path in cands:
            if path.exists():
                try:
                    if alloc.load_credentials_from_file(path):
                        return {"found": True, "source": str(path.name)}
                except Exception:
                    continue
        env_ok = bool(os.environ.get("BRAIN_PASSWORD")) and bool(
            os.environ.get("BRAIN_EMAIL") or os.environ.get("BRAIN_USERNAME"))
        return {"found": env_ok, "source": "env" if env_ok else None}
    except Exception as exc:  # pragma: no cover
        return {"found": False, "error": str(exc)[:120]}


def apply_overrides(alloc, settings: dict) -> dict:
    """把 payload.settings 映射到 allocator 全局配置。返回生效配置摘要。"""
    g = lambda key, default: settings.get(key, default)  # noqa: E731

    alloc.TARGET_REGION = alloc.clean_region(g("region", alloc.TARGET_REGION))
    alloc.TARGET_DELAY = alloc.clean_delay(g("delay", alloc.TARGET_DELAY))

    # 仅覆盖 UI 暴露的核心参数；未传时保持脚本内置默认。
    if "total_points" in settings:
        alloc.TOTAL_POINTS = max(0, int(settings["total_points"]))
    if "target_alpha_count" in settings:
        alloc.TARGET_ALPHA_COUNT = max(1, int(settings["target_alpha_count"]))
    if "min_alpha_count" in settings:
        alloc.MIN_ALPHA_COUNT = max(1, int(settings["min_alpha_count"]))
    if "max_alpha_count" in settings:
        alloc.MAX_ALPHA_COUNT = max(alloc.MIN_ALPHA_COUNT, int(settings["max_alpha_count"]))
    if "super_point_share" in settings:
        alloc.SUPER_POINT_SHARE = min(0.5, max(0.0, float(settings["super_point_share"])))
    if "min_points_per_alpha" in settings:
        alloc.MIN_POINTS_PER_ALPHA = max(0, int(settings["min_points_per_alpha"]))
    if "regular_max_points_per_alpha" in settings:
        alloc.REGULAR_MAX_POINTS_PER_ALPHA = max(0, int(settings["regular_max_points_per_alpha"]))
    if "super_max_points_per_alpha" in settings:
        alloc.SUPER_MAX_POINTS_PER_ALPHA = max(0, int(settings["super_max_points_per_alpha"]))
    if "max_pnl_corr" in settings:
        alloc.MAX_PNL_CORR = min(1.0, max(0.0, float(settings["max_pnl_corr"])))
    if "soft_pnl_corr" in settings:
        alloc.SOFT_PNL_CORR = min(alloc.MAX_PNL_CORR, max(0.0, float(settings["soft_pnl_corr"])))
    if "max_alpha_scan" in settings:
        alloc.MAX_ALPHA_SCAN = max(10, int(settings["max_alpha_scan"]))
    if "preselect_limit_per_type" in settings:
        alloc.PRESELECT_LIMIT_PER_TYPE = max(1, int(settings["preselect_limit_per_type"]))
    if "regular_min_sharpe" in settings:
        alloc.REGULAR_MIN_SHARPE = float(settings["regular_min_sharpe"])
    if "regular_min_fitness" in settings:
        alloc.REGULAR_MIN_FITNESS = float(settings["regular_min_fitness"])
    if "regular_max_drawdown" in settings:
        alloc.REGULAR_MAX_DRAWDOWN = float(settings["regular_max_drawdown"])
    if "min_date_submitted" in settings:
        alloc.MIN_DATE_SUBMITTED = str(settings["min_date_submitted"] or "")
    if "max_date_submitted" in settings:
        alloc.MAX_DATE_SUBMITTED = str(settings["max_date_submitted"] or "")
    if "exclude_alpha_ids" in settings:
        alloc.EXCLUDE_ALPHA_IDS = {str(x).strip() for x in settings["exclude_alpha_ids"] if str(x).strip()}
    if "clear_existing_first" in settings:
        alloc.CLEAR_EXISTING_FIRST = bool(settings["clear_existing_first"])
    if "fetch_yearly_stats" in settings:
        alloc.FETCH_YEARLY_STATS = bool(settings["fetch_yearly_stats"])
    if "fetch_pnl_for_diversity" in settings:
        alloc.FETCH_PNL_FOR_DIVERSITY = bool(settings["fetch_pnl_for_diversity"])

    alloc.validate_settings()
    return {
        "region": alloc.TARGET_REGION, "delay": alloc.TARGET_DELAY,
        "total_points": alloc.TOTAL_POINTS,
        "target_alpha_count": alloc.TARGET_ALPHA_COUNT,
        "min_alpha_count": alloc.MIN_ALPHA_COUNT,
        "max_alpha_count": alloc.MAX_ALPHA_COUNT,
        "super_point_share": alloc.SUPER_POINT_SHARE,
        "max_pnl_corr": alloc.MAX_PNL_CORR,
    }


def selfcheck() -> int:
    """自检：pandas 版本 / allocator 可加载 / 凭据探测（无平台调用）。"""
    result: dict = {"ok": False, "step": "selfcheck"}
    try:
        import pandas  # noqa: PLC0415
        result["pandas"] = pandas.__version__
        alloc = load_allocator()
        result["allocator_version"] = getattr(alloc, "SCRIPT_VERSION", "?")
        result["defaults"] = {
            "region": alloc.TARGET_REGION, "delay": alloc.TARGET_DELAY,
            "total_points": alloc.TOTAL_POINTS, "action": alloc.ACTION,
        }
        cred = credentials_status(alloc)
        result["credentials"] = cred
        result["ok"] = True
        emit_result(result)
        return 0
    except Exception as exc:
        result["error"] = f"{type(exc).__name__}: {exc}"
        emit_result(result)
        return 1


def _slim_selected(df) -> list[dict]:
    """选中的 alpha 行 → 前端表格友好的精简 dict 列表。"""
    cols = ["alpha_id", "type", "selection_reason", "osmosis_new", "adjusted_quality",
            "base_quality_score", "sharpe", "fitness", "returns", "turnover", "drawdown",
            "margin", "self_corr", "prod_corr", "universe", "neutralization", "decay",
            "dateSubmitted", "osmosisPoints"]
    rows = []
    for _, r in df.iterrows():
        item = {}
        for c in cols:
            if c not in df.columns:
                continue
            v = r.get(c)
            if v is None:
                item[c] = None
            elif hasattr(v, "item"):
                try:
                    v = v.item()
                except Exception:
                    pass
            item[c] = v
        rows.append(item)
    return rows


def run_mode(mode: str, settings: dict, confirm: bool) -> int:
    result: dict = {"ok": False, "step": mode}
    alloc = load_allocator()
    result["allocator_version"] = getattr(alloc, "SCRIPT_VERSION", "?")
    result["credentials"] = credentials_status(alloc)
    result["effective"] = apply_overrides(alloc, settings)

    # 写平台必须 service 层 confirm=true（Web 二次确认按钮的产物）。
    write_modes = {"allocate", "clear"}
    if mode in write_modes and not confirm:
        result["error"] = "missing confirm=true（写平台操作需 Web 二次确认）"
        emit_result(result)
        return 2

    # 模式 → allocator 全局：preview 永远 WRITE_TO_PLATFORM=False（双保险）。
    if mode == "preview":
        alloc.ACTION = "preview"
        alloc.WRITE_TO_PLATFORM = False
    elif mode == "allocate":
        alloc.ACTION = "allocate"
        alloc.WRITE_TO_PLATFORM = True
    elif mode == "clear":
        alloc.ACTION = "clear"
        alloc.WRITE_TO_PLATFORM = True
    elif mode == "verify":
        alloc.ACTION = "preview"
        alloc.WRITE_TO_PLATFORM = False
    else:
        result["error"] = f"unknown mode: {mode}"
        emit_result(result)
        return 2
    alloc.CONFIRM_BEFORE_WRITE = False  # 交互确认已由 Web 二次确认替代
    result["write_to_platform"] = alloc.WRITE_TO_PLATFORM
    result["scope"] = alloc.scope_name(alloc.TARGET_REGION, alloc.TARGET_DELAY)

    session = alloc.authenticate()

    if mode == "verify":
        import io as _io  # noqa: PLC0415
        alloc.verify_current_scope_points()
        result["ok"] = True
        emit_result(result)
        return 0

    if mode == "clear":
        alloc.clear_existing_points(session)
        # 清完回读当前点数
        records = alloc.fetch_scope_alphas_all_visibility(
            session, alloc.TARGET_REGION, alloc.TARGET_DELAY,
            only_with_points=True, max_alpha_scan=alloc.MAX_ALPHA_SCAN,
            use_date_filter=False, use_status_filter=False)
        df = __import__("pandas").DataFrame(alloc.flatten_alpha(r) for r in records)
        pts = df[df["osmosisPoints"].notna() & (df["osmosisPoints"] > 0)] if not df.empty else df
        result["verify"] = {
            "alphas_with_points": int(len(pts)),
            "platform_sum": int(pts["osmosisPoints"].sum()) if not pts.empty else 0,
        }
        result["ok"] = True
        emit_result(result)
        return 0

    # preview / allocate：构建计划（读平台 + 打分 + 选券 + 分点）
    all_df, selected, report_path = alloc.build_allocation_plan(session)
    result["report_path"] = str(report_path)
    result["report_filename"] = Path(report_path).name
    result["selected_count"] = int(len(selected))
    result["total_points"] = int(selected["osmosis_new"].sum()) if not selected.empty else 0
    result["selected"] = _slim_selected(selected)
    if not all_df.empty:
        result["candidates"] = int(len(all_df))
        eligible = all_df[all_df.get("filter_reason", "").astype(str) == ""] if "filter_reason" in all_df.columns else all_df
        result["eligible_by_type"] = {str(k): int(v) for k, v in eligible["type"].value_counts().items()} if not eligible.empty else {}

    if mode == "allocate":
        if alloc.CLEAR_EXISTING_FIRST:
            alloc.clear_existing_points(session)
        alloc.write_allocation(session, selected)
        result["written"] = True
    else:
        result["written"] = False

    result["ok"] = True
    emit_result(result)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="osmosis 隔离 runner")
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("selfcheck")
    p_run = sub.add_parser("run")
    p_run.add_argument("--payload", required=True, help="JSON payload 文件路径")
    args = parser.parse_args()

    if args.cmd == "selfcheck":
        return selfcheck()

    try:
        payload = json.loads(Path(args.payload).read_text(encoding="utf-8"))
    except Exception as exc:
        emit_result({"ok": False, "step": "payload", "error": f"payload 解析失败: {exc}"})
        return 2
    mode = str(payload.get("mode", "preview")).lower()
    settings = payload.get("settings") or {}
    confirm = bool(payload.get("confirm", False))
    try:
        return run_mode(mode, settings, confirm)
    except SystemExit:
        raise
    except Exception as exc:
        emit_result({"ok": False, "step": mode,
                     "error": f"{type(exc).__name__}: {exc}"[:500]})
        return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        emit_result({"ok": False, "step": "interrupted", "error": "cancelled"})
        raise SystemExit(130)

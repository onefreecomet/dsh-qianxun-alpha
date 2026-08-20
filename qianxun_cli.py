#!/usr/bin/env python3
"""千寻 headless CLI（v1.0，跨平台：macOS / Linux / Windows）。

让任意 AI agent（deepseek harness / Claude Code / 任意框架）直接驱动
WorldQuant BRAIN 批量回测闭环，等价于 Windows 千寻的「AI批次」Tab + ai_bridge：
    AI 生成表达式 JSON → submit 批量回测 → 入库 → analyze 读库 → radar 信号灯 → 定向再生成

用法：
    qianxun_cli.py login                                          # 登录测试（环境变量凭据）
    qianxun_cli.py submit <batch.json> [--producer 阿法]          # 导入 JSON → 批量回测 → 入库
                    [--batch-size 8] [--concurrent 3] [--db 路径] [--no-backfill]
    qianxun_cli.py status [--batch <批次号>] [--db 路径]           # 批次列表 / 单批次详情
    qianxun_cli.py wait <批次号> [--timeout 秒] [--db 路径]        # 阻塞等待批次完成
    qianxun_cli.py analyze <批次号> [--limit N] [--db 路径]        # 读库输出该批次结果（按 |sharpe| 降序）
    qianxun_cli.py radar <批次号> [--db 路径] [--passed N --total M]  # 方向雷达四色信号
    qianxun_cli.py resume <批次号> [--db 路径]                     # 断点续跑（补跑 pending 模拟）

凭据（二选一）：
    export WQ_USERNAME=你的BRAIN账号
    export WQ_PASSWORD=你的BRAIN密码
    # 或写进 ~/.zshrc / ~/.bashrc

示例：
    python3 qianxun_cli.py submit outputs/gem_usa_01.json --producer 阿法
    python3 qianxun_cli.py wait B20260818-001 --timeout 3600
    python3 qianxun_cli.py analyze B20260818-001 --limit 30
    python3 qianxun_cli.py radar B20260818-001 --passed 120 --total 200
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from qianxun_engine.api.config import BrainConfig  # noqa: E402
from qianxun_engine.api.client import APIClient, BrainClientError  # noqa: E402
from qianxun_engine.storage.database import Storage, expression_key  # noqa: E402
from qianxun_engine.scheduler.runner import BatchScheduler  # noqa: E402

DEFAULT_DB = Path(__file__).resolve().parent / "data" / "alpha_machine.db"
RADAR_SCRIPT = Path(__file__).resolve().parent / "direction_radar.py"

# 平台必需 settings 字段（缺了会 400）。用户 JSON 里给的优先，缺失补默认。
DEFAULT_SETTINGS: dict = {
    "instrumentType": "EQUITY",
    "region": "USA",
    "universe": "TOP3000",
    "delay": 1,
    "decay": 1,
    "neutralization": "SUBINDUSTRY",
    "truncation": 0.08,
    "pasteurization": "ON",
    "testPeriod": "P0Y",
    "unitHandling": "VERIFY",
    "nanHandling": "ON",
    "language": "FASTEXPR",
    "visualization": False,
}


def _normalize_settings(settings: dict) -> dict:
    """补全平台必需 settings 字段：用户值优先，缺失用默认。"""
    merged = dict(DEFAULT_SETTINGS)
    merged.update({k: v for k, v in settings.items() if v is not None})
    return merged


# ---------------- helpers ----------------


def _storage(db: str) -> Storage:
    p = Path(db)
    p.parent.mkdir(parents=True, exist_ok=True)
    return Storage(p)


def _client() -> APIClient:
    cfg = BrainConfig.from_env()  # 优先环境变量 WQ_USERNAME/WQ_PASSWORD，缺失回退 keyring
    client = APIClient(cfg)
    client.authenticate()
    return client


def _progress_cb(quiet: bool = False):
    def cb(event: str, payload: dict) -> None:
        if quiet:
            return
        if event == "batch_started":
            print(f"  ▶ batch {payload.get('batch_idx', '?')} 开始（{payload.get('count', '?')} 个）")
        elif event == "batch_submitted":
            print(f"  ↑ batch {payload.get('batch_idx', '?')} 已提交")
        elif event == "sim_completed":
            print(f"  ✓ alpha {payload.get('alpha_id', '?')} 完成 | sharpe={payload.get('sharpe', '?')}")
        elif event == "sim_failed":
            print(f"  ✗ sim {payload.get('sim_id', '?')} 失败：{payload.get('error', '?')[:80]}")
    return cb


def _load_batch_json(path: str) -> dict:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if "settings" not in data or "expressions" not in data:
        raise SystemExit(f"JSON 格式错误：需要 {{settings: {{...}}, expressions: [...]}}（见 skill references/gem_rules.md）")
    if not isinstance(data["expressions"], list) or not data["expressions"]:
        raise SystemExit("expressions 为空，无表达式可提交")
    return data


# ---------------- commands ----------------


def cmd_login(args) -> int:
    try:
        client = _client()
        print(f"✅ 登录成功：{client.config.username}")
        return 0
    except Exception as e:
        print(f"❌ 登录失败：{type(e).__name__}: {e}")
        print("   检查环境变量 WQ_USERNAME / WQ_PASSWORD 是否已设置（export WQ_USERNAME=...）")
        return 1


def cmd_submit(args) -> int:
    data = _load_batch_json(args.file)
    settings = _normalize_settings(data["settings"])
    expressions = data["expressions"]

    st = _storage(args.db)
    # 去重：跳过已回测过的表达式（skill 协议 Step 1.8）
    done = st.completed_expression_keys()
    todo = [(e["expression"], e.get("decay", settings.get("decay", 1)), settings)
            for e in expressions
            if expression_key(e["expression"], settings) not in done]
    skipped = len(expressions) - len(todo)
    if skipped:
        print(f"⏭ 跳过 {skipped} 个已回测过的表达式")
    if not todo:
        print("全部表达式都已回测过，无需提交")
        return 0

    # 建任务 + 批次
    batch_no = st.next_batch_no()
    tid = st.create_task_run(
        name=f"AI batch {batch_no}",
        kind="ai_batch",
        config={"producer": args.producer, **settings},
        total=len(todo),
        batch_no=batch_no,
    )
    st.create_ai_batch(
        batch_no=batch_no,
        producer=args.producer,
        dataset_id=str(settings.get("dataset_id", "")),
        region=str(settings.get("region", "")),
        expression_count=len(todo),
        note=f"AI 提交 {Path(args.file).name}（跳过 {skipped}）",
    )
    print(f"📦 批次 {batch_no}：{len(todo)} 个表达式 → 开始批量回测（batch={args.batch_size}, concurrent={args.concurrent}）")

    client = _client()
    sched = BatchScheduler(
        client, st,
        progress_cb=_progress_cb(),
        max_concurrent_batches=args.concurrent,
        batch_size=args.batch_size,
    )
    st.update_ai_batch_status(batch_no, "running")
    try:
        sched.run(tid, todo)
        sched.join()
    except Exception as e:
        st.update_ai_batch_status(batch_no, "failed")
        print(f"❌ 回测异常：{e}")
        return 1

    # 回填 alphas（平台详情，限流约 30 条/分钟）
    if not args.no_backfill:
        print("回填 alpha 详情（平台限流约 30 条/分钟，耐心等待）…")
        sims = st.list_completed_simulations(tid)
        for i, s in enumerate(sims, 1):
            try:
                detail = client.get_alpha_details(s["alpha_id"])
                alpha = client.extract_alpha_metrics(detail)
                if alpha.get("alpha_id"):
                    st.upsert_alpha(alpha, batch_no=batch_no)
                if i % 25 == 0 or i == len(sims):
                    print(f"  回填进度：{i}/{len(sims)}")
            except Exception as e:
                print(f"  ⚠ alpha {s['alpha_id']} 回填失败：{e}")

    st.update_ai_batch_status(batch_no, "completed")
    print(f"✅ 批次 {batch_no} 完成。用 `qianxun_cli.py analyze {batch_no}` 看结果")
    return 0


def cmd_status(args) -> int:
    st = _storage(args.db)
    if args.batch:
        b = st.get_ai_batch(args.batch)
        if not b:
            print(f"批次 {args.batch} 不存在")
            return 1
        print(f"批次 {b['batch_no']} | {b['region']} | {b['expression_count']}个 | {b['status']} | {b['created_at']}")
        if b.get("note"):
            print(f"  note: {b['note']}")
        return 0
    print("=== 最近 AI 批次 ===")
    for b in st.list_ai_batches(limit=10):
        print(f"  {b['batch_no']} | {b['region']} | {b['expression_count']}个 | {b['status']} | {b['created_at']}")
    return 0


def cmd_wait(args) -> int:
    st = _storage(args.db)
    deadline = time.time() + (args.timeout or 3600)
    while time.time() < deadline:
        b = st.get_ai_batch(args.batch)
        if b and b["status"] in ("completed", "failed"):
            print(f"批次 {args.batch} → {b['status']}")
            return 0 if b["status"] == "completed" else 1
        time.sleep(10)
    print(f"⏰ 等待超时（{args.timeout or 3600}s），批次 {args.batch} 仍在跑。可再次 wait 或查 status")
    return 1


def cmd_analyze(args) -> int:
    st = _storage(args.db)
    rows = st.list_alphas_by_batch(args.batch, limit=args.limit)
    if not rows:
        print(f"批次 {args.batch} 无已回填结果（可能还在回填中）")
        return 1
    rows.sort(key=lambda a: abs(a.get("sharpe") or 0), reverse=True)
    print(f"=== 批次 {args.batch}：{len(rows)} 条结果（按 |sharpe| 降序）===")
    print(f"{'alpha_id':<16} {'sharpe':>7} {'fitness':>8} {'turnover':>8} {'margin_bps':>10} {'region':>5} {'check':>10}")
    for a in rows:
        print(f"{str(a.get('alpha_id','')):<16} {a.get('sharpe') or 0:>7.2f} "
              f"{a.get('fitness') or 0:>8.2f} {a.get('turnover') or 0:>8.2f} "
              f"{(a.get('margin') or 0) * 10000:>10.1f} {str(a.get('region') or ''):>5} "
              f"{str(a.get('check_status') or ''):>10}")
    return 0


def cmd_radar(args) -> int:
    if not RADAR_SCRIPT.exists():
        print(f"direction_radar.py 不存在（应放在 {RADAR_SCRIPT}）")
        return 1
    cmd = [sys.executable, str(RADAR_SCRIPT), "--batch", args.batch, "--db", args.db]
    if args.passed:
        cmd += ["--passed", str(args.passed)]
    if args.total:
        cmd += ["--total", str(args.total)]
    return subprocess.call(cmd)


def cmd_resume(args) -> int:
    """断点续跑：按批次号找回 task_run，补跑 pending 模拟。"""
    import sqlite3
    st = _storage(args.db)
    # 直接查 task_runs.batch_no（不依赖未导出的方法）
    with st._lock:
        row = st._conn.execute(
            "SELECT id FROM task_runs WHERE batch_no=?", (args.batch,)
        ).fetchone()
    if not row:
        print(f"批次 {args.batch} 没有对应任务")
        return 1
    tid = row["id"]
    client = _client()
    sched = BatchScheduler(client, st, progress_cb=_progress_cb())
    print(f"续跑任务 {tid}（批次 {args.batch}）…")
    st.update_ai_batch_status(args.batch, "running")
    sched.continue_run(tid)
    sched.join()
    st.update_ai_batch_status(args.batch, "completed")
    print(f"✅ 续跑完成")
    return 0


# ---------------- main ----------------


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="qianxun_cli", description="千寻 headless CLI（跨平台，Python 3.10+）")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("login", help="登录测试（环境变量 WQ_USERNAME/WQ_PASSWORD）")

    sp = sub.add_parser("submit", help="导入批次 JSON → 批量回测 → 入库")
    sp.add_argument("file", help="批次 JSON 路径（{settings, expressions[]}）")
    sp.add_argument("--producer", default="阿法", help="生产者标识（默认 阿法）")
    sp.add_argument("--batch-size", type=int, default=8, help="每批表达式数（默认 8）")
    sp.add_argument("--concurrent", type=int, default=3, help="并发批次数（默认 3）")
    sp.add_argument("--db", default=str(DEFAULT_DB))
    sp.add_argument("--no-backfill", action="store_true", help="跳过回填 alpha 详情")

    sp = sub.add_parser("status", help="批次列表 / 单批次详情")
    sp.add_argument("--batch", default="")
    sp.add_argument("--db", default=str(DEFAULT_DB))

    sp = sub.add_parser("wait", help="阻塞等待批次完成")
    sp.add_argument("batch")
    sp.add_argument("--timeout", type=int, default=3600)
    sp.add_argument("--db", default=str(DEFAULT_DB))

    sp = sub.add_parser("analyze", help="读库输出批次结果")
    sp.add_argument("batch")
    sp.add_argument("--limit", type=int, default=50)
    sp.add_argument("--db", default=str(DEFAULT_DB))

    sp = sub.add_parser("radar", help="方向雷达四色信号")
    sp.add_argument("batch")
    sp.add_argument("--passed", type=int)
    sp.add_argument("--total", type=int)
    sp.add_argument("--db", default=str(DEFAULT_DB))

    sp = sub.add_parser("resume", help="断点续跑批次")
    sp.add_argument("batch")
    sp.add_argument("--db", default=str(DEFAULT_DB))

    args = p.parse_args(argv)
    return {"login": cmd_login, "submit": cmd_submit, "status": cmd_status,
            "wait": cmd_wait, "analyze": cmd_analyze, "radar": cmd_radar,
            "resume": cmd_resume}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())

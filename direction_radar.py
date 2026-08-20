"""信号灯系统 Direction Radar：统计导航一批回测结果。

来源：WQ 论坛帖子 39319955780887（2026-03，作者经验分享"给 AI 装上导航"）。
目的：客观回答"这方向该继续深挖还是止损"（区分池塘没鱼 vs 鱼饵不对）。

输入：一批回测的 Sharpe 列表 + 可选（通过数/总数、表达式算子列表、上轮均值）
输出：四色信号 + DSI 分 + 各维度明细 + 建议行动 + 防误杀护栏触发记录。

统计方法（全部纯 Python + numpy 实现，无 scipy 依赖）：
- 单样本 t 检验：t = (mean - 1.0) / (std / sqrt(n))，单侧 p<0.05 显著；
  样本 < 8 时改用 Bootstrap 百分位法（9999 次重采样）
- 天花板：max_sharpe / 2.0（clip 到 0-1）
- 通过率：Wilson Score 区间下界（小样本友好）
- 稳定性：1 / (1 + 变异系数)，CV = std / |mean|
- 双峰系数：BC = (skew^2 + 1) / (kurt_adj)，> 0.556 提示双峰（存在高分子群体）
- DSI = 0.30*S_ttest + 0.25*S_ceiling + 0.25*S_passrate + 0.20*S_consist
- 对比两轮：Mann-Whitney U 效应量 r = 2*U1/(n1*n2) - 1
- 迭代趋势：Spearman 秩相关（rho > 0.5 收敛，rho < -0.3 发散）

信号规则（含 5 条防误杀护栏）：
- GREEN  均值显著 > 1 且通过率达标 → 加码深挖
- YELLOW 有潜力但证据不足 / 小样本 / 单高个 → 谨慎继续，跑结构变体
- RED    信号弱但有探索空间 → 做一次结构性改动再评估
- DEAD   三重证据（样本够大 AND 均值低 AND 天花板低）→ 记录 anti-pattern 换方向

用法：
    python direction_radar.py --sharpe 1.2,0.8,1.5,... [--passed 5 --total 10]
    python direction_radar.py --batch B20260813-001 --db <千寻 alpha_machine.db>  # 从库读
    python direction_radar.py --prev-mean 0.9 --trend 0.5,0.7,0.9  # 对比/趋势
"""

from __future__ import annotations

import argparse
import json
import math
import random
import sqlite3
import statistics
from dataclasses import dataclass, field

# ---------------------------------------------------------------- 统计工具

def _t_pdf(t: float, df: int) -> float:
    """t 分布 PDF（用 math.lgamma 避免溢出）。"""
    if df <= 0:
        return 0.0
    c = math.lgamma((df + 1) / 2) - math.lgamma(df / 2) - 0.5 * math.log(df * math.pi)
    return math.exp(c) * (1 + t * t / df) ** (-(df + 1) / 2)


def _t_sf(t: float, df: int, steps: int = 2000) -> float:
    """t 分布单侧生存函数 P(T > t)，数值积分（Simpson）。"""
    if t <= 0:
        # 对称性：P(T > t) = 1 - P(T > -t)，t<=0 时用大区间积分
        if t < -8:
            return 1.0
        # 从 t 积分到 +∞：用 [t, t+12]（尾部贡献可忽略）
        a, b = t, t + 12.0
        h = (b - a) / steps
        s = _t_pdf(a, df) + _t_pdf(b, df)
        for i in range(1, steps):
            x = a + i * h
            s += _t_pdf(x, df) * (4 if i % 2 else 2)
        return s * h / 3
    # t > 0：从 t 积分到 +∞
    a, b = t, t + 12.0
    h = (b - a) / steps
    s = _t_pdf(a, df) + _t_pdf(b, df)
    for i in range(1, steps):
        x = a + i * h
        s += _t_pdf(x, df) * (4 if i % 2 else 2)
    return s * h / 3


def _bootstrap_p(means: list[float], null: float = 1.0, n_iter: int = 9999, seed: int | None = None) -> float:
    """Bootstrap 百分位法：均值置信区间下界显著高于 null 的概率（小样本用）。"""
    rng = random.Random(seed)
    n = len(means)
    if n == 0:
        return 1.0
    lower_above = 0
    for _ in range(n_iter):
        sample = [rng.choice(means) for _ in range(n)]
        if statistics.mean(sample) > null:
            lower_above += 1
    return 1.0 - lower_above / n_iter


def _wilson_lower(passed: int, total: int, z: float = 1.96) -> float:
    """Wilson Score 区间下界（小样本通过率置信下限）。"""
    if total <= 0:
        return 0.0
    phat = passed / total
    denom = 1 + z * z / total
    center = (phat + z * z / (2 * total)) / denom
    margin = z * math.sqrt(phat * (1 - phat) / total + z * z / (4 * total * total)) / denom
    return max(0.0, center - margin)


def _bimodality_coef(values: list[float]) -> float:
    """双峰系数 BC = (skew^2 + 1) / (kurt_adj)。> 0.556 提示双峰。"""
    n = len(values)
    if n < 4:
        return 0.0
    mean = statistics.mean(values)
    sd = statistics.stdev(values) if n > 1 else 0.0
    if sd == 0:
        return 0.0
    skew = sum((x - mean) ** 3 for x in values) / (n * sd ** 3)
    kurt = sum((x - mean) ** 4 for x in values) / (n * sd ** 4)
    denom = kurt + 3 * (n - 1) ** 2 / ((n - 2) * (n - 3))
    if denom <= 0:
        return 0.0
    return (skew * skew + 1) / denom


def _gap_bimodal(values: list[float], min_per_cluster: int = 3) -> bool:
    """gap 辅助检测：排序后找最大相邻空隙，若空隙占比大且两簇样本都够，判双峰。

    对经典双峰系数（偏度法）失效的对称双峰有效。
    """
    n = len(values)
    if n < min_per_cluster * 2 + 1:
        return False
    sv = sorted(values)
    rng = sv[-1] - sv[0]
    if rng <= 0:
        return False
    max_gap, gap_idx = 0.0, -1
    for i in range(n - 1):
        g = sv[i + 1] - sv[i]
        if g > max_gap:
            max_gap, gap_idx = g, i
    if gap_idx + 1 < min_per_cluster or (n - 1 - gap_idx) < min_per_cluster:
        return False
    if max_gap / rng < 0.3:
        return False
    left, right = sv[:gap_idx + 1], sv[gap_idx + 1:]
    # 两簇内部相对紧凑（各簇 std 远小于总 std）
    import statistics as _st
    total_sd = _st.stdev(sv)
    if total_sd == 0:
        return False
    left_sd = _st.stdev(left) if len(left) > 1 else 0.0
    right_sd = _st.stdev(right) if len(right) > 1 else 0.0
    return max(left_sd, right_sd) < 0.5 * total_sd


def _is_bimodal(values: list[float]) -> bool:
    """双峰判定：经典系数法 OR gap 法。"""
    return _bimodality_coef(values) > 0.556 or _gap_bimodal(values)


def _mann_whitney_r(a: list[float], b: list[float]) -> float:
    """Mann-Whitney U 效应量 r = 2*U1/(n1*n2) - 1。r>0 表示 a 优于 b。"""
    if not a or not b:
        return 0.0
    ra = sum(1 for x in a for y in b if x > y)
    u1 = ra + 0.5 * sum(1 for x in a for y in b if x == y)
    return 2 * u1 / (len(a) * len(b)) - 1


def _spearman_rho(series: list[float]) -> float:
    """Spearman 秩相关：序列与 1..n 的秩相关，判断收敛/发散。"""
    n = len(series)
    if n < 3:
        return 0.0
    def _rank(vals):
        idx = sorted(range(len(vals)), key=lambda i: vals[i])
        ranks = [0.0] * len(vals)
        i = 0
        while i < len(idx):
            j = i
            while j + 1 < len(idx) and vals[idx[j + 1]] == vals[idx[i]]:
                j += 1
            avg = (i + 1 + j + 1) / 2
            for k in range(i, j + 1):
                ranks[idx[k]] = avg
            i = j + 1
        return ranks
    rx = _rank(series)
    ry = list(range(1, n + 1))
    mx, my = statistics.mean(rx), statistics.mean(ry)
    num = sum((a - mx) * (b - my) for a, b in zip(rx, ry))
    den = math.sqrt(sum((a - mx) ** 2 for a in rx) * sum((b - my) ** 2 for b in ry))
    return num / den if den else 0.0


# ---------------------------------------------------------------- 算子族

# 6 大算子族（来源：论坛帖）：时序/截面分组/数学变换/条件布尔/全局排名/滞后移位
def classify_operator_family(op: str) -> str:
    """把算子归到 6 大族（用于算子多样性分数）。"""
    op = op.lower()
    if op.startswith(("ts_", "days_from", "hump", "jump_", "last_diff", "kth_")):
        return "时序"
    if op.startswith(("group_", "vector_neut", "group_vector", "bucket")):
        return "截面分组"
    if op in ("log", "abs", "power", "signed_power", "scale_down", "sigmoid",
              "sqrt", "exp", "log_diff", "truncate", "fraction", "clamp",
              "right_tail", "left_tail", "tail", "min", "max", "min_max"):
        return "数学变换"
    if op in ("if_else", "and", "or", "not", ">", "<", "==", "is_nan",
              "is_not_nan", "trade_when"):
        return "条件布尔"
    if op in ("rank", "zscore", "percentile", "quantile", "normalize",
              "inverse", "reverse", "winsorize"):
        return "全局排名"
    if op in ("ts_delay", "ts_arg_min", "ts_arg_max", "ts_step"):
        return "滞后移位"
    return "时序" if op.startswith("ts") else "数学变换"


def operator_family_coverage(expressions: list[str]) -> tuple[int, set[str]]:
    """统计表达式集覆盖了多少种算子族。返回 (覆盖数, 覆盖族集合)。"""
    import re
    families: set[str] = set()
    for expr in expressions:
        for m in re.finditer(r"\b([a-z][a-z0-9_]*)\s*\(", expr):
            families.add(classify_operator_family(m.group(1)))
    return len(families), families


# ---------------------------------------------------------------- 信号判定

@dataclass
class RadarResult:
    signal: str = "YELLOW"
    dsi: float = 0.0
    n: int = 0
    mean: float = 0.0
    max_sharpe: float = 0.0
    p_value: float = 1.0
    s_ttest: float = 0.0
    s_ceiling: float = 0.0
    s_passrate: float = 0.0
    s_consist: float = 0.0
    pass_rate_lower: float = 0.0
    bimodal: bool = False
    family_coverage: int = 0
    families: set[str] = field(default_factory=set)
    guards_triggered: list[str] = field(default_factory=list)
    advice: str = ""
    detail: dict = field(default_factory=dict)


def evaluate_batch(
    sharpe_list: list[float],
    *,
    passed: int | None = None,
    total: int | None = None,
    expressions: list[str] | None = None,
    prev_mean: float | None = None,
    trend_means: list[float] | None = None,
    threshold: float = 1.0,
    seed: int | None = None,
) -> RadarResult:
    """评估一批回测结果，输出四色信号 + DSI + 护栏 + 建议。"""
    r = RadarResult()
    values = [float(s) for s in sharpe_list if s is not None]
    if len(values) < 2:
        r.signal = "YELLOW"
        r.guards_triggered.append("小样本保护：不足 2 个，无法判定")
        r.advice = "样本太少，先积累回测数量再导航"
        r.detail = {"note": "n<2，不判定"}
        return r

    r.n = len(values)
    r.mean = statistics.mean(values)
    r.max_sharpe = max(values)
    sd = statistics.stdev(values) if r.n > 1 else 0.0

    # 1) 信号显著性：t 检验（n<8 用 Bootstrap）
    if r.n < 8:
        r.p_value = _bootstrap_p(values, null=threshold, seed=seed)
        r.guards_triggered.append(f"小样本保护：n={r.n}<8，改用 Bootstrap")
    else:
        t_stat = (r.mean - threshold) / (sd / math.sqrt(r.n)) if sd > 0 else 0.0
        r.p_value = _t_sf(t_stat, df=r.n - 1)
    r.s_ttest = max(0.0, min(1.0, 1.0 - r.p_value))

    # 2) 天花板
    r.s_ceiling = max(0.0, min(1.0, r.max_sharpe / 2.0))

    # 3) 通过率（Wilson 下界）
    if total and total > 0:
        passed = passed if passed is not None else 0
        r.pass_rate_lower = _wilson_lower(passed, total)
        r.s_passrate = r.pass_rate_lower
    else:
        # 无通过率数据：用 |sharpe|>1 的比例做代理
        proxy = sum(1 for v in values if abs(v) > threshold) / r.n
        r.pass_rate_lower = _wilson_lower(int(proxy * r.n), r.n)
        r.s_passrate = r.pass_rate_lower

    # 4) 稳定性
    cv = (sd / abs(r.mean)) if r.mean != 0 else 99.0
    r.s_consist = 1.0 / (1.0 + cv)

    # DSI 加权
    r.dsi = 0.30 * r.s_ttest + 0.25 * r.s_ceiling + 0.25 * r.s_passrate + 0.20 * r.s_consist

    # 双峰检测（经典系数法 OR gap 法）
    r.bimodal = _is_bimodal(values)

    # 算子族多样性
    if expressions:
        r.family_coverage, r.families = operator_family_coverage(expressions)

    # ---------- 信号判定（含 5 条护栏） ----------
    guards = r.guards_triggered
    sig_ok = r.p_value < 0.05
    ceiling_ok = r.max_sharpe >= 1.5
    mean_ok = r.mean > threshold
    stable_ok = r.s_consist > 0.4

    # 护栏 1：小样本（n<5 只黄；n<10 不判红/死）
    if r.n < 5:
        guards.append(f"小样本保护：n={r.n}<5，只给黄灯")
        r.signal = "YELLOW"
        r.advice = f"样本 {r.n} 个不足 5，先继续回测积累样本"
        r.detail = dict(vars(r))
        return r
    if r.n < 10:
        guards.append(f"小样本保护：n={r.n}<10，不允许红/死灯")

    # 护栏 2：天花板保护（有高个个体不判死）
    if ceiling_ok and not mean_ok:
        guards.append(f"天花板保护：最高 Sharpe={r.max_sharpe:.2f}≥1.5，虽均值低但有潜力个体")

    # 护栏 3：双峰保护
    if r.bimodal:
        guards.append("双峰保护：分布呈双峰，存在高分子群体可提取")

    # 护栏 4：趋势保护（最近几轮均值上升不降级）
    if trend_means and len(trend_means) >= 2:
        rho = _spearman_rho(trend_means)
        if rho > 0.5:
            guards.append(f"趋势保护：迭代均值上升（rho={rho:.2f}），不因当前绝对值降级")

    # ---------- 判定 ----------
    dead_evidence = (r.n >= 10 and not mean_ok and r.max_sharpe < 1.5
                     and not ceiling_ok and not r.bimodal)
    red_evidence = not sig_ok and not mean_ok
    # 鱼饵太单一（算子族 ≤2）：即使三重证据齐备也不判死，先拓宽探索面
    bait_too_single = bool(expressions) and r.family_coverage <= 2 and not sig_ok

    if bait_too_single:
        r.signal = "YELLOW"
        r.advice = (f"算子族覆盖仅 {r.family_coverage} 种且无显著信号：可能是鱼饵太单一。"
                    f"先拓宽算子/构造方式再下结论，不要过早判死")
    elif dead_evidence and r.n >= 10:
        # 护栏（三重证据）：样本够大 AND 均值低 AND 天花板低，且无双峰/趋势保护
        r.signal = "DEAD"
        r.advice = "三重证据齐备：样本足够、均值低、无高个个体。记录 anti-pattern，换方向"
    elif sig_ok and mean_ok and stable_ok:
        r.signal = "GREEN"
        r.advice = "方向有统计显著信号，加码深挖，细化参数（decay/truncation/窗口）"
    elif red_evidence and r.n >= 10 and not r.bimodal:
        if r.family_coverage >= 4 and expressions:
            r.signal = "DEAD"
            r.advice = (f"算子族覆盖 {r.family_coverage} 种仍无信号：大概率数据字段本身没信号"
                        f"（池塘没鱼），记录 anti-pattern 换方向")
        else:
            r.signal = "RED"
            r.advice = "当前批次信号弱。先做一次结构性改动（换字段组合/换算子类型/换构造方式）再评估"
    elif r.bimodal:
        r.signal = "YELLOW"
        r.advice = "分布呈双峰，存在高分子群体。提取高分群体特征，定向再生成"
    elif r.family_coverage <= 2 and expressions:
        r.signal = "YELLOW"
        r.advice = f"算子族覆盖仅 {r.family_coverage} 种：可能是鱼饵太单一。先拓宽算子/构造方式再下结论"
    elif mean_ok or ceiling_ok:
        r.signal = "YELLOW"
        r.advice = "有潜力但证据不够充分，谨慎继续，再跑 1-2 轮结构变体"
    else:
        r.signal = "RED"
        r.advice = "信号偏弱，做一次结构性改动（换字段组合/换算子）再评估"

    # 对比上一轮
    if prev_mean is not None:
        r.detail["vs_prev"] = f"{r.mean:.2f} vs {prev_mean:.2f}"

    r.detail = {
        "signal": r.signal, "dsi": round(r.dsi, 3),
        "n": r.n, "mean": round(r.mean, 3), "max_sharpe": round(r.max_sharpe, 3),
        "p_value": round(r.p_value, 4),
        "s_ttest": round(r.s_ttest, 3), "s_ceiling": round(r.s_ceiling, 3),
        "s_passrate": round(r.s_passrate, 3), "s_consist": round(r.s_consist, 3),
        "pass_rate_lower": round(r.pass_rate_lower, 3),
        "bimodal": r.bimodal, "family_coverage": r.family_coverage,
        "families": sorted(r.families),
        "guards": guards, "advice": r.advice,
    }
    return r


# ---------------------------------------------------------------- CLI

def _load_from_db(db_path: str, batch_no: str) -> tuple[list[float], list[str]]:
    """从千寻 alpha_machine.db 读某批次的 sharpe 与表达式。"""
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT sharpe, expression FROM alphas WHERE batch_no=? AND sharpe IS NOT NULL",
        (batch_no,),
    ).fetchall()
    conn.close()
    sharpe = [r["sharpe"] for r in rows]
    exprs = [r["expression"] for r in rows]
    return sharpe, exprs


def main() -> None:
    ap = argparse.ArgumentParser(description="信号灯系统 Direction Radar")
    ap.add_argument("--sharpe", help="逗号分隔的 Sharpe 列表")
    ap.add_argument("--batch", help="千寻批次号（从库读）")
    ap.add_argument("--db", default=r"C:\Users\onefr\WorkBuddy\2026-07-17-09-40-38\project026_AlphaMachine\data\alpha_machine.db",
                    help="千寻 alpha_machine.db 路径")
    ap.add_argument("--passed", type=int, help="通过提交检查的数量")
    ap.add_argument("--total", type=int, help="总回测数")
    ap.add_argument("--prev-mean", type=float, help="上一轮均值（对比）")
    ap.add_argument("--trend", help="逗号分隔的历史各轮均值（趋势追踪）")
    ap.add_argument("--json", action="store_true", help="输出 JSON")
    args = ap.parse_args()

    sharpe: list[float] = []
    exprs: list[str] = []
    if args.sharpe:
        sharpe = [float(x) for x in args.sharpe.split(",") if x.strip()]
    elif args.batch:
        sharpe, exprs = _load_from_db(args.db, args.batch)
        print(f"从库读取批次 {args.batch}：{len(sharpe)} 个 alpha")
    if not sharpe:
        print("无数据。用法：--sharpe 1.2,0.8,... 或 --batch Bxxxx --db <path>")
        return

    trend = [float(x) for x in args.trend.split(",")] if args.trend else None
    r = evaluate_batch(
        sharpe, passed=args.passed, total=args.total, expressions=exprs or None,
        prev_mean=args.prev_mean, trend_means=trend,
    )
    if args.json:
        print(json.dumps(r.detail, ensure_ascii=False, indent=1))
        return

    emoji = {"GREEN": "🟢", "YELLOW": "🟡", "RED": "🔴", "DEAD": "⚫"}
    print(f"\n{'='*50}")
    print(f"信号：{emoji.get(r.signal, '?')} {r.signal} ｜ DSI={r.dsi:.3f}")
    print(f"{'='*50}")
    print(f"样本 n={r.n}｜均值 {r.mean:.3f}｜最高 {r.max_sharpe:.3f}｜p={r.p_value:.4f}")
    print(f"显著性 {r.s_ttest:.2f}｜天花板 {r.s_ceiling:.2f}｜通过率下界 {r.pass_rate_lower:.2f}｜稳定性 {r.s_consist:.2f}")
    if r.family_coverage:
        print(f"算子族覆盖 {r.family_coverage} 种：{'、'.join(sorted(r.families))}")
    if r.bimodal:
        print("⚠️ 双峰分布：存在高分子群体")
    if r.guards_triggered:
        print(f"\n护栏触发：{len(r.guards_triggered)}")
        for g in r.guards_triggered:
            print(f"  - {g}")
    print(f"\n建议：{r.advice}")
    if args.prev_mean is not None:
        print(f"对比上轮：{r.mean:.3f} vs {args.prev_mean:.3f}")
    if trend and len(trend) >= 3:
        rho = _spearman_rho(trend)
        print(f"迭代趋势 rho={rho:.2f}：{'收敛' if rho>0.5 else '发散' if rho<-0.3 else '震荡'}")


if __name__ == "__main__":
    main()

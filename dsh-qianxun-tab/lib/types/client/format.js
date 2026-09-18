import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { LADDER_THRESHOLD, LADDER_HIGH_RISK, MARGIN_EPSILON, MARGIN_TIERS, PROD_CORR_DEAD_ZONE, PROD_DEAD_ZONE_FIELDS, PROD_FRESH_FIELDS, } from "./wq-eval.js";
import css from './QianxunTab.module.css';
/** 详情表按此顺序展示的指标列。 */
export const METRIC_KEYS = [
    { key: 'sharpe', label: 'sharpe' },
    { key: 'fitness', label: 'fitness' },
    { key: 'returns', label: 'ret%', pct: true },
    { key: 'turnover', label: 'to%', pct: true },
    { key: 'margin', label: 'margin' },
];
/** 运行中的状态集合（用于高亮/进度/控制按钮显隐）。 */
export const RUNNING_STATES = new Set(['running', 'pending', 'queued', 'scheduled', 'active']);
/**
 * 数值格式化：3 位有效数字、去尾随 0；`asPct` 时把小数比率 ×100 转百分比。
 * 百分比展示去掉尾随 0（如 0.5 -> 50%，0.1234 -> 12.3%）。
 */
export function fmt(v, asPct = false) {
    if (typeof v !== 'number' || Number.isNaN(v))
        return '—';
    if (asPct)
        return `${parseFloat((v * 100).toPrecision(3))}%`;
    return String(parseFloat(v.toPrecision(3)));
}
/** 是否运行中（用于控制按钮显隐与进度条）。 */
export function isRunning(state) {
    return state !== undefined && RUNNING_STATES.has(String(state).toLowerCase());
}
/** check 三色（+黄）徽章；无值返回空。 */
export function checkBadge(check) {
    if (check === null || check === undefined || check === '')
        return '';
    const cls = check === 'pass' ? 'bPass' : check === 'warn' ? 'bWarn' : check === 'fail' ? 'bFail' : 'bNone';
    return _jsx("span", { className: css[cls], children: check });
}
/** BRAIN 单 check 项 result → CSS 徽章类（BRAIN 用 PASS/FAIL/PENDING/WARNING）。 */
function checkItemResultClass(result) {
    if (result === null || result === undefined)
        return undefined;
    const r = String(result).toUpperCase();
    if (r === 'PASS')
        return css.bPass;
    if (r === 'WARNING' || r === 'WARN')
        return css.bWarn;
    if (r === 'FAIL')
        return css.bFail;
    return css.bNone; // PENDING / 其它
}
/** 单 check 项 result 徽章。 */
function checkItemBadge(result) {
    if (result === null || result === undefined || result === '')
        return '';
    const cls = checkItemResultClass(result);
    return cls ? _jsx("span", { className: cls, children: String(result).toLowerCase() }) : _jsx("span", { className: css.bNone, children: String(result).toLowerCase() });
}
/** 把 BRAIN check 项的 value/limit 显示为紧凑字符串。value 不存在则不渲染。 */
function renderCheckMeta(c) {
    const v = c.value;
    const l = c.limit;
    if (typeof v === 'number' && typeof l === 'number')
        return `${fmt(v)} / 限 ${fmt(l)}`;
    if (typeof v === 'number')
        return fmt(v);
    return '';
}
/**
 * 渲染单 alpha 的详细 check 列表。
 * - 高亮 PROD_CORRELATION（最常用筛选项）
 * - 用三色徽章标 PASS/FAIL/WARNING/PENDING
 * - 顶部 summary：X 通过 / Y 失败 / Z 待定 / W 警告
 */
export function renderChecksList(checks) {
    if (checks.length === 0) {
        return (_jsxs("div", { className: css.empty, children: [_jsx("span", { className: css.emptyIcon, children: "\uD83D\uDDC2\uFE0F" }), _jsx("span", { children: "\u672C alpha \u6CA1\u6709 check \u6570\u636E" })] }));
    }
    let pass = 0, fail = 0, warn = 0, pending = 0;
    for (const c of checks) {
        const r = String(c.result ?? '').toUpperCase();
        if (r === 'PASS')
            pass++;
        else if (r === 'FAIL')
            fail++;
        else if (r === 'WARNING' || r === 'WARN')
            warn++;
        else
            pending++;
    }
    // 排序：FAIL → WARNING → PENDING → PASS（重点在上）；PROD_CORRELATION 置顶
    const order = { FAIL: 0, WARNING: 1, WARN: 1, PENDING: 2, PASS: 3 };
    const sorted = [...checks].sort((a, b) => {
        if (a.name === 'PROD_CORRELATION')
            return -1;
        if (b.name === 'PROD_CORRELATION')
            return 1;
        const oa = order[String(a.result ?? '').toUpperCase()] ?? 4;
        const ob = order[String(b.result ?? '').toUpperCase()] ?? 4;
        return oa - ob;
    });
    return (_jsxs("div", { className: css.checksPanel, children: [_jsxs("div", { className: css.checksSummary, children: [_jsxs("span", { className: css.bPass, children: [pass, " pass"] }), fail > 0 && _jsxs("span", { className: css.bFail, children: [fail, " fail"] }), warn > 0 && _jsxs("span", { className: css.bWarn, children: [warn, " warn"] }), pending > 0 && _jsxs("span", { className: css.bNone, children: [pending, " pending"] }), _jsx("span", { className: css.spacer }), _jsxs("span", { className: css.checksTotal, children: ["\u5171 ", checks.length, " \u9879"] })] }), _jsx("div", { className: css.checksList, children: sorted.map((c, i) => {
                    const isPC = c.name === 'PROD_CORRELATION';
                    const meta = renderCheckMeta(c);
                    return (_jsxs("div", { className: `${css.checkItem}${isPC ? ' ' + css.checkItemHighlight : ''}`, children: [_jsx("span", { className: css.checkItemName, title: c.name, children: c.name }), _jsx("span", { className: css.checkItemMeta, children: meta }), _jsx("span", { className: css.checkItemResult, children: checkItemBadge(c.result) })] }, `${c.name}-${i}`));
                }) })] }));
}
/** 渲染全量逐条结果表。results 为空时给友好空态。
 * 提供 actions 时，每行末尾追加最多 3 个动作按钮。 */
export function renderMetricsTable(results, actions) {
    if (results === undefined || results.length === 0) {
        return (_jsxs("div", { className: css.empty, children: [_jsx("span", { className: css.emptyIcon, children: "\uD83D\uDDC2\uFE0F" }), _jsx("span", { children: "\u672C\u6279\u6B21\u6682\u65E0\u9010\u6761\u7ED3\u679C" })] }));
    }
    const showActions = actions !== undefined &&
        (actions.onCheck !== undefined || actions.onProdCorr !== undefined || actions.onLocalSelf !== undefined);
    return (_jsx("div", { className: css.tableWrap, children: _jsxs("table", { className: css.table, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "alpha_id" }), _jsx("th", { children: "\u8868\u8FBE\u5F0F" }), METRIC_KEYS.map(m => (_jsx("th", { children: m.label }, m.key))), _jsx("th", { children: "check" }), _jsx("th", { children: "\u72B6\u6001" }), showActions && _jsx("th", {})] }) }), _jsx("tbody", { children: results.map(result => {
                        const sharpe = result.metrics?.sharpe;
                        const sharpeCls = typeof sharpe === 'number'
                            ? sharpe >= 0 ? 'valPos' : 'valNeg'
                            : undefined;
                        const alphaId = result.alpha_id;
                        const canAct = typeof alphaId === 'string' && alphaId !== '';
                        return (_jsxs("tr", { children: [_jsx("td", { className: css.cellAlpha, children: alphaId ?? '—' }), _jsx("td", { className: css.cellExpr, title: result.expression ?? '', children: result.expression ?? '—' }), METRIC_KEYS.map(m => (_jsx("td", { className: `${css.cellNum}${m.key === 'sharpe' && sharpeCls ? ' ' + css[sharpeCls] : ''}`, children: fmt(result.metrics?.[m.key], m.pct) }, m.key))), _jsx("td", { children: checkBadge(result.metrics?.check_status) }), _jsx("td", { className: css.cellStatus, children: result.status ?? '—' }), showActions && (_jsx("td", { className: css.cellAction, children: canAct ? (_jsxs(_Fragment, { children: [actions?.onCheck !== undefined && (_jsx("button", { type: "button", className: css.iconBtn, title: "\u67E5\u770B BRAIN \u8BE6\u7EC6 check", "aria-label": "check", onClick: () => actions.onCheck?.(alphaId), children: "\uD83D\uDD0D" })), actions?.onProdCorr !== undefined && (_jsx("button", { type: "button", className: css.iconBtn, title: "\u62C9\u53D6\u771F prod correlation\uFF08\u7ED5\u8FC7 PENDING\uFF09", "aria-label": "prod corr", onClick: () => actions.onProdCorr?.(alphaId), children: "\uD83D\uDCC8" })), actions?.onLocalSelf !== undefined && (_jsx("button", { type: "button", className: css.iconBtn, title: "\u672C\u5730\u6838\u5BF9 SELF_CORRELATION\uFF08\u62C9 PnL + JS \u7B97 Pearson\uFF09", "aria-label": "local self", onClick: () => actions.onLocalSelf?.(alphaId), children: "\uD83D\uDCD0" }))] })) : (_jsx("span", { className: css.cellActionNone, title: "\u8BE5 alpha \u7F3A\u5C11 alpha_id\uFF0C\u65E0\u6CD5 check", children: "\u2014" })) }))] }, result.idx));
                    }) })] }) }));
}
// ============================================================
// 稳健性评估 —— 移植自 wq-alpha-research skill
// ============================================================
/** margin = (0.7 - prod_corr)，并查表得到 tier 标签。 */
export function classifyMargin(prodCorr) {
    const m = MARGIN_EPSILON;
    if (typeof prodCorr !== 'number' || Number.isNaN(prodCorr)) {
        return { label: 'no_data', margin: 0, tier: 'no_data' };
    }
    const margin = Math.max(0, PROD_CORR_DEAD_ZONE - prodCorr + m);
    let tier = 'tight';
    for (const t of MARGIN_TIERS) {
        if (margin >= t.threshold) {
            tier = t.label;
            break;
        }
    }
    return { label: tier, margin, tier };
}
/** 词边界匹配：避免 "ad" 之类短字段名误伤 adjusted/load/spread/trading 等。 */
function matchesWithWordBoundary(haystack, needle) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![A-Za-z0-9_])$${escaped}(?![A-Za-z0-9_])`);
    return re.test(haystack);
}
/** 表达式里包含已知 prod-fresh 字段？ */
export function isProdFreshField(expr) {
    if (!expr)
        return { hit: false };
    for (const { field } of PROD_FRESH_FIELDS) {
        if (matchesWithWordBoundary(expr, field))
            return { hit: true, field };
    }
    return { hit: false };
}
/** 表达式里包含已知 prod 雷区字段？ */
export function isDeadZoneField(expr) {
    if (!expr)
        return { hit: false };
    for (const { field, note } of PROD_DEAD_ZONE_FIELDS) {
        if (matchesWithWordBoundary(expr, field))
            return { hit: true, field, note };
    }
    return { hit: false };
}
/** IS_LADDER_SHARPE 风险分级（避免给必败 alpha 浪费 submission check）。 */
export function classifyLadderRisk(v) {
    if (typeof v !== 'number' || Number.isNaN(v))
        return 'no_data';
    if (v < LADDER_THRESHOLD)
        return 'certain_fail';
    if (v < LADDER_HIGH_RISK)
        return 'high';
    if (v < 1.85)
        return 'medium';
    return 'low';
}
// ============================================================
// 本地 SELF_CORRELATION —— 浏览器内 Pearson（不需 numpy）
// 参考 xiegengcai/self_correlation.py 设计：日期对齐 + Pearson on raw daily PnL
// ============================================================
/** 单组 PnL 的差分（每日盈亏）—— 用 PnL 增量做相关，更接近 BRAIN 的指标。 */
function pnlToReturns(records) {
    const out = [];
    for (let i = 1; i < records.length; i++) {
        const cur = records[i]?.pnl;
        const prev = records[i - 1]?.pnl;
        if (typeof cur === 'number' && typeof prev === 'number' && Number.isFinite(cur) && Number.isFinite(prev)) {
            out.push(cur - prev);
        }
    }
    return out;
}
/** Pearson correlation of two numeric series. Returns NaN on insufficient data. */
export function pearson(xs, ys) {
    const n = Math.min(xs.length, ys.length);
    if (n < 2)
        return NaN;
    let sumX = 0;
    let sumY = 0;
    for (let i = 0; i < n; i++) {
        sumX += xs[i] ?? 0;
        sumY += ys[i] ?? 0;
    }
    const meanX = sumX / n;
    const meanY = sumY / n;
    let num = 0;
    let denomX = 0;
    let denomY = 0;
    for (let i = 0; i < n; i++) {
        const dx = (xs[i] ?? 0) - meanX;
        const dy = (ys[i] ?? 0) - meanY;
        num += dx * dy;
        denomX += dx * dx;
        denomY += dy * dy;
    }
    const denom = Math.sqrt(denomX * denomY);
    return denom === 0 ? NaN : num / denom;
}
/** 用每日 returns（PnL 增量）算与候选集的相关性，返回 max / min / per-candidate。 */
export function computeLocalSelfCorr(target, candidates) {
    // 把 target 转 returns，一次算
    const targetReturns = pnlToReturns(target);
    const targetDays = target.length;
    const perCandidate = [];
    let max = null;
    let min = null;
    for (const c of candidates) {
        const candReturns = pnlToReturns(c.records);
        // 对齐：取较短的，用索引对齐而非日期对齐（PnL 单调日序）
        const n = Math.min(targetReturns.length, candReturns.length);
        if (n < 30) {
            // 太少样本，标记为 null（不参与 max/min）
            perCandidate.push({ alphaId: c.alphaId, corr: null, overlapDays: n });
            continue;
        }
        const corr = pearson(targetReturns.slice(0, n), candReturns.slice(0, n));
        if (!Number.isNaN(corr)) {
            perCandidate.push({ alphaId: c.alphaId, corr, overlapDays: n });
            if (max === null || corr > max)
                max = corr;
            if (min === null || corr < min)
                min = corr;
        }
        else {
            perCandidate.push({ alphaId: c.alphaId, corr: null, overlapDays: n });
        }
    }
    return { targetReturns, targetDays, perCandidate, max, min };
}
//# sourceMappingURL=format.js.map
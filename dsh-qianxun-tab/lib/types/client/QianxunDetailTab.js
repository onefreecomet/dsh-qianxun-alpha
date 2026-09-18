import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 千寻批次详情 tab —— 展示某一批次的完整逐条回测结果。
 *
 * 由列表 tab（QianxunTab）通过 `ctx.betterSidebar.openTab({ type:'qianxun-detail',
 * title, meta:{ batchNo } })` 打开。`props.tab.meta.batchNo` 标识要展示的批次；
 * 无 batchNo 时显示“未指定批次”。5s 轮询（仅 visible 时）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { actOnBatch, getActiveAlphas, getAlphaCheck, getAlphaProdCorr, getBackfillStatus, getBatchResult, getCachedPnl, getPnlCacheStatus, resumeBatch, startBackfillPnls, QIANXUN_BASE, } from "./qianxun.js";
import { classifyLadderRisk, classifyMargin, computeLocalSelfCorr, isDeadZoneField, isProdFreshField, isRunning, renderChecksList, renderMetricsTable, } from "./format.js";
import { PROD_CORR_DEAD_ZONE, } from "./wq-eval.js";
import { AlphaPoolCard } from "./AlphaPoolCard.js";
import css from './QianxunTab.module.css';
/** 从 tab meta 读取要展示的批次号。 */
function batchNoFromTab(props) {
    const meta = props.tab?.meta;
    const raw = meta?.batchNo;
    return typeof raw === 'string' && raw !== '' ? raw : undefined;
}
export function QianxunDetailTab(props) {
    const { visible } = props;
    const batchNo = batchNoFromTab(props);
    const [detail, setDetail] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [jsonView, setJsonView] = useState(null);
    // 单 alpha 的 BRAIN 详细 check 面板状态
    const [checkAlphaId, setCheckAlphaId] = useState(null);
    const [checks, setChecks] = useState(null);
    const [checkLoading, setCheckLoading] = useState(false);
    const [checkError, setCheckError] = useState(null);
    // 单 alpha 的 PROD_CORRELATION 拉取状态（按行）
    const [prodCorrAlphaId, setProdCorrAlphaId] = useState(null);
    const [prodCorr, setProdCorr] = useState(null);
    const [prodCorrLoading, setProdCorrLoading] = useState(false);
    const [prodCorrError, setProdCorrError] = useState(null);
    // 单 alpha 的本地 SELF_CORRELATION 核对（PnL 下载 + Pearson）
    const [localAlphaId, setLocalAlphaId] = useState(null);
    const [localLoading, setLocalLoading] = useState(false);
    const [localError, setLocalError] = useState(null);
    const [localResult, setLocalResult] = useState(null);
    // 本地 PnL 缓存状态（侧边栏 header 展示用）
    const [cacheStatus, setCacheStatus] = useState(null);
    // BRAIN ACTIVE alpha_ids（与 BRAIN SELF_CORRELATION 真实对比集同口径）
    const [activeAlphas, setActiveAlphas] = useState(null);
    // PnL 批量回填任务状态
    const [backfill, setBackfill] = useState(null);
    const [backfillJobId, setBackfillJobId] = useState(null);
    const refreshCacheStatus = useCallback(async () => {
        try {
            const [s, a] = await Promise.all([getPnlCacheStatus(), getActiveAlphas()]);
            setCacheStatus(s);
            setActiveAlphas(a);
        }
        catch {
            // 静默失败，不影响主流程
        }
    }, []);
    // 加载 + 可见时 60s 刷新（ACTIVE 5 min 缓存，前端多刷也无意义，60s 足矣）
    useEffect(() => {
        if (!visible)
            return;
        void refreshCacheStatus();
        const timer = window.setInterval(() => { void refreshCacheStatus(); }, 60000);
        return () => window.clearInterval(timer);
    }, [visible, refreshCacheStatus]);
    /** 启动回填任务：异步，不阻塞 UI。完成后自动刷新缓存状态。 */
    const doStartBackfill = useCallback(async () => {
        try {
            const start = await startBackfillPnls({});
            setBackfillJobId(start.job_id);
            setBackfill({
                status: 'running',
                total: start.total,
                done: 0,
                errors: [],
                region: null,
            });
        }
        catch (cause) {
            // 启动失败也静默
            void cause;
        }
    }, []);
    // 回填任务运行时：每 2 s 轮询一次进度，结束/失败时停
    useEffect(() => {
        if (backfillJobId === null)
            return;
        if (backfill === null || backfill.status === 'running') {
            const timer = window.setInterval(async () => {
                try {
                    const s = await getBackfillStatus(backfillJobId);
                    setBackfill(s);
                    if (s.status !== 'running') {
                        // 任务结束：刷新缓存 + 清 job_id
                        void refreshCacheStatus();
                        setTimeout(() => setBackfillJobId(null), 2000);
                    }
                }
                catch {
                    // 单次轮询失败不影响下一轮
                }
            }, 2000);
            return () => window.clearInterval(timer);
        }
    }, [backfillJobId, backfill?.status, refreshCacheStatus]);
    const load = useCallback(async () => {
        if (batchNo === undefined)
            return;
        setLoading(true);
        setError(null);
        try {
            const d = await getBatchResult(batchNo);
            setDetail(d);
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
        finally {
            setLoading(false);
        }
    }, [batchNo]);
    // 轮询：visible 时立即加载 + 每 5s 刷新。
    useEffect(() => {
        if (!visible || batchNo === undefined)
            return;
        void load();
        const timer = window.setInterval(() => {
            void load();
        }, 5000);
        return () => window.clearInterval(timer);
    }, [visible, batchNo, load]);
    // 从隐藏回到可见时补一次刷新。
    const prevVisible = useRef(null);
    useEffect(() => {
        if (visible && prevVisible.current === false)
            void load();
        prevVisible.current = visible;
    }, [visible, load]);
    const runAction = useCallback(async (action) => {
        if (batchNo === undefined)
            return;
        setBusy(true);
        try {
            await action();
            await load();
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
        finally {
            setBusy(false);
        }
    }, [batchNo, load]);
    const onAct = (action) => () => runAction(() => actOnBatch(batchNo, action));
    const onResumeBack = () => () => runAction(() => resumeBatch(batchNo));
    const doViewResult = async () => {
        if (batchNo === undefined)
            return;
        try {
            const d = await getBatchResult(batchNo);
            setJsonView(JSON.stringify(d, null, 2));
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };
    /** 触发单 alpha 的 BRAIN check 拉取。*/
    const doCheckAlpha = useCallback(async (alphaId) => {
        setCheckAlphaId(alphaId);
        setCheckLoading(true);
        setCheckError(null);
        setChecks(null);
        try {
            const resp = await getAlphaCheck(alphaId);
            // BRAIN 返回结构：{"is": {"checks": [...]}}。取 is.checks。
            const list = resp.is?.checks ?? [];
            setChecks(list);
        }
        catch (cause) {
            setCheckError(cause instanceof Error ? cause.message : String(cause));
        }
        finally {
            setCheckLoading(false);
        }
    }, []);
    const closeCheckPanel = useCallback(() => {
        setCheckAlphaId(null);
        setChecks(null);
        setCheckError(null);
        setCheckLoading(false);
    }, []);
    /** 拉单 alpha 的 prod correlation 数值（不死等 check）。 */
    const doFetchProdCorr = useCallback(async (alphaId) => {
        setProdCorrAlphaId(alphaId);
        setProdCorrLoading(true);
        setProdCorrError(null);
        setProdCorr(null);
        try {
            const r = await getAlphaProdCorr(alphaId);
            setProdCorr(r);
        }
        catch (cause) {
            setProdCorrError(cause instanceof Error ? cause.message : String(cause));
        }
        finally {
            setProdCorrLoading(false);
        }
    }, []);
    const closeProdCorrPanel = useCallback(() => {
        setProdCorrAlphaId(null);
        setProdCorr(null);
        setProdCorrError(null);
        setProdCorrLoading(false);
    }, []);
    /** 本地核对 SELF_CORRELATION：与本地 PnL 缓存 ∩ ACTIVE 比（与 BRAIN 真实口径对齐）。
     * 候选集 = `cache ∩ ACTIVE - {self}`：
     * - cache = 已下载 PnL 的所有 alpha（包含已退出 active 的）
     * - ACTIVE = BRAIN 当前活跃组合（与 SELF_CORRELATION 同口径）
     * - 交集 = BRAIN 实际对比的子集
     * 首次访问会触发 qianxund 写缓存；二次秒出。 */
    const doLocalSelfCorr = useCallback(async (targetAlphaId) => {
        setLocalAlphaId(targetAlphaId);
        setLocalLoading(true);
        setLocalError(null);
        setLocalResult(null);
        try {
            // 0. 拉最新 ACTIVE 列表（防 TTL 过期——缓存是 5 min，本地核对前刷新更稳）
            let active = activeAlphas;
            if (active === null) {
                active = await getActiveAlphas();
                setActiveAlphas(active);
            }
            const activeSet = new Set(active.ids);
            // 1. 取目标 PnL（qianxund 自动 fallback BRAIN + 写盘）
            const targetResp = await getCachedPnl(targetAlphaId);
            // 2. 候选集 = 本地缓存 ∩ ACTIVE（除自己）
            const cache = await getPnlCacheStatus();
            const otherIds = cache.items
                .map(it => it.alpha_id)
                .filter(aid => aid !== targetAlphaId && activeSet.has(aid));
            if (otherIds.length === 0) {
                const activeCachedCount = cache.items.filter(it => activeSet.has(it.alpha_id)).length;
                setLocalError(activeCachedCount === 0
                    ? '本地 PnL 缓存里没有任何 ACTIVE 的 alpha——需要先把 ACTIVE alpha 的 PnL 缓存到本地'
                    : '除自己外，缓存里没有可对比的 ACTIVE alpha');
                return;
            }
            // 3. 候选 PnL 都走本地缓存
            const candResps = await Promise.all(otherIds.map(async (aid) => {
                try {
                    const p = await getCachedPnl(aid);
                    return { alphaId: aid, records: p.records };
                }
                catch {
                    return { alphaId: aid, records: [] };
                }
            }));
            const validCands = candResps.filter(c => c.records.length > 0);
            if (validCands.length === 0) {
                setLocalError('候选 PnL 全部为空，无法计算');
                return;
            }
            // 4. 浏览器内算 Pearson
            const result = computeLocalSelfCorr(targetResp.records, validCands);
            setLocalResult(result);
            // 5. 刷新缓存状态（新增了目标 alpha 的条目）
            void refreshCacheStatus();
        }
        catch (cause) {
            setLocalError(cause instanceof Error ? cause.message : String(cause));
        }
        finally {
            setLocalLoading(false);
        }
    }, [activeAlphas, refreshCacheStatus]);
    const closeLocalPanel = useCallback(() => {
        setLocalAlphaId(null);
        setLocalResult(null);
        setLocalError(null);
        setLocalLoading(false);
    }, []);
    const doDownloadResult = async () => {
        if (batchNo === undefined)
            return;
        try {
            const d = await getBatchResult(batchNo);
            const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${batchNo}-result.json`;
            a.click();
            URL.revokeObjectURL(url);
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    };
    // 无批次号：本页仍要能用 —— 顶部那句死路提示换成 Alpha 自选池（存 alpha_id 的地方）。
    if (batchNo === undefined) {
        return (_jsxs("div", { className: css.root, children: [_jsxs("header", { className: css.header, children: [_jsx("span", { className: css.titleIcon, children: "\uD83D\uDD0E" }), _jsx("span", { className: css.title, children: "\u5343\u5BFB\u7ED3\u679C" }), _jsx("span", { className: css.spacer }), _jsx("button", { type: "button", className: css.iconBtn, onClick: () => { void refreshCacheStatus(); }, title: "\u5237\u65B0", "aria-label": "\u5237\u65B0", children: "\u27F3" })] }), _jsxs("div", { className: css.body, children: [_jsx(AlphaPoolCard, { visible: visible }), _jsx("div", { className: css.emptySub, children: "\u60F3\u770B\u67D0\u4E2A\u6279\u6B21\u7684\u9010\u6761\u7ED3\u679C\uFF1A\u56DE\u300C\u5343\u5BFB\u56DE\u6D4B\u300D\u5217\u8868\uFF0C\u70B9\u8BE5\u6279\u6B21\u7684\u300C\u8BE6\u60C5\u300D\u6309\u94AE\u3002" }), _jsxs("div", { className: css.statusFooter, children: ["\u5F15\u64CE ", QIANXUN_BASE] })] })] }));
    }
    const running = detail !== null && isRunning(detail.state);
    const done = Math.min(detail?.done ?? 0, detail?.total ?? detail?.done ?? 0);
    const total = detail?.total ?? 0;
    const pct = total > 0 ? Math.round((done / total) * 100) : detail ? 100 : 0;
    /** 稳健性快评卡：基于已加载的逐条结果（无需新 API）。
     * 检查项：
     *  1. IS_LADDER_SHARPE 风险（避免给必败 alpha 浪费 check）
     *  2. prod_fresh 字段加分（薄 margin 但字段新 → 仍可推）
     *  3. 雷区字段告警（prod_corr >= 0.70 概率大）
     */
    const renderRobustnessCard = () => {
        const results = detail?.results ?? [];
        if (results.length === 0)
            return null;
        const issues = [];
        const freshHits = [];
        for (const r of results) {
            const ladder = r.metrics?.sharpe;
            const ladderRisk = classifyLadderRisk(typeof ladder === 'number' ? ladder : null);
            if (ladderRisk === 'certain_fail') {
                issues.push({
                    alphaIdx: r.idx,
                    tag: 'certain_fail',
                    msg: `idx ${r.idx} LADDER 必败 (sharpe=${ladder})`,
                });
            }
            const fresh = isProdFreshField(r.expression ?? null);
            if (fresh.hit && fresh.field !== undefined) {
                freshHits.push({ alphaIdx: r.idx, field: fresh.field });
            }
            const dead = isDeadZoneField(r.expression ?? null);
            if (dead.hit && dead.field !== undefined) {
                issues.push({
                    alphaIdx: r.idx,
                    tag: 'dead_zone',
                    msg: `idx ${r.idx} 字段 ${dead.field}${dead.note !== undefined ? ' · ' + dead.note : ''}`,
                });
            }
        }
        const hasIssues = issues.length > 0;
        const hasFresh = freshHits.length > 0;
        if (!hasIssues && !hasFresh)
            return null;
        return (_jsxs("div", { className: css.card, children: [_jsxs("div", { className: css.cardHead, children: [_jsx("span", { className: css.cardIcon, children: "\uD83D\uDEE1\uFE0F" }), _jsxs("span", { className: css.cardTitle, children: ["\u7A33\u5065\u6027\u5FEB\u8BC4\uFF08", results.length, " \u6761\uFF09"] })] }), hasIssues && (_jsx("div", { className: css.issueList, children: issues.map((it, i) => (_jsxs("div", { className: `${css.issueRow} ${it.tag === 'certain_fail' ? css.issueDanger : css.issueWarn}`, children: [_jsx("span", { className: css.issueTag, children: it.tag === 'certain_fail' ? '必败' : '雷区' }), _jsx("span", { className: css.issueMsg, children: it.msg })] }, i))) })), hasFresh && (_jsxs("div", { className: css.freshList, children: [_jsxs("div", { className: css.metaLine, children: [_jsx("span", { className: css.freshTag, children: "prod-fresh" }), freshHits.length, " \u6761\u5B57\u6BB5\u65B0\uFF08prod \u4FE1\u53F7\u672A\u9971\u548C\uFF09\uFF1A"] }), freshHits.map((f, i) => (_jsx("div", { className: css.freshRow, children: _jsx("code", { className: css.freshField, children: f.field }) }, i)))] })), _jsxs("div", { className: css.metaLine, children: ["\u70B9\u51FB\u4E0B\u65B9\u4EFB\u4E00 alpha \u884C\u7684 \uD83D\uDD0D \u770B BRAIN \u8BE6\u7EC6 checks\uFF1B\u70B9\u51FB \uD83D\uDCC8 \u770B\u771F prod_corr\uFF1B \u70B9\u51FB \uD83D\uDCD0 ", _jsx("b", { children: "\u672C\u5730" }), "\u7ACB\u5373\u7B97 SELF_CORRELATION\uFF08\u65E0\u987B\u7B49 BRAIN PENDING\uFF09\u3002"] })] }));
    };
    /** 单 alpha 的 PROD_CORRELATION 拉取面板。 */
    const renderProdCorrPanel = () => {
        if (prodCorrAlphaId === null)
            return null;
        const max = prodCorr?.max ?? null;
        const min = prodCorr?.min ?? null;
        const deadZone = max !== null && max >= PROD_CORR_DEAD_ZONE;
        const tier = max !== null ? classifyMargin(max) : null;
        return (_jsxs("div", { className: css.card, children: [_jsxs("div", { className: css.cardHead, children: [_jsx("span", { className: css.cardIcon, children: "\uD83D\uDCC8" }), _jsxs("span", { className: css.cardTitle, children: ["prod correlation \u00B7 ", prodCorrAlphaId] }), _jsx("span", { className: css.spacer }), _jsx("button", { type: "button", className: css.iconBtn, onClick: closeProdCorrPanel, title: "\u5173\u95ED", "aria-label": "\u5173\u95ED prod corr \u9762\u677F", children: "\u2715" })] }), prodCorrLoading && _jsx("div", { className: css.metaLine, children: "\u62C9\u53D6\u4E2D\u2026\uFF08BRAIN \u9996\u6B21\u5E38\u7A7A\uFF0C\u5F15\u64CE\u5DF2\u81EA\u52A8\u91CD\u8BD5 3 \u6B21\uFF09" }), prodCorrError !== null && (_jsx("div", { className: `${css.msg} ${css.msgErr}`, children: prodCorrError })), prodCorr !== null && !prodCorrLoading && prodCorrError === null && (_jsxs(_Fragment, { children: [_jsxs("div", { className: css.prodCorrRow, children: [_jsx("span", { className: css.prodCorrLabel, children: "max" }), _jsx("span", { className: `${css.prodCorrValue} ${deadZone ? css.valNeg : css.valPos}`, children: max === null ? '—' : max.toFixed(4) }), _jsx("span", { className: css.prodCorrLabel, children: "min" }), _jsx("span", { className: css.prodCorrValue, children: min === null ? '—' : min.toFixed(4) }), _jsx("span", { className: css.spacer }), tier !== null && (_jsxs("span", { className: `${css.tierBadge} ${css[`tier_${tier.label}`] ?? ''}`, children: [tier.label, " \u00B7 margin ", tier.margin.toFixed(4)] }))] }), deadZone && (_jsxs("div", { className: `${css.msg} ${css.msgErr}`, children: ["\u26A0\uFE0F max prod_corr \u2265 ", PROD_CORR_DEAD_ZONE, " \u6B7B\u533A\u7EBF\uFF0C\u6B64 alpha \u5927\u6982\u7387 submission FAIL"] })), !deadZone && max !== null && (_jsxs("div", { className: `${css.msg} ${css.msgOk}`, children: ["\u2713 \u5B89\u5168\u8FB9\u9645 ", tier?.margin.toFixed(4) ?? '?', "\uFF08\u6B7B\u533A\u7EBF ", PROD_CORR_DEAD_ZONE, "\uFF09"] })), _jsxs("div", { className: css.metaLine, children: ["\u5019\u9009\u96C6\uFF1A", prodCorr.records.length, " \u6761"] })] }))] }));
    };
    /** 单 alpha 的本地 SELF_CORRELATION 核对面板。 */
    const renderLocalPanel = () => {
        if (localAlphaId === null)
            return null;
        return (_jsxs("div", { className: css.card, children: [_jsxs("div", { className: css.cardHead, children: [_jsx("span", { className: css.cardIcon, children: "\uD83D\uDCD0" }), _jsxs("span", { className: css.cardTitle, children: ["\u672C\u5730 SELF_CORRELATION \u00B7 ", localAlphaId] }), _jsx("span", { className: css.spacer }), _jsx("button", { type: "button", className: css.iconBtn, onClick: closeLocalPanel, title: "\u5173\u95ED", "aria-label": "\u5173\u95ED\u672C\u5730\u6838\u5BF9\u9762\u677F", children: "\u2715" })] }), localLoading && (_jsx("div", { className: css.metaLine, children: "\u4E0B\u8F7D PnL \u5E76\u7B97 Pearson\u2026\uFF08\u6BCF\u591A 1 \u4E2A\u5019\u9009 +1 \u6B21\u8BF7\u6C42\uFF1B\u901A\u5E38 ~3s/\u6279\uFF09" })), localError !== null && (_jsx("div", { className: `${css.msg} ${css.msgErr}`, children: localError })), localResult !== null && !localLoading && localError === null && (_jsxs(_Fragment, { children: [_jsxs("div", { className: css.prodCorrRow, children: [_jsx("span", { className: css.prodCorrLabel, children: "\u5019\u9009\u6570" }), _jsx("span", { className: css.prodCorrValue, children: localResult.perCandidate.length }), _jsx("span", { className: css.prodCorrLabel, children: "target \u65E5\u6570" }), _jsx("span", { className: css.prodCorrValue, children: localResult.targetDays }), _jsx("span", { className: css.spacer }), localResult.max !== null && (_jsxs("span", { className: `${css.tierBadge} ${localResult.max >= PROD_CORR_DEAD_ZONE ? css.tier_tight : ''}`, children: ["max = ", localResult.max.toFixed(4)] }))] }), _jsx("div", { className: css.checksList, children: localResult.perCandidate.map((c, i) => {
                                const v = c.corr;
                                const isDead = v !== null && v !== undefined && v >= PROD_CORR_DEAD_ZONE;
                                return (_jsxs("div", { className: css.checkItem, children: [_jsxs("span", { className: css.checkItemName, title: c.alphaId, children: [c.alphaId.slice(0, 14), c.alphaId.length > 14 ? '…' : ''] }), _jsxs("span", { className: css.checkItemMeta, children: [c.overlapDays, "d \u5BF9\u9F50"] }), _jsx("span", { className: css.checkItemResult, children: v === null || v === undefined ? (_jsx("span", { className: css.bNone, children: "n/a" })) : isDead ? (_jsx("span", { className: css.bFail, children: v.toFixed(3) })) : (_jsx("span", { className: css.bPass, children: v.toFixed(3) })) })] }, i));
                            }) }), _jsx("div", { className: css.metaLine, children: "BRAIN SELF_CORRELATION \u8FD8 PENDING \u65F6\u672C\u9762\u677F\u7ACB\u5373\u53EF\u8BFB\uFF1BPASS \u540E\u4E24\u8005\u5DEE\u5F02 \u2264 0.05 \uFF08\u672C\u5730 = raw daily PnL \u589E\u91CF Pearson\uFF1BBRAIN = 4-year rolling Pearson\uFF09\u3002" })] }))] }));
    };
    return (_jsxs("div", { className: css.root, children: [_jsxs("header", { className: css.header, children: [_jsx("span", { className: css.titleIcon, children: "\uD83D\uDD2C" }), _jsxs("span", { className: css.title, children: [batchNo, " \u7ED3\u679C"] }), _jsxs("span", { className: css.cacheBadge, title: cacheStatus === null
                            ? 'PnL 缓存加载中…'
                            : `本地 PnL 缓存：${cacheStatus.cache_dir}\n` +
                                `· 共 ${cacheStatus.count} 个 alpha · ${(cacheStatus.total_bytes / 1024).toFixed(0)} KB\n` +
                                (activeAlphas !== null
                                    ? `· 🟢 ACTIVE（与 BRAIN 同口径）${activeAlphas.count} 个\n` +
                                        `· SELF_CORRELATION 对比基线 = 缓存 ∩ ACTIVE`
                                    : ''), children: ["\uD83D\uDCE6 ", cacheStatus === null
                                ? '缓存…'
                                : `${cacheStatus.count} 个`, activeAlphas !== null && (_jsxs("span", { className: css.cacheBadgeActive, children: ["\u00B7 \uD83D\uDFE2 ", activeAlphas.count, " ACTIVE"] })), backfill !== null && backfill.status === 'running' && (_jsxs("span", { className: css.cacheBadgeBackfill, children: ["\u00B7 \uD83D\uDD04 ", backfill.done, "/", backfill.total] })), backfill !== null && backfill.status === 'partial' && (_jsxs("span", { className: css.cacheBadgePartial, title: "\u90E8\u5206\u5931\u8D25\uFF0C\u53EF\u91CD\u8BD5", children: ["\u00B7 \u26A0\uFE0F \u90E8\u5206 ", backfill.done, "/", backfill.total] })), backfill !== null && backfill.status === 'captcha_blocked' && (_jsx("span", { className: css.cacheBadgeCaptcha, title: backfill.stopped_reason ?? 'BRAIN 触发人机验证', children: "\u00B7 \uD83E\uDD16 captcha" }))] }), _jsx("button", { type: "button", className: css.backfillBtn, onClick: () => { void doStartBackfill(); }, disabled: backfill?.status === 'running', title: backfill?.status === 'running'
                            ? `同步中：${backfill.done}/${backfill.total}`
                            : '从 BRAIN 拉取当前 ACTIVE 列表里所有未缓存的 PnL 存到本地（多次点击可累积）', children: backfill?.status === 'running' ? '🔄 同步中…' : '🔄 同步 ACTIVE' }), _jsx("span", { className: css.spacer }), _jsx("span", { className: `${css.dot} ${isRunning(detail?.state) ? css.dotRunning : detail?.state === 'error' ? css.dotError : css.dotOk}` }), _jsx("button", { type: "button", className: css.iconBtn, onClick: () => {
                            void load();
                        }, title: "\u5237\u65B0", "aria-label": "\u5237\u65B0", children: "\u27F3" })] }), _jsxs("div", { className: css.body, children: [_jsx(AlphaPoolCard, { visible: visible, onInspect: alphaId => { void doCheckAlpha(alphaId); } }), error !== null && (_jsxs("div", { className: css.error, role: "alert", children: [error, _jsx("button", { type: "button", className: css.retryBtn, onClick: () => void load(), children: "\u91CD\u8BD5" })] })), detail === null && error === null && (_jsxs("div", { className: css.empty, children: [_jsx("span", { className: css.emptyIcon, children: "\u23F3" }), _jsx("span", { children: loading ? '加载中…' : '等待加载…' })] })), detail !== null && (_jsxs(_Fragment, { children: [_jsxs("div", { className: css.summaryCard, children: [_jsxs("div", { className: css.summaryRow, children: [_jsx("span", { className: css.batchId, children: batchNo }), _jsx("span", { className: `${css.badge} ${running ? css.badgeRunning : detail.state === 'error' ? css.badgeError : css.badgeDone}`, children: detail.state ?? '—' }), detail.name !== undefined && detail.name !== null && detail.name !== '' && (_jsx("span", { className: css.summaryName, children: detail.name })), _jsx("span", { className: css.spacer }), _jsxs("span", { className: css.summaryMeta, children: ["\u5DF2\u6D4B ", done, "/", total] })] }), total > 0 && (_jsxs("div", { className: css.progressTrack, children: [_jsx("div", { className: `${css.progressFill} ${running ? css.progressRunning : detail.state === 'error' ? css.progressError : css.progressDone}`, style: { width: `${pct}%` } }), _jsxs("span", { className: css.progressText, children: [pct, "%"] })] }))] }), _jsxs("div", { className: css.toolbar, children: [_jsx("button", { type: "button", className: `${css.iconBtn} ${css.actionIco}`, disabled: busy || !running, onClick: onAct('pause'), title: "\u6682\u505C\u6279\u6B21", children: "\u23F8" }), _jsx("button", { type: "button", className: `${css.iconBtn} ${css.actionIco}`, disabled: busy || !running, onClick: onAct('resume'), title: "\u6062\u590D\u6279\u6B21", children: "\u25B6" }), _jsx("button", { type: "button", className: `${css.iconBtn} ${css.actionIco} ${css.actionDanger}`, disabled: busy, onClick: onAct('cancel'), title: "\u53D6\u6D88\u6279\u6B21", children: "\u2715" }), _jsx("button", { type: "button", className: `${css.iconBtn} ${css.actionIco}`, disabled: busy, onClick: onResumeBack(), title: "\u65AD\u70B9\u7EED\u8DD1", children: "\u21BB" }), _jsx("span", { className: css.spacer }), _jsx("button", { type: "button", className: css.btnGhost, disabled: busy, onClick: () => void doViewResult(), title: "\u67E5\u770B\u7ED3\u679C JSON", children: "JSON" }), _jsx("button", { type: "button", className: css.btnGhost, disabled: busy, onClick: () => void doDownloadResult(), title: "\u4E0B\u8F7D\u7ED3\u679C JSON", children: "\u21E9 \u4E0B\u8F7D" })] }), jsonView !== null && (_jsxs("div", { className: css.card, children: [_jsxs("div", { className: css.cardHead, children: [_jsx("span", { className: css.cardTitle, children: "\u7ED3\u679C JSON" }), _jsx("button", { type: "button", className: css.iconBtn, onClick: () => setJsonView(null), title: "\u5173\u95ED", children: "\u2715" })] }), _jsx("pre", { className: css.pre, children: jsonView })] })), _jsxs("div", { className: css.card, children: [_jsx("div", { className: css.cardHead, children: _jsxs("span", { className: css.cardTitle, children: ["\u9010\u6761\u7ED3\u679C\uFF08", detail.results?.length ?? 0, "\uFF09"] }) }), renderMetricsTable(detail.results, {
                                        onCheck: alphaId => { void doCheckAlpha(alphaId); },
                                        onProdCorr: alphaId => { void doFetchProdCorr(alphaId); },
                                        onLocalSelf: alphaId => { void doLocalSelfCorr(alphaId); },
                                    })] }), renderRobustnessCard(), renderProdCorrPanel(), renderLocalPanel(), checkAlphaId !== null && (_jsxs("div", { className: css.card, children: [_jsxs("div", { className: css.cardHead, children: [_jsx("span", { className: css.cardIcon, children: "\uD83D\uDD0D" }), _jsxs("span", { className: css.cardTitle, children: ["BRAIN check \u00B7 ", checkAlphaId] }), _jsx("span", { className: css.spacer }), _jsx("button", { type: "button", className: css.iconBtn, onClick: closeCheckPanel, title: "\u5173\u95ED", "aria-label": "\u5173\u95ED check \u9762\u677F", children: "\u2715" })] }), checkLoading && (_jsx("div", { className: css.metaLine, children: "\u52A0\u8F7D\u4E2D\u2026" })), checkError !== null && (_jsx("div", { className: css.msg + ' ' + css.msgErr, children: checkError })), checks !== null && !checkLoading && checkError === null && renderChecksList(checks)] }))] })), _jsxs("div", { className: css.statusFooter, children: ["\u5F15\u64CE ", QIANXUN_BASE] })] })] }));
}
//# sourceMappingURL=QianxunDetailTab.js.map
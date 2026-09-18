import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * AlphaPoolCard.tsx — 「Alpha 自选池 + 提交闸」卡（千寻结果页里存 alpha_id 的地方）。
 *
 * 干什么：
 *   · 输入框存 alpha_id（支持一次粘一坨：逗号 / 换行 / 空格分隔）
 *   · 表格：状态 / region / alpha_id（可一键复制）/ sharpe / fitness / ret% / to% /
 *     margin（万分之一）/ selfcorr / prodcorr / 备注（可直接在格子里写）
 *   · 「同步」按钮一次性刷新整池的状态与指标
 *   · 顶部显示「账号当日新增 active」（每天本地 12:00 重置）
 *   · 提交栏：粘 alpha_id → 先拉 check 列出 FAIL → 确认后**真的提交到平台**
 *
 * 数据从哪来：全部走引擎（`/api/alpha-pool*`）。池子落在引擎侧（跨浏览器/跨端口都在），
 * 打 BRAIN 的活也由引擎代劳——浏览器既没有凭据，也会撞 CORS。
 *
 * 降级：引擎如果还是老版本（没有这几个接口），GET 会 404。这里不报红，而是明确
 * 告诉用户「引擎需要重启才生效」，UI 其余部分不受影响。
 *
 * ⚠️ 提交红线：提交不可逆。本组件只做「人类点按钮 → 引擎执行」这一条路，
 * 引擎侧还会硬校验 confirm token。agent / 脚本不得代提。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getActiveStats, getAlphaCheck, getAlphaPool, getSubmitJob, mutateAlphaPool, setAlphaPoolNote, submitAlphas, syncAlphaPool, } from "./qianxun.js";
import { fmt } from "./format.js";
import { PROD_CORR_DEAD_ZONE } from "./wq-eval.js";
import css from './QianxunTab.module.css';
/** 一次最多提交几个（与引擎侧 _SUBMIT_MAX_IDS 对齐）。 */
const SUBMIT_MAX_IDS = 5;
/** 提交任务轮询间隔（毫秒）。 */
const SUBMIT_POLL_MS = 4000;
/** 提交状态（active/unsubmit）→ 展示元信息。 */
const STATUS_META = {
    active: {
        label: 'active',
        cls: 'poolActive',
        hint: '在 BRAIN 的 ACTIVE 组合里（已提交且未被踢出）',
    },
    unsubmit: {
        label: 'unsubmit',
        cls: 'poolUnsubmit',
        hint: '不在 ACTIVE 组合里（未提交 / 已失效）',
    },
    unknown: {
        label: 'unknown',
        cls: 'poolUnknown',
        hint: '这次没拿到状态（BRAIN 不可用或账号里查不到这个 id）',
    },
};
/** 提交结论 → 展示元信息。 */
const SUBMIT_META = {
    queued: { label: '排队中', cls: 'submitQueued' },
    submitted: { label: '已提交', cls: 'submitOk' },
    blocked: { label: '提交被拒', cls: 'submitBad' },
    failed: { label: '提交失败', cls: 'submitBad' },
    timeout: { label: '提交超时', cls: 'submitBad' },
    pending: { label: '待续查', cls: 'submitWarn' },
};
/** 把任意 status 字符串映射到展示元信息（未知态原样显示）。 */
function statusMeta(status) {
    const key = String(status ?? 'unknown').toLowerCase();
    return STATUS_META[key] ?? { label: key, cls: 'poolUnknown', hint: `BRAIN 状态：${key}` };
}
/** 把任意提交状态映射到展示元信息。 */
function submitMeta(state) {
    if (state === null || state === undefined || state === '')
        return null;
    return SUBMIT_META[state] ?? { label: state, cls: 'submitWarn' };
}
/** `err`（fetch 抛出的错误）是否表示「引擎还没这个接口」。 */
function isMissingEndpoint(err) {
    const msg = err instanceof Error ? err.message : String(err);
    return /qianxun 404\b/.test(msg) || /not found/i.test(msg);
}
/** margin 按用户口径以「万分之一」为单位显示：0.000783 → 7.83。 */
function fmtWan(v) {
    if (typeof v !== 'number' || Number.isNaN(v))
        return '—';
    return String(parseFloat((v * 10000).toPrecision(3)));
}
/** PASS/FAIL/WARNING/PENDING → 已有徽章类（css 模块索引带 undefined，故返回可空）。 */
function statusBadgeCls(result) {
    const r = result.toUpperCase();
    if (r === 'PASS')
        return css.bPass;
    if (r === 'FAIL')
        return css.bFail;
    if (r === 'WARNING' || r === 'WARN')
        return css.bWarn;
    return css.bNone;
}
/** 相关性单元格：数值 + PASS/FAIL 徽章竖排，>= 死区线标红。 */
function corrCell(value, result) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return result ? _jsx("span", { className: statusBadgeCls(result), children: String(result).toLowerCase() })
            : _jsx("span", { className: css.bNone, children: "\u2014" });
    }
    const dead = value >= PROD_CORR_DEAD_ZONE;
    return (_jsxs("span", { className: css.poolCorrCell, children: [_jsx("span", { className: dead ? css.valNeg : css.valPos, title: dead ? `≥ 死区线 ${PROD_CORR_DEAD_ZONE}` : undefined, children: fmt(value) }), result !== null && result !== undefined && result !== '' && (_jsx("span", { className: statusBadgeCls(result), children: String(result).toLowerCase() }))] }));
}
/** 复制到剪贴板。优先 Clipboard API，回落 execCommand（本机 http 下两者都可用）。 */
async function copyText(text) {
    try {
        if (navigator.clipboard !== undefined) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    }
    catch {
        // 落到兜底
    }
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        return ok;
    }
    catch {
        return false;
    }
}
/** 把输入的文本解析成去重保序的 alpha_id 列表（与引擎侧同口径）。 */
function parseIds(raw) {
    const out = [];
    const seen = new Set();
    for (const chunk of raw.split(/[\s,;]+/)) {
        const s = chunk.trim();
        if (/^[A-Za-z0-9]{4,16}$/.test(s) && !seen.has(s)) {
            seen.add(s);
            out.push(s);
        }
    }
    return out;
}
/** 从 check 响应里挑出 FAIL 项名字。 */
function failNames(payload) {
    const checks = payload
        ?.is?.checks;
    if (!Array.isArray(checks))
        return [];
    return checks
        .filter(c => String(c?.['result'] ?? '').toUpperCase() === 'FAIL')
        .map(c => String(c?.['name'] ?? '?'));
}
export function AlphaPoolCard(props) {
    const { visible = true, onInspect } = props;
    const [pool, setPool] = useState(null);
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [mutating, setMutating] = useState(false);
    const [error, setError] = useState(null);
    const [engineMissing, setEngineMissing] = useState(false);
    const [draft, setDraft] = useState('');
    const [notice, setNotice] = useState(null);
    const [expanded, setExpanded] = useState(true);
    // 备注：按 id 存草稿，1s 防抖自动保存 + 回车/失焦立刻保存
    const [noteDraft, setNoteDraft] = useState({});
    const [noteBusy, setNoteBusy] = useState(null);
    const [noteSaved, setNoteSaved] = useState(null);
    const noteTimers = useRef({});
    // 复制反馈：记住刚复制过的 id，短暂显示 ✓
    const [copied, setCopied] = useState(null);
    // 提交
    const [submitDraft, setSubmitDraft] = useState('');
    const [submitBusy, setSubmitBusy] = useState(false);
    const [jobId, setJobId] = useState(null);
    const [job, setJob] = useState(null);
    const [submitMsg, setSubmitMsg] = useState(null);
    const applyPool = useCallback((next) => {
        setPool(next);
    }, []);
    /** 读池子 + 当日 active（池子是本地；stats 会打一次 BRAIN，但吃引擎 5min 缓存）。 */
    const load = useCallback(async (opts = {}) => {
        setLoading(true);
        setError(null);
        try {
            const r = await getAlphaPool();
            setEngineMissing(false);
            applyPool(r);
        }
        catch (cause) {
            if (isMissingEndpoint(cause)) {
                setEngineMissing(true);
                setError(null);
            }
            else {
                setError(cause instanceof Error ? cause.message : String(cause));
            }
        }
        finally {
            setLoading(false);
        }
        if (opts.withStats !== false) {
            try {
                setStats(await getActiveStats());
            }
            catch {
                // stats 是锦上添花，失败不打扰用户
            }
        }
    }, [applyPool]);
    useEffect(() => {
        if (!visible)
            return;
        void load();
    }, [visible, load]);
    // 当日 active 定时刷新（引擎侧 ACTIVE 列表有 5min 缓存，这里 2min 足够）
    useEffect(() => {
        if (!visible)
            return;
        const timer = window.setInterval(() => {
            void getActiveStats().then(setStats).catch(() => { });
        }, 120000);
        return () => window.clearInterval(timer);
    }, [visible]);
    // 提交任务轮询：跑完自动刷新池子（结论已落回条目）
    useEffect(() => {
        if (jobId === null)
            return;
        let stop = false;
        const tick = async () => {
            try {
                const j = await getSubmitJob(jobId);
                if (stop)
                    return;
                setJob(j);
                if (j.running !== true) {
                    setJobId(null);
                    await load();
                    return;
                }
            }
            catch (cause) {
                if (!stop)
                    setError(cause instanceof Error ? cause.message : String(cause));
                return;
            }
            if (!stop)
                window.setTimeout(() => { void tick(); }, SUBMIT_POLL_MS);
        };
        void tick();
        return () => { stop = true; };
    }, [jobId, load]);
    /** 加：支持一次粘一坨 id。 */
    const doAdd = useCallback(async () => {
        const raw = draft.trim();
        if (raw === '')
            return;
        setMutating(true);
        setError(null);
        setNotice(null);
        try {
            const r = await mutateAlphaPool('add', raw);
            applyPool(r);
            setDraft('');
            setEngineMissing(false);
            // 加完立刻同步一次，省得用户还要再点一下「同步」
            void (async () => {
                try {
                    const synced = await syncAlphaPool();
                    applyPool(synced);
                    setNotice(syncNotice(synced));
                }
                catch {
                    setNotice('已加入；BRAIN 数据未拉到，可点「同步」重试');
                }
            })();
        }
        catch (cause) {
            if (isMissingEndpoint(cause))
                setEngineMissing(true);
            else
                setError(cause instanceof Error ? cause.message : String(cause));
        }
        finally {
            setMutating(false);
        }
    }, [draft, applyPool]);
    /** 删单条 / 清空。 */
    const doMutate = useCallback(async (action, alphaId) => {
        if (action === 'clear' &&
            !window.confirm('清空整个自选池？（只删本地名单，不动 BRAIN 上的 alpha）'))
            return;
        setMutating(true);
        setError(null);
        try {
            const r = await mutateAlphaPool(action, alphaId);
            applyPool(r);
            setNotice(action === 'clear' ? '已清空自选池' : `已移除 ${alphaId ?? ''}`);
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
        finally {
            setMutating(false);
        }
    }, [applyPool]);
    /** 同步：整池（ids 为空 = 全刷）或单条。 */
    const doSync = useCallback(async (ids) => {
        setSyncing(true);
        setError(null);
        setNotice(null);
        try {
            const r = await syncAlphaPool(ids);
            applyPool(r);
            setNotice(syncNotice(r));
            setEngineMissing(false);
        }
        catch (cause) {
            if (isMissingEndpoint(cause))
                setEngineMissing(true);
            else
                setError(cause instanceof Error ? cause.message : String(cause));
        }
        finally {
            setSyncing(false);
            void getActiveStats().then(setStats).catch(() => { });
        }
    }, [applyPool]);
    /** 保存备注（1s 防抖 + 回车/失焦都会走到这里）。 */
    const saveNote = useCallback(async (alphaId, value) => {
        setNoteBusy(alphaId);
        try {
            const r = await setAlphaPoolNote(alphaId, value);
            applyPool(r);
            setNoteDraft(d => {
                if (d[alphaId] !== value)
                    return d;
                const next = { ...d };
                delete next[alphaId];
                return next;
            });
            setNoteSaved(alphaId);
            window.setTimeout(() => {
                setNoteSaved(cur => (cur === alphaId ? null : cur));
            }, 1500);
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
        finally {
            setNoteBusy(null);
        }
    }, [applyPool]);
    const onChangeNote = useCallback((alphaId, value) => {
        setNoteDraft(d => ({ ...d, [alphaId]: value }));
        const timer = noteTimers.current[alphaId];
        if (timer !== undefined)
            window.clearTimeout(timer);
        noteTimers.current[alphaId] = window.setTimeout(() => {
            void saveNote(alphaId, value);
        }, 1000);
    }, [saveNote]);
    /** 复制 alpha_id。 */
    const doCopy = useCallback(async (alphaId) => {
        const ok = await copyText(alphaId);
        if (ok) {
            setCopied(alphaId);
            window.setTimeout(() => setCopied(cur => (cur === alphaId ? null : cur)), 1200);
        }
        else {
            setError(`复制失败（浏览器拒绝），请手动选中 ${alphaId}`);
        }
    }, []);
    /**
     * 提交：先拉 check 列出 FAIL，确认后才真提交（两道闸）。
     *   1) 通用确认：不可逆 + 占额度
     *   2) 若有 FAIL：额外一次确认，把 FAIL 项摊开（默认拦住，但仍可强制提）
     */
    const doSubmit = useCallback(async () => {
        const ids = parseIds(submitDraft);
        if (ids.length === 0) {
            setError('没有解析出合法 alpha_id（4-16 位字母数字）');
            return;
        }
        if (ids.length > SUBMIT_MAX_IDS) {
            setError(`一次最多提交 ${SUBMIT_MAX_IDS} 个（提交不可逆，防手滑）；这次给了 ${ids.length} 个`);
            return;
        }
        setSubmitBusy(true);
        setError(null);
        setSubmitMsg('正在拉取 check（提交前预检）…');
        try {
            const lines = [];
            let failCount = 0;
            for (const id of ids) {
                try {
                    const checks = await getAlphaCheck(id);
                    const fails = failNames(checks);
                    if (fails.length > 0) {
                        failCount++;
                        lines.push(`  ${id}  ✗ ${fails.join(', ')}`);
                    }
                    else {
                        lines.push(`  ${id}  ✓ 预检未见 FAIL`);
                    }
                }
                catch (cause) {
                    lines.push(`  ${id}  ? 拿不到 check：${cause instanceof Error ? cause.message : String(cause)}`);
                }
            }
            setSubmitMsg(null);
            const head = `真的要提交这 ${ids.length} 个 alpha 到 BRAIN 平台吗？\n\n` +
                '⚠️ 不可逆：会占用提交额度，并写进账号的 ACTIVE 组合。\n' +
                '提交后平台要算几十分钟到几小时，期间可以离开页面。\n';
            if (!window.confirm(`${head}\n提交前预检：\n${lines.join('\n')}`)) {
                setSubmitMsg('已取消提交');
                return;
            }
            if (failCount > 0) {
                const warn = `⚠️ 其中 ${failCount} 条有 FAIL 项（平台多半会直接拒绝，白耗额度）：\n\n` +
                    `${lines.filter(l => l.includes('✗')).join('\n')}\n\n确定还要提交吗？`;
                if (!window.confirm(warn)) {
                    setSubmitMsg('已取消提交（有 FAIL 项）');
                    return;
                }
            }
            const started = await submitAlphas(ids);
            if (started.job_id === undefined)
                throw new Error(started.error ?? '引擎没有返回 job_id');
            setJobId(started.job_id);
            setJob(null);
            setSubmitMsg(`已交给引擎提交（任务 ${started.job_id}）` +
                ((started.auto_added?.length ?? 0) > 0
                    ? `；${started.auto_added?.length} 个新 id 已自动加入自选池便于追踪`
                    : ''));
            setSubmitDraft('');
            await load({ withStats: false });
        }
        catch (cause) {
            if (isMissingEndpoint(cause))
                setEngineMissing(true);
            else
                setError(cause instanceof Error ? cause.message : String(cause));
        }
        finally {
            setSubmitBusy(false);
        }
    }, [submitDraft, load]);
    /** 续查：只轮询，不再 POST（避免重复提交撞 400 / 白占额度）。 */
    const doContinuePoll = useCallback(async () => {
        const ids = parseIds(submitDraft);
        if (ids.length === 0) {
            setError('先把要续查的 alpha_id 粘到提交框里');
            return;
        }
        setSubmitBusy(true);
        setError(null);
        try {
            const started = await submitAlphas(ids, { pollOnly: true });
            if (started.job_id === undefined)
                throw new Error(started.error ?? '引擎没有返回 job_id');
            setJobId(started.job_id);
            setJob(null);
            setSubmitMsg(`已开始续查（任务 ${started.job_id}）：只查结果，不会重复提交`);
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
        finally {
            setSubmitBusy(false);
        }
    }, [submitDraft]);
    const items = pool?.items ?? [];
    const poolActive = useMemo(() => items.filter(it => String(it.status ?? '').toLowerCase() === 'active').length, [items]);
    if (engineMissing) {
        return (_jsxs("div", { className: css.card, children: [_jsxs("div", { className: css.cardHead, children: [_jsx("span", { className: css.cardIcon, children: "\u2B50" }), _jsx("span", { className: css.cardTitle, children: "Alpha \u81EA\u9009\u6C60" })] }), _jsxs("div", { className: `${css.msg} ${css.msgErr}`, children: ["\u5F15\u64CE\u8FD8\u6CA1\u6709\u81EA\u9009\u6C60\u63A5\u53E3\uFF08", _jsx("code", { children: "/api/alpha-pool" }), " \u8FD4\u56DE 404\uFF09\u3002 \u91CD\u542F\u4E00\u6B21\u5F15\u64CE\u5373\u53EF\u751F\u6548\uFF1A", _jsx("br", {}), _jsx("code", { children: "launchctl kickstart -k gui/$(id -u)/com.qianxund" })] })] }));
    }
    const jobItemList = job?.items ?? {};
    const jobRunning = jobId !== null;
    return (_jsxs("div", { className: css.card, children: [_jsxs("div", { className: css.cardHead, children: [_jsx("button", { type: "button", className: css.iconBtn, onClick: () => setExpanded(e => !e), "aria-expanded": expanded, title: expanded ? '收起' : '展开', children: expanded ? '▾' : '▸' }), _jsx("span", { className: css.cardIcon, children: "\u2B50" }), _jsxs("span", { className: css.cardTitle, title: `池内 ${poolActive} 条 active / 共 ${items.length} 条`, children: ["Alpha \u81EA\u9009\u6C60\uFF08", pool?.count ?? 0, "\uFF09"] }), _jsx("span", { className: css.spacer }), stats !== null && (_jsxs("span", { className: stats.stale === true ? css.dailyBadgeStale : css.dailyBadge, title: '当日新增 = 当前 ACTIVE 集合 − 上一次 ' + String(stats.reset_hour ?? 12) + ':00 的基准线\n' +
                            `基准线取自 ${stats.baseline_reset_at ?? '—'}（${stats.baseline_count ?? 0} 条）\n` +
                            `下次重置：${stats.next_reset_at ?? '—'}（本地时间）\n` +
                            '局限：基准线只在有人打开这个页面时滚动，长时间不看页面期间的进出无法回溯——宁可漏算不会多算' +
                            (stats.stale === true ? '\n⚠️ 这次没拿到 ACTIVE 列表，显示的是上次观察值' : ''), children: ["\uD83D\uDCC8 \u4ECA\u65E5\u65B0\u589E active ", stats.daily_new ?? 0, _jsxs("span", { className: css.dailyBadgeSub, children: ["\u00B7 \u8D26\u53F7\u5171 ", stats.active_count ?? '—'] })] })), _jsx("button", { type: "button", className: css.btnPrimary, disabled: syncing || loading || (pool?.count ?? 0) === 0, onClick: () => { void doSync(); }, title: "\u91CD\u65B0\u62C9\u53D6\u6574\u6C60\u7684\u6307\u6807\u3001\u76F8\u5173\u6027\u4E0E\u63D0\u4EA4\u72B6\u6001\uFF08BRAIN \u9650\u6D41\u65F6\u53EF\u80FD\u53EA\u5237\u5230\u4E00\u90E8\u5206\uFF0C\u518D\u70B9\u4E00\u6B21\u7EED\u5237\uFF09", children: syncing ? '🔄 同步中…' : '🔄 同步' })] }), expanded && (_jsxs(_Fragment, { children: [_jsxs("form", { className: css.poolAddRow, onSubmit: e => { e.preventDefault(); void doAdd(); }, children: [_jsx("input", { className: css.input, type: "text", value: draft, onChange: e => setDraft(e.target.value), placeholder: "\u7C98 alpha_id\uFF08\u53EF\u4E00\u6B21\u591A\u4E2A\uFF0C\u9017\u53F7 / \u6362\u884C / \u7A7A\u683C\u5206\u9694\uFF09", "aria-label": "\u6DFB\u52A0 alpha_id \u5230\u81EA\u9009\u6C60", spellCheck: false, autoComplete: "off" }), _jsx("button", { type: "submit", className: css.btnPrimary, disabled: mutating || draft.trim() === '', children: "\uFF0B \u6DFB\u52A0" }), _jsx("button", { type: "button", className: css.btnGhost, disabled: mutating || (pool?.count ?? 0) === 0, onClick: () => { void doMutate('clear'); }, title: "\u6E05\u7A7A\u81EA\u9009\u6C60\uFF08\u53EA\u5220\u672C\u5730\u540D\u5355\uFF09", children: "\u6E05\u7A7A" })] }), _jsxs("div", { className: css.poolMetaLine, "aria-live": "polite", children: [loading && '读取中…', !loading && pool !== null && (_jsxs(_Fragment, { children: ["\u6700\u540E\u540C\u6B65\uFF1A", pool.synced_at !== null && pool.synced_at !== undefined
                                        ? new Date(pool.synced_at).toLocaleString()
                                        : '从未'] })), notice !== null && _jsxs("span", { className: css.poolNotice, children: [" \u00B7 ", notice] })] }), error !== null && (_jsxs("div", { className: `${css.msg} ${css.msgErr}`, role: "alert", children: [error, " \u2014\u2014 \u68C0\u67E5\u5F15\u64CE\u662F\u5426\u5728\u8DD1\uFF1A", _jsx("code", { children: "curl -s localhost:8765/health" })] })), pool !== null && pool.count === 0 && (_jsxs("div", { className: css.empty, children: [_jsx("span", { className: css.emptyIcon, children: "\u2B50" }), _jsxs("div", { children: [_jsx("span", { children: "\u6C60\u5B50\u8FD8\u662F\u7A7A\u7684\uFF1A\u628A\u60F3\u76EF\u7684 alpha_id \u7C98\u5230\u4E0A\u9762\u7684\u8F93\u5165\u6846\u3002" }), _jsx("div", { className: css.emptySub, children: "\u5B58\u8FDB\u53BB\u540E\u70B9\u300C\u540C\u6B65\u300D\u5373\u53EF\u770B\u5230 sharpe / fitness / ret / turnover / margin / selfcorr / prodcorr \u4E0E active \u72B6\u6001\uFF1B\u5907\u6CE8\u53EF\u4EE5\u76F4\u63A5\u5728\u8868\u683C\u91CC\u5199\u3002" })] })] })), items.length > 0 && (_jsx("div", { className: `${css.tableWrap} ${css.poolTable}`, children: _jsxs("table", { className: css.table, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { scope: "col", children: "\u72B6\u6001" }), _jsx("th", { scope: "col", children: "region" }), _jsx("th", { scope: "col", children: "alpha_id" }), _jsx("th", { scope: "col", children: "sharpe" }), _jsx("th", { scope: "col", children: "fitness" }), _jsx("th", { scope: "col", children: "ret%" }), _jsx("th", { scope: "col", children: "to%" }), _jsx("th", { scope: "col", title: "\u4EE5\u4E07\u5206\u4E4B\u4E00\u4E3A\u5355\u4F4D\uFF080.000783 \u2192 7.83\uFF09", children: "margin" }), _jsx("th", { scope: "col", children: "selfcorr" }), _jsx("th", { scope: "col", children: "prodcorr" }), _jsx("th", { scope: "col", children: "\u5907\u6CE8" }), _jsx("th", { scope: "col", "aria-label": "\u64CD\u4F5C" })] }) }), _jsx("tbody", { children: items.map(it => {
                                        const meta = statusMeta(it.status);
                                        const sm = submitMeta(it.submit?.state);
                                        const m = it.metrics ?? {};
                                        const errs = it.errors ?? [];
                                        const noteValue = noteDraft[it.alpha_id] ?? it.note ?? '';
                                        return (_jsxs("tr", { children: [_jsxs("td", { className: css.cellStatus, children: [_jsx("span", { className: `${css.badge} ${css[meta.cls] ?? ''}`, title: meta.hint, children: meta.label }), sm !== null && (_jsx("span", { className: `${css.submitMarkBadge} ${css[sm.cls] ?? ''}`, title: [
                                                                it.submit?.error ?? '',
                                                                (it.submit?.fails?.length ?? 0) > 0
                                                                    ? `FAIL: ${it.submit?.fails?.join(', ')}` : '',
                                                                it.submit?.at !== null && it.submit?.at !== undefined
                                                                    ? `at ${it.submit.at}` : '',
                                                            ].filter(Boolean).join('\n'), children: sm.label })), errs.length > 0 && (_jsx("span", { className: css.poolErrDot, title: errs.join('\n'), children: "\u26A0\uFE0F" }))] }), _jsx("td", { className: css.cellStatus, children: it.region ?? '—' }), _jsxs("td", { className: css.cellAlpha, children: [_jsx("button", { type: "button", className: css.poolIdBtn, onClick: () => onInspect?.(it.alpha_id), title: onInspect !== undefined ? '看 BRAIN 详细 checks' : it.alpha_id, children: it.alpha_id }), _jsx("button", { type: "button", className: css.copyBtn, onClick: () => { void doCopy(it.alpha_id); }, title: `复制 ${it.alpha_id}`, "aria-label": `复制 ${it.alpha_id}`, children: copied === it.alpha_id ? '✓' : '⧉' })] }), _jsx("td", { className: css.cellNum, children: fmt(m.sharpe) }), _jsx("td", { className: css.cellNum, children: fmt(m.fitness) }), _jsx("td", { className: css.cellNum, children: fmt(m.returns, true) }), _jsx("td", { className: css.cellNum, children: fmt(m.turnover, true) }), _jsx("td", { className: css.cellNum, title: `margin = ${m.margin ?? '—'}`, children: fmtWan(m.margin) }), _jsx("td", { className: css.cellNum, children: corrCell(it.self_corr, it.self_corr_result) }), _jsx("td", { className: css.cellNum, children: corrCell(it.prod_corr, it.prod_corr_result) }), _jsxs("td", { className: css.cellNote, children: [_jsx("input", { className: css.noteInput, type: "text", value: noteValue, onChange: e => onChangeNote(it.alpha_id, e.target.value), onBlur: e => { void saveNote(it.alpha_id, e.target.value); }, onKeyDown: e => {
                                                                if (e.key === 'Enter')
                                                                    e.target.blur();
                                                            }, placeholder: "\u5199\u70B9\u5907\u6CE8\u2026", "aria-label": `${it.alpha_id} 的备注`, maxLength: 500, spellCheck: false }), noteBusy === it.alpha_id && _jsx("span", { className: css.noteHint, children: "\u2026" }), noteSaved === it.alpha_id && _jsx("span", { className: css.noteHintOk, children: "\u2713" })] }), _jsxs("td", { className: css.cellAction, children: [_jsx("button", { type: "button", className: css.iconBtn, disabled: syncing, onClick: () => { void doSync([it.alpha_id]); }, title: "\u53EA\u5237\u65B0\u8FD9\u4E00\u6761", "aria-label": `刷新 ${it.alpha_id}`, children: "\u27F3" }), _jsx("button", { type: "button", className: css.iconBtn, disabled: mutating, onClick: () => { void doMutate('remove', it.alpha_id); }, title: "\u4ECE\u81EA\u9009\u6C60\u79FB\u9664", "aria-label": `移除 ${it.alpha_id}`, children: "\u2715" })] })] }, it.alpha_id));
                                    }) })] }) })), _jsxs("div", { className: css.submitBox, children: [_jsxs("div", { className: css.submitHead, children: [_jsx("span", { className: css.submitTitle, children: "\u26A1 \u63D0\u4EA4\u5230\u5E73\u53F0" }), _jsxs("span", { className: css.submitWarnText, children: ["\u4E0D\u53EF\u9006 \u00B7 \u5360\u63D0\u4EA4\u989D\u5EA6 \u00B7 \u5199\u8FDB\u8D26\u53F7 ACTIVE \u7EC4\u5408 \u00B7 \u5355\u6B21 \u2264 ", SUBMIT_MAX_IDS, " \u4E2A"] })] }), _jsxs("form", { className: css.submitRow, onSubmit: e => { e.preventDefault(); void doSubmit(); }, children: [_jsx("input", { className: css.input, type: "text", value: submitDraft, onChange: e => setSubmitDraft(e.target.value), placeholder: "\u7C98\u8981\u63D0\u4EA4\u7684 alpha_id\uFF08\u70B9\u63D0\u4EA4\u540E\u5148\u62C9 check \u7ED9\u4F60\u8FC7\u76EE\uFF09", "aria-label": "\u8981\u63D0\u4EA4\u5230\u5E73\u53F0\u7684 alpha_id", spellCheck: false, autoComplete: "off", disabled: submitBusy || jobRunning }), _jsx("button", { type: "submit", className: css.submitBtn, disabled: submitBusy || jobRunning || submitDraft.trim() === '', children: submitBusy ? '预检中…' : '⚡ 提交' }), _jsx("button", { type: "button", className: css.btnGhost, disabled: submitBusy || jobRunning || submitDraft.trim() === '', onClick: () => { void doContinuePoll(); }, title: "\u5E73\u53F0\u4E0A\u4E00\u6B21\u6CA1\u7B97\u5B8C\u65F6\uFF0C\u53EA\u67E5\u7ED3\u679C\u3001\u4E0D\u518D\u91CD\u590D\u63D0\u4EA4", children: "\u7EED\u67E5" })] }), submitMsg !== null && _jsx("div", { className: css.submitMsg, children: submitMsg }), job !== null && (_jsxs("div", { className: css.submitProgress, "aria-live": "polite", children: [jobRunning
                                        ? _jsxs("span", { className: css.submitSpinner, children: ["\u23F3 \u4EFB\u52A1 ", job.job_id, " \u8FDB\u884C\u4E2D\u2026"] })
                                        : _jsxs("span", { children: ["\u4EFB\u52A1 ", job.job_id, " \u5DF2\u7ED3\u675F"] }), _jsx("div", { className: css.submitJobList, children: Object.entries(jobItemList).map(([id, it]) => {
                                            const meta = submitMeta(it.state);
                                            return (_jsxs("div", { className: css.submitJobRow, children: [_jsx("span", { className: css.submitJobId, children: id }), meta !== null && (_jsx("span", { className: `${css.submitJobBadge} ${css[meta.cls] ?? ''}`, children: meta.label })), it.error !== null && it.error !== undefined && (_jsx("span", { className: css.submitJobErr, title: it.error, children: it.error })), (it.fails?.length ?? 0) > 0 && (_jsx("span", { className: css.submitJobFails, title: "\u5E73\u53F0\u7ED9\u51FA\u7684 FAIL \u9879", children: it.fails?.join(', ') }))] }, id));
                                        }) })] }))] })] }))] }));
}
/** 同步结果 → 一行人话。 */
function syncNotice(r) {
    const parts = [];
    if (r.message !== undefined)
        parts.push(r.message);
    else
        parts.push(`已刷新 ${r.refreshed ?? 0}/${r.count} 条`);
    if (r.partial === true) {
        parts.push(`仍有 ${r.remaining?.length ?? 0} 条没刷到，可再点一次「同步」续刷`);
    }
    if (r.active_ok === false) {
        parts.push('（这次没拿到 ACTIVE 列表，状态按每个 alpha 自己的 BRAIN 状态判定）');
    }
    return parts.join('；');
}
//# sourceMappingURL=AlphaPoolCard.js.map
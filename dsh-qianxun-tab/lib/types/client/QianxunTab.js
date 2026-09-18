import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/** 千寻回测控制台——dsh-better-sidebar 的自定义 tab 内容组件（列表视图）。 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { actOnBatch, getBatchResult, getConfig, getQuota, listBatches, resumeBatch, setConfig, QIANXUN_BASE, } from "./qianxun.js";
import { isRunning } from "./format.js";
import { copyPrompt, createPrompt, ensurePromptsLoaded, getPrompt, listPrompts, promptsSource, refreshPrompts, subscribePrompts, } from "./prompts.js";
import css from './QianxunTab.module.css';
/** 分页默认条数与可选值。`all` = 不分页（一次性渲染全部）。 */
const PAGE_SIZE_OPTIONS = [3, 4, 5, 8, 'all'];
const DEFAULT_PAGE_SIZE = 3;
/** 批次状态 → 行状态类。 */
function stateClass(state) {
    const s = String(state).toLowerCase();
    // 终态成功：done / finished / complete / completed 都算绿。
    if (s === 'done' ||
        s === 'finished' ||
        s === 'complete' ||
        s === 'completed' ||
        s === 'success' ||
        s === 'succeeded') {
        return css.rowStateDone;
    }
    // 终态非成功：失败 / 取消 / 中止 — 一律红。
    if (s === 'error' ||
        s === 'failed' ||
        s === 'fail' ||
        s === 'cancelled' ||
        s === 'canceled' ||
        s === 'cancel' ||
        s === 'stopped' ||
        s === 'stop' ||
        s === 'abort' ||
        s === 'aborted' ||
        s === 'halted' ||
        s === 'killed') {
        return css.rowStateError;
    }
    // 临时暂停 — 黄（警告）。
    if (s === 'paused' || s === 'pause' || s === 'pausing' || s === 'suspended')
        return css.rowStatePaused;
    if (isRunning(s))
        return css.rowStateRunning;
    return css.rowStateQueued;
}
/** 进度条 fill 颜色类。running 优先；终态按 stateClass；其它无色（与行首 bar 一致）。 */
function progressFillClass(state, running) {
    if (running)
        return css.progressRunning ?? '';
    const sc = stateClass(state);
    if (sc === css.rowStateDone)
        return css.progressDone ?? '';
    if (sc === css.rowStateError)
        return css.progressError ?? '';
    if (sc === css.rowStatePaused)
        return css.progressPaused ?? '';
    return '';
}
export function QianxunTab(props) {
    const { visible } = props;
    const [batches, setBatches] = useState([]);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(false);
    const [engineOnline, setEngineOnline] = useState(null);
    // expanded batch id -> loaded detail（已删除：行点击直接 openDetail）
    // const [expanded, setExpanded] = useState<Record<string, boolean>>({})
    // const [details, setDetails] = useState<Record<string, QianxunBatchDetail>>({})
    // const [detailError, setDetailError] = useState<Record<string, string>>({})
    const [busy, setBusy] = useState({});
    // 引擎配置 / 配额
    const [quota, setQuota] = useState(null);
    const [configBusy, setConfigBusy] = useState(false);
    const [configMsg, setConfigMsg] = useState(null);
    const [configMsgOk, setConfigMsgOk] = useState(false);
    const [concurrentInput, setConcurrentInput] = useState('');
    const [batchSizeInput, setBatchSizeInput] = useState('');
    // submit form（已移至 Web UI http://127.0.0.1:8765/ui）
    // 提示词模块
    const [prompts, setPrompts] = useState([]);
    const [promptsFrom, setPromptsFrom] = useState('loading');
    const [copyHintText, setCopyHintText] = useState(null);
    // 加载提示词列表：首次挂载确保已从服务端加载；之后每次回到列表 tab 再对齐一次
    // （可能别的浏览器/窗口刚改过）。数据源是服务端，见 prompts.ts。
    const promptSyncedRef = useRef(false);
    useEffect(() => {
        if (!visible)
            return;
        const sync = () => {
            setPrompts(listPrompts());
            setPromptsFrom(promptsSource());
        };
        sync();
        const unsubscribe = subscribePrompts(sync);
        const task = promptSyncedRef.current ? refreshPrompts() : ensurePromptsLoaded();
        promptSyncedRef.current = true;
        void task.then(sync);
        return unsubscribe;
    }, [visible]);
    /** 新增提示词并打开编辑 tab。 */
    const onAddPrompt = useCallback(() => {
        const p = createPrompt('新提示词', '');
        setPrompts(listPrompts());
        props.ctx?.betterSidebar?.openTab({
            type: 'qianxun-prompt',
            title: p.name,
            id: `qianxun-prompt:${p.id}`,
            meta: { promptId: p.id },
        });
    }, [props.ctx]);
    /** 点击提示词 → 打开编辑 tab。 */
    const openPrompt = useCallback((promptId) => {
        const p = getPrompt(promptId);
        props.ctx?.betterSidebar?.openTab({
            type: 'qianxun-prompt',
            title: p?.name ?? '提示词',
            id: `qianxun-prompt:${promptId}`,
            meta: { promptId },
        });
    }, [props.ctx]);
    // 分页
    const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
    const [currentPage, setCurrentPage] = useState(1);
    /** 当前批次数下的总页数（pageSize='all' 时固定为 1）。 */
    const totalPages = useMemo(() => {
        if (pageSize === 'all')
            return 1;
        return Math.max(1, Math.ceil(batches.length / pageSize));
    }, [batches.length, pageSize]);
    /** 当前页可见的批次（pageSize='all' 时返回全部）。 */
    const pageBatches = useMemo(() => {
        if (pageSize === 'all')
            return batches;
        const start = (currentPage - 1) * pageSize;
        return batches.slice(start, start + pageSize);
    }, [batches, currentPage, pageSize]);
    /** 批次总数或页大小变化时，把 currentPage 夹紧到合法范围。 */
    useEffect(() => {
        if (currentPage > totalPages)
            setCurrentPage(totalPages);
    }, [totalPages, currentPage]);
    const refresh = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [b, c, q] = await Promise.all([
                listBatches(),
                getConfig().catch(() => null),
                getQuota().catch(() => null),
            ]);
            setBatches(b ?? []);
            setEngineOnline(true);
            if (c) {
                setConcurrentInput(String(c.concurrent ?? ''));
                setBatchSizeInput(String(c.batch_size ?? ''));
            }
            if (q)
                setQuota(q);
        }
        catch (cause) {
            setEngineOnline(false);
            setError(cause instanceof Error ? cause.message : String(cause));
        }
        finally {
            setLoading(false);
        }
    }, []);
    // 轮询（visible 时）：立即 + 每 5s。
    useEffect(() => {
        if (!visible)
            return;
        void refresh();
        const timer = window.setInterval(() => {
            void refresh();
        }, 5000);
        return () => window.clearInterval(timer);
    }, [visible, refresh]);
    // 从隐藏回到可见时补一次刷新。
    const prevVisible = useRef(null);
    useEffect(() => {
        if (visible && prevVisible.current === false)
            void refresh();
        prevVisible.current = visible;
    }, [visible, refresh]);
    // toggleBatch 已删除：行点击直接 openDetail，无需先拉详情展开
    const runAction = useCallback(async (batchNo, action) => {
        setBusy(prev => ({ ...prev, [batchNo]: true }));
        try {
            await action();
            await refresh();
        }
        catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
        finally {
            setBusy(prev => ({ ...prev, [batchNo]: false }));
        }
    }, [refresh]);
    const onAct = (batchNo, action) => () => runAction(batchNo, () => actOnBatch(batchNo, action));
    const onResumeBack = (batchNo) => () => runAction(batchNo, () => resumeBatch(batchNo));
    /** 打开该批次的独立详情 tab（每批次一个，可多个批次并存）。 */
    const openDetail = useCallback((batchNo) => {
        props.ctx?.betterSidebar?.openTab({
            type: 'qianxun-detail',
            title: `${batchNo} 结果`,
            id: `qianxun-detail:${batchNo}`,
            meta: { batchNo },
        });
    }, [props.ctx]);
    const doApplyConfig = async () => {
        setConfigBusy(true);
        setConfigMsg(null);
        try {
            const body = {};
            const ci = parseInt(concurrentInput, 10);
            const bi = parseInt(batchSizeInput, 10);
            if (!Number.isNaN(ci) && ci >= 1)
                body.concurrent = ci;
            if (!Number.isNaN(bi) && bi >= 1 && bi <= 10)
                body.batch_size = bi;
            const c = await setConfig(body);
            setConfigMsg(`已应用：并发=${c.concurrent} 批大小=${c.batch_size}`);
            setConfigMsgOk(true);
            void refresh();
        }
        catch (cause) {
            setConfigMsg(cause instanceof Error ? cause.message : String(cause));
            setConfigMsgOk(false);
        }
        finally {
            setConfigBusy(false);
        }
    };
    const doViewResult = async (batchNo) => {
        // 在独立详情 tab 中展示完整结果 JSON。
        openDetail(batchNo);
    };
    const doDownloadResult = async (batchNo) => {
        try {
            const detail = await getBatchResult(batchNo);
            const blob = new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' });
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
    const renderRow = (batch) => {
        const batchNo = batch.id ?? batch.round;
        if (batchNo === undefined)
            return null;
        const isBusy = busy[batchNo] ?? false;
        const running = isRunning(batch.state);
        const done = Math.min(batch.done ?? 0, batch.total || batch.done || 0);
        const total = batch.total ?? 0;
        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        return (_jsx("div", { className: css.row, children: _jsxs("div", { className: css.rowHead, onClick: () => {
                    openDetail(batchNo);
                }, children: [_jsx("span", { className: `${css.rowBar} ${stateClass(batch.state)}` }), _jsxs("div", { className: css.rowMain, children: [_jsxs("div", { className: css.rowTop, children: [_jsx("span", { className: css.rowId, children: batchNo }), _jsx("span", { className: `${css.badge} ${stateClass(batch.state)}`, children: batch.state ?? '—' }), batch.name !== undefined && batch.name !== null && batch.name !== '' && (_jsx("span", { className: css.rowName, children: batch.name })), _jsx("span", { className: css.spacer }), _jsxs("span", { className: css.rowMeta, children: [done, "/", total || '?'] })] }), total > 0 && (_jsx("div", { className: css.progressTrack, children: _jsx("div", { className: `${css.progressFill} ${progressFillClass(batch.state, running)}`, style: { width: `${pct}%` } }) }))] }), _jsxs("div", { className: css.rowActions, onClick: event => event.stopPropagation(), children: [running && (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: `${css.iconBtn} ${css.actionIco}`, disabled: isBusy, onClick: onAct(batchNo, 'pause'), title: "\u6682\u505C\u6279\u6B21", "aria-label": "\u6682\u505C", children: "\u23F8" }), _jsx("button", { type: "button", className: `${css.iconBtn} ${css.actionIco}`, disabled: isBusy, onClick: onAct(batchNo, 'resume'), title: "\u6062\u590D\u6279\u6B21", "aria-label": "\u6062\u590D", children: "\u25B6" })] })), _jsx("button", { type: "button", className: `${css.iconBtn} ${css.actionIco}`, disabled: isBusy, onClick: onResumeBack(batchNo), title: "\u65AD\u70B9\u7EED\u8DD1", "aria-label": "\u65AD\u70B9\u7EED\u8DD1", children: "\u21BB" }), _jsx("button", { type: "button", className: `${css.iconBtn} ${css.actionIco}`, disabled: isBusy, onClick: () => {
                                    void doViewResult(batchNo);
                                }, title: "\u7ED3\u679C JSON\uFF08\u6253\u5F00\u72EC\u7ACB\u8BE6\u60C5 tab\uFF09", "aria-label": "\u7ED3\u679C JSON", children: '{}' }), _jsx("button", { type: "button", className: `${css.iconBtn} ${css.actionIco}`, disabled: isBusy, onClick: () => {
                                    void doDownloadResult(batchNo);
                                }, title: "\u4E0B\u8F7D\u7ED3\u679C JSON", "aria-label": "\u4E0B\u8F7D", children: "\u21E9" })] })] }) }, batchNo));
    };
    const renderConfig = () => {
        return (_jsxs("div", { className: css.card, children: [_jsxs("div", { className: css.cardHead, children: [_jsx("span", { className: css.cardIcon, children: "\u2699\uFE0F" }), _jsx("span", { className: css.cardTitle, children: "\u5F15\u64CE\u914D\u7F6E" })] }), _jsxs("div", { className: css.fieldRow, children: [_jsx("span", { className: css.fieldLabel, children: "\u5E76\u53D1" }), _jsx("input", { className: `${css.input} ${css.configInput}`, value: concurrentInput, placeholder: "\u5E76\u53D1\u69FD\u6570", onChange: e => setConcurrentInput(e.target.value) }), _jsx("span", { className: css.fieldLabel, children: "\u6279\u5927\u5C0F" }), _jsx("input", { className: `${css.input} ${css.configInput}`, value: batchSizeInput, placeholder: "\u6BCF\u6279\u6761\u6570", onChange: e => setBatchSizeInput(e.target.value) }), _jsx("button", { type: "button", className: css.configBtn, disabled: configBusy, onClick: () => {
                                void doApplyConfig();
                            }, children: configBusy ? _jsx("span", { className: css.spinner }) : '应用' })] }), configMsg !== null && (_jsx("div", { className: `${css.msg} ${configMsgOk ? css.msgOk : css.msgErr}`, children: configMsg }))] }));
    };
    /** 分页条：上一页 / 页码 / 下一页 / 总数 + 页大小下拉。
     * 仅在有批次且 pageSize 不是 'all' 时显示完整控件；'all' 时只展示总数。 */
    const renderPagination = () => {
        const total = batches.length;
        if (total === 0)
            return null;
        const all = pageSize === 'all';
        const canPrev = !all && currentPage > 1;
        const canNext = !all && currentPage < totalPages;
        const sizeLabel = all ? '全部' : `每页 ${pageSize}`;
        return (_jsxs("div", { className: css.pagination, role: "navigation", "aria-label": "\u6279\u6B21\u5206\u9875", children: [_jsx("button", { type: "button", className: css.paginationBtn, disabled: !canPrev, onClick: () => {
                        if (canPrev)
                            setCurrentPage(p => p - 1);
                    }, "aria-label": "\u4E0A\u4E00\u9875", title: "\u4E0A\u4E00\u9875", children: "\u2039" }), _jsxs("span", { className: css.paginationInfo, children: [all ? '全部' : (_jsxs(_Fragment, { children: ["\u7B2C ", _jsx("b", { children: currentPage }), "/", _jsx("b", { children: totalPages }), " \u9875"] })), _jsxs("span", { className: css.paginationTotal, children: ["\u00B7 \u5171 ", _jsx("b", { children: total }), " \u6279"] })] }), _jsx("button", { type: "button", className: css.paginationBtn, disabled: !canNext, onClick: () => {
                        if (canNext)
                            setCurrentPage(p => p + 1);
                    }, "aria-label": "\u4E0B\u4E00\u9875", title: "\u4E0B\u4E00\u9875", children: "\u203A" }), _jsx("span", { className: css.spacer }), _jsx("span", { className: css.paginationSizeLabel, children: "\u9875\u5927\u5C0F" }), _jsx("select", { className: css.paginationSizeSelect, value: pageSize === 'all' ? 'all' : String(pageSize), onChange: e => {
                        const v = e.target.value;
                        setPageSize(v === 'all' ? 'all' : Number(v));
                        setCurrentPage(1);
                    }, title: "\u6BCF\u9875\u663E\u793A\u6761\u6570", "aria-label": "\u6BCF\u9875\u663E\u793A\u6761\u6570", children: PAGE_SIZE_OPTIONS.map(opt => (_jsx("option", { value: opt === 'all' ? 'all' : String(opt), children: opt === 'all' ? '全部' : opt }, opt))) }), _jsx("span", { className: css.paginationSizeHint, children: sizeLabel })] }));
    };
    const renderPrompts = () => {
        // prompts state 在组件顶层声明（见 state 段）
        return (_jsxs("div", { className: css.card, children: [_jsxs("div", { className: css.cardHead, children: [_jsx("span", { className: css.cardIcon, children: "\uD83D\uDCCB" }), _jsx("span", { className: css.cardTitle, children: "\u63D0\u793A\u8BCD" }), promptsFrom !== 'loading' && (_jsx("span", { className: css.promptSavedTag, title: promptsFrom === 'server'
                                ? '存在宿主侧 $DSH_HOME/qianxun/prompts.json：同一台机器的任何浏览器、任何端口看到的是同一份'
                                : '服务端存储不可用（非 web profile，或从其它机器访问），当前仅存在本浏览器 localStorage：换浏览器会看不到', children: promptsFrom === 'server' ? '服务端同步' : '仅本浏览器' })), _jsx("span", { className: css.spacer }), _jsx("button", { type: "button", className: css.btnGhost, onClick: onAddPrompt, title: "\u65B0\u589E\u63D0\u793A\u8BCD", "aria-label": "\u65B0\u589E\u63D0\u793A\u8BCD", children: "\uFF0B \u65B0\u589E" })] }), prompts.length === 0 ? (_jsxs("div", { className: css.empty, children: [_jsx("span", { className: css.emptyIcon, children: "\uD83D\uDCC4" }), _jsxs("div", { children: [_jsx("div", { className: css.emptyTitle, children: "\u6682\u65E0\u63D0\u793A\u8BCD" }), _jsx("div", { className: css.emptySub, children: "\u70B9\u300C\uFF0B \u65B0\u589E\u300D\u521B\u5EFA\u7B2C\u4E00\u6761\u3002" })] })] })) : (_jsx("div", { className: css.promptList, children: prompts.map(p => (_jsxs("div", { className: css.promptItem, children: [_jsxs("button", { type: "button", className: css.promptName, onClick: () => openPrompt(p.id), title: `打开「${p.name}」编辑`, children: [_jsx("span", { className: css.promptItemIcon, children: "\uD83D\uDCC4" }), _jsx("span", { className: css.promptItemName, children: p.name })] }), _jsx("button", { type: "button", className: `${css.iconBtn} ${css.promptCopyBtn}`, onClick: () => {
                                    void copyPrompt(p.id).then(ok => {
                                        setCopyHintText(ok ? `已复制「${p.name}」` : '复制失败');
                                        setTimeout(() => setCopyHintText(null), 2000);
                                    });
                                }, title: "\u590D\u5236\u63D0\u793A\u8BCD\u5185\u5BB9", "aria-label": "\u590D\u5236", children: "\u29C9" })] }, p.id))) })), copyHintText !== null && (_jsx("div", { className: `${css.msg} ${css.msgOk}`, children: copyHintText }))] }));
    };
    /** 启动引擎：离线时先调常驻启动器(8766)拉起，再轮询等引擎就绪。 */
    const [engineStarting, setEngineStarting] = useState(false);
    const [engineBtnMsg, setEngineBtnMsg] = useState(null);
    const handleStartEngine = useCallback(() => {
        // 在线：只做个即时探测确认（点一下刷新状态）
        if (engineOnline === true) {
            void refresh();
            setEngineBtnMsg('✓ 引擎在线');
            setTimeout(() => setEngineBtnMsg(null), 2000);
            return;
        }
        // 离线：调常驻启动器 qianxund-ctl(8766) /api/start 真正拉起
        setEngineStarting(true);
        setEngineBtnMsg('正在启动引擎…');
        const ctlBase = 'http://127.0.0.1:8766';
        const token = 'qianxund-ctl';
        fetch(`${ctlBase}/api/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Api-Token': token },
            body: '{}',
        })
            .then(r => r.json().catch(() => ({})))
            .then(res => {
            const started = res?.started === true || res?.message === 'via launchd kickstart' || res?.ok === true;
            if (!started && res?.message !== 'already_running') {
                setEngineStarting(false);
                setEngineBtnMsg('⚠ 启动失败：' + (res?.error ?? res?.message ?? '未知错误'));
                setTimeout(() => setEngineBtnMsg(null), 5000);
                return;
            }
            // 已请求启动：轮询 8765 等就绪（最多 15s）
            let tries = 0;
            const timer = window.setInterval(() => {
                tries += 1;
                fetch(`${QIANXUN_BASE}/health`, { method: 'GET' })
                    .then(r => r.ok)
                    .catch(() => false)
                    .then(ok => {
                    if (ok) {
                        window.clearInterval(timer);
                        setEngineStarting(false);
                        setEngineBtnMsg('✓ 引擎已启动');
                        setTimeout(() => setEngineBtnMsg(null), 2500);
                        void refresh();
                    }
                    else if (tries >= 15) {
                        window.clearInterval(timer);
                        setEngineStarting(false);
                        setEngineBtnMsg('⚠ 引擎启动中，请稍候再刷新');
                        setTimeout(() => setEngineBtnMsg(null), 5000);
                    }
                });
            }, 1000);
        })
            .catch(cause => {
            setEngineStarting(false);
            setEngineBtnMsg('⚠ 启动器不可用：' + (cause instanceof Error ? cause.message : String(cause)));
            setTimeout(() => setEngineBtnMsg(null), 5000);
        });
    }, [engineOnline, refresh]);
    return (_jsxs("div", { className: css.root, children: [_jsxs("header", { className: css.header, children: [_jsx("span", { className: css.titleIcon, children: "\uD83E\uDDE0" }), _jsx("span", { className: css.title, children: "\u5343\u5BFB\u56DE\u6D4B" }), _jsxs("span", { className: css.quotaChip, title: "\u4ECA\u65E5\u63D0\u4EA4 / \u6BCF\u65E5\u5269\u4F59\u914D\u989D / \u91CD\u7F6E\u65F6\u95F4", children: [_jsx("span", { className: css.quotaLabel, children: "\u4ECA\u65E5" }), _jsx("b", { children: quota?.submitted_today ?? '—' }), _jsx("span", { className: css.quotaSep, children: "\u00B7" }), _jsx("span", { className: css.quotaLabel, children: "\u5269" }), quota?.quota?.limit !== undefined && quota.quota?.remaining !== undefined ? (_jsxs(_Fragment, { children: [_jsx("b", { children: quota.quota.remaining }), _jsx("span", { className: css.quotaSep, children: "/" }), _jsx("b", { children: quota.quota.limit }), (() => {
                                        const rs = quota.quota?.reset_sec;
                                        const rm = rs !== undefined && Number.isFinite(rs) ? Math.round(rs / 60) : null;
                                        return rm !== null ? _jsxs(_Fragment, { children: [_jsx("span", { className: css.quotaSep, children: "\u00B7" }), _jsxs("span", { children: [rm, "min"] })] }) : null;
                                    })()] })) : (_jsx("b", { children: "\u2014" }))] }), _jsx("span", { className: css.spacer }), _jsx("button", { type: "button", className: engineOnline ? css.startEngineBtnOnline : css.startEngineBtnOffline, onClick: handleStartEngine, disabled: engineStarting, title: engineOnline
                            ? '引擎运行中（launchd 托管，崩溃自动重启）。点击探测状态'
                            : engineStarting
                                ? '正在启动引擎…'
                                : '引擎离线。点击启动：launchd 会自动拉起（KeepAlive），稍候', "aria-label": "\u542F\u52A8\u5F15\u64CE", children: engineStarting
                            ? '⚡ 启动中…'
                            : engineOnline
                                ? '🟢 引擎在线'
                                : '⚡ 启动引擎' }), engineBtnMsg !== null && (_jsx("span", { className: `${css.startEngineToast} ${engineBtnMsg.startsWith('✓') ? css.startEngineToastOk : engineBtnMsg.startsWith('⚠') ? css.startEngineToastWarn : ''}`, children: engineBtnMsg })), _jsx("button", { type: "button", className: css.iconBtn, onClick: () => {
                            void refresh();
                        }, "aria-label": "\u5237\u65B0", title: "\u5237\u65B0", children: loading ? _jsx("span", { className: css.spinner }) : '⟳' })] }), _jsxs("div", { className: css.body, children: [error !== null && (_jsxs("div", { className: css.error, role: "alert", children: [error, _jsx("button", { type: "button", className: css.retryBtn, onClick: () => void refresh(), children: "\u91CD\u8BD5" })] })), renderPagination(), batches.length === 0 && error === null && (_jsxs("div", { className: css.empty, children: [_jsx("span", { className: css.emptyIcon, children: "\uD83D\uDDC2\uFE0F" }), _jsxs("div", { children: [_jsx("div", { className: css.emptyTitle, children: "\u8FD8\u6CA1\u6709\u56DE\u6D4B\u6279\u6B21" }), _jsx("div", { className: css.emptySub, children: "\u53EF\u901A\u8FC7\u4E0B\u65B9\u300C\u63D0\u4EA4\u6279\u6B21\u300D\u521B\u5EFA\uFF0C\u6216\u7B49\u5F85\u5F15\u64CE\u4EA7\u51FA\u3002" })] })] })), pageBatches.map(renderRow), renderConfig(), renderPrompts(), _jsxs("div", { className: css.statusFooter, children: ["\u5F15\u64CE ", _jsx("a", { href: QIANXUN_BASE, target: "_blank", rel: "noopener noreferrer", className: css.statusFooterLink, children: QIANXUN_BASE })] })] })] }));
}
//# sourceMappingURL=QianxunTab.js.map
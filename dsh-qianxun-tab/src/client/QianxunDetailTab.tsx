/**
 * 千寻批次详情 tab —— 展示某一批次的完整逐条回测结果。
 *
 * 由列表 tab（QianxunTab）通过 `ctx.betterSidebar.openTab({ type:'qianxun-detail',
 * title, meta:{ batchNo } })` 打开。`props.tab.meta.batchNo` 标识要展示的批次；
 * 无 batchNo 时显示“未指定批次”。5s 轮询（仅 visible 时）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { BetterSidebarTabComponentProps } from './better-sidebar.ts'
import type {
  QianxunAction,
  QianxunActiveAlphasResponse,
  QianxunAlphaCheck,
  QianxunBatchDetail,
  QianxunPnlResponse,
  QianxunProdCorrResponse,
} from './qianxun.ts'
import {
  actOnBatch,
  getActiveAlphas,
  getAlphaCheck,
  getAlphaProdCorr,
  getBackfillStatus,
  getBatchResult,
  getCachedPnl,
  getPnlCacheStatus,
  resumeBatch,
  startBackfillPnls,
  QIANXUN_BASE,
} from './qianxun.ts'
import {
  classifyLadderRisk,
  classifyMargin,
  computeLocalSelfCorr,
  isDeadZoneField,
  isProdFreshField,
  isRunning,
  renderChecksList,
  renderMetricsTable,
} from './format.tsx'
import {
  PROD_CORR_DEAD_ZONE,
} from './wq-eval.ts'
import { AlphaPoolCard } from './AlphaPoolCard.tsx'
import css from './QianxunTab.module.css'

/** 从 tab meta 读取要展示的批次号。 */
function batchNoFromTab(props: BetterSidebarTabComponentProps): string | undefined {
  const meta = props.tab?.meta as { batchNo?: unknown } | undefined
  const raw = meta?.batchNo
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

export function QianxunDetailTab(props: BetterSidebarTabComponentProps): JSX.Element | null {
  const { visible } = props
  const batchNo = batchNoFromTab(props)

  const [detail, setDetail] = useState<QianxunBatchDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [jsonView, setJsonView] = useState<string | null>(null)

  // 单 alpha 的 BRAIN 详细 check 面板状态
  const [checkAlphaId, setCheckAlphaId] = useState<string | null>(null)
  const [checks, setChecks] = useState<QianxunAlphaCheck[] | null>(null)
  const [checkLoading, setCheckLoading] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)

  // 单 alpha 的 PROD_CORRELATION 拉取状态（按行）
  const [prodCorrAlphaId, setProdCorrAlphaId] = useState<string | null>(null)
  const [prodCorr, setProdCorr] = useState<QianxunProdCorrResponse | null>(null)
  const [prodCorrLoading, setProdCorrLoading] = useState(false)
  const [prodCorrError, setProdCorrError] = useState<string | null>(null)

  // 单 alpha 的本地 SELF_CORRELATION 核对（PnL 下载 + Pearson）
  const [localAlphaId, setLocalAlphaId] = useState<string | null>(null)
  const [localLoading, setLocalLoading] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const [localResult, setLocalResult] = useState<ReturnType<typeof computeLocalSelfCorr> | null>(null)

  // 本地 PnL 缓存状态（侧边栏 header 展示用）
  const [cacheStatus, setCacheStatus] = useState<Awaited<ReturnType<typeof getPnlCacheStatus>> | null>(null)
  // BRAIN ACTIVE alpha_ids（与 BRAIN SELF_CORRELATION 真实对比集同口径）
  const [activeAlphas, setActiveAlphas] = useState<Awaited<ReturnType<typeof getActiveAlphas>> | null>(null)
  // PnL 批量回填任务状态
  const [backfill, setBackfill] = useState<Awaited<ReturnType<typeof getBackfillStatus>> | null>(null)
  const [backfillJobId, setBackfillJobId] = useState<string | null>(null)

  const refreshCacheStatus = useCallback(async (): Promise<void> => {
    try {
      const [s, a] = await Promise.all([getPnlCacheStatus(), getActiveAlphas()])
      setCacheStatus(s)
      setActiveAlphas(a)
    } catch {
      // 静默失败，不影响主流程
    }
  }, [])

  // 加载 + 可见时 60s 刷新（ACTIVE 5 min 缓存，前端多刷也无意义，60s 足矣）
  useEffect(() => {
    if (!visible) return
    void refreshCacheStatus()
    const timer = window.setInterval(() => { void refreshCacheStatus() }, 60000)
    return () => window.clearInterval(timer)
  }, [visible, refreshCacheStatus])

  /** 启动回填任务：异步，不阻塞 UI。完成后自动刷新缓存状态。 */
  const doStartBackfill = useCallback(async (): Promise<void> => {
    try {
      const start = await startBackfillPnls({})
      setBackfillJobId(start.job_id)
      setBackfill({
        status: 'running',
        total: start.total,
        done: 0,
        errors: [],
        region: null,
      })
    } catch (cause) {
      // 启动失败也静默
      void cause
    }
  }, [])

  // 回填任务运行时：每 2 s 轮询一次进度，结束/失败时停
  useEffect(() => {
    if (backfillJobId === null) return
    if (backfill === null || backfill.status === 'running') {
      const timer = window.setInterval(async () => {
        try {
          const s = await getBackfillStatus(backfillJobId)
          setBackfill(s)
          if (s.status !== 'running') {
            // 任务结束：刷新缓存 + 清 job_id
            void refreshCacheStatus()
            setTimeout(() => setBackfillJobId(null), 2000)
          }
        } catch {
          // 单次轮询失败不影响下一轮
        }
      }, 2000)
      return () => window.clearInterval(timer)
    }
  }, [backfillJobId, backfill?.status, refreshCacheStatus])

  const load = useCallback(async () => {
    if (batchNo === undefined) return
    setLoading(true)
    setError(null)
    try {
      const d = await getBatchResult(batchNo)
      setDetail(d)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [batchNo])

  // 轮询：visible 时立即加载 + 每 5s 刷新。
  useEffect(() => {
    if (!visible || batchNo === undefined) return
    void load()
    const timer = window.setInterval(() => {
      void load()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [visible, batchNo, load])

  // 从隐藏回到可见时补一次刷新。
  const prevVisible = useRef<boolean | null>(null)
  useEffect(() => {
    if (visible && prevVisible.current === false) void load()
    prevVisible.current = visible
  }, [visible, load])

  const runAction = useCallback(
    async (action: () => Promise<unknown>) => {
      if (batchNo === undefined) return
      setBusy(true)
      try {
        await action()
        await load()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [batchNo, load],
  )

  const onAct = (action: QianxunAction) => () => runAction(() => actOnBatch(batchNo as string, action))
  const onResumeBack = () => () => runAction(() => resumeBatch(batchNo as string))

  const doViewResult = async (): Promise<void> => {
    if (batchNo === undefined) return
    try {
      const d = await getBatchResult(batchNo)
      setJsonView(JSON.stringify(d, null, 2))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  /** 触发单 alpha 的 BRAIN check 拉取。*/
  const doCheckAlpha = useCallback(async (alphaId: string): Promise<void> => {
    setCheckAlphaId(alphaId)
    setCheckLoading(true)
    setCheckError(null)
    setChecks(null)
    try {
      const resp = await getAlphaCheck(alphaId)
      // BRAIN 返回结构：{"is": {"checks": [...]}}。取 is.checks。
      const list: QianxunAlphaCheck[] = resp.is?.checks ?? []
      setChecks(list)
    } catch (cause) {
      setCheckError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setCheckLoading(false)
    }
  }, [])

  const closeCheckPanel = useCallback((): void => {
    setCheckAlphaId(null)
    setChecks(null)
    setCheckError(null)
    setCheckLoading(false)
  }, [])

  /** 拉单 alpha 的 prod correlation 数值（不死等 check）。 */
  const doFetchProdCorr = useCallback(async (alphaId: string): Promise<void> => {
    setProdCorrAlphaId(alphaId)
    setProdCorrLoading(true)
    setProdCorrError(null)
    setProdCorr(null)
    try {
      const r = await getAlphaProdCorr(alphaId)
      setProdCorr(r)
    } catch (cause) {
      setProdCorrError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setProdCorrLoading(false)
    }
  }, [])

  const closeProdCorrPanel = useCallback((): void => {
    setProdCorrAlphaId(null)
    setProdCorr(null)
    setProdCorrError(null)
    setProdCorrLoading(false)
  }, [])

  /** 本地核对 SELF_CORRELATION：与本地 PnL 缓存 ∩ ACTIVE 比（与 BRAIN 真实口径对齐）。
   * 候选集 = `cache ∩ ACTIVE - {self}`：
   * - cache = 已下载 PnL 的所有 alpha（包含已退出 active 的）
   * - ACTIVE = BRAIN 当前活跃组合（与 SELF_CORRELATION 同口径）
   * - 交集 = BRAIN 实际对比的子集
   * 首次访问会触发 qianxund 写缓存；二次秒出。 */
  const doLocalSelfCorr = useCallback(
    async (targetAlphaId: string): Promise<void> => {
      setLocalAlphaId(targetAlphaId)
      setLocalLoading(true)
      setLocalError(null)
      setLocalResult(null)
      try {
        // 0. 拉最新 ACTIVE 列表（防 TTL 过期——缓存是 5 min，本地核对前刷新更稳）
        let active: QianxunActiveAlphasResponse | null = activeAlphas
        if (active === null) {
          active = await getActiveAlphas()
          setActiveAlphas(active)
        }
        const activeSet = new Set(active.ids)
        // 1. 取目标 PnL（qianxund 自动 fallback BRAIN + 写盘）
        const targetResp: QianxunPnlResponse = await getCachedPnl(targetAlphaId)
        // 2. 候选集 = 本地缓存 ∩ ACTIVE（除自己）
        const cache = await getPnlCacheStatus()
        const otherIds = cache.items
          .map(it => it.alpha_id)
          .filter(aid => aid !== targetAlphaId && activeSet.has(aid))
        if (otherIds.length === 0) {
          const activeCachedCount = cache.items.filter(it => activeSet.has(it.alpha_id)).length
          setLocalError(
            activeCachedCount === 0
              ? '本地 PnL 缓存里没有任何 ACTIVE 的 alpha——需要先把 ACTIVE alpha 的 PnL 缓存到本地'
              : '除自己外，缓存里没有可对比的 ACTIVE alpha',
          )
          return
        }
        // 3. 候选 PnL 都走本地缓存
        const candResps = await Promise.all(
          otherIds.map(async aid => {
            try {
              const p = await getCachedPnl(aid)
              return { alphaId: aid, records: p.records }
            } catch {
              return { alphaId: aid, records: [] }
            }
          }),
        )
        const validCands = candResps.filter(c => c.records.length > 0)
        if (validCands.length === 0) {
          setLocalError('候选 PnL 全部为空，无法计算')
          return
        }
        // 4. 浏览器内算 Pearson
        const result = computeLocalSelfCorr(targetResp.records, validCands)
        setLocalResult(result)
        // 5. 刷新缓存状态（新增了目标 alpha 的条目）
        void refreshCacheStatus()
      } catch (cause) {
        setLocalError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setLocalLoading(false)
      }
    },
    [activeAlphas, refreshCacheStatus],
  )

  const closeLocalPanel = useCallback((): void => {
    setLocalAlphaId(null)
    setLocalResult(null)
    setLocalError(null)
    setLocalLoading(false)
  }, [])

  const doDownloadResult = async (): Promise<void> => {
    if (batchNo === undefined) return
    try {
      const d = await getBatchResult(batchNo)
      const blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${batchNo}-result.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  // 无批次号：本页仍要能用 —— 顶部那句死路提示换成 Alpha 自选池（存 alpha_id 的地方）。
  if (batchNo === undefined) {
    return (
      <div className={css.root}>
        <header className={css.header}>
          <span className={css.titleIcon}>🔎</span>
          <span className={css.title}>千寻结果</span>
          <span className={css.spacer} />
          <button
            type="button"
            className={css.iconBtn}
            onClick={() => { void refreshCacheStatus() }}
            title="刷新"
            aria-label="刷新"
          >
            ⟳
          </button>
        </header>
        <div className={css.body}>
          <AlphaPoolCard visible={visible} />
          <div className={css.emptySub}>
            想看某个批次的逐条结果：回「千寻回测」列表，点该批次的「详情」按钮。
          </div>
          <div className={css.statusFooter}>
            引擎 {QIANXUN_BASE}
          </div>
        </div>
      </div>
    )
  }

  const running = detail !== null && isRunning(detail.state)
  const done = Math.min(detail?.done ?? 0, detail?.total ?? detail?.done ?? 0)
  const total = detail?.total ?? 0
  const pct = total > 0 ? Math.round((done / total) * 100) : detail ? 100 : 0

  /** 稳健性快评卡：基于已加载的逐条结果（无需新 API）。
   * 检查项：
   *  1. IS_LADDER_SHARPE 风险（避免给必败 alpha 浪费 check）
   *  2. prod_fresh 字段加分（薄 margin 但字段新 → 仍可推）
   *  3. 雷区字段告警（prod_corr >= 0.70 概率大）
   */
  const renderRobustnessCard = (): ReactNode | null => {
    const results = detail?.results ?? []
    if (results.length === 0) return null
    const issues: Array<{ alphaIdx: number; tag: 'certain_fail' | 'dead_zone'; msg: string }> = []
    const freshHits: Array<{ alphaIdx: number; field: string }> = []
    for (const r of results) {
      const ladder = r.metrics?.sharpe
      const ladderRisk = classifyLadderRisk(typeof ladder === 'number' ? ladder : null)
      if (ladderRisk === 'certain_fail') {
        issues.push({
          alphaIdx: r.idx,
          tag: 'certain_fail',
          msg: `idx ${r.idx} LADDER 必败 (sharpe=${ladder})`,
        })
      }
      const fresh = isProdFreshField(r.expression ?? null)
      if (fresh.hit && fresh.field !== undefined) {
        freshHits.push({ alphaIdx: r.idx, field: fresh.field })
      }
      const dead = isDeadZoneField(r.expression ?? null)
      if (dead.hit && dead.field !== undefined) {
        issues.push({
          alphaIdx: r.idx,
          tag: 'dead_zone',
          msg: `idx ${r.idx} 字段 ${dead.field}${dead.note !== undefined ? ' · ' + dead.note : ''}`,
        })
      }
    }
    const hasIssues = issues.length > 0
    const hasFresh = freshHits.length > 0
    if (!hasIssues && !hasFresh) return null
    return (
      <div className={css.card}>
        <div className={css.cardHead}>
          <span className={css.cardIcon}>🛡️</span>
          <span className={css.cardTitle}>稳健性快评（{results.length} 条）</span>
        </div>
        {hasIssues && (
          <div className={css.issueList}>
            {issues.map((it, i) => (
              <div key={i} className={`${css.issueRow} ${it.tag === 'certain_fail' ? css.issueDanger : css.issueWarn}`}>
                <span className={css.issueTag}>
                  {it.tag === 'certain_fail' ? '必败' : '雷区'}
                </span>
                <span className={css.issueMsg}>{it.msg}</span>
              </div>
            ))}
          </div>
        )}
        {hasFresh && (
          <div className={css.freshList}>
            <div className={css.metaLine}>
              <span className={css.freshTag}>prod-fresh</span>
              {freshHits.length} 条字段新（prod 信号未饱和）：
            </div>
            {freshHits.map((f, i) => (
              <div key={i} className={css.freshRow}>
                <code className={css.freshField}>{f.field}</code>
              </div>
            ))}
          </div>
        )}
        <div className={css.metaLine}>
          点击下方任一 alpha 行的 🔍 看 BRAIN 详细 checks；点击 📈 看真 prod_corr；
          点击 📐 <b>本地</b>立即算 SELF_CORRELATION（无须等 BRAIN PENDING）。
        </div>
      </div>
    )
  }

  /** 单 alpha 的 PROD_CORRELATION 拉取面板。 */
  const renderProdCorrPanel = (): ReactNode | null => {
    if (prodCorrAlphaId === null) return null
    const max = prodCorr?.max ?? null
    const min = prodCorr?.min ?? null
    const deadZone = max !== null && max >= PROD_CORR_DEAD_ZONE
    const tier = max !== null ? classifyMargin(max) : null
    return (
      <div className={css.card}>
        <div className={css.cardHead}>
          <span className={css.cardIcon}>📈</span>
          <span className={css.cardTitle}>prod correlation · {prodCorrAlphaId}</span>
          <span className={css.spacer} />
          <button
            type="button"
            className={css.iconBtn}
            onClick={closeProdCorrPanel}
            title="关闭"
            aria-label="关闭 prod corr 面板"
          >
            ✕
          </button>
        </div>
        {prodCorrLoading && <div className={css.metaLine}>拉取中…（BRAIN 首次常空，引擎已自动重试 3 次）</div>}
        {prodCorrError !== null && (
          <div className={`${css.msg} ${css.msgErr}`}>{prodCorrError}</div>
        )}
        {prodCorr !== null && !prodCorrLoading && prodCorrError === null && (
          <>
            <div className={css.prodCorrRow}>
              <span className={css.prodCorrLabel}>max</span>
              <span className={`${css.prodCorrValue} ${deadZone ? css.valNeg : css.valPos}`}>
                {max === null ? '—' : max.toFixed(4)}
              </span>
              <span className={css.prodCorrLabel}>min</span>
              <span className={css.prodCorrValue}>
                {min === null ? '—' : min.toFixed(4)}
              </span>
              <span className={css.spacer} />
              {tier !== null && (
                <span className={`${css.tierBadge} ${css[`tier_${tier.label}`] ?? ''}`}>
                  {tier.label} · margin {tier.margin.toFixed(4)}
                </span>
              )}
            </div>
            {deadZone && (
              <div className={`${css.msg} ${css.msgErr}`}>
                ⚠️ max prod_corr ≥ {PROD_CORR_DEAD_ZONE} 死区线，此 alpha 大概率 submission FAIL
              </div>
            )}
            {!deadZone && max !== null && (
              <div className={`${css.msg} ${css.msgOk}`}>
                ✓ 安全边际 {tier?.margin.toFixed(4) ?? '?'}（死区线 {PROD_CORR_DEAD_ZONE}）
              </div>
            )}
            <div className={css.metaLine}>候选集：{prodCorr.records.length} 条</div>
          </>
        )}
      </div>
    )
  }

  /** 单 alpha 的本地 SELF_CORRELATION 核对面板。 */
  const renderLocalPanel = (): ReactNode | null => {
    if (localAlphaId === null) return null
    return (
      <div className={css.card}>
        <div className={css.cardHead}>
          <span className={css.cardIcon}>📐</span>
          <span className={css.cardTitle}>本地 SELF_CORRELATION · {localAlphaId}</span>
          <span className={css.spacer} />
          <button
            type="button"
            className={css.iconBtn}
            onClick={closeLocalPanel}
            title="关闭"
            aria-label="关闭本地核对面板"
          >
            ✕
          </button>
        </div>
        {localLoading && (
          <div className={css.metaLine}>
            下载 PnL 并算 Pearson…（每多 1 个候选 +1 次请求；通常 ~3s/批）
          </div>
        )}
        {localError !== null && (
          <div className={`${css.msg} ${css.msgErr}`}>{localError}</div>
        )}
        {localResult !== null && !localLoading && localError === null && (
          <>
            <div className={css.prodCorrRow}>
              <span className={css.prodCorrLabel}>候选数</span>
              <span className={css.prodCorrValue}>{localResult.perCandidate.length}</span>
              <span className={css.prodCorrLabel}>target 日数</span>
              <span className={css.prodCorrValue}>{localResult.targetDays}</span>
              <span className={css.spacer} />
              {localResult.max !== null && (
                <span className={`${css.tierBadge} ${localResult.max >= PROD_CORR_DEAD_ZONE ? css.tier_tight : ''}`}>
                  max = {localResult.max.toFixed(4)}
                </span>
              )}
            </div>
            <div className={css.checksList}>
              {localResult.perCandidate.map((c, i) => {
                const v = c.corr
                const isDead = v !== null && v !== undefined && v >= PROD_CORR_DEAD_ZONE
                return (
                  <div key={i} className={css.checkItem}>
                    <span className={css.checkItemName} title={c.alphaId}>
                      {c.alphaId.slice(0, 14)}{c.alphaId.length > 14 ? '…' : ''}
                    </span>
                    <span className={css.checkItemMeta}>{c.overlapDays}d 对齐</span>
                    <span className={css.checkItemResult}>
                      {v === null || v === undefined ? (
                        <span className={css.bNone}>n/a</span>
                      ) : isDead ? (
                        <span className={css.bFail}>{v.toFixed(3)}</span>
                      ) : (
                        <span className={css.bPass}>{v.toFixed(3)}</span>
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
            <div className={css.metaLine}>
              BRAIN SELF_CORRELATION 还 PENDING 时本面板立即可读；PASS 后两者差异 ≤ 0.05
              （本地 = raw daily PnL 增量 Pearson；BRAIN = 4-year rolling Pearson）。
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <div className={css.root}>
      <header className={css.header}>
        <span className={css.titleIcon}>🔬</span>
        <span className={css.title}>{batchNo} 结果</span>
        <span
          className={css.cacheBadge}
          title={
            cacheStatus === null
              ? 'PnL 缓存加载中…'
              : `本地 PnL 缓存：${cacheStatus.cache_dir}\n` +
                `· 共 ${cacheStatus.count} 个 alpha · ${(cacheStatus.total_bytes / 1024).toFixed(0)} KB\n` +
                (activeAlphas !== null
                  ? `· 🟢 ACTIVE（与 BRAIN 同口径）${activeAlphas.count} 个\n` +
                    `· SELF_CORRELATION 对比基线 = 缓存 ∩ ACTIVE`
                  : '')
          }
        >
          📦 {cacheStatus === null
            ? '缓存…'
            : `${cacheStatus.count} 个`}
          {activeAlphas !== null && (
            <span className={css.cacheBadgeActive}>· 🟢 {activeAlphas.count} ACTIVE</span>
          )}
          {backfill !== null && backfill.status === 'running' && (
            <span className={css.cacheBadgeBackfill}>
              · 🔄 {backfill.done}/{backfill.total}
            </span>
          )}
          {backfill !== null && backfill.status === 'partial' && (
            <span className={css.cacheBadgePartial} title="部分失败，可重试">
              · ⚠️ 部分 {backfill.done}/{backfill.total}
            </span>
          )}
          {backfill !== null && backfill.status === 'captcha_blocked' && (
            <span className={css.cacheBadgeCaptcha} title={backfill.stopped_reason ?? 'BRAIN 触发人机验证'}>
              · 🤖 captcha
            </span>
          )}
        </span>
        <button
          type="button"
          className={css.backfillBtn}
          onClick={() => { void doStartBackfill() }}
          disabled={backfill?.status === 'running'}
          title={
            backfill?.status === 'running'
              ? `同步中：${backfill.done}/${backfill.total}`
              : '从 BRAIN 拉取当前 ACTIVE 列表里所有未缓存的 PnL 存到本地（多次点击可累积）'
          }
        >
          {backfill?.status === 'running' ? '🔄 同步中…' : '🔄 同步 ACTIVE'}
        </button>
        <span className={css.spacer} />
        <span className={`${css.dot} ${isRunning(detail?.state) ? css.dotRunning : detail?.state === 'error' ? css.dotError : css.dotOk}`} />
        <button
          type="button"
          className={css.iconBtn}
          onClick={() => {
            void load()
          }}
          title="刷新"
          aria-label="刷新"
        >
          ⟳
        </button>
      </header>

      <div className={css.body}>
        <AlphaPoolCard
          visible={visible}
          onInspect={alphaId => { void doCheckAlpha(alphaId) }}
        />

        {error !== null && (
          <div className={css.error} role="alert">
            {error}
            <button type="button" className={css.retryBtn} onClick={() => void load()}>
              重试
            </button>
          </div>
        )}

        {detail === null && error === null && (
          <div className={css.empty}>
            <span className={css.emptyIcon}>⏳</span>
            <span>{loading ? '加载中…' : '等待加载…'}</span>
          </div>
        )}

        {detail !== null && (
          <>
            <div className={css.summaryCard}>
              <div className={css.summaryRow}>
                <span className={css.batchId}>{batchNo}</span>
                <span className={`${css.badge} ${running ? css.badgeRunning : detail.state === 'error' ? css.badgeError : css.badgeDone}`}>
                  {detail.state ?? '—'}
                </span>
                {detail.name !== undefined && detail.name !== null && detail.name !== '' && (
                  <span className={css.summaryName}>{detail.name}</span>
                )}
                <span className={css.spacer} />
                <span className={css.summaryMeta}>已测 {done}/{total}</span>
              </div>
              {total > 0 && (
                <div className={css.progressTrack}>
                  <div
                    className={`${css.progressFill} ${running ? css.progressRunning : detail.state === 'error' ? css.progressError : css.progressDone}`}
                    style={{ width: `${pct}%` }}
                  />
                  <span className={css.progressText}>{pct}%</span>
                </div>
              )}
            </div>

            <div className={css.toolbar}>
              <button
                type="button"
                className={`${css.iconBtn} ${css.actionIco}`}
                disabled={busy || !running}
                onClick={onAct('pause')}
                title="暂停批次"
              >
                ⏸
              </button>
              <button
                type="button"
                className={`${css.iconBtn} ${css.actionIco}`}
                disabled={busy || !running}
                onClick={onAct('resume')}
                title="恢复批次"
              >
                ▶
              </button>
              <button
                type="button"
                className={`${css.iconBtn} ${css.actionIco} ${css.actionDanger}`}
                disabled={busy}
                onClick={onAct('cancel')}
                title="取消批次"
              >
                ✕
              </button>
              <button
                type="button"
                className={`${css.iconBtn} ${css.actionIco}`}
                disabled={busy}
                onClick={onResumeBack()}
                title="断点续跑"
              >
                ↻
              </button>
              <span className={css.spacer} />
              <button
                type="button"
                className={css.btnGhost}
                disabled={busy}
                onClick={() => void doViewResult()}
                title="查看结果 JSON"
              >
                JSON
              </button>
              <button
                type="button"
                className={css.btnGhost}
                disabled={busy}
                onClick={() => void doDownloadResult()}
                title="下载结果 JSON"
              >
                ⇩ 下载
              </button>
            </div>

            {jsonView !== null && (
              <div className={css.card}>
                <div className={css.cardHead}>
                  <span className={css.cardTitle}>结果 JSON</span>
                  <button type="button" className={css.iconBtn} onClick={() => setJsonView(null)} title="关闭">
                    ✕
                  </button>
                </div>
                <pre className={css.pre}>{jsonView}</pre>
              </div>
            )}

            <div className={css.card}>
              <div className={css.cardHead}>
                <span className={css.cardTitle}>逐条结果（{detail.results?.length ?? 0}）</span>
              </div>
              {renderMetricsTable(
                detail.results,
                {
                  onCheck: alphaId => { void doCheckAlpha(alphaId) },
                  onProdCorr: alphaId => { void doFetchProdCorr(alphaId) },
                  onLocalSelf: alphaId => { void doLocalSelfCorr(alphaId) },
                },
              )}
            </div>

            {renderRobustnessCard()}
            {renderProdCorrPanel()}
            {renderLocalPanel()}

            {checkAlphaId !== null && (
              <div className={css.card}>
                <div className={css.cardHead}>
                  <span className={css.cardIcon}>🔍</span>
                  <span className={css.cardTitle}>
                    BRAIN check · {checkAlphaId}
                  </span>
                  <span className={css.spacer} />
                  <button
                    type="button"
                    className={css.iconBtn}
                    onClick={closeCheckPanel}
                    title="关闭"
                    aria-label="关闭 check 面板"
                  >
                    ✕
                  </button>
                </div>
                {checkLoading && (
                  <div className={css.metaLine}>加载中…</div>
                )}
                {checkError !== null && (
                  <div className={css.msg + ' ' + css.msgErr}>{checkError}</div>
                )}
                {checks !== null && !checkLoading && checkError === null && renderChecksList(checks)}
              </div>
            )}
          </>
        )}

        <div className={css.statusFooter}>
          引擎 {QIANXUN_BASE}
        </div>
      </div>
    </div>
  )
}

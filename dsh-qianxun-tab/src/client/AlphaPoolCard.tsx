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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {
  QianxunActiveStats,
  QianxunPoolResponse,
  QianxunSubmitJob,
} from './qianxun.ts'
import {
  getActiveStats,
  getAlphaCheck,
  getAlphaPool,
  getSubmitJob,
  mutateAlphaPool,
  setAlphaPoolNote,
  submitAlphas,
  syncAlphaPool,
} from './qianxun.ts'
import { fmt } from './format.tsx'
import { PROD_CORR_DEAD_ZONE } from './wq-eval.ts'
import css from './QianxunTab.module.css'

/** 一次最多提交几个（与引擎侧 _SUBMIT_MAX_IDS 对齐）。 */
const SUBMIT_MAX_IDS = 5
/** 提交任务轮询间隔（毫秒）。 */
const SUBMIT_POLL_MS = 4000

/** 提交状态（active/unsubmit）→ 展示元信息。 */
const STATUS_META: Record<string, { label: string; cls: string; hint: string }> = {
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
}

/** 提交结论 → 展示元信息。 */
const SUBMIT_META: Record<string, { label: string; cls: string }> = {
  queued: { label: '排队中', cls: 'submitQueued' },
  submitted: { label: '已提交', cls: 'submitOk' },
  blocked: { label: '提交被拒', cls: 'submitBad' },
  failed: { label: '提交失败', cls: 'submitBad' },
  timeout: { label: '提交超时', cls: 'submitBad' },
  pending: { label: '待续查', cls: 'submitWarn' },
}

/** 把任意 status 字符串映射到展示元信息（未知态原样显示）。 */
function statusMeta(status: string | null | undefined): { label: string; cls: string; hint: string } {
  const key = String(status ?? 'unknown').toLowerCase()
  return STATUS_META[key] ?? { label: key, cls: 'poolUnknown', hint: `BRAIN 状态：${key}` }
}

/** 把任意提交状态映射到展示元信息。 */
function submitMeta(state: string | null | undefined): { label: string; cls: string } | null {
  if (state === null || state === undefined || state === '') return null
  return SUBMIT_META[state] ?? { label: state, cls: 'submitWarn' }
}

/** `err`（fetch 抛出的错误）是否表示「引擎还没这个接口」。 */
function isMissingEndpoint(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /qianxun 404\b/.test(msg) || /not found/i.test(msg)
}

/** margin 按用户口径以「万分之一」为单位显示：0.000783 → 7.83。 */
function fmtWan(v: unknown): string {
  if (typeof v !== 'number' || Number.isNaN(v)) return '—'
  return String(parseFloat((v * 10000).toPrecision(3)))
}

/** PASS/FAIL/WARNING/PENDING → 已有徽章类（css 模块索引带 undefined，故返回可空）。 */
function statusBadgeCls(result: string): string | undefined {
  const r = result.toUpperCase()
  if (r === 'PASS') return css.bPass
  if (r === 'FAIL') return css.bFail
  if (r === 'WARNING' || r === 'WARN') return css.bWarn
  return css.bNone
}

/** 相关性单元格：数值 + PASS/FAIL 徽章竖排，>= 死区线标红。 */
function corrCell(value: number | null | undefined, result: string | null | undefined): ReactNode {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return result ? <span className={statusBadgeCls(result)}>{String(result).toLowerCase()}</span>
      : <span className={css.bNone}>—</span>
  }
  const dead = value >= PROD_CORR_DEAD_ZONE
  return (
    <span className={css.poolCorrCell}>
      <span className={dead ? css.valNeg : css.valPos}
        title={dead ? `≥ 死区线 ${PROD_CORR_DEAD_ZONE}` : undefined}>
        {fmt(value)}
      </span>
      {result !== null && result !== undefined && result !== '' && (
        <span className={statusBadgeCls(result)}>{String(result).toLowerCase()}</span>
      )}
    </span>
  )
}

/** 复制到剪贴板。优先 Clipboard API，回落 execCommand（本机 http 下两者都可用）。 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 落到兜底
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/** 把输入的文本解析成去重保序的 alpha_id 列表（与引擎侧同口径）。 */
function parseIds(raw: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const chunk of raw.split(/[\s,;]+/)) {
    const s = chunk.trim()
    if (/^[A-Za-z0-9]{4,16}$/.test(s) && !seen.has(s)) {
      seen.add(s)
      out.push(s)
    }
  }
  return out
}

/** 从 check 响应里挑出 FAIL 项名字。 */
function failNames(payload: unknown): string[] {
  const checks = (payload as { is?: { checks?: Array<Record<string, unknown>> } } | null)
    ?.is?.checks
  if (!Array.isArray(checks)) return []
  return checks
    .filter(c => String(c?.['result'] ?? '').toUpperCase() === 'FAIL')
    .map(c => String(c?.['name'] ?? '?'))
}

export interface AlphaPoolCardProps {
  /** 侧边栏 tab 是否可见（不可见时不打 BRAIN，避免后台无意义请求）。 */
  visible?: boolean
  /** 点某一行的 alpha_id 时回调（详情页用它打开已有的 BRAIN check 面板）。 */
  onInspect?: (alphaId: string) => void
}

export function AlphaPoolCard(props: AlphaPoolCardProps): JSX.Element {
  const { visible = true, onInspect } = props

  const [pool, setPool] = useState<QianxunPoolResponse | null>(null)
  const [stats, setStats] = useState<QianxunActiveStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [mutating, setMutating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [engineMissing, setEngineMissing] = useState(false)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)

  // 备注：按 id 存草稿，1s 防抖自动保存 + 回车/失焦立刻保存
  const [noteDraft, setNoteDraft] = useState<Record<string, string>>({})
  const [noteBusy, setNoteBusy] = useState<string | null>(null)
  const [noteSaved, setNoteSaved] = useState<string | null>(null)
  const noteTimers = useRef<Record<string, number>>({})

  // 复制反馈：记住刚复制过的 id，短暂显示 ✓
  const [copied, setCopied] = useState<string | null>(null)

  // 提交
  const [submitDraft, setSubmitDraft] = useState('')
  const [submitBusy, setSubmitBusy] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<QianxunSubmitJob | null>(null)
  const [submitMsg, setSubmitMsg] = useState<string | null>(null)

  const applyPool = useCallback((next: QianxunPoolResponse): void => {
    setPool(next)
  }, [])

  /** 读池子 + 当日 active（池子是本地；stats 会打一次 BRAIN，但吃引擎 5min 缓存）。 */
  const load = useCallback(async (opts: { withStats?: boolean } = {}): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const r = await getAlphaPool()
      setEngineMissing(false)
      applyPool(r)
    } catch (cause) {
      if (isMissingEndpoint(cause)) {
        setEngineMissing(true)
        setError(null)
      } else {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      setLoading(false)
    }
    if (opts.withStats !== false) {
      try {
        setStats(await getActiveStats())
      } catch {
        // stats 是锦上添花，失败不打扰用户
      }
    }
  }, [applyPool])

  useEffect(() => {
    if (!visible) return
    void load()
  }, [visible, load])

  // 当日 active 定时刷新（引擎侧 ACTIVE 列表有 5min 缓存，这里 2min 足够）
  useEffect(() => {
    if (!visible) return
    const timer = window.setInterval(() => {
      void getActiveStats().then(setStats).catch(() => {})
    }, 120000)
    return () => window.clearInterval(timer)
  }, [visible])

  // 提交任务轮询：跑完自动刷新池子（结论已落回条目）
  useEffect(() => {
    if (jobId === null) return
    let stop = false
    const tick = async (): Promise<void> => {
      try {
        const j = await getSubmitJob(jobId)
        if (stop) return
        setJob(j)
        if (j.running !== true) {
          setJobId(null)
          await load()
          return
        }
      } catch (cause) {
        if (!stop) setError(cause instanceof Error ? cause.message : String(cause))
        return
      }
      if (!stop) window.setTimeout(() => { void tick() }, SUBMIT_POLL_MS)
    }
    void tick()
    return () => { stop = true }
  }, [jobId, load])

  /** 加：支持一次粘一坨 id。 */
  const doAdd = useCallback(async (): Promise<void> => {
    const raw = draft.trim()
    if (raw === '') return
    setMutating(true)
    setError(null)
    setNotice(null)
    try {
      const r = await mutateAlphaPool('add', raw)
      applyPool(r)
      setDraft('')
      setEngineMissing(false)
      // 加完立刻同步一次，省得用户还要再点一下「同步」
      void (async () => {
        try {
          const synced = await syncAlphaPool()
          applyPool(synced)
          setNotice(syncNotice(synced))
        } catch {
          setNotice('已加入；BRAIN 数据未拉到，可点「同步」重试')
        }
      })()
    } catch (cause) {
      if (isMissingEndpoint(cause)) setEngineMissing(true)
      else setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setMutating(false)
    }
  }, [draft, applyPool])

  /** 删单条 / 清空。 */
  const doMutate = useCallback(async (
    action: 'remove' | 'clear',
    alphaId?: string,
  ): Promise<void> => {
    if (action === 'clear' &&
      !window.confirm('清空整个自选池？（只删本地名单，不动 BRAIN 上的 alpha）')) return
    setMutating(true)
    setError(null)
    try {
      const r = await mutateAlphaPool(action, alphaId)
      applyPool(r)
      setNotice(action === 'clear' ? '已清空自选池' : `已移除 ${alphaId ?? ''}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setMutating(false)
    }
  }, [applyPool])

  /** 同步：整池（ids 为空 = 全刷）或单条。 */
  const doSync = useCallback(async (ids?: string[]): Promise<void> => {
    setSyncing(true)
    setError(null)
    setNotice(null)
    try {
      const r = await syncAlphaPool(ids)
      applyPool(r)
      setNotice(syncNotice(r))
      setEngineMissing(false)
    } catch (cause) {
      if (isMissingEndpoint(cause)) setEngineMissing(true)
      else setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSyncing(false)
      void getActiveStats().then(setStats).catch(() => {})
    }
  }, [applyPool])

  /** 保存备注（1s 防抖 + 回车/失焦都会走到这里）。 */
  const saveNote = useCallback(async (alphaId: string, value: string): Promise<void> => {
    setNoteBusy(alphaId)
    try {
      const r = await setAlphaPoolNote(alphaId, value)
      applyPool(r)
      setNoteDraft(d => {
        if (d[alphaId] !== value) return d
        const next = { ...d }
        delete next[alphaId]
        return next
      })
      setNoteSaved(alphaId)
      window.setTimeout(() => {
        setNoteSaved(cur => (cur === alphaId ? null : cur))
      }, 1500)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setNoteBusy(null)
    }
  }, [applyPool])

  const onChangeNote = useCallback((alphaId: string, value: string): void => {
    setNoteDraft(d => ({ ...d, [alphaId]: value }))
    const timer = noteTimers.current[alphaId]
    if (timer !== undefined) window.clearTimeout(timer)
    noteTimers.current[alphaId] = window.setTimeout(() => {
      void saveNote(alphaId, value)
    }, 1000)
  }, [saveNote])

  /** 复制 alpha_id。 */
  const doCopy = useCallback(async (alphaId: string): Promise<void> => {
    const ok = await copyText(alphaId)
    if (ok) {
      setCopied(alphaId)
      window.setTimeout(() => setCopied(cur => (cur === alphaId ? null : cur)), 1200)
    } else {
      setError(`复制失败（浏览器拒绝），请手动选中 ${alphaId}`)
    }
  }, [])

  /**
   * 提交：先拉 check 列出 FAIL，确认后才真提交（两道闸）。
   *   1) 通用确认：不可逆 + 占额度
   *   2) 若有 FAIL：额外一次确认，把 FAIL 项摊开（默认拦住，但仍可强制提）
   */
  const doSubmit = useCallback(async (): Promise<void> => {
    const ids = parseIds(submitDraft)
    if (ids.length === 0) {
      setError('没有解析出合法 alpha_id（4-16 位字母数字）')
      return
    }
    if (ids.length > SUBMIT_MAX_IDS) {
      setError(`一次最多提交 ${SUBMIT_MAX_IDS} 个（提交不可逆，防手滑）；这次给了 ${ids.length} 个`)
      return
    }
    setSubmitBusy(true)
    setError(null)
    setSubmitMsg('正在拉取 check（提交前预检）…')
    try {
      const lines: string[] = []
      let failCount = 0
      for (const id of ids) {
        try {
          const checks = await getAlphaCheck(id)
          const fails = failNames(checks)
          if (fails.length > 0) {
            failCount++
            lines.push(`  ${id}  ✗ ${fails.join(', ')}`)
          } else {
            lines.push(`  ${id}  ✓ 预检未见 FAIL`)
          }
        } catch (cause) {
          lines.push(`  ${id}  ? 拿不到 check：${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }
      setSubmitMsg(null)

      const head = `真的要提交这 ${ids.length} 个 alpha 到 BRAIN 平台吗？\n\n` +
        '⚠️ 不可逆：会占用提交额度，并写进账号的 ACTIVE 组合。\n' +
        '提交后平台要算几十分钟到几小时，期间可以离开页面。\n'
      if (!window.confirm(`${head}\n提交前预检：\n${lines.join('\n')}`)) {
        setSubmitMsg('已取消提交')
        return
      }
      if (failCount > 0) {
        const warn = `⚠️ 其中 ${failCount} 条有 FAIL 项（平台多半会直接拒绝，白耗额度）：\n\n` +
          `${lines.filter(l => l.includes('✗')).join('\n')}\n\n确定还要提交吗？`
        if (!window.confirm(warn)) {
          setSubmitMsg('已取消提交（有 FAIL 项）')
          return
        }
      }
      const started = await submitAlphas(ids)
      if (started.job_id === undefined) throw new Error(started.error ?? '引擎没有返回 job_id')
      setJobId(started.job_id)
      setJob(null)
      setSubmitMsg(
        `已交给引擎提交（任务 ${started.job_id}）` +
        ((started.auto_added?.length ?? 0) > 0
          ? `；${started.auto_added?.length} 个新 id 已自动加入自选池便于追踪`
          : ''),
      )
      setSubmitDraft('')
      await load({ withStats: false })
    } catch (cause) {
      if (isMissingEndpoint(cause)) setEngineMissing(true)
      else setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitBusy(false)
    }
  }, [submitDraft, load])

  /** 续查：只轮询，不再 POST（避免重复提交撞 400 / 白占额度）。 */
  const doContinuePoll = useCallback(async (): Promise<void> => {
    const ids = parseIds(submitDraft)
    if (ids.length === 0) {
      setError('先把要续查的 alpha_id 粘到提交框里')
      return
    }
    setSubmitBusy(true)
    setError(null)
    try {
      const started = await submitAlphas(ids, { pollOnly: true })
      if (started.job_id === undefined) throw new Error(started.error ?? '引擎没有返回 job_id')
      setJobId(started.job_id)
      setJob(null)
      setSubmitMsg(`已开始续查（任务 ${started.job_id}）：只查结果，不会重复提交`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSubmitBusy(false)
    }
  }, [submitDraft])

  const items = pool?.items ?? []
  const poolActive = useMemo(
    () => items.filter(it => String(it.status ?? '').toLowerCase() === 'active').length, [items])

  if (engineMissing) {
    return (
      <div className={css.card}>
        <div className={css.cardHead}>
          <span className={css.cardIcon}>⭐</span>
          <span className={css.cardTitle}>Alpha 自选池</span>
        </div>
        <div className={`${css.msg} ${css.msgErr}`}>
          引擎还没有自选池接口（<code>/api/alpha-pool</code> 返回 404）。
          重启一次引擎即可生效：<br />
          <code>launchctl kickstart -k gui/$(id -u)/com.qianxund</code>
        </div>
      </div>
    )
  }

  const jobItemList = job?.items ?? {}
  const jobRunning = jobId !== null

  return (
    <div className={css.card}>
      <div className={css.cardHead}>
        <button
          type="button"
          className={css.iconBtn}
          onClick={() => setExpanded(e => !e)}
          aria-expanded={expanded}
          title={expanded ? '收起' : '展开'}
        >
          {expanded ? '▾' : '▸'}
        </button>
        <span className={css.cardIcon}>⭐</span>
        <span className={css.cardTitle}
          title={`池内 ${poolActive} 条 active / 共 ${items.length} 条`}>
          Alpha 自选池（{pool?.count ?? 0}）
        </span>
        <span className={css.spacer} />
        {stats !== null && (
          <span
            className={stats.stale === true ? css.dailyBadgeStale : css.dailyBadge}
            title={
              '当日新增 = 当前 ACTIVE 集合 − 上一次 ' + String(stats.reset_hour ?? 12) + ':00 的基准线\n' +
              `基准线取自 ${stats.baseline_reset_at ?? '—'}（${stats.baseline_count ?? 0} 条）\n` +
              `下次重置：${stats.next_reset_at ?? '—'}（本地时间）\n` +
              '局限：基准线只在有人打开这个页面时滚动，长时间不看页面期间的进出无法回溯——宁可漏算不会多算' +
              (stats.stale === true ? '\n⚠️ 这次没拿到 ACTIVE 列表，显示的是上次观察值' : '')
            }
          >
            📈 今日新增 active {stats.daily_new ?? 0}
            <span className={css.dailyBadgeSub}>· 账号共 {stats.active_count ?? '—'}</span>
          </span>
        )}
        <button
          type="button"
          className={css.btnPrimary}
          disabled={syncing || loading || (pool?.count ?? 0) === 0}
          onClick={() => { void doSync() }}
          title="重新拉取整池的指标、相关性与提交状态（BRAIN 限流时可能只刷到一部分，再点一次续刷）"
        >
          {syncing ? '🔄 同步中…' : '🔄 同步'}
        </button>
      </div>

      {expanded && (
        <>
          <form className={css.poolAddRow} onSubmit={e => { e.preventDefault(); void doAdd() }}>
            <input
              className={css.input}
              type="text"
              value={draft}
              onChange={e => setDraft(e.target.value)}
              placeholder="粘 alpha_id（可一次多个，逗号 / 换行 / 空格分隔）"
              aria-label="添加 alpha_id 到自选池"
              spellCheck={false}
              autoComplete="off"
            />
            <button type="submit" className={css.btnPrimary}
              disabled={mutating || draft.trim() === ''}>＋ 添加</button>
            <button type="button" className={css.btnGhost}
              disabled={mutating || (pool?.count ?? 0) === 0}
              onClick={() => { void doMutate('clear') }}
              title="清空自选池（只删本地名单）">清空</button>
          </form>

          <div className={css.poolMetaLine} aria-live="polite">
            {loading && '读取中…'}
            {!loading && pool !== null && (
              <>
                最后同步：
                {pool.synced_at !== null && pool.synced_at !== undefined
                  ? new Date(pool.synced_at).toLocaleString()
                  : '从未'}
              </>
            )}
            {notice !== null && <span className={css.poolNotice}> · {notice}</span>}
          </div>

          {error !== null && (
            <div className={`${css.msg} ${css.msgErr}`} role="alert">
              {error} —— 检查引擎是否在跑：<code>curl -s localhost:8765/health</code>
            </div>
          )}

          {pool !== null && pool.count === 0 && (
            <div className={css.empty}>
              <span className={css.emptyIcon}>⭐</span>
              <div>
                <span>池子还是空的：把想盯的 alpha_id 粘到上面的输入框。</span>
                <div className={css.emptySub}>
                  存进去后点「同步」即可看到 sharpe / fitness / ret / turnover / margin /
                  selfcorr / prodcorr 与 active 状态；备注可以直接在表格里写。
                </div>
              </div>
            </div>
          )}

          {items.length > 0 && (
            <div className={`${css.tableWrap} ${css.poolTable}`}>
              <table className={css.table}>
                <thead>
                  <tr>
                    <th scope="col">状态</th>
                    <th scope="col">region</th>
                    <th scope="col">alpha_id</th>
                    <th scope="col">sharpe</th>
                    <th scope="col">fitness</th>
                    <th scope="col">ret%</th>
                    <th scope="col">to%</th>
                    <th scope="col" title="以万分之一为单位（0.000783 → 7.83）">margin</th>
                    <th scope="col">selfcorr</th>
                    <th scope="col">prodcorr</th>
                    <th scope="col">备注</th>
                    <th scope="col" aria-label="操作" />
                  </tr>
                </thead>
                <tbody>
                  {items.map(it => {
                    const meta = statusMeta(it.status)
                    const sm = submitMeta(it.submit?.state)
                    const m = it.metrics ?? {}
                    const errs = it.errors ?? []
                    const noteValue = noteDraft[it.alpha_id] ?? it.note ?? ''
                    return (
                      <tr key={it.alpha_id}>
                        <td className={css.cellStatus}>
                          <span className={`${css.badge} ${css[meta.cls] ?? ''}`} title={meta.hint}>
                            {meta.label}
                          </span>
                          {sm !== null && (
                            <span className={`${css.submitMarkBadge} ${css[sm.cls] ?? ''}`}
                              title={[
                                it.submit?.error ?? '',
                                (it.submit?.fails?.length ?? 0) > 0
                                  ? `FAIL: ${it.submit?.fails?.join(', ')}` : '',
                                it.submit?.at !== null && it.submit?.at !== undefined
                                  ? `at ${it.submit.at}` : '',
                              ].filter(Boolean).join('\n')}>
                              {sm.label}
                            </span>
                          )}
                          {errs.length > 0 && (
                            <span className={css.poolErrDot} title={errs.join('\n')}>⚠️</span>
                          )}
                        </td>
                        <td className={css.cellStatus}>{it.region ?? '—'}</td>
                        <td className={css.cellAlpha}>
                          <button type="button" className={css.poolIdBtn}
                            onClick={() => onInspect?.(it.alpha_id)}
                            title={onInspect !== undefined ? '看 BRAIN 详细 checks' : it.alpha_id}>
                            {it.alpha_id}
                          </button>
                          <button type="button" className={css.copyBtn}
                            onClick={() => { void doCopy(it.alpha_id) }}
                            title={`复制 ${it.alpha_id}`}
                            aria-label={`复制 ${it.alpha_id}`}>
                            {copied === it.alpha_id ? '✓' : '⧉'}
                          </button>
                        </td>
                        <td className={css.cellNum}>{fmt(m.sharpe)}</td>
                        <td className={css.cellNum}>{fmt(m.fitness)}</td>
                        <td className={css.cellNum}>{fmt(m.returns, true)}</td>
                        <td className={css.cellNum}>{fmt(m.turnover, true)}</td>
                        <td className={css.cellNum} title={`margin = ${m.margin ?? '—'}`}>
                          {fmtWan(m.margin)}
                        </td>
                        <td className={css.cellNum}>{corrCell(it.self_corr, it.self_corr_result)}</td>
                        <td className={css.cellNum}>{corrCell(it.prod_corr, it.prod_corr_result)}</td>
                        <td className={css.cellNote}>
                          <input
                            className={css.noteInput}
                            type="text"
                            value={noteValue}
                            onChange={e => onChangeNote(it.alpha_id, e.target.value)}
                            onBlur={e => { void saveNote(it.alpha_id, e.target.value) }}
                            onKeyDown={e => {
                              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                            }}
                            placeholder="写点备注…"
                            aria-label={`${it.alpha_id} 的备注`}
                            maxLength={500}
                            spellCheck={false}
                          />
                          {noteBusy === it.alpha_id && <span className={css.noteHint}>…</span>}
                          {noteSaved === it.alpha_id && <span className={css.noteHintOk}>✓</span>}
                        </td>
                        <td className={css.cellAction}>
                          <button type="button" className={css.iconBtn} disabled={syncing}
                            onClick={() => { void doSync([it.alpha_id]) }}
                            title="只刷新这一条" aria-label={`刷新 ${it.alpha_id}`}>⟳</button>
                          <button type="button" className={css.iconBtn} disabled={mutating}
                            onClick={() => { void doMutate('remove', it.alpha_id) }}
                            title="从自选池移除" aria-label={`移除 ${it.alpha_id}`}>✕</button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* ── 提交栏（不可逆操作，放在最下面、和上面的浏览操作隔开）── */}
          <div className={css.submitBox}>
            <div className={css.submitHead}>
              <span className={css.submitTitle}>⚡ 提交到平台</span>
              <span className={css.submitWarnText}>
                不可逆 · 占提交额度 · 写进账号 ACTIVE 组合 · 单次 ≤ {SUBMIT_MAX_IDS} 个
              </span>
            </div>
            <form className={css.submitRow}
              onSubmit={e => { e.preventDefault(); void doSubmit() }}>
              <input
                className={css.input}
                type="text"
                value={submitDraft}
                onChange={e => setSubmitDraft(e.target.value)}
                placeholder="粘要提交的 alpha_id（点提交后先拉 check 给你过目）"
                aria-label="要提交到平台的 alpha_id"
                spellCheck={false}
                autoComplete="off"
                disabled={submitBusy || jobRunning}
              />
              <button type="submit" className={css.submitBtn}
                disabled={submitBusy || jobRunning || submitDraft.trim() === ''}>
                {submitBusy ? '预检中…' : '⚡ 提交'}
              </button>
              <button type="button" className={css.btnGhost}
                disabled={submitBusy || jobRunning || submitDraft.trim() === ''}
                onClick={() => { void doContinuePoll() }}
                title="平台上一次没算完时，只查结果、不再重复提交">
                续查
              </button>
            </form>
            {submitMsg !== null && <div className={css.submitMsg}>{submitMsg}</div>}
            {job !== null && (
              <div className={css.submitProgress} aria-live="polite">
                {jobRunning
                  ? <span className={css.submitSpinner}>⏳ 任务 {job.job_id} 进行中…</span>
                  : <span>任务 {job.job_id} 已结束</span>}
                <div className={css.submitJobList}>
                  {Object.entries(jobItemList).map(([id, it]) => {
                    const meta = submitMeta(it.state)
                    return (
                      <div key={id} className={css.submitJobRow}>
                        <span className={css.submitJobId}>{id}</span>
                        {meta !== null && (
                          <span className={`${css.submitJobBadge} ${css[meta.cls] ?? ''}`}>
                            {meta.label}
                          </span>
                        )}
                        {it.error !== null && it.error !== undefined && (
                          <span className={css.submitJobErr} title={it.error}>{it.error}</span>
                        )}
                        {(it.fails?.length ?? 0) > 0 && (
                          <span className={css.submitJobFails} title="平台给出的 FAIL 项">
                            {it.fails?.join(', ')}
                          </span>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

        </>
      )}
    </div>
  )
}

/** 同步结果 → 一行人话。 */
function syncNotice(r: Awaited<ReturnType<typeof syncAlphaPool>>): string {
  const parts: string[] = []
  if (r.message !== undefined) parts.push(r.message)
  else parts.push(`已刷新 ${r.refreshed ?? 0}/${r.count} 条`)
  if (r.partial === true) {
    parts.push(`仍有 ${r.remaining?.length ?? 0} 条没刷到，可再点一次「同步」续刷`)
  }
  if (r.active_ok === false) {
    parts.push('（这次没拿到 ACTIVE 列表，状态按每个 alpha 自己的 BRAIN 状态判定）')
  }
  return parts.join('；')
}

/**
 * 千寻 detail / 列表共用的展示工具：指标格式化、check 徽章、指标表渲染。
 */

import type { ReactNode } from 'react'
import type {
  QianxunAlphaCheck,
  QianxunBatchDetail,
  QianxunMetrics,
  QianxunPnlRecord,
} from './qianxun.ts'
import {
  LADDER_THRESHOLD,
  LADDER_HIGH_RISK,
  MARGIN_EPSILON,
  MARGIN_TIERS,
  PROD_CORR_DEAD_ZONE,
  PROD_DEAD_ZONE_FIELDS,
  PROD_FRESH_FIELDS,
} from './wq-eval.ts'
import css from './QianxunTab.module.css'

/** 详情表按此顺序展示的指标列。 */
export const METRIC_KEYS: ReadonlyArray<{ key: keyof QianxunMetrics; label: string; pct?: boolean }> = [
  { key: 'sharpe', label: 'sharpe' },
  { key: 'fitness', label: 'fitness' },
  { key: 'returns', label: 'ret%', pct: true },
  { key: 'turnover', label: 'to%', pct: true },
  { key: 'margin', label: 'margin' },
]

/** 运行中的状态集合（用于高亮/进度/控制按钮显隐）。 */
export const RUNNING_STATES = new Set(['running', 'pending', 'queued', 'scheduled', 'active'])

/**
 * 数值格式化：3 位有效数字、去尾随 0；`asPct` 时把小数比率 ×100 转百分比。
 * 百分比展示去掉尾随 0（如 0.5 -> 50%，0.1234 -> 12.3%）。
 */
export function fmt(v: unknown, asPct = false): string {
  if (typeof v !== 'number' || Number.isNaN(v)) return '—'
  if (asPct) return `${parseFloat((v * 100).toPrecision(3))}%`
  return String(parseFloat(v.toPrecision(3)))
}

/** 是否运行中（用于控制按钮显隐与进度条）。 */
export function isRunning(state: string | undefined): boolean {
  return state !== undefined && RUNNING_STATES.has(String(state).toLowerCase())
}

/** check 三色（+黄）徽章；无值返回空。 */
export function checkBadge(check: string | null | undefined): ReactNode {
  if (check === null || check === undefined || check === '') return ''
  const cls =
    check === 'pass' ? 'bPass' : check === 'warn' ? 'bWarn' : check === 'fail' ? 'bFail' : 'bNone'
  return <span className={css[cls]}>{check}</span>
}

/** BRAIN 单 check 项 result → CSS 徽章类（BRAIN 用 PASS/FAIL/PENDING/WARNING）。 */
function checkItemResultClass(result: string | null | undefined): string | undefined {
  if (result === null || result === undefined) return undefined
  const r = String(result).toUpperCase()
  if (r === 'PASS') return css.bPass
  if (r === 'WARNING' || r === 'WARN') return css.bWarn
  if (r === 'FAIL') return css.bFail
  return css.bNone // PENDING / 其它
}

/** 单 check 项 result 徽章。 */
function checkItemBadge(result: string | null | undefined): ReactNode {
  if (result === null || result === undefined || result === '') return ''
  const cls = checkItemResultClass(result)
  return cls ? <span className={cls}>{String(result).toLowerCase()}</span> : <span className={css.bNone}>{String(result).toLowerCase()}</span>
}

/** 把 BRAIN check 项的 value/limit 显示为紧凑字符串。value 不存在则不渲染。 */
function renderCheckMeta(c: QianxunAlphaCheck): string {
  const v = c.value
  const l = c.limit
  if (typeof v === 'number' && typeof l === 'number') return `${fmt(v)} / 限 ${fmt(l)}`
  if (typeof v === 'number') return fmt(v)
  return ''
}

/**
 * 渲染单 alpha 的详细 check 列表。
 * - 高亮 PROD_CORRELATION（最常用筛选项）
 * - 用三色徽章标 PASS/FAIL/WARNING/PENDING
 * - 顶部 summary：X 通过 / Y 失败 / Z 待定 / W 警告
 */
export function renderChecksList(checks: QianxunAlphaCheck[]): ReactNode {
  if (checks.length === 0) {
    return (
      <div className={css.empty}>
        <span className={css.emptyIcon}>🗂️</span>
        <span>本 alpha 没有 check 数据</span>
      </div>
    )
  }
  let pass = 0, fail = 0, warn = 0, pending = 0
  for (const c of checks) {
    const r = String(c.result ?? '').toUpperCase()
    if (r === 'PASS') pass++
    else if (r === 'FAIL') fail++
    else if (r === 'WARNING' || r === 'WARN') warn++
    else pending++
  }
  // 排序：FAIL → WARNING → PENDING → PASS（重点在上）；PROD_CORRELATION 置顶
  const order: Record<string, number> = { FAIL: 0, WARNING: 1, WARN: 1, PENDING: 2, PASS: 3 }
  const sorted = [...checks].sort((a, b) => {
    if (a.name === 'PROD_CORRELATION') return -1
    if (b.name === 'PROD_CORRELATION') return 1
    const oa = order[String(a.result ?? '').toUpperCase()] ?? 4
    const ob = order[String(b.result ?? '').toUpperCase()] ?? 4
    return oa - ob
  })
  return (
    <div className={css.checksPanel}>
      <div className={css.checksSummary}>
        <span className={css.bPass}>{pass} pass</span>
        {fail > 0 && <span className={css.bFail}>{fail} fail</span>}
        {warn > 0 && <span className={css.bWarn}>{warn} warn</span>}
        {pending > 0 && <span className={css.bNone}>{pending} pending</span>}
        <span className={css.spacer} />
        <span className={css.checksTotal}>共 {checks.length} 项</span>
      </div>
      <div className={css.checksList}>
        {sorted.map((c, i) => {
          const isPC = c.name === 'PROD_CORRELATION'
          const meta = renderCheckMeta(c)
          return (
            <div
              key={`${c.name}-${i}`}
              className={`${css.checkItem}${isPC ? ' ' + css.checkItemHighlight : ''}`}
            >
              <span className={css.checkItemName} title={c.name}>{c.name}</span>
              <span className={css.checkItemMeta}>{meta}</span>
              <span className={css.checkItemResult}>{checkItemBadge(c.result)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** 渲染全量逐条结果表。results 为空时给友好空态。
 * 提供 `onCheck` 时，每行末尾追加一个 "🔍 check" 按钮用于触发详细 check 拉取。 */
/** renderMetricsTable 可选回调：每行最多 3 个动作按钮（🔍/📈/📐）。 */
export interface MetricsTableActions {
  /** 点击 🔍：拉取 BRAIN `/alphas/{id}/check` 全部 checks */
  onCheck?: (alphaId: string) => void
  /** 点击 📈：拉取 `/alphas/{id}/correlations/prod` 真 prod_corr 数值（绕过 PENDING） */
  onProdCorr?: (alphaId: string) => void
  /** 点击 📐：下载 PnL + 浏览器内算本地 SELF_CORRELATION（不依赖 BRAIN） */
  onLocalSelf?: (alphaId: string) => void
}

/** 渲染全量逐条结果表。results 为空时给友好空态。
 * 提供 actions 时，每行末尾追加最多 3 个动作按钮。 */
export function renderMetricsTable(
  results: QianxunBatchDetail['results'],
  actions?: MetricsTableActions,
): ReactNode {
  if (results === undefined || results.length === 0) {
    return (
      <div className={css.empty}>
        <span className={css.emptyIcon}>🗂️</span>
        <span>本批次暂无逐条结果</span>
      </div>
    )
  }
  const showActions =
    actions !== undefined &&
    (actions.onCheck !== undefined || actions.onProdCorr !== undefined || actions.onLocalSelf !== undefined)
  return (
    <div className={css.tableWrap}>
      <table className={css.table}>
        <thead>
          <tr>
            <th>alpha_id</th>
            <th>表达式</th>
            {METRIC_KEYS.map(m => (
              <th key={m.key}>{m.label}</th>
            ))}
            <th>check</th>
            <th>状态</th>
            {showActions && <th></th>}
          </tr>
        </thead>
        <tbody>
          {results.map(result => {
            const sharpe = result.metrics?.sharpe
            const sharpeCls = typeof sharpe === 'number'
              ? sharpe >= 0 ? 'valPos' : 'valNeg'
              : undefined
            const alphaId = result.alpha_id
            const canAct = typeof alphaId === 'string' && alphaId !== ''
            return (
              <tr key={result.idx}>
                <td className={css.cellAlpha}>{alphaId ?? '—'}</td>
                <td className={css.cellExpr} title={result.expression ?? ''}>
                  {result.expression ?? '—'}
                </td>
                {METRIC_KEYS.map(m => (
                  <td key={m.key} className={`${css.cellNum}${m.key === 'sharpe' && sharpeCls ? ' ' + css[sharpeCls] : ''}`}>
                    {fmt(result.metrics?.[m.key], m.pct)}
                  </td>
                ))}
                <td>{checkBadge(result.metrics?.check_status)}</td>
                <td className={css.cellStatus}>{result.status ?? '—'}</td>
                {showActions && (
                  <td className={css.cellAction}>
                    {canAct ? (
                      <>
                        {actions?.onCheck !== undefined && (
                          <button
                            type="button"
                            className={css.iconBtn}
                            title="查看 BRAIN 详细 check"
                            aria-label="check"
                            onClick={() => actions.onCheck?.(alphaId as string)}
                          >
                            🔍
                          </button>
                        )}
                        {actions?.onProdCorr !== undefined && (
                          <button
                            type="button"
                            className={css.iconBtn}
                            title="拉取真 prod correlation（绕过 PENDING）"
                            aria-label="prod corr"
                            onClick={() => actions.onProdCorr?.(alphaId as string)}
                          >
                            📈
                          </button>
                        )}
                        {actions?.onLocalSelf !== undefined && (
                          <button
                            type="button"
                            className={css.iconBtn}
                            title="本地核对 SELF_CORRELATION（拉 PnL + JS 算 Pearson）"
                            aria-label="local self"
                            onClick={() => actions.onLocalSelf?.(alphaId as string)}
                          >
                            📐
                          </button>
                        )}
                      </>
                    ) : (
                      <span className={css.cellActionNone} title="该 alpha 缺少 alpha_id，无法 check">—</span>
                    )}
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// ============================================================
// 稳健性评估 —— 移植自 wq-alpha-research skill
// ============================================================

/** margin = (0.7 - prod_corr)，并查表得到 tier 标签。 */
export function classifyMargin(prodCorr: number | null | undefined): { label: string; margin: number; tier: string } {
  const m = MARGIN_EPSILON
  if (typeof prodCorr !== 'number' || Number.isNaN(prodCorr)) {
    return { label: 'no_data', margin: 0, tier: 'no_data' }
  }
  const margin = Math.max(0, PROD_CORR_DEAD_ZONE - prodCorr + m)
  let tier = 'tight'
  for (const t of MARGIN_TIERS) {
    if (margin >= t.threshold) {
      tier = t.label
      break
    }
  }
  return { label: tier, margin, tier }
}

/** 词边界匹配：避免 "ad" 之类短字段名误伤 adjusted/load/spread/trading 等。 */
function matchesWithWordBoundary(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?<![A-Za-z0-9_])$${escaped}(?![A-Za-z0-9_])`)
  return re.test(haystack)
}

/** 表达式里包含已知 prod-fresh 字段？ */
export function isProdFreshField(expr: string | null | undefined): { hit: boolean; field?: string } {
  if (!expr) return { hit: false }
  for (const { field } of PROD_FRESH_FIELDS) {
    if (matchesWithWordBoundary(expr, field)) return { hit: true, field }
  }
  return { hit: false }
}

/** 表达式里包含已知 prod 雷区字段？ */
export function isDeadZoneField(expr: string | null | undefined): { hit: boolean; field?: string; note?: string } {
  if (!expr) return { hit: false }
  for (const { field, note } of PROD_DEAD_ZONE_FIELDS) {
    if (matchesWithWordBoundary(expr, field)) return { hit: true, field, note }
  }
  return { hit: false }
}

/** IS_LADDER_SHARPE 风险分级（避免给必败 alpha 浪费 submission check）。 */
export function classifyLadderRisk(v: number | null | undefined): 'no_data' | 'certain_fail' | 'high' | 'medium' | 'low' {
  if (typeof v !== 'number' || Number.isNaN(v)) return 'no_data'
  if (v < LADDER_THRESHOLD) return 'certain_fail'
  if (v < LADDER_HIGH_RISK) return 'high'
  if (v < 1.85) return 'medium'
  return 'low'
}

// ============================================================
// 本地 SELF_CORRELATION —— 浏览器内 Pearson（不需 numpy）
// 参考 xiegengcai/self_correlation.py 设计：日期对齐 + Pearson on raw daily PnL
// ============================================================

/** 单组 PnL 的差分（每日盈亏）—— 用 PnL 增量做相关，更接近 BRAIN 的指标。 */
function pnlToReturns(records: QianxunPnlRecord[]): number[] {
  const out: number[] = []
  for (let i = 1; i < records.length; i++) {
    const cur = records[i]?.pnl
    const prev = records[i - 1]?.pnl
    if (typeof cur === 'number' && typeof prev === 'number' && Number.isFinite(cur) && Number.isFinite(prev)) {
      out.push(cur - prev)
    }
  }
  return out
}

/** Pearson correlation of two numeric series. Returns NaN on insufficient data. */
export function pearson(xs: number[], ys: number[]): number {
  const n = Math.min(xs.length, ys.length)
  if (n < 2) return NaN
  let sumX = 0
  let sumY = 0
  for (let i = 0; i < n; i++) {
    sumX += xs[i] ?? 0
    sumY += ys[i] ?? 0
  }
  const meanX = sumX / n
  const meanY = sumY / n
  let num = 0
  let denomX = 0
  let denomY = 0
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] ?? 0) - meanX
    const dy = (ys[i] ?? 0) - meanY
    num += dx * dy
    denomX += dx * dx
    denomY += dy * dy
  }
  const denom = Math.sqrt(denomX * denomY)
  return denom === 0 ? NaN : num / denom
}

/** 用每日 returns（PnL 增量）算与候选集的相关性，返回 max / min / per-candidate。 */
export function computeLocalSelfCorr(
  target: QianxunPnlRecord[],
  candidates: Array<{ alphaId: string; records: QianxunPnlRecord[] }>,
): {
  targetReturns: number[]
  targetDays: number
  perCandidate: Array<{
    alphaId: string
    corr: number | null
    overlapDays: number
  }>
  max: number | null
  min: number | null
} {
  // 把 target 转 returns，一次算
  const targetReturns = pnlToReturns(target)
  const targetDays = target.length
  const perCandidate: Array<{ alphaId: string; corr: number | null; overlapDays: number }> = []
  let max: number | null = null
  let min: number | null = null
  for (const c of candidates) {
    const candReturns = pnlToReturns(c.records)
    // 对齐：取较短的，用索引对齐而非日期对齐（PnL 单调日序）
    const n = Math.min(targetReturns.length, candReturns.length)
    if (n < 30) {
      // 太少样本，标记为 null（不参与 max/min）
      perCandidate.push({ alphaId: c.alphaId, corr: null, overlapDays: n })
      continue
    }
    const corr = pearson(targetReturns.slice(0, n), candReturns.slice(0, n))
    if (!Number.isNaN(corr)) {
      perCandidate.push({ alphaId: c.alphaId, corr, overlapDays: n })
      if (max === null || corr > max) max = corr
      if (min === null || corr < min) min = corr
    } else {
      perCandidate.push({ alphaId: c.alphaId, corr: null, overlapDays: n })
    }
  }
  return { targetReturns, targetDays, perCandidate, max, min }
}

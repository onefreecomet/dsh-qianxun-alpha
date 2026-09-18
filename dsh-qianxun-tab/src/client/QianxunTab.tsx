/** 千寻回测控制台——dsh-better-sidebar 的自定义 tab 内容组件（列表视图）。 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { BetterSidebarTabComponentProps } from './better-sidebar.ts'
import type {
  QianxunAction,
  QianxunBatch,
  QianxunQuota,
} from './qianxun.ts'
import {
  actOnBatch,
  getBatchResult,
  getConfig,
  getQuota,
  listBatches,
  resumeBatch,
  setConfig,
  QIANXUN_BASE,
} from './qianxun.ts'
import { isRunning } from './format.tsx'
import {
  copyPrompt,
  createPrompt,
  ensurePromptsLoaded,
  getPrompt,
  listPrompts,
  promptsSource,
  refreshPrompts,
  subscribePrompts,
} from './prompts.ts'
import type { QianxunPrompt, QianxunPromptSource } from './prompts.ts'
import css from './QianxunTab.module.css'

/** 分页默认条数与可选值。`all` = 不分页（一次性渲染全部）。 */
const PAGE_SIZE_OPTIONS: ReadonlyArray<number | 'all'> = [3, 4, 5, 8, 'all']
const DEFAULT_PAGE_SIZE: number | 'all' = 3

/** 批次状态 → 行状态类。 */
function stateClass(state: string): string | undefined {
  const s = String(state).toLowerCase()
  // 终态成功：done / finished / complete / completed 都算绿。
  if (
    s === 'done' ||
    s === 'finished' ||
    s === 'complete' ||
    s === 'completed' ||
    s === 'success' ||
    s === 'succeeded'
  ) {
    return css.rowStateDone
  }
  // 终态非成功：失败 / 取消 / 中止 — 一律红。
  if (
    s === 'error' ||
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
    s === 'killed'
  ) {
    return css.rowStateError
  }
  // 临时暂停 — 黄（警告）。
  if (s === 'paused' || s === 'pause' || s === 'pausing' || s === 'suspended') return css.rowStatePaused
  if (isRunning(s)) return css.rowStateRunning
  return css.rowStateQueued
}

/** 进度条 fill 颜色类。running 优先；终态按 stateClass；其它无色（与行首 bar 一致）。 */
function progressFillClass(state: string, running: boolean): string {
  if (running) return css.progressRunning ?? ''
  const sc = stateClass(state)
  if (sc === css.rowStateDone) return css.progressDone ?? ''
  if (sc === css.rowStateError) return css.progressError ?? ''
  if (sc === css.rowStatePaused) return css.progressPaused ?? ''
  return ''
}

export function QianxunTab(props: BetterSidebarTabComponentProps): JSX.Element | null {
  const { visible } = props

  const [batches, setBatches] = useState<QianxunBatch[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [engineOnline, setEngineOnline] = useState<boolean | null>(null)

  // expanded batch id -> loaded detail（已删除：行点击直接 openDetail）
  // const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  // const [details, setDetails] = useState<Record<string, QianxunBatchDetail>>({})
  // const [detailError, setDetailError] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  // 引擎配置 / 配额
  const [quota, setQuota] = useState<QianxunQuota | null>(null)
  const [configBusy, setConfigBusy] = useState(false)
  const [configMsg, setConfigMsg] = useState<string | null>(null)
  const [configMsgOk, setConfigMsgOk] = useState(false)
  const [concurrentInput, setConcurrentInput] = useState('')
  const [batchSizeInput, setBatchSizeInput] = useState('')

  // submit form（已移至 Web UI http://127.0.0.1:8765/ui）

  // 提示词模块
  const [prompts, setPrompts] = useState<QianxunPrompt[]>([])
  const [promptsFrom, setPromptsFrom] = useState<QianxunPromptSource>('loading')
  const [copyHintText, setCopyHintText] = useState<string | null>(null)

  // 加载提示词列表：首次挂载确保已从服务端加载；之后每次回到列表 tab 再对齐一次
  // （可能别的浏览器/窗口刚改过）。数据源是服务端，见 prompts.ts。
  const promptSyncedRef = useRef(false)
  useEffect(() => {
    if (!visible) return
    const sync = (): void => {
      setPrompts(listPrompts())
      setPromptsFrom(promptsSource())
    }
    sync()
    const unsubscribe = subscribePrompts(sync)
    const task = promptSyncedRef.current ? refreshPrompts() : ensurePromptsLoaded()
    promptSyncedRef.current = true
    void task.then(sync)
    return unsubscribe
  }, [visible])

  /** 新增提示词并打开编辑 tab。 */
  const onAddPrompt = useCallback((): void => {
    const p = createPrompt('新提示词', '')
    setPrompts(listPrompts())
    props.ctx?.betterSidebar?.openTab({
      type: 'qianxun-prompt',
      title: p.name,
      id: `qianxun-prompt:${p.id}`,
      meta: { promptId: p.id },
    })
  }, [props.ctx])

  /** 点击提示词 → 打开编辑 tab。 */
  const openPrompt = useCallback(
    (promptId: string): void => {
      const p = getPrompt(promptId)
      props.ctx?.betterSidebar?.openTab({
        type: 'qianxun-prompt',
        title: p?.name ?? '提示词',
        id: `qianxun-prompt:${promptId}`,
        meta: { promptId },
      })
    },
    [props.ctx],
  )

  // 分页
  const [pageSize, setPageSize] = useState<number | 'all'>(DEFAULT_PAGE_SIZE)
  const [currentPage, setCurrentPage] = useState(1)

  /** 当前批次数下的总页数（pageSize='all' 时固定为 1）。 */
  const totalPages = useMemo(() => {
    if (pageSize === 'all') return 1
    return Math.max(1, Math.ceil(batches.length / pageSize))
  }, [batches.length, pageSize])

  /** 当前页可见的批次（pageSize='all' 时返回全部）。 */
  const pageBatches = useMemo<QianxunBatch[]>(() => {
    if (pageSize === 'all') return batches
    const start = (currentPage - 1) * pageSize
    return batches.slice(start, start + pageSize)
  }, [batches, currentPage, pageSize])

  /** 批次总数或页大小变化时，把 currentPage 夹紧到合法范围。 */
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages)
  }, [totalPages, currentPage])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [b, c, q] = await Promise.all([
        listBatches(),
        getConfig().catch(() => null),
        getQuota().catch(() => null),
      ])
      setBatches(b ?? [])
      setEngineOnline(true)
      if (c) {
        setConcurrentInput(String(c.concurrent ?? ''))
        setBatchSizeInput(String(c.batch_size ?? ''))
      }
      if (q) setQuota(q)
    } catch (cause) {
      setEngineOnline(false)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [])

  // 轮询（visible 时）：立即 + 每 5s。
  useEffect(() => {
    if (!visible) return
    void refresh()
    const timer = window.setInterval(() => {
      void refresh()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [visible, refresh])

  // 从隐藏回到可见时补一次刷新。
  const prevVisible = useRef<boolean | null>(null)
  useEffect(() => {
    if (visible && prevVisible.current === false) void refresh()
    prevVisible.current = visible
  }, [visible, refresh])

  // toggleBatch 已删除：行点击直接 openDetail，无需先拉详情展开

  const runAction = useCallback(
    async (batchNo: string, action: () => Promise<unknown>) => {
      setBusy(prev => ({ ...prev, [batchNo]: true }))
      try {
        await action()
        await refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(prev => ({ ...prev, [batchNo]: false }))
      }
    },
    [refresh],
  )

  const onAct = (batchNo: string, action: QianxunAction) => () =>
    runAction(batchNo, () => actOnBatch(batchNo, action))
  const onResumeBack = (batchNo: string) => () =>
    runAction(batchNo, () => resumeBatch(batchNo))

  /** 打开该批次的独立详情 tab（每批次一个，可多个批次并存）。 */
  const openDetail = useCallback(
    (batchNo: string) => {
      props.ctx?.betterSidebar?.openTab({
        type: 'qianxun-detail',
        title: `${batchNo} 结果`,
        id: `qianxun-detail:${batchNo}`,
        meta: { batchNo },
      })
    },
    [props.ctx],
  )

  const doApplyConfig = async (): Promise<void> => {
    setConfigBusy(true)
    setConfigMsg(null)
    try {
      const body: { concurrent?: number; batch_size?: number } = {}
      const ci = parseInt(concurrentInput, 10)
      const bi = parseInt(batchSizeInput, 10)
      if (!Number.isNaN(ci) && ci >= 1) body.concurrent = ci
      if (!Number.isNaN(bi) && bi >= 1 && bi <= 10) body.batch_size = bi
      const c = await setConfig(body)
      setConfigMsg(`已应用：并发=${c.concurrent} 批大小=${c.batch_size}`)
      setConfigMsgOk(true)
      void refresh()
    } catch (cause) {
      setConfigMsg(cause instanceof Error ? cause.message : String(cause))
      setConfigMsgOk(false)
    } finally {
      setConfigBusy(false)
    }
  }

  const doViewResult = async (batchNo: string): Promise<void> => {
    // 在独立详情 tab 中展示完整结果 JSON。
    openDetail(batchNo)
  }

  const doDownloadResult = async (batchNo: string): Promise<void> => {
    try {
      const detail = await getBatchResult(batchNo)
      const blob = new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' })
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

  const renderRow = (batch: QianxunBatch): ReactNode => {
    const batchNo = batch.id ?? batch.round
    if (batchNo === undefined) return null
    const isBusy = busy[batchNo] ?? false
    const running = isRunning(batch.state)
    const done = Math.min(batch.done ?? 0, batch.total || batch.done || 0)
    const total = batch.total ?? 0
    const pct = total > 0 ? Math.round((done / total) * 100) : 0
    return (
      <div key={batchNo} className={css.row}>
        <div
          className={css.rowHead}
          onClick={() => {
            openDetail(batchNo)
          }}
        >
          <span className={`${css.rowBar} ${stateClass(batch.state)}`} />
          <div className={css.rowMain}>
            <div className={css.rowTop}>
              <span className={css.rowId}>{batchNo}</span>
              <span className={`${css.badge} ${stateClass(batch.state)}`}>
                {batch.state ?? '—'}
              </span>
              {batch.name !== undefined && batch.name !== null && batch.name !== '' && (
                <span className={css.rowName}>{batch.name}</span>
              )}
              <span className={css.spacer} />
              <span className={css.rowMeta}>
                {done}/{total || '?'}
              </span>
            </div>
            {total > 0 && (
              <div className={css.progressTrack}>
                <div
                  className={`${css.progressFill} ${progressFillClass(batch.state, running)}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
          </div>
          <div className={css.rowActions} onClick={event => event.stopPropagation()}>
            {running && (
              <>
                <button
                  type="button"
                  className={`${css.iconBtn} ${css.actionIco}`}
                  disabled={isBusy}
                  onClick={onAct(batchNo, 'pause')}
                  title="暂停批次"
                  aria-label="暂停"
                >
                  ⏸
                </button>
                <button
                  type="button"
                  className={`${css.iconBtn} ${css.actionIco}`}
                  disabled={isBusy}
                  onClick={onAct(batchNo, 'resume')}
                  title="恢复批次"
                  aria-label="恢复"
                >
                  ▶
                </button>
              </>
            )}
            <button
              type="button"
              className={`${css.iconBtn} ${css.actionIco}`}
              disabled={isBusy}
              onClick={onResumeBack(batchNo)}
              title="断点续跑"
              aria-label="断点续跑"
            >
              ↻
            </button>
            <button
              type="button"
              className={`${css.iconBtn} ${css.actionIco}`}
              disabled={isBusy}
              onClick={() => {
                void doViewResult(batchNo)
              }}
              title="结果 JSON（打开独立详情 tab）"
              aria-label="结果 JSON"
            >
              {'{}'}
            </button>
            <button
              type="button"
              className={`${css.iconBtn} ${css.actionIco}`}
              disabled={isBusy}
              onClick={() => {
                void doDownloadResult(batchNo)
              }}
              title="下载结果 JSON"
              aria-label="下载"
            >
              ⇩
            </button>
          </div>
        </div>
      </div>
    )
  }

  const renderConfig = (): ReactNode => {
    return (
      <div className={css.card}>
        <div className={css.cardHead}>
          <span className={css.cardIcon}>⚙️</span>
          <span className={css.cardTitle}>引擎配置</span>
        </div>
        <div className={css.fieldRow}>
          <span className={css.fieldLabel}>并发</span>
          <input
            className={`${css.input} ${css.configInput}`}
            value={concurrentInput}
            placeholder="并发槽数"
            onChange={e => setConcurrentInput(e.target.value)}
          />
          <span className={css.fieldLabel}>批大小</span>
          <input
            className={`${css.input} ${css.configInput}`}
            value={batchSizeInput}
            placeholder="每批条数"
            onChange={e => setBatchSizeInput(e.target.value)}
          />
          <button
            type="button"
            className={css.configBtn}
            disabled={configBusy}
            onClick={() => {
              void doApplyConfig()
            }}
          >
            {configBusy ? <span className={css.spinner} /> : '应用'}
          </button>
        </div>
        {configMsg !== null && (
          <div className={`${css.msg} ${configMsgOk ? css.msgOk : css.msgErr}`}>{configMsg}</div>
        )}
      </div>
    )
  }

  /** 分页条：上一页 / 页码 / 下一页 / 总数 + 页大小下拉。
   * 仅在有批次且 pageSize 不是 'all' 时显示完整控件；'all' 时只展示总数。 */
  const renderPagination = (): ReactNode | null => {
    const total = batches.length
    if (total === 0) return null
    const all = pageSize === 'all'
    const canPrev = !all && currentPage > 1
    const canNext = !all && currentPage < totalPages
    const sizeLabel = all ? '全部' : `每页 ${pageSize}`
    return (
      <div className={css.pagination} role="navigation" aria-label="批次分页">
        <button
          type="button"
          className={css.paginationBtn}
          disabled={!canPrev}
          onClick={() => {
            if (canPrev) setCurrentPage(p => p - 1)
          }}
          aria-label="上一页"
          title="上一页"
        >
          ‹
        </button>
        <span className={css.paginationInfo}>
          {all ? '全部' : (
            <>
              第 <b>{currentPage}</b>/<b>{totalPages}</b> 页
            </>
          )}
          <span className={css.paginationTotal}>· 共 <b>{total}</b> 批</span>
        </span>
        <button
          type="button"
          className={css.paginationBtn}
          disabled={!canNext}
          onClick={() => {
            if (canNext) setCurrentPage(p => p + 1)
          }}
          aria-label="下一页"
          title="下一页"
        >
          ›
        </button>
        <span className={css.spacer} />
        <span className={css.paginationSizeLabel}>页大小</span>
        <select
          className={css.paginationSizeSelect}
          value={pageSize === 'all' ? 'all' : String(pageSize)}
          onChange={e => {
            const v = e.target.value
            setPageSize(v === 'all' ? 'all' : Number(v))
            setCurrentPage(1)
          }}
          title="每页显示条数"
          aria-label="每页显示条数"
        >
          {PAGE_SIZE_OPTIONS.map(opt => (
            <option key={opt} value={opt === 'all' ? 'all' : String(opt)}>
              {opt === 'all' ? '全部' : opt}
            </option>
          ))}
        </select>
        <span className={css.paginationSizeHint}>{sizeLabel}</span>
      </div>
    )
  }

  const renderPrompts = (): ReactNode => {
    // prompts state 在组件顶层声明（见 state 段）
    return (
      <div className={css.card}>
        <div className={css.cardHead}>
          <span className={css.cardIcon}>📋</span>
          <span className={css.cardTitle}>提示词</span>
          {promptsFrom !== 'loading' && (
            <span
              className={css.promptSavedTag}
              title={promptsFrom === 'server'
                ? '存在宿主侧 $DSH_HOME/qianxun/prompts.json：同一台机器的任何浏览器、任何端口看到的是同一份'
                : '服务端存储不可用（非 web profile，或从其它机器访问），当前仅存在本浏览器 localStorage：换浏览器会看不到'}
            >
              {promptsFrom === 'server' ? '服务端同步' : '仅本浏览器'}
            </span>
          )}
          <span className={css.spacer} />
          <button
            type="button"
            className={css.btnGhost}
            onClick={onAddPrompt}
            title="新增提示词"
            aria-label="新增提示词"
          >
            ＋ 新增
          </button>
        </div>
        {prompts.length === 0 ? (
          <div className={css.empty}>
            <span className={css.emptyIcon}>📄</span>
            <div>
              <div className={css.emptyTitle}>暂无提示词</div>
              <div className={css.emptySub}>点「＋ 新增」创建第一条。</div>
            </div>
          </div>
        ) : (
          <div className={css.promptList}>
            {prompts.map(p => (
              <div key={p.id} className={css.promptItem}>
                <button
                  type="button"
                  className={css.promptName}
                  onClick={() => openPrompt(p.id)}
                  title={`打开「${p.name}」编辑`}
                >
                  <span className={css.promptItemIcon}>📄</span>
                  <span className={css.promptItemName}>{p.name}</span>
                </button>
                <button
                  type="button"
                  className={`${css.iconBtn} ${css.promptCopyBtn}`}
                  onClick={() => {
                    void copyPrompt(p.id).then(ok => {
                      setCopyHintText(ok ? `已复制「${p.name}」` : '复制失败')
                      setTimeout(() => setCopyHintText(null), 2000)
                    })
                  }}
                  title="复制提示词内容"
                  aria-label="复制"
                >
                  ⧉
                </button>
              </div>
            ))}
          </div>
        )}
        {copyHintText !== null && (
          <div className={`${css.msg} ${css.msgOk}`}>{copyHintText}</div>
        )}
      </div>
    )
  }

  /** 启动引擎：离线时先调常驻启动器(8766)拉起，再轮询等引擎就绪。 */
  const [engineStarting, setEngineStarting] = useState(false)
  const [engineBtnMsg, setEngineBtnMsg] = useState<string | null>(null)
  const handleStartEngine = useCallback(() => {
    // 在线：只做个即时探测确认（点一下刷新状态）
    if (engineOnline === true) {
      void refresh()
      setEngineBtnMsg('✓ 引擎在线')
      setTimeout(() => setEngineBtnMsg(null), 2000)
      return
    }
    // 离线：调常驻启动器 qianxund-ctl(8766) /api/start 真正拉起
    setEngineStarting(true)
    setEngineBtnMsg('正在启动引擎…')
    const ctlBase = 'http://127.0.0.1:8766'
    const token = 'qianxund-ctl'
    fetch(`${ctlBase}/api/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Token': token },
      body: '{}',
    })
      .then(r => r.json().catch(() => ({})))
      .then(res => {
        const started = res?.started === true || res?.message === 'via launchd kickstart' || res?.ok === true
        if (!started && res?.message !== 'already_running') {
          setEngineStarting(false)
          setEngineBtnMsg('⚠ 启动失败：' + (res?.error ?? res?.message ?? '未知错误'))
          setTimeout(() => setEngineBtnMsg(null), 5000)
          return
        }
        // 已请求启动：轮询 8765 等就绪（最多 15s）
        let tries = 0
        const timer = window.setInterval(() => {
          tries += 1
          fetch(`${QIANXUN_BASE}/health`, { method: 'GET' })
            .then(r => r.ok)
            .catch(() => false)
            .then(ok => {
              if (ok) {
                window.clearInterval(timer)
                setEngineStarting(false)
                setEngineBtnMsg('✓ 引擎已启动')
                setTimeout(() => setEngineBtnMsg(null), 2500)
                void refresh()
              } else if (tries >= 15) {
                window.clearInterval(timer)
                setEngineStarting(false)
                setEngineBtnMsg('⚠ 引擎启动中，请稍候再刷新')
                setTimeout(() => setEngineBtnMsg(null), 5000)
              }
            })
        }, 1000)
      })
      .catch(cause => {
        setEngineStarting(false)
        setEngineBtnMsg('⚠ 启动器不可用：' + (cause instanceof Error ? cause.message : String(cause)))
        setTimeout(() => setEngineBtnMsg(null), 5000)
      })
  }, [engineOnline, refresh])

  return (
    <div className={css.root}>
      <header className={css.header}>
        <span className={css.titleIcon}>🧠</span>
        <span className={css.title}>千寻回测</span>
        <span className={css.quotaChip} title="今日提交 / 每日剩余配额 / 重置时间">
          <span className={css.quotaLabel}>今日</span>
          <b>{quota?.submitted_today ?? '—'}</b>
          <span className={css.quotaSep}>·</span>
          <span className={css.quotaLabel}>剩</span>
          {quota?.quota?.limit !== undefined && quota.quota?.remaining !== undefined ? (
            <>
              <b>{quota.quota.remaining}</b>
              <span className={css.quotaSep}>/</span>
              <b>{quota.quota.limit}</b>
              {(() => {
                const rs = quota.quota?.reset_sec
                const rm = rs !== undefined && Number.isFinite(rs) ? Math.round((rs as number) / 60) : null
                return rm !== null ? <><span className={css.quotaSep}>·</span><span>{rm}min</span></> : null
              })()}
            </>
          ) : (
            <b>—</b>
          )}
        </span>
        <span className={css.spacer} />
        <button
          type="button"
          className={engineOnline ? css.startEngineBtnOnline : css.startEngineBtnOffline}
          onClick={handleStartEngine}
          disabled={engineStarting}
          title={
            engineOnline
              ? '引擎运行中（launchd 托管，崩溃自动重启）。点击探测状态'
              : engineStarting
                ? '正在启动引擎…'
                : '引擎离线。点击启动：launchd 会自动拉起（KeepAlive），稍候'
          }
          aria-label="启动引擎"
        >
          {engineStarting
            ? '⚡ 启动中…'
            : engineOnline
              ? '🟢 引擎在线'
              : '⚡ 启动引擎'}
        </button>
        {engineBtnMsg !== null && (
          <span className={`${css.startEngineToast} ${engineBtnMsg.startsWith('✓') ? css.startEngineToastOk : engineBtnMsg.startsWith('⚠') ? css.startEngineToastWarn : ''}`}>
            {engineBtnMsg}
          </span>
        )}
        <button
          type="button"
          className={css.iconBtn}
          onClick={() => {
            void refresh()
          }}
          aria-label="刷新"
          title="刷新"
        >
          {loading ? <span className={css.spinner} /> : '⟳'}
        </button>
      </header>

      <div className={css.body}>
        {error !== null && (
          <div className={css.error} role="alert">
            {error}
            <button type="button" className={css.retryBtn} onClick={() => void refresh()}>
              重试
            </button>
          </div>
        )}

        {renderPagination()}

        {batches.length === 0 && error === null && (
          <div className={css.empty}>
            <span className={css.emptyIcon}>🗂️</span>
            <div>
              <div className={css.emptyTitle}>还没有回测批次</div>
              <div className={css.emptySub}>可通过下方「提交批次」创建，或等待引擎产出。</div>
            </div>
          </div>
        )}

        {pageBatches.map(renderRow)}

        {renderConfig()}
        {renderPrompts()}

        <div className={css.statusFooter}>
          引擎 <a href={QIANXUN_BASE} target="_blank" rel="noopener noreferrer" className={css.statusFooterLink}>{QIANXUN_BASE}</a>
        </div>
      </div>
    </div>
  )
}

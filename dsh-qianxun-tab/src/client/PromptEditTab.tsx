/**
 * PromptEditTab — 提示词编辑 tab。
 * 由列表 tab（QianxunTab）点提示词名字 → openTab({type:'qianxun-prompt', meta:{promptId}})
 * 打开。内容存服务端（见 prompts.ts），text 实时可改，离开自动保存。
 *
 * 数据是异步到达的（页面刷新后恢复的 prompt tab 可能先于服务端加载完成），
 * 因此这里先同步取一次，取不到再等一次加载；一旦载入过就不再回填，
 * 以免覆盖正在编辑的内容。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { BetterSidebarTabComponentProps } from './better-sidebar.ts'
import {
  deletePrompt,
  ensurePromptsLoaded,
  getPrompt,
  subscribePrompts,
  updatePrompt,
  type QianxunPrompt,
} from './prompts.ts'
import css from './QianxunTab.module.css'

/** 从 tab meta 读提示词 id。 */
function promptIdFromTab(props: BetterSidebarTabComponentProps): string | undefined {
  const meta = props.tab?.meta as { promptId?: unknown } | undefined
  const raw = meta?.promptId
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

export function PromptEditTab(props: BetterSidebarTabComponentProps): JSX.Element | null {
  const promptId = promptIdFromTab(props)

  const [prompt, setPrompt] = useState<QianxunPrompt | null>(null)
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState(false)
  const [delBusy, setDelBusy] = useState(false)
  /** 已从存储载入过（载入后不再回填，避免覆盖编辑中的内容）。 */
  const loadedRef = useRef(false)

  // 加载（同步命中 → 立即填充；未命中 → 等 ensurePromptsLoaded 完成后再填充）
  useEffect(() => {
    if (promptId === undefined) return
    loadedRef.current = false
    setPrompt(null)
    const fill = (): void => {
      if (loadedRef.current) return
      const p = getPrompt(promptId)
      if (!p) return
      loadedRef.current = true
      setPrompt(p)
      setName(p.name)
      setContent(p.content)
    }
    fill()
    const unsubscribe = subscribePrompts(fill)
    void ensurePromptsLoaded().then(fill)
    return unsubscribe
  }, [promptId])

  // 自动保存（防抖 500ms）
  useEffect(() => {
    if (prompt === null || promptId === undefined) return
    if (name === prompt.name && content === prompt.content) return
    const t = setTimeout(() => {
      const updated = updatePrompt(promptId, { name, content })
      if (updated) {
        setPrompt(updated)
        setSaved(true)
        setTimeout(() => setSaved(false), 1500)
      }
    }, 500)
    return () => clearTimeout(t)
  }, [name, content, prompt, promptId])

  const onDelete = useCallback((): void => {
    if (promptId === undefined || delBusy) return
    if (!window.confirm(`删除提示词「${name}」？此操作不可恢复。`)) return
    setDelBusy(true)
    deletePrompt(promptId)
    // 关闭当前 tab：better-sidebar 无直接 close API，用 openTab 切到 qianxun 列表
    props.ctx?.betterSidebar?.openTab({ type: 'qianxun', id: 'qianxun', title: '千寻回测' })
    setDelBusy(false)
  }, [promptId, name, delBusy, props.ctx])

  if (promptId === undefined) {
    return (
      <div className={css.root}>
        <header className={css.header}>
          <span className={css.titleIcon}>📋</span>
          <span className={css.title}>提示词</span>
        </header>
        <div className={css.body}>
          <div className={css.empty}>
            <span className={css.emptyIcon}>🗂️</span>
            <span>未指定提示词：请从「千寻回测」列表点击某条提示词打开。</span>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={css.root}>
      <header className={css.header}>
        <span className={css.titleIcon}>📋</span>
        <span className={css.title} style={{ flex: '1', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {prompt?.name ?? '提示词'}
        </span>
        <span className={css.spacer} />
        {saved && <span className={css.promptSavedTag}>已保存</span>}
        <button
          type="button"
          className={css.iconBtn}
          onClick={() => {
            const p = getPrompt(promptId)
            if (p) void navigator.clipboard.writeText(p.content)
          }}
          title="复制到剪贴板"
        >
          ⧉
        </button>
        <button
          type="button"
          className={`${css.iconBtn} ${css.promptDelBtn}`}
          onClick={onDelete}
          disabled={delBusy}
          title="删除此提示词"
        >
          🗑
        </button>
      </header>

      <div className={css.body}>
        <div className={css.card}>
          <div className={css.field}>
            <span className={css.fieldLabel}>名称</span>
            <input
              className={css.input}
              value={name}
              placeholder="提示词名字"
              onChange={e => setName(e.target.value)}
            />
          </div>
          <div className={css.field}>
            <span className={css.fieldLabel}>内容（自动保存 · 最多 20000 字）</span>
            <textarea
              className={`${css.textarea} ${css.promptTextarea}`}
              value={content}
              placeholder="在这里粘贴/编辑提示词内容…"
              onChange={e => setContent(e.target.value)}
            />
          </div>
          <div className={css.metaLine}>
            更新于 {prompt ? new Date(prompt.updated_at).toLocaleString() : '—'} · 修改后自动保存
          </div>
        </div>
      </div>
    </div>
  )
}
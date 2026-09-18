/**
 * prompts.ts — 千寻侧边栏「提示词」模块的存储层。
 *
 * 权威数据在**宿主的服务端存储**（`$DSH_HOME/qianxun/prompts.json`，由本插件的
 * Node 半区在 `/api/dsh-qianxun-tab/prompts` 上提供 GET/PUT）。localStorage
 * （key: `qianxun_prompts`）只作为镜像/离线兜底：
 *
 *   - 服务端可用：读服务端、写服务端（300ms 防抖全量 PUT），localStorage 同步镜像；
 *   - 服务端不可用（非 web profile，或绑到 0.0.0.0 后从别的机器访问）：自动回落到
 *     localStorage，功能不中断，只是又回到「同浏览器同源」的可见范围；
 *   - 一次性上迁：本浏览器从未同步过（无 `qianxun_prompts_synced` 标记）而
 *     localStorage 有数据时，把旧数据**按 id 合并**进服务端。标记用于区分
 *     「迁移前的历史数据」与「已在别处同步过的镜像」，避免已删除的条目被复活。
 *
 * 为什么不再只存 localStorage：localStorage 按「浏览器 profile × 源（协议+主机+
 * 端口）」隔离。Safari 存的提示词 Chrome 看不到；DSH Desktop 每次启动都用随机端口，
 * origin 每次都不一样，localStorage 每次都是空桶。
 */

export interface QianxunPrompt {
  id: string
  name: string
  content: string
  created_at: number
  updated_at: number
}

/** 提示词模块的数据来源，供 UI 提示用。 */
export type QianxunPromptSource = 'loading' | 'server' | 'local'

const STORAGE_KEY = 'qianxun_prompts'
/** 已成功与服务端同步过的标记（存在即不再做一次性上迁）。 */
const SYNCED_KEY = 'qianxun_prompts_synced'
const API_PATH = '/api/dsh-qianxun-tab/prompts'
const MAX_CONTENT = 20000 // 单条提示词上限（字符）
const MAX_COUNT = 200 // 列表上限
const PUSH_DEBOUNCE_MS = 300

function safeParse(raw: string | null): QianxunPrompt[] {
  if (!raw) return []
  try {
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (p): p is QianxunPrompt =>
        p !== null && typeof p === 'object' &&
        typeof p.id === 'string' && typeof p.name === 'string' &&
        typeof p.content === 'string',
    )
  } catch {
    return []
  }
}

/** 读 localStorage 镜像（永不在读取路径上抛错）。 */
function readLocal(): QianxunPrompt[] {
  try {
    return safeParse(localStorage.getItem(STORAGE_KEY))
  } catch {
    return []
  }
}

/** 写 localStorage 镜像（quota 等异常静默）。 */
function writeLocal(list: QianxunPrompt[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {
    // quota exceeded 等：静默
  }
}

/** 打上「已同步」标记：此后不再把本浏览器的旧数据当作迁移源。 */
function markSynced(): void {
  try {
    localStorage.setItem(SYNCED_KEY, '1')
  } catch {
    // 静默
  }
}

function hasSynced(): boolean {
  try {
    return localStorage.getItem(SYNCED_KEY) === '1'
  } catch {
    return false
  }
}

/* ------------------------------------------------------------ 内存态与订阅 */

let cache: QianxunPrompt[] | null = null
let source: QianxunPromptSource = 'loading'
let loaded: Promise<void> | null = null
let pushTimer: ReturnType<typeof setTimeout> | undefined
let pushPending = false
const listeners = new Set<() => void>()

/** 当前列表（内存态；首次访问先以 localStorage 镜像兜底，避免空白闪烁）。 */
function current(): QianxunPrompt[] {
  if (cache === null) cache = readLocal()
  return cache
}

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      // 单个订阅者异常不影响其它订阅者
    }
  }
}

/** 订阅列表变化（服务端加载完成、增删改）。返回取消订阅函数。 */
export function subscribePrompts(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** 当前数据来源：'loading' 尚未确定，'server' 服务端可用，'local' 已回落本地。 */
export function promptsSource(): QianxunPromptSource {
  return source
}

/* --------------------------------------------------------------- 服务端同步 */

async function fetchServer(): Promise<{ rev: number; prompts: QianxunPrompt[] } | undefined> {
  try {
    const res = await fetch(API_PATH, {
      method: 'GET',
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
    })
    if (!res.ok) return undefined
    const body = await res.json() as { ok?: unknown; rev?: unknown; prompts?: unknown }
    if (body.ok !== true || !Array.isArray(body.prompts)) return undefined
    const prompts = safeParse(JSON.stringify(body.prompts))
    const rev = typeof body.rev === 'number' ? body.rev : 0
    return { rev, prompts }
  } catch {
    return undefined
  }
}

/** 全量推送内存态到服务端。返回是否成功。 */
async function pushServer(): Promise<boolean> {
  try {
    const res = await fetch(API_PATH, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ prompts: current() }),
    })
    if (!res.ok) return false
    writeLocal(current())
    markSynced()
    return true
  } catch {
    return false
  }
}

/** 变更后防抖推送（仅服务端模式下生效）。 */
function schedulePush(): void {
  if (source !== 'server') return
  pushPending = true
  if (pushTimer !== undefined) clearTimeout(pushTimer)
  pushTimer = setTimeout(() => {
    pushTimer = undefined
    if (!pushPending) return
    pushPending = false
    void pushServer().then(ok => {
      if (!ok) {
        // 服务端掉线：本次页面生命周期内退回本地模式，避免反复失败刷屏。
        source = 'local'
        notify()
      }
    })
  }, PUSH_DEBOUNCE_MS)
}

/** 按 id 合并：base 打底，overlay 覆盖同 id 条目并追加新条目。 */
function mergeById(base: QianxunPrompt[], overlay: QianxunPrompt[]): QianxunPrompt[] {
  const byId = new Map<string, QianxunPrompt>()
  for (const p of base) byId.set(p.id, p)
  for (const p of overlay) byId.set(p.id, p)
  return [...byId.values()].slice(-MAX_COUNT)
}

/** 加载一次服务端数据（页面生命周期内只自动执行一次）。 */
async function load(): Promise<void> {
  const remote = await fetchServer()
  if (remote === undefined) {
    source = 'local'
    cache = readLocal()
    notify()
    return
  }
  source = 'server'
  const local = readLocal()
  if (!hasSynced() && local.length > 0) {
    // 一次性上迁：本浏览器在旧版本（纯 localStorage）里留下的数据并入服务端。
    // 合并而非覆盖，避免多个浏览器各有各的存量时丢数据。
    const merged = mergeById(remote.prompts, local)
    cache = merged
    const changed = merged.length !== remote.prompts.length
      || merged.some(p => !remote.prompts.some(r => r.id === p.id && r.updated_at === p.updated_at))
    if (changed) {
      const ok = await pushServer()
      if (!ok) source = 'local'
    } else {
      writeLocal(cache)
      markSynced()
    }
  } else {
    cache = remote.prompts
    writeLocal(cache)
    markSynced()
  }
  notify()
}

/** 确保已尝试从服务端加载（幂等）。UI 挂载时调用，勿 await 阻塞渲染。 */
export function ensurePromptsLoaded(): Promise<void> {
  loaded ??= load()
  return loaded
}

/**
 * 重新拉取服务端（用于 tab 重新可见时对齐别的浏览器/窗口写入）。
 * 服务端不可用时不做任何事，本地模式下也不会覆盖内存态；
 * 有未落盘的本地改动（防抖窗口内）时跳过，避免用旧数据盖掉正在编辑的内容。
 */
export async function refreshPrompts(): Promise<void> {
  if (pushPending) return
  const remote = await fetchServer()
  if (remote === undefined) return
  source = 'server'
  cache = remote.prompts
  writeLocal(cache)
  markSynced()
  notify()
}

/* ----------------------------------------------------------------- 读写 API */

/** 读全部提示词（按 updated_at 倒序）。 */
export function listPrompts(): QianxunPrompt[] {
  return [...current()].sort((a, b) => b.updated_at - a.updated_at)
}

/** 按 id 读单条。 */
export function getPrompt(id: string): QianxunPrompt | undefined {
  return current().find(p => p.id === id)
}

/** 新增一条，返回新对象。 */
export function createPrompt(name: string, content: string = ''): QianxunPrompt {
  const now = Date.now()
  const prompt: QianxunPrompt = {
    id: `p-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim() || '未命名提示词',
    content: content.slice(0, MAX_CONTENT),
    created_at: now,
    updated_at: now,
  }
  const all = current()
  all.push(prompt)
  cache = all.slice(-MAX_COUNT)
  writeLocal(cache)
  notify()
  schedulePush()
  return prompt
}

/** 更新内容/名字，返回更新后对象；不存在返回 undefined。 */
export function updatePrompt(id: string, patch: { name?: string; content?: string }): QianxunPrompt | undefined {
  const all = current()
  const idx = all.findIndex(p => p.id === id)
  if (idx === -1) return undefined
  const cur = all[idx] as QianxunPrompt
  if (patch.name !== undefined) cur.name = patch.name.trim() || cur.name
  if (patch.content !== undefined) cur.content = patch.content.slice(0, MAX_CONTENT)
  cur.updated_at = Date.now()
  writeLocal(all)
  notify()
  schedulePush()
  return cur
}

/** 删除一条。 */
export function deletePrompt(id: string): boolean {
  const all = current()
  const next = all.filter(p => p.id !== id)
  if (next.length === all.length) return false
  cache = next
  writeLocal(cache)
  notify()
  schedulePush()
  return true
}

/** 复制提示词到剪贴板。返回是否成功。 */
export async function copyPrompt(id: string): Promise<boolean> {
  const p = getPrompt(id)
  if (!p) return false
  try {
    await navigator.clipboard.writeText(p.content)
    return true
  } catch {
    // fallback：textarea + execCommand
    const ta = document.createElement('textarea')
    ta.value = p.content
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  }
}

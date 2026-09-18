/**
 * 本地结构化的 dsh-better-sidebar 服务类型（monorepo 内编译用）。
 *
 * 该包在 DSH 仓库内构建，而 dsh-better-sidebar 是 profile 里安装的外部 npm 包，
 * 不出现在本仓库的依赖图里——它对自己 `Context` 的 `declare module` 增强到不了这里。
 * 因此这里按实际运行期形状定义一份结构化的 `BetterSidebarService` /
 * `TabDescriptor` / `TabComponentProps`，并把 `@deepseek-ai/cordis` 的 `Context`
 * 增强出 `betterSidebar` 成员，使 `ctx.betterSidebar.registerTab(...)` 在仓库内
 * 即可类型检查。这些类型是结构子集，运行期不会携带任何导入值（纯类型，打包时被擦除）。
 */
import type { Context as CordisContext } from '@deepseek-ai/cordis'
import type { ReactNode } from 'react'

/** 打开的单个 tab 的结构子集（见 SidebarTab）。meta 为 JSON 可序列化的插件自有状态。 */
export interface BetterSidebarTabMeta {
  // 结构子集，其它字段不被本插件使用。
  [key: string]: unknown
}

/** better-sidebar 的 tab 内容组件接收的 props（结构子集，见 TabComponentProps）。 */
export interface BetterSidebarTabComponentProps {
  ctx: CordisContext
  /** 该 tab 是否为活动 tab 且面板展开（隐藏时 live 视图应暂停轮询）。 */
  visible: boolean
  /** 会话级侧边栏 store（结构占位，本插件不深用）。 */
  store: unknown
  /** 会话作用域（结构占位）。 */
  scope: unknown
  /** 当前打开的 tab，含由 openTab seed 携带的 meta。 */
  tab: {
    id: string
    type: string
    title: string
    meta?: unknown
  }
  // 其余字段本插件未使用，保留为可选以兼容结构。
  [key: string]: unknown
}

/** openTab 的 seed（结构子集，见 OpenTabSeed）。 */
export interface BetterSidebarOpenTabSeed {
  type: string
  title?: string
  path?: string
  diff?: unknown
  id?: string
  url?: string
  /** JSON 可序列化的 tab 自定义状态。 */
  meta?: unknown
}

/** 在 better-sidebar 注册一个 tab 所需的描述器字段（结构子集，见 TabDescriptor）。 */
export interface BetterSidebarTabDescriptor {
  /** 唯一 id；同时是 SidebarTab.type 值。 */
  id: string
  /** tab 标题（+ 菜单、标签栏）。 */
  title: string | (() => string)
  /** 可选图标。 */
  icon?: ReactNode | ((size: number) => ReactNode)
  /** + 菜单排序，默认 100。 */
  order?: number
  /** single: true 表示开一次即可、重复打开聚焦已有实例（dedupeKey=()=>id）。 */
  single?: boolean
  /** tab 内容组件。 */
  component: (props: BetterSidebarTabComponentProps) => ReactNode
}

/** `ctx.betterSidebar` 服务（结构子集，见 BetterSidebarService）。 */
export interface BetterSidebarService {
  registerTab(descriptor: BetterSidebarTabDescriptor): () => void
  /** 打开一个 tab；`meta` 会随 seed 持久化到打开的 tab 上。 */
  openTab(seed: BetterSidebarOpenTabSeed, scope?: unknown): void
  /** 当前快照（结构占位，仅作类型完整）。 */
  getSnapshot?(): unknown
  subscribe?(listener: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** dsh-better-sidebar 暴露的客户端侧边栏注册服务（仅浏览器端存在）。 */
    betterSidebar: BetterSidebarService
  }
}

/**
 * 本地结构化的 `webServer` 服务类型（monorepo 内编译用）。
 *
 * 该包在 DSH 仓库内构建，而承载路由的 `@deepseek-ai/dsh-host-webserver` 由宿主
 * profile 提供，不出现在本仓库的依赖图里——它对自己 `Context` 的 `declare module`
 * 增强到不了这里（与 client 半区的 better-sidebar.ts 同一处理方式）。因此这里按
 * 实际运行期形状定义一份结构化的 `WebServer` / `WebRoute`，供 `apply` 里
 * `ctx.get('webServer')` 的结果做类型断言。这些类型是结构子集，运行期不携带
 * 任何导入值（纯类型，打包时被擦除）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** 路由匹配方式：'exact' 精确匹配路径，'prefix' 匹配该前缀及其子路径。 */
export type WebRouteKind = 'exact' | 'prefix'

/** 一条具名路由注册（结构子集，见 @deepseek-ai/dsh-host-webserver 的 WebRoute）。 */
export interface WebRoute {
  kind: WebRouteKind
  /** 绝对路径，无尾斜杠。 */
  path: string
  /** 独占整条响应的生命周期。 */
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** `ctx.webServer` 服务（结构子集，仅本插件用到的成员）。 */
export interface WebServer {
  /** 注册一条具名路由，返回移除该路由的 disposer。 */
  register(route: WebRoute): () => void
}

/**
 * @deepseek-ai/dsh-qianxun-tab — 千寻回测控制台（dsh-better-sidebar 自定义 tab）。
 *
 * 本文件是 Node（宿主）半区入口：把「提示词」从浏览器 localStorage 迁到宿主的
 * 服务端存储，并在 `/api/dsh-qianxun-tab/prompts` 上暴露给浏览器半区调用。
 * 背景：localStorage 按「浏览器 profile × 源（协议+主机+端口）」隔离，Safari 里
 * 存的提示词 Chrome 看不到；DSH Desktop 每次启动都用 `reservePort()` 拿一个新的
 * 随机端口（origin 每次都变），localStorage 因此每次都是空桶。改为服务端存储后，
 * 同一台机器上的任何浏览器/任何端口看到的都是同一份数据。
 *
 * 数据落盘：`$DSH_HOME/qianxun/prompts.json`
 *   { version, rev, updatedAt, prompts: [{ id, name, content, created_at, updated_at }] }
 * 写入是原子的（临时文件 + rename），并按到达顺序串行化，避免并发覆盖。
 *
 * 路由（exact，同源 fetch）：
 *   GET    /api/dsh-qianxun-tab/prompts  → { ok, rev, updatedAt, prompts }
 *   PUT    /api/dsh-qianxun-tab/prompts  ← { prompts } → { ok, rev, updatedAt, count }
 *
 * 浏览器半区（`exports["./client"]`）仍负责 tab 注册与 UI。
 *
 * 关于 `inject`：`betterSidebar` 是浏览器端服务，绝不能出现在这里；`webServer` 则
 * **必须**声明为宿主依赖。原因是 cordis 的服务读取默认走 strict：
 *   `ctx.get(name)` → `reflect._getImpl(name, true)` →
 *   `if (strict && impl.fiber.state !== FiberState.ACTIVE) return undefined`
 * 服务提供方（host-webserver）的 `[Service.init]` 是异步的（要 listen），启动期各
 * 插件按顺序 apply；不声明 inject 时本插件会先跑、`ctx.get('webServer')` 拿到
 * undefined，路由就被静默跳过了（2026-09-12 实测踩到：桌面版端点一直 401）。
 * 声明 `inject: ['webServer']` 后 cordis 会把本插件推迟到该服务可用之后再 apply。
 * 非 web profile 没有 webServer 时本插件保持 pending，不会报错。
 */
import type { Context } from '@deepseek-ai/cordis';
/** cordis.yml 插件行使用的插件名。 */
export declare const name = "dsh-qianxun-tab";
/**
 * Node 半区需要注入的服务。
 *
 * `webServer` 必须在这里声明：cordis 的 `ctx.get()` 默认是 strict 读取，服务提供方
 * 的 fiber 未 ACTIVE 时返回 undefined（host-webserver 的 init 是异步 listen），
 * 声明后由 cordis 负责推迟 apply，避免启动期竞态导致路由静默丢失。
 * 宿主侧没有 `betterSidebar`（那是浏览器端服务），不能出现在这里。
 */
export declare const inject: string[];
/**
 * Node 半区挂载：把提示词端点注册到宿主的 webServer。
 *
 * `inject: ['webServer']` 已保证 apply 时该服务可用；这里的兜底分支只作防御，
 * 且**必须留日志**——2026-09-12 的故障就是这条路径曾经静默 return，导致路由没注册
 * 却在日志里查不到任何痕迹（浏览器半区只会安静地回落到 localStorage）。
 */
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map
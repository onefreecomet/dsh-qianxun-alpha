/**
 * 千寻回测 tab client-plugin 入口。
 *
 * 作为 dsh-better-sidebar 的自定义 tab 注册：通过 `inject: ['betterSidebar']` 声明
 * 依赖 better-sidebar 服务，在 `apply` 里调用 `ctx.betterSidebar.registerTab(...)`
 * 注册 id 为 `qianxun` 的 tab，其内容组件 QianxunTab 直连本地回测引擎 REST API。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
/** 需要 better-sidebar 服务就绪（浏览器端）后本插件才挂载。 */
export declare const inject: string[];
/** 注册千寻回测 tab 到 better-sidebar 侧边栏。 */
export declare function apply(ctx: ClientContext): void;
//# sourceMappingURL=index.d.ts.map
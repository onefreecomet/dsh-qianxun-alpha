/**
 * 千寻回测 tab client-plugin 入口。
 *
 * 作为 dsh-better-sidebar 的自定义 tab 注册：通过 `inject: ['betterSidebar']` 声明
 * 依赖 better-sidebar 服务，在 `apply` 里调用 `ctx.betterSidebar.registerTab(...)`
 * 注册 id 为 `qianxun` 的 tab，其内容组件 QianxunTab 直连本地回测引擎 REST API。
 */
import { createElement } from 'react';
import { QianxunTab } from "./QianxunTab.js";
import { QianxunDetailTab } from "./QianxunDetailTab.js";
import { PromptEditTab } from "./PromptEditTab.js";
/** 需要 better-sidebar 服务就绪（浏览器端）后本插件才挂载。 */
export const inject = ['betterSidebar'];
/** 注册千寻回测 tab 到 better-sidebar 侧边栏。 */
export function apply(ctx) {
    ctx.effect(() => {
        const disposers = [
            ctx.betterSidebar.registerTab({
                id: 'qianxun',
                title: '千寻回测',
                single: true,
                // 本文件为 .ts，用 createElement 构造组件渲染，避免 JSX（JSX 仅限 .tsx）。
                component: props => createElement(QianxunTab, props),
            }),
            // 批次详情 tab：可由列表 tab 用 openTab 打开，且可开多个（不设 single）。
            ctx.betterSidebar.registerTab({
                id: 'qianxun-detail',
                title: '千寻结果',
                icon: '🔬',
                // 不设 single：允许开多个详情 tab（dedupeKey 默认按 tab.id 去重，
                // 每个 openTab 会带上不同的 meta，但 id 相同会聚焦已有实例——
                // 因此这里显式按 batchNo 生成的 id 去重，见 QianxunTab 打开详情处）。
                component: props => createElement(QianxunDetailTab, props),
            }),
            // 提示词编辑 tab：点击列表项打开，可编辑、自动保存、删除。
            ctx.betterSidebar.registerTab({
                id: 'qianxun-prompt',
                title: '提示词',
                icon: '📋',
                component: props => createElement(PromptEditTab, props),
            }),
        ];
        return () => {
            for (const dispose of disposers)
                dispose();
        };
    }, 'dsh-qianxun-tab: register betterSidebar tabs');
}
//# sourceMappingURL=index.js.map
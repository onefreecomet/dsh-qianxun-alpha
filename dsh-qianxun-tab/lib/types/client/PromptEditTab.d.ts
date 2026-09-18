/**
 * PromptEditTab — 提示词编辑 tab。
 * 由列表 tab（QianxunTab）点提示词名字 → openTab({type:'qianxun-prompt', meta:{promptId}})
 * 打开。内容存服务端（见 prompts.ts），text 实时可改，离开自动保存。
 *
 * 数据是异步到达的（页面刷新后恢复的 prompt tab 可能先于服务端加载完成），
 * 因此这里先同步取一次，取不到再等一次加载；一旦载入过就不再回填，
 * 以免覆盖正在编辑的内容。
 */
import type { BetterSidebarTabComponentProps } from './better-sidebar.ts';
export declare function PromptEditTab(props: BetterSidebarTabComponentProps): JSX.Element | null;
//# sourceMappingURL=PromptEditTab.d.ts.map
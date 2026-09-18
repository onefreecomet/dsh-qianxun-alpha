/**
 * 千寻批次详情 tab —— 展示某一批次的完整逐条回测结果。
 *
 * 由列表 tab（QianxunTab）通过 `ctx.betterSidebar.openTab({ type:'qianxun-detail',
 * title, meta:{ batchNo } })` 打开。`props.tab.meta.batchNo` 标识要展示的批次；
 * 无 batchNo 时显示“未指定批次”。5s 轮询（仅 visible 时）。
 */
import type { BetterSidebarTabComponentProps } from './better-sidebar.ts';
export declare function QianxunDetailTab(props: BetterSidebarTabComponentProps): JSX.Element | null;
//# sourceMappingURL=QianxunDetailTab.d.ts.map
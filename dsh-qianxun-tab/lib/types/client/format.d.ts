/**
 * 千寻 detail / 列表共用的展示工具：指标格式化、check 徽章、指标表渲染。
 */
import type { ReactNode } from 'react';
import type { QianxunAlphaCheck, QianxunBatchDetail, QianxunMetrics, QianxunPnlRecord } from './qianxun.ts';
/** 详情表按此顺序展示的指标列。 */
export declare const METRIC_KEYS: ReadonlyArray<{
    key: keyof QianxunMetrics;
    label: string;
    pct?: boolean;
}>;
/** 运行中的状态集合（用于高亮/进度/控制按钮显隐）。 */
export declare const RUNNING_STATES: Set<string>;
/**
 * 数值格式化：3 位有效数字、去尾随 0；`asPct` 时把小数比率 ×100 转百分比。
 * 百分比展示去掉尾随 0（如 0.5 -> 50%，0.1234 -> 12.3%）。
 */
export declare function fmt(v: unknown, asPct?: boolean): string;
/** 是否运行中（用于控制按钮显隐与进度条）。 */
export declare function isRunning(state: string | undefined): boolean;
/** check 三色（+黄）徽章；无值返回空。 */
export declare function checkBadge(check: string | null | undefined): ReactNode;
/**
 * 渲染单 alpha 的详细 check 列表。
 * - 高亮 PROD_CORRELATION（最常用筛选项）
 * - 用三色徽章标 PASS/FAIL/WARNING/PENDING
 * - 顶部 summary：X 通过 / Y 失败 / Z 待定 / W 警告
 */
export declare function renderChecksList(checks: QianxunAlphaCheck[]): ReactNode;
/** 渲染全量逐条结果表。results 为空时给友好空态。
 * 提供 `onCheck` 时，每行末尾追加一个 "🔍 check" 按钮用于触发详细 check 拉取。 */
/** renderMetricsTable 可选回调：每行最多 3 个动作按钮（🔍/📈/📐）。 */
export interface MetricsTableActions {
    /** 点击 🔍：拉取 BRAIN `/alphas/{id}/check` 全部 checks */
    onCheck?: (alphaId: string) => void;
    /** 点击 📈：拉取 `/alphas/{id}/correlations/prod` 真 prod_corr 数值（绕过 PENDING） */
    onProdCorr?: (alphaId: string) => void;
    /** 点击 📐：下载 PnL + 浏览器内算本地 SELF_CORRELATION（不依赖 BRAIN） */
    onLocalSelf?: (alphaId: string) => void;
}
/** 渲染全量逐条结果表。results 为空时给友好空态。
 * 提供 actions 时，每行末尾追加最多 3 个动作按钮。 */
export declare function renderMetricsTable(results: QianxunBatchDetail['results'], actions?: MetricsTableActions): ReactNode;
/** margin = (0.7 - prod_corr)，并查表得到 tier 标签。 */
export declare function classifyMargin(prodCorr: number | null | undefined): {
    label: string;
    margin: number;
    tier: string;
};
/** 表达式里包含已知 prod-fresh 字段？ */
export declare function isProdFreshField(expr: string | null | undefined): {
    hit: boolean;
    field?: string;
};
/** 表达式里包含已知 prod 雷区字段？ */
export declare function isDeadZoneField(expr: string | null | undefined): {
    hit: boolean;
    field?: string;
    note?: string;
};
/** IS_LADDER_SHARPE 风险分级（避免给必败 alpha 浪费 submission check）。 */
export declare function classifyLadderRisk(v: number | null | undefined): 'no_data' | 'certain_fail' | 'high' | 'medium' | 'low';
/** Pearson correlation of two numeric series. Returns NaN on insufficient data. */
export declare function pearson(xs: number[], ys: number[]): number;
/** 用每日 returns（PnL 增量）算与候选集的相关性，返回 max / min / per-candidate。 */
export declare function computeLocalSelfCorr(target: QianxunPnlRecord[], candidates: Array<{
    alphaId: string;
    records: QianxunPnlRecord[];
}>): {
    targetReturns: number[];
    targetDays: number;
    perCandidate: Array<{
        alphaId: string;
        corr: number | null;
        overlapDays: number;
    }>;
    max: number | null;
    min: number | null;
};
//# sourceMappingURL=format.d.ts.map
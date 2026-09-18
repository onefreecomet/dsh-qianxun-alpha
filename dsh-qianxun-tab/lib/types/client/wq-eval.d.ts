/**
 * wq-eval.ts — 把 wq-alpha-research skill `submission_checker.py` 的实战沉淀
 * 翻译成 TypeScript 常量 + 工具函数。供 Qianxun 前端做稳健性 / prod-fresh /
 * dead-zone 评估，无需调外部脚本。
 *
 * 数据来源（2026-07 实战沉淀的 24 个 USA pass alpha 经验）：
 * - `submission_checker.py::MARGIN_TIERS`     — 三档安全边际阈值
 * - `submission_checker.py::PROD_FRESH_FIELDS` — prod-fresh 字段清单
 * - `submission_checker.py::PROD_DEAD_ZONE_FIELDS` — prod 雷区字段清单
 *
 * 更新来源：wq-alpha-research skill 的 scripts/submission_checker.py
 * 改这份文件时务必同步刷新上游 skill。
 */
/** 三档安全边际阈值（与 wq-alpha-research skill 完全对齐）。
 * margin = 0.7 - prod_corr（含 epsilon 防浮点）。margin 越大越安全。 */
export declare const MARGIN_TIERS: ReadonlyArray<{
    threshold: number;
    label: string;
    description: string;
}>;
/** 已知 "prod-fresh" 字段（USA TOP3000 实战发现，ac=0-2, cov > 0.94）。
 * 在 sidebar 表达式中匹配到时，会作为"加分项"标注。 */
export declare const PROD_FRESH_FIELDS: ReadonlyArray<{
    field: string;
    note: string;
}>;
/** 已知 "prod 雷区" 字段（USA TOP3000 实战发现，prod_corr > 0.70 必中）。
 * 词边界匹配——"ad" 不会误伤 "adjusted/load/spread/trading" 等。 */
export declare const PROD_DEAD_ZONE_FIELDS: ReadonlyArray<{
    field: string;
    note: string;
}>;
/** IS_LADDER_SHARPE 阈值（submission 早信号，避免给必败 alpha 浪费 check）。 */
export declare const LADDER_THRESHOLD = 1.58;
export declare const LADDER_HIGH_RISK = 1.68;
/** prod_corr 死区线（BRAIN 平台硬线）。 */
export declare const PROD_CORR_DEAD_ZONE = 0.7;
/** margin 计算 epsilon（防浮点精度问题，如 0.7-0.65=0.04999...）。 */
export declare const MARGIN_EPSILON = 1e-9;
//# sourceMappingURL=wq-eval.d.ts.map
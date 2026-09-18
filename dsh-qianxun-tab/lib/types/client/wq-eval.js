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
export const MARGIN_TIERS = [
    { threshold: 0.10, label: 'excellent', description: '安全边际极宽，强烈推荐' },
    { threshold: 0.05, label: 'robust', description: '安全边际足，推荐' },
    { threshold: 0.02, label: 'marginal', description: '安全边际薄，谨慎推荐（字段新时仍可）' },
    { threshold: 0.0, label: 'tight', description: '压线通过，仅字段 prod_fresh 时可' },
];
/** 已知 "prod-fresh" 字段（USA TOP3000 实战发现，ac=0-2, cov > 0.94）。
 * 在 sidebar 表达式中匹配到时，会作为"加分项"标注。 */
export const PROD_FRESH_FIELDS = [
    { field: 'anl10_smartest_prr_fy1_smart_ests_v2', note: 'Price Return Ratio FY1 Smart Est v2' },
    { field: 'anl10_smartest_gps_fy1_smart_ests_v2', note: 'Gross Profit/Sales FY1 Smart Est v2' },
    { field: 'anl10_smartest_ebi_fy1_smart_ests_v2', note: 'Earnings Before Interest FY1 Smart Est v2' },
    { field: 'anl10_smartest_ebt_fy1_smart_ests_v2', note: 'Earnings Before Tax FY1 Smart Est v2' },
    { field: 'anl10_smartest_fcf_fy1_smart_ests_v2', note: 'Free Cash Flow FY1 Smart Est v2' },
    { field: 'anl10_smartest_sal_fy1_smart_ests_v2', note: 'Sales FY1 Smart Est v2' },
    { field: 'alt2_short_term_hedge_signal_5d_q5', note: '5-day hedge q5 quintile' },
    { field: 'alt_short_term_hedge_signal_5d_bin1', note: '5-day hedge q1 decile' },
    { field: 'alt_short_term_hedge_signal_5d_bin5', note: '5-day hedge q5 decile' },
    { field: 'alt_long_term_hedge_signal_60d_bin1_mcr', note: '60-day long hedge q1 (mcr)' },
    { field: 'alt_long_term_hedge_signal_120d_bin1_mcr', note: '120-day long hedge q1 (mcr)' },
];
/** 已知 "prod 雷区" 字段（USA TOP3000 实战发现，prod_corr > 0.70 必中）。
 * 词边界匹配——"ad" 不会误伤 "adjusted/load/spread/trading" 等。 */
export const PROD_DEAD_ZONE_FIELDS = [
    { field: 'operating_income/equity', note: 'OI/E 雷区（ac 200+，已有 100+ 衍生 alpha）' },
    { field: 'operating_income/sales', note: 'OI/S 雷区' },
    { field: 'est_eps/close', note: 'EPS yield 雷区（ac 200+）' },
    { field: 'est_fcf/close', note: 'FCF yield 雷区' },
    { field: 'est_revenue/close', note: 'Revenue yield 雷区' },
    { field: 'free_cash_flow_reported_value/equity', note: 'FCF/E 雷区' },
    { field: 'equity/assets', note: 'equity/assets 雷区' },
    { field: 'liabilities/assets', note: 'liabilities/assets 雷区' },
    { field: 'sales/assets', note: 'sales/assets 雷区' },
    { field: 'enterprise_value/cashflow', note: 'EV/CF 雷区' },
    { field: 'logv', note: 'log volume 主因子雷区（BRAIN 100+ 流动性 alpha）' },
    { field: 'vwap', note: 'vwap 矩阵字段，不能用 group_neutralize' },
    { field: 'aposc', note: 'aposc 矩阵字段，不能用 group_neutralize' },
    { field: 'ad', note: 'ad 矩阵字段，不能用 group_neutralize' },
    { field: 'afinn_negative_word_count', note: 'afinn 字段，prod 雷区' },
    { field: 'snt23_5neg_conf_up_170', note: 'snt23 情绪字段，prod 雷区' },
    { field: 'daily_equity_mood_indicator', note: '情绪指标雷区' },
    { field: 'anl10_smartest_prr_fy2_smart_ests_v2', note: 'prr FY2 已有 prod' },
    { field: 'anl10_smartest_prr_fq1_smart_ests_v2', note: 'prr FQ1 已有 prod' },
    { field: 'anl10_smartest_prr_fq2_smart_ests_v2', note: 'prr FQ2 已有 prod' },
    { field: 'anl10_smartest_roa_fy1_smart_ests_v2', note: 'roa FY1 已有 prod（0.74-0.81）' },
    { field: 'anl10_smartest_roe_fy1_smart_ests_v2', note: 'roe FY1 已有 prod（0.74-0.81）' },
    { field: 'anl10_smartest_ner_fy1_smart_ests_v2', note: 'ner FY1 已有 prod（0.70+）' },
];
/** IS_LADDER_SHARPE 阈值（submission 早信号，避免给必败 alpha 浪费 check）。 */
export const LADDER_THRESHOLD = 1.58;
export const LADDER_HIGH_RISK = 1.68;
/** prod_corr 死区线（BRAIN 平台硬线）。 */
export const PROD_CORR_DEAD_ZONE = 0.70;
/** margin 计算 epsilon（防浮点精度问题，如 0.7-0.65=0.04999...）。 */
export const MARGIN_EPSILON = 1e-9;
//# sourceMappingURL=wq-eval.js.map
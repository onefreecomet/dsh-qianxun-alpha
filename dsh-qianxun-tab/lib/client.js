window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-qianxun-tab",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/qianxun.ts
		/**
		* 浏览器端 REST 客户端，直连本地千寻（Qianxun）回测引擎 http://127.0.0.1:8765。
		*
		* CORS 关键（已实测）：
		* - 引擎对 GET 不打预检、返回 `Access-Control-Allow-Origin: *`，读操作用普通 fetch。
		* - 引擎对 OPTIONS 返回 501（Unsupported method），带 JSON content-type 的浏览器
		*   POST 会被 CORS 预检拦截。因此所有写操作都以 *简单请求* 发送：
		*   用 `Content-Type: text/plain;charset=UTF-8` 携带 JSON 字符串 body。
		*   引擎对 content-type 不敏感、一律按 JSON 解析 body（已实测返回 200）。
		*/
		/** 本地回测引擎基地址，可用 URL 参数 ?qianxun= 覆盖（便于测试）。 */
		const QIANXUN_BASE = (() => {
			return (typeof location !== "undefined" ? new URLSearchParams(location.search).get("qianxun") : null) ?? "http://127.0.0.1:8765";
		})();
		async function readJson(url) {
			const res = await fetch(url, { headers: { Accept: "application/json" } });
			if (!res.ok) throw new Error(`qianxun ${res.status} ${res.statusText} for ${url}`);
			return res.json();
		}
		/** POST JSON body，作为 CORS 简单请求（text/plain 规避 8765 的 OPTIONS 501）。 */
		async function postJson(url, body) {
			const res = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "text/plain;charset=UTF-8" },
				body: JSON.stringify(body ?? {})
			});
			if (!res.ok) throw new Error(`qianxun ${res.status} ${res.statusText} for ${url}`);
			return res.json().catch(() => ({}));
		}
		/** 取批次列表（引擎返回最新在前）。 */
		async function listBatches() {
			const data = await readJson(`${QIANXUN_BASE}/api/jobs`);
			if (Array.isArray(data)) return data;
			return data?.jobs ?? [];
		}
		/** 取单批完整结果。 */
		async function getBatchResult(batchNo) {
			return readJson(`${QIANXUN_BASE}/api/jobs/${encodeURIComponent(batchNo)}/result`);
		}
		/** 取单 alpha 的 BRAIN check 详情（PROD_CORRELATION + 全部 checks）。
		* qianxund 端有 60s TTL 缓存。失败时抛 Error，UI 需要捕获并降级显示。 */
		async function getAlphaCheck(alphaId) {
			return readJson(`${QIANXUN_BASE}/api/alphas/${encodeURIComponent(alphaId)}/check`);
		}
		/** 取单 alpha 的本地缓存 PnL（qianxund 会自动 fallback BRAIN + 写盘）。
		* 二次调用秒出，无 BRAIN 网络往返。 */
		async function getCachedPnl(alphaId) {
			return readJson(`${QIANXUN_BASE}/api/pnl-cache/${encodeURIComponent(alphaId)}`);
		}
		/** 取本地 PnL 缓存列表（用于侧边栏显示已缓存数量）。 */
		async function getPnlCacheStatus() {
			return readJson(`${QIANXUN_BASE}/api/pnl-cache`);
		}
		async function getActiveAlphas() {
			return readJson(`${QIANXUN_BASE}/api/active-alphas`);
		}
		/** 启动 PnL 批量回填任务（异步），返回 job_id 用于轮询。
		* Content-Type 故意用 text/plain 规避 CORS preflight（qianxund 没 OPTIONS handler）；
		* 跟 submitBatch 一致——服务端按 JSON 解析 body。 */
		async function startBackfillPnls(req = {}) {
			const r = await fetch(`${QIANXUN_BASE}/api/pnl-cache-backfill`, {
				method: "POST",
				headers: { "Content-Type": "text/plain;charset=UTF-8" },
				body: JSON.stringify(req)
			});
			if (!r.ok) throw new Error(`qianxun ${r.status} ${r.statusText}`);
			return r.json();
		}
		/** 轮询回填任务进度 */
		async function getBackfillStatus(jobId) {
			return readJson(`${QIANXUN_BASE}/api/pnl-cache-backfill/${encodeURIComponent(jobId)}`);
		}
		/** 取单 alpha 的 prod correlation 数值。
		* qianxund 端有 60s TTL 缓存 + 首次空响应也由后端重试 3 次。 */
		async function getAlphaProdCorr(alphaId) {
			const raw = await readJson(`${QIANXUN_BASE}/api/alphas/${encodeURIComponent(alphaId)}/correlations/prod`);
			return {
				max: typeof raw.max === "number" ? raw.max : null,
				min: typeof raw.min === "number" ? raw.min : null,
				records: Array.isArray(raw.records) ? raw.records : []
			};
		}
		/** 对批次执行控制动词（pause / resume / cancel）。 */
		async function actOnBatch(batchNo, action) {
			return postJson(`${QIANXUN_BASE}/api/jobs/${encodeURIComponent(batchNo)}`, { action });
		}
		/** 断点续跑：POST /api/jobs/<batch>/resume。 */
		async function resumeBatch(batchNo) {
			return postJson(`${QIANXUN_BASE}/api/jobs/${encodeURIComponent(batchNo)}/resume`, {});
		}
		/** GET /api/config —— 当前并发 / 批大小。 */
		async function getConfig() {
			return readJson(`${QIANXUN_BASE}/api/config`);
		}
		/** POST /api/config —— 调并发 / 批大小。body 只传要改的项。 */
		async function setConfig(body) {
			return await postJson(`${QIANXUN_BASE}/api/config`, body);
		}
		/** GET /api/quota —— 今日提交数 / 每日配额。 */
		async function getQuota() {
			return readJson(`${QIANXUN_BASE}/api/quota`);
		}
		/** 读池子（纯本地，不打 BRAIN）。 */
		async function getAlphaPool() {
			return readJson(`${QIANXUN_BASE}/api/alpha-pool`);
		}
		/** 改池子：action = add | remove | clear | set。 */
		async function mutateAlphaPool(action, ids) {
			return await postJson(`${QIANXUN_BASE}/api/alpha-pool`, {
				action,
				ids
			});
		}
		/** 写某条 alpha 的备注（纯本地）。注意引擎的 action 是 note，不是改池子成员。 */
		async function setAlphaPoolNote(alphaId, note) {
			return await postJson(`${QIANXUN_BASE}/api/alpha-pool`, {
				action: "note",
				alpha_id: alphaId,
				note
			});
		}
		/** 同步：拉取整池（或指定 ids）的指标 / 相关性 / 状态。 */
		async function syncAlphaPool(ids) {
			return await postJson(`${QIANXUN_BASE}/api/alpha-pool/sync`, ids ? { ids } : {});
		}
		/** 账号当日新增 ACTIVE 数（每天本地 12:00 重置，吃引擎侧 5min 缓存）。 */
		async function getActiveStats(force = false) {
			return readJson(`${QIANXUN_BASE}/api/alpha-pool/active-stats${force ? "?force=1" : ""}`);
		}
		/**
		* ⚠️ 真提交（不可逆）。只有人类点按钮才会走到这里。
		*
		* `confirm` 是引擎侧硬性闸门：必须逐字传 CONFIRM_SUBMIT_TOKEN，否则 400。
		* agent / 脚本不得代为调用。
		*/
		const CONFIRM_SUBMIT_TOKEN = "yes-i-know";
		async function submitAlphas(ids, opts = {}) {
			return await postJson(opts.pollOnly === true ? `${QIANXUN_BASE}/api/alpha-pool/submit/poll` : `${QIANXUN_BASE}/api/alpha-pool/submit`, {
				ids,
				confirm: CONFIRM_SUBMIT_TOKEN
			});
		}
		/** 查提交任务进度。 */
		async function getSubmitJob(jobId) {
			return readJson(`${QIANXUN_BASE}/api/alpha-pool/submit/${encodeURIComponent(jobId)}`);
		}
		//#endregion
		//#region src/client/wq-eval.ts
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
		const MARGIN_TIERS = [
			{
				threshold: .1,
				label: "excellent",
				description: "安全边际极宽，强烈推荐"
			},
			{
				threshold: .05,
				label: "robust",
				description: "安全边际足，推荐"
			},
			{
				threshold: .02,
				label: "marginal",
				description: "安全边际薄，谨慎推荐（字段新时仍可）"
			},
			{
				threshold: 0,
				label: "tight",
				description: "压线通过，仅字段 prod_fresh 时可"
			}
		];
		/** 已知 "prod-fresh" 字段（USA TOP3000 实战发现，ac=0-2, cov > 0.94）。
		* 在 sidebar 表达式中匹配到时，会作为"加分项"标注。 */
		const PROD_FRESH_FIELDS = [
			{
				field: "anl10_smartest_prr_fy1_smart_ests_v2",
				note: "Price Return Ratio FY1 Smart Est v2"
			},
			{
				field: "anl10_smartest_gps_fy1_smart_ests_v2",
				note: "Gross Profit/Sales FY1 Smart Est v2"
			},
			{
				field: "anl10_smartest_ebi_fy1_smart_ests_v2",
				note: "Earnings Before Interest FY1 Smart Est v2"
			},
			{
				field: "anl10_smartest_ebt_fy1_smart_ests_v2",
				note: "Earnings Before Tax FY1 Smart Est v2"
			},
			{
				field: "anl10_smartest_fcf_fy1_smart_ests_v2",
				note: "Free Cash Flow FY1 Smart Est v2"
			},
			{
				field: "anl10_smartest_sal_fy1_smart_ests_v2",
				note: "Sales FY1 Smart Est v2"
			},
			{
				field: "alt2_short_term_hedge_signal_5d_q5",
				note: "5-day hedge q5 quintile"
			},
			{
				field: "alt_short_term_hedge_signal_5d_bin1",
				note: "5-day hedge q1 decile"
			},
			{
				field: "alt_short_term_hedge_signal_5d_bin5",
				note: "5-day hedge q5 decile"
			},
			{
				field: "alt_long_term_hedge_signal_60d_bin1_mcr",
				note: "60-day long hedge q1 (mcr)"
			},
			{
				field: "alt_long_term_hedge_signal_120d_bin1_mcr",
				note: "120-day long hedge q1 (mcr)"
			}
		];
		/** 已知 "prod 雷区" 字段（USA TOP3000 实战发现，prod_corr > 0.70 必中）。
		* 词边界匹配——"ad" 不会误伤 "adjusted/load/spread/trading" 等。 */
		const PROD_DEAD_ZONE_FIELDS = [
			{
				field: "operating_income/equity",
				note: "OI/E 雷区（ac 200+，已有 100+ 衍生 alpha）"
			},
			{
				field: "operating_income/sales",
				note: "OI/S 雷区"
			},
			{
				field: "est_eps/close",
				note: "EPS yield 雷区（ac 200+）"
			},
			{
				field: "est_fcf/close",
				note: "FCF yield 雷区"
			},
			{
				field: "est_revenue/close",
				note: "Revenue yield 雷区"
			},
			{
				field: "free_cash_flow_reported_value/equity",
				note: "FCF/E 雷区"
			},
			{
				field: "equity/assets",
				note: "equity/assets 雷区"
			},
			{
				field: "liabilities/assets",
				note: "liabilities/assets 雷区"
			},
			{
				field: "sales/assets",
				note: "sales/assets 雷区"
			},
			{
				field: "enterprise_value/cashflow",
				note: "EV/CF 雷区"
			},
			{
				field: "logv",
				note: "log volume 主因子雷区（BRAIN 100+ 流动性 alpha）"
			},
			{
				field: "vwap",
				note: "vwap 矩阵字段，不能用 group_neutralize"
			},
			{
				field: "aposc",
				note: "aposc 矩阵字段，不能用 group_neutralize"
			},
			{
				field: "ad",
				note: "ad 矩阵字段，不能用 group_neutralize"
			},
			{
				field: "afinn_negative_word_count",
				note: "afinn 字段，prod 雷区"
			},
			{
				field: "snt23_5neg_conf_up_170",
				note: "snt23 情绪字段，prod 雷区"
			},
			{
				field: "daily_equity_mood_indicator",
				note: "情绪指标雷区"
			},
			{
				field: "anl10_smartest_prr_fy2_smart_ests_v2",
				note: "prr FY2 已有 prod"
			},
			{
				field: "anl10_smartest_prr_fq1_smart_ests_v2",
				note: "prr FQ1 已有 prod"
			},
			{
				field: "anl10_smartest_prr_fq2_smart_ests_v2",
				note: "prr FQ2 已有 prod"
			},
			{
				field: "anl10_smartest_roa_fy1_smart_ests_v2",
				note: "roa FY1 已有 prod（0.74-0.81）"
			},
			{
				field: "anl10_smartest_roe_fy1_smart_ests_v2",
				note: "roe FY1 已有 prod（0.74-0.81）"
			},
			{
				field: "anl10_smartest_ner_fy1_smart_ests_v2",
				note: "ner FY1 已有 prod（0.70+）"
			}
		];
		/** prod_corr 死区线（BRAIN 平台硬线）。 */
		const PROD_CORR_DEAD_ZONE = .7;
		/** margin 计算 epsilon（防浮点精度问题，如 0.7-0.65=0.04999...）。 */
		const MARGIN_EPSILON = 1e-9;
		//#endregion
		//#region \0dsh-css:src/client/QianxunTab.module.css.mjs
		const css = ":root{--qx-green:#3fb950;--qx-red:#ff7b72;--qx-yellow:#d29922;--qx-blue:#58a6ff}.aG5CZG_root{height:100%;min-height:0;color:var(--ds-color-text,#e5e5e5);background:var(--ds-color-bg,#151515);flex-direction:column;font-size:12px;display:flex}.aG5CZG_header{border-bottom:1px solid var(--ds-color-border,#333);background:var(--ds-color-bg-soft,#1c1c1c);flex-shrink:0;align-items:center;gap:8px;padding:10px 12px;display:flex}.aG5CZG_titleIcon{font-size:15px;line-height:1}.aG5CZG_title{letter-spacing:.2px;font-weight:650}.aG5CZG_spacer{flex:1}.aG5CZG_quotaChip{background:color-mix(in srgb, var(--ds-color-bg,#1a1a1a) 40%, transparent);border:1px solid var(--ds-color-border,#333);color:var(--ds-color-text,#e5e5e5);font-variant-numeric:tabular-nums;white-space:nowrap;cursor:help;border-radius:999px;flex-shrink:0;align-items:center;gap:3px;padding:2px 8px;font-size:11px;display:inline-flex}.aG5CZG_quotaLabel{opacity:.7;font-size:10px}.aG5CZG_quotaChip b{color:var(--qx-blue);font-weight:650}.aG5CZG_quotaSep{opacity:.4;margin:0 1px}.aG5CZG_startEngineBtnOnline{background:color-mix(in srgb, var(--qx-green) 15%, transparent);border:1px solid color-mix(in srgb, var(--qx-green) 50%, transparent);color:var(--qx-green);cursor:default;white-space:nowrap;border-radius:6px;padding:3px 8px;font-family:inherit;font-size:11px;font-weight:600}.aG5CZG_startEngineBtnOffline{background:color-mix(in srgb, var(--qx-red) 15%, transparent);border:1px dashed color-mix(in srgb, var(--qx-red) 50%, transparent);color:var(--qx-red);cursor:pointer;white-space:nowrap;border-radius:6px;padding:3px 8px;font-family:inherit;font-size:11px;font-weight:600;animation:2s ease-in-out infinite aG5CZG_pulseOffline}@keyframes aG5CZG_pulseOffline{0%,to{opacity:1}50%{opacity:.6}}.aG5CZG_startEngineToast{text-overflow:ellipsis;white-space:nowrap;border-radius:6px;flex-shrink:0;max-width:220px;padding:2px 8px;font-size:11px;font-weight:600;animation:1.6s ease-in-out infinite aG5CZG_startEngineFade;overflow:hidden}.aG5CZG_startEngineToastOk{color:var(--qx-green);background:color-mix(in srgb, var(--qx-green) 12%, transparent)}.aG5CZG_startEngineToastWarn{color:var(--qx-yellow);background:color-mix(in srgb, var(--qx-yellow) 12%, transparent)}@keyframes aG5CZG_startEngineFade{0%,to{opacity:1}50%{opacity:.6}}.aG5CZG_cacheBadge{background:color-mix(in srgb, var(--qx-blue) 12%, transparent);border:1px solid color-mix(in srgb, var(--qx-blue) 35%, transparent);color:var(--qx-blue);font-variant-numeric:tabular-nums;white-space:nowrap;cursor:help;border-radius:999px;flex-shrink:0;align-items:center;gap:4px;padding:2px 8px;font-size:11px;font-weight:500;display:inline-flex}.aG5CZG_cacheBadgeActive{color:var(--qx-green);font-weight:600}.aG5CZG_cacheBadgeBackfill{color:var(--qx-yellow);font-variant-numeric:tabular-nums;font-weight:600;animation:1.4s ease-in-out infinite aG5CZG_cacheBackfillPulse}.aG5CZG_cacheBadgePartial{color:var(--qx-yellow);font-weight:600}.aG5CZG_cacheBadgeCaptcha{color:var(--qx-red);font-weight:600}@keyframes aG5CZG_cacheBackfillPulse{0%,to{opacity:1}50%{opacity:.55}}.aG5CZG_backfillBtn{background:color-mix(in srgb, var(--qx-blue) 12%, transparent);border:1px solid color-mix(in srgb, var(--qx-blue) 45%, transparent);color:var(--qx-blue);cursor:pointer;white-space:nowrap;border-radius:6px;flex-shrink:0;padding:3px 10px;font-family:inherit;font-size:11px;font-weight:600;transition:background .15s}.aG5CZG_backfillBtn:hover:not(:disabled){background:color-mix(in srgb, var(--qx-blue) 22%, transparent)}.aG5CZG_backfillBtn:disabled{opacity:.5;cursor:default}.aG5CZG_dot{border-radius:50%;flex-shrink:0;width:8px;height:8px}.aG5CZG_dotOnline,.aG5CZG_dotOk{background:var(--qx-green);box-shadow:0 0 0 3px color-mix(in srgb, var(--qx-green) 25%, transparent)}.aG5CZG_dotOffline,.aG5CZG_dotError{background:var(--qx-red);box-shadow:0 0 0 3px color-mix(in srgb, var(--qx-red) 25%, transparent)}.aG5CZG_dotUnknown{background:#8b949e;box-shadow:0 0 0 3px #8b949e40}.aG5CZG_dotRunning{background:var(--qx-blue);box-shadow:0 0 0 3px color-mix(in srgb, var(--qx-blue) 25%, transparent)}.aG5CZG_dotLabel{opacity:.75;white-space:nowrap;font-size:11px}.aG5CZG_body{flex-direction:column;flex:1;gap:10px;min-height:0;padding:10px;display:flex;overflow:auto}.aG5CZG_pagination{z-index:3;background:color-mix(in srgb, var(--ds-color-bg-soft,#1c1c1c) 92%, transparent);backdrop-filter:blur(6px);border:1px solid var(--ds-color-border,#333);color:var(--ds-color-text,#e5e5e5);border-radius:8px;align-items:center;gap:8px;padding:6px 10px;font-size:11px;display:flex;position:sticky;top:0;box-shadow:0 2px 6px #00000040}.aG5CZG_paginationBtn{border:1px solid var(--ds-color-border,#444);color:var(--ds-color-text,#e5e5e5);cursor:pointer;background:0 0;border-radius:6px;flex-shrink:0;justify-content:center;align-items:center;width:24px;height:24px;padding:0;font-size:14px;line-height:1;display:inline-flex}.aG5CZG_paginationBtn:hover:not(:disabled){background:var(--ds-color-bg-soft,#2a2a2a);border-color:var(--qx-blue);color:var(--qx-blue)}.aG5CZG_paginationBtn:disabled{opacity:.3;cursor:default}.aG5CZG_paginationInfo{white-space:nowrap;font-variant-numeric:tabular-nums;font-size:11px}.aG5CZG_paginationInfo b{color:var(--qx-blue);font-weight:650}.aG5CZG_paginationTotal{opacity:.75;margin-left:2px}.aG5CZG_paginationSizeLabel{opacity:.7;white-space:nowrap;font-size:11px}.aG5CZG_paginationSizeSelect{background:var(--ds-color-bg,#101010);border:1px solid var(--ds-color-border,#444);color:var(--ds-color-text,#e5e5e5);cursor:pointer;border-radius:6px;height:24px;padding:2px 6px;font-family:inherit;font-size:11px}.aG5CZG_paginationSizeSelect:focus{border-color:var(--qx-blue);box-shadow:0 0 0 2px color-mix(in srgb, var(--qx-blue) 25%, transparent);outline:none}.aG5CZG_paginationSizeHint{opacity:.55;white-space:nowrap;font-size:10px}.aG5CZG_iconBtn{color:var(--ds-color-text,#e5e5e5);cursor:pointer;background:0 0;border:1px solid #0000;border-radius:6px;justify-content:center;align-items:center;gap:4px;padding:3px 7px;font-size:12px;line-height:1.4;display:inline-flex}.aG5CZG_iconBtn:hover:not(:disabled){background:var(--ds-color-bg-soft,#2a2a2a);border-color:var(--ds-color-border,#444)}.aG5CZG_iconBtn:disabled{opacity:.35;cursor:default}.aG5CZG_actionIco{min-width:24px}.aG5CZG_actionDanger{color:var(--qx-red);border-color:color-mix(in srgb, var(--qx-red) 45%, transparent)}.aG5CZG_actionDanger:hover:not(:disabled){background:color-mix(in srgb, var(--qx-red) 12%, transparent);border-color:var(--qx-red)}.aG5CZG_actionPrimary{color:var(--qx-blue);border-color:color-mix(in srgb, var(--qx-blue) 45%, transparent)}.aG5CZG_actionPrimary:hover:not(:disabled){background:color-mix(in srgb, var(--qx-blue) 12%, transparent);border-color:var(--qx-blue)}.aG5CZG_retryBtn{border:1px solid var(--ds-color-border,#444);color:var(--ds-color-text,#e5e5e5);cursor:pointer;background:0 0;border-radius:5px;margin-left:8px;padding:1px 8px;font-size:11px}.aG5CZG_retryBtn:hover{background:var(--ds-color-bg-soft,#2a2a2a)}.aG5CZG_btnGhost{border:1px solid var(--ds-color-border,#444);color:var(--ds-color-text,#e5e5e5);cursor:pointer;background:0 0;border-radius:6px;align-items:center;gap:4px;padding:3px 10px;font-size:12px;display:inline-flex}.aG5CZG_btnGhost:hover:not(:disabled){background:var(--ds-color-bg-soft,#2a2a2a);border-color:var(--ds-color-border,#666)}.aG5CZG_btnGhost:disabled{opacity:.35;cursor:default}.aG5CZG_btnPrimary{background:color-mix(in srgb, var(--qx-blue) 18%, transparent);color:var(--qx-blue);border:1px solid color-mix(in srgb, var(--qx-blue) 60%, transparent);cursor:pointer;border-radius:6px;align-items:center;gap:6px;padding:4px 14px;font-size:12px;font-weight:600;display:inline-flex}.aG5CZG_btnPrimary:hover:not(:disabled){background:color-mix(in srgb, var(--qx-blue) 28%, transparent)}.aG5CZG_btnPrimary:disabled{opacity:.5;cursor:default}.aG5CZG_spinner{border:2px solid color-mix(in srgb, var(--qx-blue) 30%, transparent);border-top-color:currentColor;border-radius:50%;width:11px;height:11px;animation:.7s linear infinite aG5CZG_qxSpin;display:inline-block}@keyframes aG5CZG_qxSpin{to{transform:rotate(360deg)}}.aG5CZG_error{color:var(--qx-red);border:1px solid color-mix(in srgb, var(--qx-red) 40%, transparent);background:color-mix(in srgb, var(--qx-red) 8%, transparent);word-break:break-word;border-radius:8px;align-items:center;padding:8px 10px;display:flex}.aG5CZG_msg{word-break:break-word;border-radius:6px;padding:6px 10px;font-size:11px}.aG5CZG_msgOk{color:var(--qx-green);border:1px solid color-mix(in srgb, var(--qx-green) 40%, transparent);background:color-mix(in srgb, var(--qx-green) 8%, transparent)}.aG5CZG_msgErr{color:var(--qx-red);border:1px solid color-mix(in srgb, var(--qx-red) 40%, transparent);background:color-mix(in srgb, var(--qx-red) 8%, transparent)}.aG5CZG_empty{color:var(--ds-color-text-subtle,#9b9b9b);text-align:left;border:1px dashed var(--ds-color-border,#333);background:var(--ds-color-bg-soft,#1a1a1a);border-radius:10px;flex-direction:row;justify-content:center;align-items:center;gap:10px;padding:26px 16px;display:flex}.aG5CZG_emptyIcon{font-size:26px}.aG5CZG_emptyTitle{color:var(--ds-color-text,#e5e5e5);font-size:13px;font-weight:600}.aG5CZG_emptySub{opacity:.75;margin-top:2px;font-size:11px}.aG5CZG_row{border:1px solid var(--ds-color-border,#333);background:linear-gradient(180deg, color-mix(in srgb, var(--ds-color-bg-soft,#262626) 92%, transparent), var(--ds-color-bg-soft,#222));border-radius:10px;overflow:hidden}.aG5CZG_row:hover{transform:translateY(-1px);box-shadow:0 6px 18px #00000073}.aG5CZG_rowHead{cursor:pointer;align-items:stretch;gap:10px;padding:8px 10px;display:flex}.aG5CZG_rowHead:hover{background:color-mix(in srgb, var(--ds-color-bg-soft,#2a2a2a) 70%, transparent)}.aG5CZG_rowBar{border-radius:4px;flex-shrink:0;align-self:stretch;width:4px}.aG5CZG_rowBar.aG5CZG_rowStateRunning{background:var(--qx-blue)}.aG5CZG_rowBar.aG5CZG_rowStateDone{background:var(--qx-green)}.aG5CZG_rowBar.aG5CZG_rowStateError{background:var(--qx-red)}.aG5CZG_rowBar.aG5CZG_rowStatePaused{background:var(--qx-yellow)}.aG5CZG_rowBar.aG5CZG_rowStateQueued{background:#6e7781}.aG5CZG_rowMain{flex-direction:column;flex:1;gap:6px;min-width:0;display:flex}.aG5CZG_rowTop{flex-wrap:wrap;align-items:center;gap:8px;min-width:0;display:flex}.aG5CZG_rowId{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;font-weight:650}.aG5CZG_rowName{opacity:.65;text-overflow:ellipsis;white-space:nowrap;max-width:180px;overflow:hidden}.aG5CZG_rowMeta{opacity:.7;white-space:nowrap;font-size:11px}.aG5CZG_rowActions{flex-shrink:0;align-items:center;gap:3px;display:flex}.aG5CZG_badge{background:color-mix(in srgb, currentColor 16%, transparent);white-space:nowrap;border:1px solid;border-radius:20px;padding:1px 8px;font-size:11px;font-weight:500;line-height:1.5}.aG5CZG_badge.aG5CZG_rowStateRunning{color:var(--qx-blue)}.aG5CZG_badge.aG5CZG_rowStateDone{color:var(--qx-green)}.aG5CZG_badge.aG5CZG_rowStateError{color:var(--qx-red)}.aG5CZG_badge.aG5CZG_rowStatePaused{color:var(--qx-yellow)}.aG5CZG_badge.aG5CZG_rowStateQueued{color:#8b949e}.aG5CZG_badge.aG5CZG_badgeRunning{color:var(--qx-blue)}.aG5CZG_badge.aG5CZG_badgeDone{color:var(--qx-green)}.aG5CZG_badge.aG5CZG_badgeError{color:var(--qx-red)}.aG5CZG_badge.aG5CZG_badgePaused{color:var(--qx-yellow)}.aG5CZG_progressTrack{background:var(--ds-color-bg,#161616);border-radius:4px;height:6px;position:relative;overflow:hidden}.aG5CZG_progressFill{border-radius:4px;height:100%;transition:width .4s}.aG5CZG_progressRunning{background:linear-gradient(90deg, var(--qx-blue), color-mix(in srgb, var(--qx-blue) 60%, #fff))}.aG5CZG_progressDone{background:linear-gradient(90deg, var(--qx-green), color-mix(in srgb, var(--qx-green) 55%, #fff))}.aG5CZG_progressError{background:var(--qx-red)}.aG5CZG_progressPaused{background:linear-gradient(90deg, var(--qx-yellow), color-mix(in srgb, var(--qx-yellow) 55%, #fff))}.aG5CZG_progressText{color:var(--ds-color-text,#e5e5e5);font-size:10px;font-weight:600;position:absolute;top:50%;right:6px;transform:translateY(-50%)}.aG5CZG_summaryCard{border:1px solid var(--ds-color-border,#333);background:linear-gradient(180deg, color-mix(in srgb, var(--ds-color-bg-soft,#262626) 92%, transparent), var(--ds-color-bg-soft,#222));border-radius:10px;flex-direction:column;gap:8px;padding:10px 12px;display:flex}.aG5CZG_summaryRow{flex-wrap:wrap;align-items:center;gap:10px;display:flex}.aG5CZG_batchId{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:14px;font-weight:650}.aG5CZG_summaryName{opacity:.65;text-overflow:ellipsis;white-space:nowrap;max-width:220px;overflow:hidden}.aG5CZG_summaryMeta{opacity:.8;white-space:nowrap;font-size:12px}.aG5CZG_toolbar{flex-wrap:wrap;align-items:center;gap:6px;display:flex}.aG5CZG_tableWrap{border:1px solid var(--ds-color-border,#2a2a2a);border-radius:8px;max-height:420px;overflow:auto}.aG5CZG_table{border-collapse:collapse;width:100%;font-size:11px}.aG5CZG_table thead th{z-index:1;background:color-mix(in srgb, var(--ds-color-bg-soft,#242424) 92%, transparent);backdrop-filter:blur(4px);opacity:.85;text-align:left;white-space:nowrap;border-bottom:1px solid var(--ds-color-border,#333);padding:6px 8px;font-weight:600;position:sticky;top:0}.aG5CZG_table th,.aG5CZG_table td{border-bottom:1px solid var(--ds-color-border,#2a2a2a);vertical-align:top;text-align:left;padding:5px 8px}.aG5CZG_table tbody tr{transition:background .12s}.aG5CZG_table tbody tr:hover td{background:color-mix(in srgb, var(--ds-color-bg-soft,#2a2a2a) 80%, transparent)}.aG5CZG_cellNum{white-space:nowrap;font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;text-align:right!important}.aG5CZG_valPos{color:var(--qx-green)}.aG5CZG_valNeg{color:var(--qx-red)}.aG5CZG_cellExpr{text-overflow:ellipsis;white-space:nowrap;max-width:240px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden}.aG5CZG_cellAlpha{white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.aG5CZG_cellStatus{white-space:nowrap}.aG5CZG_cellAction{white-space:nowrap;text-align:center;padding-left:4px!important;padding-right:4px!important}.aG5CZG_cellActionNone{opacity:.35;font-size:11px}.aG5CZG_bPass{color:var(--qx-green);border:1px solid color-mix(in srgb, var(--qx-green) 45%, transparent);background:color-mix(in srgb, var(--qx-green) 10%, transparent);border-radius:20px;padding:0 8px;font-size:10px}.aG5CZG_bWarn{color:var(--qx-yellow);border:1px solid color-mix(in srgb, var(--qx-yellow) 45%, transparent);background:color-mix(in srgb, var(--qx-yellow) 10%, transparent);border-radius:20px;padding:0 8px;font-size:10px}.aG5CZG_bFail{color:var(--qx-red);border:1px solid color-mix(in srgb, var(--qx-red) 45%, transparent);background:color-mix(in srgb, var(--qx-red) 10%, transparent);border-radius:20px;padding:0 8px;font-size:10px}.aG5CZG_bNone{color:var(--ds-color-text-subtle,#8b949e);opacity:.7;border-radius:20px;padding:0 8px;font-size:10px}.aG5CZG_checksPanel{flex-direction:column;gap:8px;display:flex}.aG5CZG_checksSummary{flex-wrap:wrap;align-items:center;gap:6px;font-size:11px;display:flex}.aG5CZG_checksSummary .aG5CZG_bPass,.aG5CZG_checksSummary .aG5CZG_bWarn,.aG5CZG_checksSummary .aG5CZG_bFail,.aG5CZG_checksSummary .aG5CZG_bNone{padding:1px 8px;font-size:10px}.aG5CZG_checksTotal{opacity:.6;font-size:11px}.aG5CZG_checksList{border:1px solid var(--ds-color-border,#2a2a2a);background:color-mix(in srgb, var(--ds-color-bg,#101010) 70%, transparent);border-radius:8px;flex-direction:column;gap:3px;max-height:280px;padding:6px 8px;display:flex;overflow:auto}.aG5CZG_checkItem{border-radius:5px;align-items:center;gap:8px;padding:3px 4px;font-size:11px;display:flex}.aG5CZG_checkItem:hover{background:color-mix(in srgb, var(--ds-color-bg-soft,#2a2a2a) 70%, transparent)}.aG5CZG_checkItemHighlight{background:color-mix(in srgb, var(--qx-blue) 8%, transparent);border:1px solid color-mix(in srgb, var(--qx-blue) 35%, transparent);padding:2px 6px}.aG5CZG_checkItemHighlight .aG5CZG_checkItemName{color:var(--qx-blue);font-weight:650}.aG5CZG_checkItemName{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;overflow:hidden}.aG5CZG_checkItemMeta{font-variant-numeric:tabular-nums;color:var(--ds-color-text,#e5e5e5);white-space:nowrap;flex-shrink:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}.aG5CZG_checkItemResult{text-align:right;flex-shrink:0;min-width:60px}.aG5CZG_issueList{flex-direction:column;gap:4px;display:flex}.aG5CZG_issueRow{border-radius:6px;align-items:center;gap:8px;padding:4px 8px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;display:flex}.aG5CZG_issueRow.aG5CZG_issueWarn{border:1px solid color-mix(in srgb, var(--qx-yellow) 45%, transparent);background:color-mix(in srgb, var(--qx-yellow) 8%, transparent)}.aG5CZG_issueRow.aG5CZG_issueDanger{border:1px solid color-mix(in srgb, var(--qx-red) 45%, transparent);background:color-mix(in srgb, var(--qx-red) 8%, transparent)}.aG5CZG_issueTag{border-radius:4px;flex-shrink:0;padding:1px 6px;font-size:10px;font-weight:650}.aG5CZG_issueRow.aG5CZG_issueWarn .aG5CZG_issueTag{color:var(--qx-yellow);background:color-mix(in srgb, var(--qx-yellow) 20%, transparent)}.aG5CZG_issueRow.aG5CZG_issueDanger .aG5CZG_issueTag{color:var(--qx-red);background:color-mix(in srgb, var(--qx-red) 20%, transparent)}.aG5CZG_issueMsg{text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;overflow:hidden}.aG5CZG_freshList{flex-direction:column;gap:4px;margin-top:6px;display:flex}.aG5CZG_freshTag{color:var(--qx-green);background:color-mix(in srgb, var(--qx-green) 18%, transparent);border:1px solid color-mix(in srgb, var(--qx-green) 45%, transparent);border-radius:4px;margin-right:6px;padding:1px 6px;font-size:10px;font-weight:650}.aG5CZG_freshRow{padding:2px 8px;font-size:11px}.aG5CZG_freshField{color:var(--qx-green);background:var(--ds-color-bg,#101010);border:1px solid var(--ds-color-border,#333);border-radius:4px;padding:2px 6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px}.aG5CZG_prodCorrRow{align-items:center;gap:10px;padding:4px 0;font-size:12px;display:flex}.aG5CZG_prodCorrLabel{opacity:.7;font-size:11px}.aG5CZG_prodCorrValue{font-variant-numeric:tabular-nums;min-width:60px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;font-weight:600}.aG5CZG_tierBadge{border:1px solid;border-radius:999px;padding:2px 10px;font-size:11px;font-weight:600}.aG5CZG_tier_excellent{color:var(--qx-green);background:color-mix(in srgb, var(--qx-green) 15%, transparent)}.aG5CZG_tier_robust{color:var(--qx-green);background:color-mix(in srgb, var(--qx-green) 10%, transparent);opacity:.85}.aG5CZG_tier_marginal{color:var(--qx-yellow);background:color-mix(in srgb, var(--qx-yellow) 12%, transparent)}.aG5CZG_tier_tight{color:var(--qx-red);background:color-mix(in srgb, var(--qx-red) 12%, transparent)}.aG5CZG_card{border:1px solid var(--ds-color-border,#333);background:var(--ds-color-bg-soft,#1c1c1c);border-radius:10px;flex-direction:column;flex-shrink:0;gap:10px;padding:12px;display:flex}.aG5CZG_cardHead{align-items:center;gap:8px;display:flex}.aG5CZG_cardIcon{font-size:14px}.aG5CZG_cardTitle{font-weight:650}.aG5CZG_field{flex-direction:column;gap:5px;display:flex}.aG5CZG_fieldRow{flex-wrap:wrap;align-items:center;gap:6px;display:flex}.aG5CZG_fieldLabel{opacity:.7;white-space:nowrap;font-size:11px}.aG5CZG_configInput{text-align:center;flex-shrink:0;width:52px;padding:2px 6px;font-size:11px}.aG5CZG_configBtn{background:color-mix(in srgb, var(--qx-blue) 15%, transparent);border:1px solid color-mix(in srgb, var(--qx-blue) 50%, transparent);color:var(--qx-blue);cursor:pointer;white-space:nowrap;border-radius:6px;flex-shrink:0;padding:2px 10px;font-family:inherit;font-size:11px;font-weight:600}.aG5CZG_configBtn:hover:not(:disabled){background:color-mix(in srgb, var(--qx-blue) 25%, transparent)}.aG5CZG_configBtn:disabled{opacity:.5;cursor:default}.aG5CZG_metaLine{opacity:.85;flex-wrap:wrap;gap:4px;font-size:11px;display:flex}.aG5CZG_promptList{flex-direction:column;gap:4px;max-height:260px;display:flex;overflow:auto}.aG5CZG_promptItem{border:1px solid var(--ds-color-border,#333);background:color-mix(in srgb, var(--ds-color-bg,#101010) 70%, transparent);border-radius:8px;align-items:center;gap:6px;padding:4px 8px;transition:border-color .15s,background .15s;display:flex}.aG5CZG_promptItem:hover{border-color:color-mix(in srgb, var(--qx-blue) 45%, transparent);background:color-mix(in srgb, var(--ds-color-bg-soft,#2a2a2a) 60%, transparent)}.aG5CZG_promptName{min-width:0;color:var(--ds-color-text,#e5e5e5);cursor:pointer;text-align:left;background:0 0;border:none;flex:1;align-items:center;gap:6px;padding:2px 0;font-family:inherit;font-size:12px;font-weight:500;display:flex}.aG5CZG_promptName:hover{color:var(--qx-blue)}.aG5CZG_promptItemIcon{flex-shrink:0;font-size:13px}.aG5CZG_promptItemName{text-overflow:ellipsis;white-space:nowrap;flex:1;overflow:hidden}.aG5CZG_promptCopyBtn{color:var(--ds-color-text-subtle,#9b9b9b);flex-shrink:0;font-size:13px}.aG5CZG_promptCopyBtn:hover{color:var(--qx-blue)}.aG5CZG_promptSavedTag{color:var(--qx-green);margin-right:6px;font-size:11px}.aG5CZG_promptDelBtn{color:var(--qx-red)}.aG5CZG_promptDelBtn:hover{background:color-mix(in srgb, var(--qx-red) 12%, transparent)}.aG5CZG_promptTextarea{white-space:pre-wrap;word-break:break-word;min-height:320px;line-height:1.5}.aG5CZG_input,.aG5CZG_textarea{background:var(--ds-color-bg,#101010);border:1px solid var(--ds-color-border,#444);color:var(--ds-color-text,#e5e5e5);border-radius:6px;padding:5px 9px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}.aG5CZG_input:focus,.aG5CZG_textarea:focus{border-color:var(--qx-blue);box-shadow:0 0 0 2px color-mix(in srgb, var(--qx-blue) 25%, transparent);outline:none}.aG5CZG_textarea{resize:vertical;min-height:72px}.aG5CZG_pre{background:var(--ds-color-bg,#101010);border:1px solid var(--ds-color-border,#333);white-space:pre-wrap;word-break:break-word;border-radius:8px;max-height:320px;padding:10px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;overflow:auto}.aG5CZG_statusFooter{opacity:.5;text-align:right;text-overflow:ellipsis;white-space:nowrap;padding:2px 4px;font-size:10px;overflow:hidden}.aG5CZG_statusFooterLink{color:var(--qx-blue);border-bottom:1px dashed color-mix(in srgb, var(--qx-blue) 50%, transparent);text-decoration:none;transition:opacity .15s,border-color .15s}.aG5CZG_statusFooterLink:hover{opacity:1;border-bottom-color:var(--qx-blue);border-bottom-style:solid}.aG5CZG_poolAddRow{align-items:center;gap:6px;margin:8px 0 4px;display:flex}.aG5CZG_poolAddRow .aG5CZG_input{flex:1;min-width:0}.aG5CZG_poolMetaLine{opacity:.7;flex-wrap:wrap;gap:4px;padding:2px 2px 6px;font-size:10px;display:flex}.aG5CZG_poolNotice{color:var(--qx-blue);opacity:.95}.aG5CZG_poolStats{white-space:nowrap;align-items:center;gap:6px;font-size:10px;display:inline-flex}.aG5CZG_poolActivePill{color:var(--qx-green)}.aG5CZG_poolUnsubmitPill{color:var(--ds-color-text-subtle,#8b949e)}.aG5CZG_poolUnknownPill{color:var(--qx-yellow)}.aG5CZG_badge.aG5CZG_poolActive{color:var(--qx-green)}.aG5CZG_badge.aG5CZG_poolUnsubmit{color:var(--ds-color-text-subtle,#8b949e)}.aG5CZG_badge.aG5CZG_poolUnknown{color:var(--qx-yellow)}.aG5CZG_poolIdBtn{color:var(--qx-blue);font:inherit;cursor:pointer;text-align:left;border:none;border-bottom:1px dashed color-mix(in srgb, var(--qx-blue) 45%, transparent);background:0 0;padding:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.aG5CZG_poolIdBtn:hover{border-bottom-style:solid}.aG5CZG_poolCorrCell{flex-direction:column;align-items:flex-end;gap:1px;line-height:1.3;display:inline-flex}.aG5CZG_poolErrDot{cursor:help;margin-left:4px;font-size:10px}.aG5CZG_dailyBadge{white-space:nowrap;color:var(--qx-green);border:1px solid color-mix(in srgb, var(--qx-green) 45%, transparent);background:color-mix(in srgb, var(--qx-green) 10%, transparent);cursor:help;border-radius:20px;align-items:baseline;gap:4px;padding:1px 8px;font-size:11px;display:inline-flex}.aG5CZG_dailyBadgeStale{white-space:nowrap;cursor:help;color:var(--qx-yellow);border:1px solid color-mix(in srgb, var(--qx-yellow) 45%, transparent);background:color-mix(in srgb, var(--qx-yellow) 10%, transparent);border-radius:20px;align-items:baseline;gap:4px;padding:1px 8px;font-size:11px;display:inline-flex}.aG5CZG_dailyBadgeSub{opacity:.65;font-size:10px}.aG5CZG_copyBtn{color:var(--ds-color-text-subtle,#8b949e);cursor:pointer;background:0 0;border:none;border-radius:4px;margin-left:4px;padding:0 2px;font-size:11px;line-height:1}.aG5CZG_copyBtn:hover{color:var(--qx-blue);background:color-mix(in srgb, var(--qx-blue) 14%, transparent)}.aG5CZG_cellNote{min-width:130px;padding-top:2px!important;padding-bottom:2px!important}.aG5CZG_noteInput{width:100%;min-width:110px;color:var(--ds-color-text,#e5e5e5);background:0 0;border:1px solid #0000;border-radius:4px;padding:2px 5px;font-family:inherit;font-size:11px}.aG5CZG_noteInput::placeholder{color:var(--ds-color-text-subtle,#8b949e);opacity:.55}.aG5CZG_noteInput:hover{border-color:var(--ds-color-border,#333)}.aG5CZG_noteInput:focus{background:var(--ds-color-bg,#101010);border-color:var(--qx-blue);outline:none}.aG5CZG_noteHint,.aG5CZG_noteHintOk{margin-left:2px;font-size:10px}.aG5CZG_noteHintOk{color:var(--qx-green)}.aG5CZG_submitBox{border:1px solid color-mix(in srgb, var(--qx-red) 40%, transparent);background:color-mix(in srgb, var(--qx-red) 6%, transparent);border-radius:8px;margin:10px 0 6px;padding:8px 10px}.aG5CZG_submitHead{flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:6px;display:flex}.aG5CZG_submitTitle{color:var(--qx-red);font-size:11px;font-weight:650}.aG5CZG_submitWarnText{opacity:.7;font-size:10px}.aG5CZG_submitRow{align-items:center;gap:6px;display:flex}.aG5CZG_submitRow .aG5CZG_input{flex:1;min-width:0}.aG5CZG_submitBtn{background:color-mix(in srgb, var(--qx-red) 20%, transparent);border:1px solid color-mix(in srgb, var(--qx-red) 55%, transparent);color:var(--qx-red);cursor:pointer;white-space:nowrap;border-radius:6px;padding:5px 12px;font-size:12px;font-weight:600}.aG5CZG_submitBtn:hover:not(:disabled){background:color-mix(in srgb, var(--qx-red) 32%, transparent)}.aG5CZG_submitBtn:disabled{opacity:.45;cursor:not-allowed}.aG5CZG_submitMsg{opacity:.85;margin-top:5px;font-size:10px}.aG5CZG_submitProgress{flex-direction:column;gap:4px;margin-top:6px;font-size:11px;display:flex}.aG5CZG_submitSpinner{color:var(--qx-blue)}.aG5CZG_submitJobList{flex-direction:column;gap:3px;display:flex}.aG5CZG_submitJobRow{flex-wrap:wrap;align-items:center;gap:6px;font-size:10px;display:flex}.aG5CZG_submitJobId{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.aG5CZG_submitJobBadge{background:color-mix(in srgb, currentColor 12%, transparent);white-space:nowrap;border:1px solid;border-radius:20px;padding:0 7px;font-size:10px}.aG5CZG_submitJobErr{opacity:.7;text-overflow:ellipsis;white-space:nowrap;max-width:100%;overflow:hidden}.aG5CZG_submitJobFails{color:var(--qx-red);opacity:.85}.aG5CZG_submitMarkBadge{background:color-mix(in srgb, currentColor 12%, transparent);white-space:nowrap;border:1px solid;border-radius:20px;margin-left:4px;padding:0 6px;font-size:10px}.aG5CZG_submitQueued{color:var(--qx-blue)}.aG5CZG_submitOk{color:var(--qx-green)}.aG5CZG_submitBad{color:var(--qx-red)}.aG5CZG_submitWarn{color:var(--qx-yellow)}.aG5CZG_poolTable{border:1px solid color-mix(in srgb, var(--ds-color-text,#e5e5e5) 24%, transparent);background:color-mix(in srgb, var(--ds-color-bg-soft,#1c1c1c) 60%, transparent);box-shadow:inset 0 1px 0 color-mix(in srgb, var(--ds-color-text,#e5e5e5) 7%, transparent), 0 1px 3px #0000004d;border-radius:10px}.aG5CZG_poolTable .aG5CZG_table thead th{opacity:1;color:var(--ds-color-text,#e5e5e5);background:color-mix(in srgb, var(--ds-color-bg-soft,#2e2e2e) 96%, transparent);border-bottom:1px solid color-mix(in srgb, var(--ds-color-text,#e5e5e5) 22%, transparent)}.aG5CZG_poolTable .aG5CZG_table th+th,.aG5CZG_poolTable .aG5CZG_table td+td{border-left:1px solid color-mix(in srgb, var(--ds-color-text,#e5e5e5) 7%, transparent)}.aG5CZG_poolTable .aG5CZG_table th,.aG5CZG_poolTable .aG5CZG_table td{border-bottom-color:color-mix(in srgb, var(--ds-color-text,#e5e5e5) 10%, transparent)}.aG5CZG_poolTable .aG5CZG_table td{padding:6px 9px}";
		const tagId = "@deepseek-ai/dsh-qianxun-tab/QianxunTab.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-qianxun-tab";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var QianxunTab_module_css_default = {
			"actionIco": "aG5CZG_actionIco",
			"poolAddRow": "aG5CZG_poolAddRow",
			"poolUnknown": "aG5CZG_poolUnknown",
			"root": "aG5CZG_root",
			"rowStateQueued": "aG5CZG_rowStateQueued",
			"actionPrimary": "aG5CZG_actionPrimary",
			"submitMarkBadge": "aG5CZG_submitMarkBadge",
			"dotOffline": "aG5CZG_dotOffline",
			"retryBtn": "aG5CZG_retryBtn",
			"btnGhost": "aG5CZG_btnGhost",
			"emptyTitle": "aG5CZG_emptyTitle",
			"poolMetaLine": "aG5CZG_poolMetaLine",
			"pagination": "aG5CZG_pagination",
			"tier_marginal": "aG5CZG_tier_marginal",
			"emptyIcon": "aG5CZG_emptyIcon",
			"dotUnknown": "aG5CZG_dotUnknown",
			"dotOk": "aG5CZG_dotOk",
			"cellExpr": "aG5CZG_cellExpr",
			"checksList": "aG5CZG_checksList",
			"valPos": "aG5CZG_valPos",
			"quotaLabel": "aG5CZG_quotaLabel",
			"cellActionNone": "aG5CZG_cellActionNone",
			"progressDone": "aG5CZG_progressDone",
			"rowActions": "aG5CZG_rowActions",
			"issueTag": "aG5CZG_issueTag",
			"promptCopyBtn": "aG5CZG_promptCopyBtn",
			"cacheBadgeBackfill": "aG5CZG_cacheBadgeBackfill",
			"prodCorrLabel": "aG5CZG_prodCorrLabel",
			"promptTextarea": "aG5CZG_promptTextarea",
			"poolStats": "aG5CZG_poolStats",
			"cacheBadgeCaptcha": "aG5CZG_cacheBadgeCaptcha",
			"promptItem": "aG5CZG_promptItem",
			"dailyBadgeSub": "aG5CZG_dailyBadgeSub",
			"actionDanger": "aG5CZG_actionDanger",
			"submitWarnText": "aG5CZG_submitWarnText",
			"dotRunning": "aG5CZG_dotRunning",
			"poolUnsubmit": "aG5CZG_poolUnsubmit",
			"submitTitle": "aG5CZG_submitTitle",
			"startEngineToastWarn": "aG5CZG_startEngineToastWarn",
			"textarea": "aG5CZG_textarea",
			"submitBtn": "aG5CZG_submitBtn",
			"issueList": "aG5CZG_issueList",
			"freshList": "aG5CZG_freshList",
			"freshRow": "aG5CZG_freshRow",
			"fieldRow": "aG5CZG_fieldRow",
			"statusFooterLink": "aG5CZG_statusFooterLink",
			"badgeRunning": "aG5CZG_badgeRunning",
			"header": "aG5CZG_header",
			"msg": "aG5CZG_msg",
			"pulseOffline": "aG5CZG_pulseOffline",
			"table": "aG5CZG_table",
			"progressRunning": "aG5CZG_progressRunning",
			"promptList": "aG5CZG_promptList",
			"error": "aG5CZG_error",
			"cacheBadgePartial": "aG5CZG_cacheBadgePartial",
			"rowMeta": "aG5CZG_rowMeta",
			"cacheBackfillPulse": "aG5CZG_cacheBackfillPulse",
			"poolActivePill": "aG5CZG_poolActivePill",
			"configInput": "aG5CZG_configInput",
			"cellAlpha": "aG5CZG_cellAlpha",
			"progressFill": "aG5CZG_progressFill",
			"metaLine": "aG5CZG_metaLine",
			"tier_robust": "aG5CZG_tier_robust",
			"qxSpin": "aG5CZG_qxSpin",
			"badgeError": "aG5CZG_badgeError",
			"prodCorrRow": "aG5CZG_prodCorrRow",
			"poolIdBtn": "aG5CZG_poolIdBtn",
			"dotLabel": "aG5CZG_dotLabel",
			"paginationBtn": "aG5CZG_paginationBtn",
			"valNeg": "aG5CZG_valNeg",
			"startEngineFade": "aG5CZG_startEngineFade",
			"poolCorrCell": "aG5CZG_poolCorrCell",
			"iconBtn": "aG5CZG_iconBtn",
			"checkItemHighlight": "aG5CZG_checkItemHighlight",
			"submitJobFails": "aG5CZG_submitJobFails",
			"cacheBadgeActive": "aG5CZG_cacheBadgeActive",
			"paginationInfo": "aG5CZG_paginationInfo",
			"startEngineToast": "aG5CZG_startEngineToast",
			"summaryCard": "aG5CZG_summaryCard",
			"promptName": "aG5CZG_promptName",
			"rowStateError": "aG5CZG_rowStateError",
			"cellStatus": "aG5CZG_cellStatus",
			"poolActive": "aG5CZG_poolActive",
			"summaryName": "aG5CZG_summaryName",
			"submitBox": "aG5CZG_submitBox",
			"empty": "aG5CZG_empty",
			"rowStatePaused": "aG5CZG_rowStatePaused",
			"bNone": "aG5CZG_bNone",
			"pre": "aG5CZG_pre",
			"paginationSizeSelect": "aG5CZG_paginationSizeSelect",
			"cardIcon": "aG5CZG_cardIcon",
			"submitRow": "aG5CZG_submitRow",
			"fieldLabel": "aG5CZG_fieldLabel",
			"promptItemIcon": "aG5CZG_promptItemIcon",
			"bPass": "aG5CZG_bPass",
			"noteHint": "aG5CZG_noteHint",
			"spinner": "aG5CZG_spinner",
			"cacheBadge": "aG5CZG_cacheBadge",
			"freshTag": "aG5CZG_freshTag",
			"submitSpinner": "aG5CZG_submitSpinner",
			"bFail": "aG5CZG_bFail",
			"submitOk": "aG5CZG_submitOk",
			"rowStateDone": "aG5CZG_rowStateDone",
			"tierBadge": "aG5CZG_tierBadge",
			"dailyBadgeStale": "aG5CZG_dailyBadgeStale",
			"submitJobRow": "aG5CZG_submitJobRow",
			"submitQueued": "aG5CZG_submitQueued",
			"poolUnknownPill": "aG5CZG_poolUnknownPill",
			"toolbar": "aG5CZG_toolbar",
			"checksTotal": "aG5CZG_checksTotal",
			"freshField": "aG5CZG_freshField",
			"titleIcon": "aG5CZG_titleIcon",
			"summaryRow": "aG5CZG_summaryRow",
			"submitProgress": "aG5CZG_submitProgress",
			"title": "aG5CZG_title",
			"badgePaused": "aG5CZG_badgePaused",
			"emptySub": "aG5CZG_emptySub",
			"startEngineBtnOnline": "aG5CZG_startEngineBtnOnline",
			"msgErr": "aG5CZG_msgErr",
			"msgOk": "aG5CZG_msgOk",
			"progressTrack": "aG5CZG_progressTrack",
			"backfillBtn": "aG5CZG_backfillBtn",
			"badgeDone": "aG5CZG_badgeDone",
			"progressError": "aG5CZG_progressError",
			"checkItemMeta": "aG5CZG_checkItemMeta",
			"promptDelBtn": "aG5CZG_promptDelBtn",
			"statusFooter": "aG5CZG_statusFooter",
			"quotaSep": "aG5CZG_quotaSep",
			"dot": "aG5CZG_dot",
			"startEngineBtnOffline": "aG5CZG_startEngineBtnOffline",
			"submitJobList": "aG5CZG_submitJobList",
			"submitBad": "aG5CZG_submitBad",
			"submitWarn": "aG5CZG_submitWarn",
			"promptSavedTag": "aG5CZG_promptSavedTag",
			"rowId": "aG5CZG_rowId",
			"checksSummary": "aG5CZG_checksSummary",
			"submitHead": "aG5CZG_submitHead",
			"cardTitle": "aG5CZG_cardTitle",
			"checksPanel": "aG5CZG_checksPanel",
			"cardHead": "aG5CZG_cardHead",
			"tableWrap": "aG5CZG_tableWrap",
			"checkItem": "aG5CZG_checkItem",
			"dotError": "aG5CZG_dotError",
			"issueMsg": "aG5CZG_issueMsg",
			"summaryMeta": "aG5CZG_summaryMeta",
			"poolNotice": "aG5CZG_poolNotice",
			"cellNote": "aG5CZG_cellNote",
			"checkItemName": "aG5CZG_checkItemName",
			"issueRow": "aG5CZG_issueRow",
			"rowMain": "aG5CZG_rowMain",
			"configBtn": "aG5CZG_configBtn",
			"progressText": "aG5CZG_progressText",
			"paginationTotal": "aG5CZG_paginationTotal",
			"startEngineToastOk": "aG5CZG_startEngineToastOk",
			"rowStateRunning": "aG5CZG_rowStateRunning",
			"field": "aG5CZG_field",
			"batchId": "aG5CZG_batchId",
			"dailyBadge": "aG5CZG_dailyBadge",
			"submitJobId": "aG5CZG_submitJobId",
			"bWarn": "aG5CZG_bWarn",
			"submitJobErr": "aG5CZG_submitJobErr",
			"body": "aG5CZG_body",
			"spacer": "aG5CZG_spacer",
			"noteInput": "aG5CZG_noteInput",
			"submitMsg": "aG5CZG_submitMsg",
			"poolTable": "aG5CZG_poolTable",
			"row": "aG5CZG_row",
			"rowName": "aG5CZG_rowName",
			"prodCorrValue": "aG5CZG_prodCorrValue",
			"rowHead": "aG5CZG_rowHead",
			"issueWarn": "aG5CZG_issueWarn",
			"submitJobBadge": "aG5CZG_submitJobBadge",
			"paginationSizeHint": "aG5CZG_paginationSizeHint",
			"rowTop": "aG5CZG_rowTop",
			"paginationSizeLabel": "aG5CZG_paginationSizeLabel",
			"copyBtn": "aG5CZG_copyBtn",
			"rowBar": "aG5CZG_rowBar",
			"card": "aG5CZG_card",
			"checkItemResult": "aG5CZG_checkItemResult",
			"poolErrDot": "aG5CZG_poolErrDot",
			"progressPaused": "aG5CZG_progressPaused",
			"issueDanger": "aG5CZG_issueDanger",
			"tier_tight": "aG5CZG_tier_tight",
			"noteHintOk": "aG5CZG_noteHintOk",
			"tier_excellent": "aG5CZG_tier_excellent",
			"cellNum": "aG5CZG_cellNum",
			"promptItemName": "aG5CZG_promptItemName",
			"poolUnsubmitPill": "aG5CZG_poolUnsubmitPill",
			"badge": "aG5CZG_badge",
			"input": "aG5CZG_input",
			"dotOnline": "aG5CZG_dotOnline",
			"quotaChip": "aG5CZG_quotaChip",
			"btnPrimary": "aG5CZG_btnPrimary",
			"cellAction": "aG5CZG_cellAction"
		};
		//#endregion
		//#region src/client/format.tsx
		/** 详情表按此顺序展示的指标列。 */
		const METRIC_KEYS = [
			{
				key: "sharpe",
				label: "sharpe"
			},
			{
				key: "fitness",
				label: "fitness"
			},
			{
				key: "returns",
				label: "ret%",
				pct: true
			},
			{
				key: "turnover",
				label: "to%",
				pct: true
			},
			{
				key: "margin",
				label: "margin"
			}
		];
		/** 运行中的状态集合（用于高亮/进度/控制按钮显隐）。 */
		const RUNNING_STATES = new Set([
			"running",
			"pending",
			"queued",
			"scheduled",
			"active"
		]);
		/**
		* 数值格式化：3 位有效数字、去尾随 0；`asPct` 时把小数比率 ×100 转百分比。
		* 百分比展示去掉尾随 0（如 0.5 -> 50%，0.1234 -> 12.3%）。
		*/
		function fmt(v, asPct = false) {
			if (typeof v !== "number" || Number.isNaN(v)) return "—";
			if (asPct) return `${parseFloat((v * 100).toPrecision(3))}%`;
			return String(parseFloat(v.toPrecision(3)));
		}
		/** 是否运行中（用于控制按钮显隐与进度条）。 */
		function isRunning(state) {
			return state !== void 0 && RUNNING_STATES.has(String(state).toLowerCase());
		}
		/** check 三色（+黄）徽章；无值返回空。 */
		function checkBadge(check) {
			if (check === null || check === void 0 || check === "") return "";
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: QianxunTab_module_css_default[check === "pass" ? "bPass" : check === "warn" ? "bWarn" : check === "fail" ? "bFail" : "bNone"],
				children: check
			});
		}
		/** BRAIN 单 check 项 result → CSS 徽章类（BRAIN 用 PASS/FAIL/PENDING/WARNING）。 */
		function checkItemResultClass(result) {
			if (result === null || result === void 0) return void 0;
			const r = String(result).toUpperCase();
			if (r === "PASS") return QianxunTab_module_css_default.bPass;
			if (r === "WARNING" || r === "WARN") return QianxunTab_module_css_default.bWarn;
			if (r === "FAIL") return QianxunTab_module_css_default.bFail;
			return QianxunTab_module_css_default.bNone;
		}
		/** 单 check 项 result 徽章。 */
		function checkItemBadge(result) {
			if (result === null || result === void 0 || result === "") return "";
			const cls = checkItemResultClass(result);
			return cls ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: cls,
				children: String(result).toLowerCase()
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: QianxunTab_module_css_default.bNone,
				children: String(result).toLowerCase()
			});
		}
		/** 把 BRAIN check 项的 value/limit 显示为紧凑字符串。value 不存在则不渲染。 */
		function renderCheckMeta(c) {
			const v = c.value;
			const l = c.limit;
			if (typeof v === "number" && typeof l === "number") return `${fmt(v)} / 限 ${fmt(l)}`;
			if (typeof v === "number") return fmt(v);
			return "";
		}
		/**
		* 渲染单 alpha 的详细 check 列表。
		* - 高亮 PROD_CORRELATION（最常用筛选项）
		* - 用三色徽章标 PASS/FAIL/WARNING/PENDING
		* - 顶部 summary：X 通过 / Y 失败 / Z 待定 / W 警告
		*/
		function renderChecksList(checks) {
			if (checks.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: QianxunTab_module_css_default.empty,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: QianxunTab_module_css_default.emptyIcon,
					children: "🗂️"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "本 alpha 没有 check 数据" })]
			});
			let pass = 0, fail = 0, warn = 0, pending = 0;
			for (const c of checks) {
				const r = String(c.result ?? "").toUpperCase();
				if (r === "PASS") pass++;
				else if (r === "FAIL") fail++;
				else if (r === "WARNING" || r === "WARN") warn++;
				else pending++;
			}
			const order = {
				FAIL: 0,
				WARNING: 1,
				WARN: 1,
				PENDING: 2,
				PASS: 3
			};
			const sorted = [...checks].sort((a, b) => {
				if (a.name === "PROD_CORRELATION") return -1;
				if (b.name === "PROD_CORRELATION") return 1;
				return (order[String(a.result ?? "").toUpperCase()] ?? 4) - (order[String(b.result ?? "").toUpperCase()] ?? 4);
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: QianxunTab_module_css_default.checksPanel,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: QianxunTab_module_css_default.checksSummary,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: QianxunTab_module_css_default.bPass,
							children: [pass, " pass"]
						}),
						fail > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: QianxunTab_module_css_default.bFail,
							children: [fail, " fail"]
						}),
						warn > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: QianxunTab_module_css_default.bWarn,
							children: [warn, " warn"]
						}),
						pending > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: QianxunTab_module_css_default.bNone,
							children: [pending, " pending"]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: QianxunTab_module_css_default.spacer }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: QianxunTab_module_css_default.checksTotal,
							children: [
								"共 ",
								checks.length,
								" 项"
							]
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: QianxunTab_module_css_default.checksList,
					children: sorted.map((c, i) => {
						const isPC = c.name === "PROD_CORRELATION";
						const meta = renderCheckMeta(c);
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: `${QianxunTab_module_css_default.checkItem}${isPC ? " " + QianxunTab_module_css_default.checkItemHighlight : ""}`,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: QianxunTab_module_css_default.checkItemName,
									title: c.name,
									children: c.name
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: QianxunTab_module_css_default.checkItemMeta,
									children: meta
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: QianxunTab_module_css_default.checkItemResult,
									children: checkItemBadge(c.result)
								})
							]
						}, `${c.name}-${i}`);
					})
				})]
			});
		}
		/** 渲染全量逐条结果表。results 为空时给友好空态。
		* 提供 actions 时，每行末尾追加最多 3 个动作按钮。 */
		function renderMetricsTable(results, actions) {
			if (results === void 0 || results.length === 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: QianxunTab_module_css_default.empty,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: QianxunTab_module_css_default.emptyIcon,
					children: "🗂️"
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "本批次暂无逐条结果" })]
			});
			const showActions = actions !== void 0 && (actions.onCheck !== void 0 || actions.onProdCorr !== void 0 || actions.onLocalSelf !== void 0);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: QianxunTab_module_css_default.tableWrap,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
					className: QianxunTab_module_css_default.table,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "alpha_id" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "表达式" }),
						METRIC_KEYS.map((m) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: m.label }, m.key)),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "check" }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", { children: "状态" }),
						showActions && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {})
					] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: results.map((result) => {
						const sharpe = result.metrics?.sharpe;
						const sharpeCls = typeof sharpe === "number" ? sharpe >= 0 ? "valPos" : "valNeg" : void 0;
						const alphaId = result.alpha_id;
						const canAct = typeof alphaId === "string" && alphaId !== "";
						return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
								className: QianxunTab_module_css_default.cellAlpha,
								children: alphaId ?? "—"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
								className: QianxunTab_module_css_default.cellExpr,
								title: result.expression ?? "",
								children: result.expression ?? "—"
							}),
							METRIC_KEYS.map((m) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
								className: `${QianxunTab_module_css_default.cellNum}${m.key === "sharpe" && sharpeCls ? " " + QianxunTab_module_css_default[sharpeCls] : ""}`,
								children: fmt(result.metrics?.[m.key], m.pct)
							}, m.key)),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", { children: checkBadge(result.metrics?.check_status) }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
								className: QianxunTab_module_css_default.cellStatus,
								children: result.status ?? "—"
							}),
							showActions && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
								className: QianxunTab_module_css_default.cellAction,
								children: canAct ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
									actions?.onCheck !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: QianxunTab_module_css_default.iconBtn,
										title: "查看 BRAIN 详细 check",
										"aria-label": "check",
										onClick: () => actions.onCheck?.(alphaId),
										children: "🔍"
									}),
									actions?.onProdCorr !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: QianxunTab_module_css_default.iconBtn,
										title: "拉取真 prod correlation（绕过 PENDING）",
										"aria-label": "prod corr",
										onClick: () => actions.onProdCorr?.(alphaId),
										children: "📈"
									}),
									actions?.onLocalSelf !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: QianxunTab_module_css_default.iconBtn,
										title: "本地核对 SELF_CORRELATION（拉 PnL + JS 算 Pearson）",
										"aria-label": "local self",
										onClick: () => actions.onLocalSelf?.(alphaId),
										children: "📐"
									})
								] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: QianxunTab_module_css_default.cellActionNone,
									title: "该 alpha 缺少 alpha_id，无法 check",
									children: "—"
								})
							})
						] }, result.idx);
					}) })]
				})
			});
		}
		/** margin = (0.7 - prod_corr)，并查表得到 tier 标签。 */
		function classifyMargin(prodCorr) {
			const m = MARGIN_EPSILON;
			if (typeof prodCorr !== "number" || Number.isNaN(prodCorr)) return {
				label: "no_data",
				margin: 0,
				tier: "no_data"
			};
			const margin = Math.max(0, PROD_CORR_DEAD_ZONE - prodCorr + m);
			let tier = "tight";
			for (const t of MARGIN_TIERS) if (margin >= t.threshold) {
				tier = t.label;
				break;
			}
			return {
				label: tier,
				margin,
				tier
			};
		}
		/** 词边界匹配：避免 "ad" 之类短字段名误伤 adjusted/load/spread/trading 等。 */
		function matchesWithWordBoundary(haystack, needle) {
			const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			return new RegExp(`(?<![A-Za-z0-9_])$${escaped}(?![A-Za-z0-9_])`).test(haystack);
		}
		/** 表达式里包含已知 prod-fresh 字段？ */
		function isProdFreshField(expr) {
			if (!expr) return { hit: false };
			for (const { field } of PROD_FRESH_FIELDS) if (matchesWithWordBoundary(expr, field)) return {
				hit: true,
				field
			};
			return { hit: false };
		}
		/** 表达式里包含已知 prod 雷区字段？ */
		function isDeadZoneField(expr) {
			if (!expr) return { hit: false };
			for (const { field, note } of PROD_DEAD_ZONE_FIELDS) if (matchesWithWordBoundary(expr, field)) return {
				hit: true,
				field,
				note
			};
			return { hit: false };
		}
		/** IS_LADDER_SHARPE 风险分级（避免给必败 alpha 浪费 submission check）。 */
		function classifyLadderRisk(v) {
			if (typeof v !== "number" || Number.isNaN(v)) return "no_data";
			if (v < 1.58) return "certain_fail";
			if (v < 1.68) return "high";
			if (v < 1.85) return "medium";
			return "low";
		}
		/** 单组 PnL 的差分（每日盈亏）—— 用 PnL 增量做相关，更接近 BRAIN 的指标。 */
		function pnlToReturns(records) {
			const out = [];
			for (let i = 1; i < records.length; i++) {
				const cur = records[i]?.pnl;
				const prev = records[i - 1]?.pnl;
				if (typeof cur === "number" && typeof prev === "number" && Number.isFinite(cur) && Number.isFinite(prev)) out.push(cur - prev);
			}
			return out;
		}
		/** Pearson correlation of two numeric series. Returns NaN on insufficient data. */
		function pearson(xs, ys) {
			const n = Math.min(xs.length, ys.length);
			if (n < 2) return NaN;
			let sumX = 0;
			let sumY = 0;
			for (let i = 0; i < n; i++) {
				sumX += xs[i] ?? 0;
				sumY += ys[i] ?? 0;
			}
			const meanX = sumX / n;
			const meanY = sumY / n;
			let num = 0;
			let denomX = 0;
			let denomY = 0;
			for (let i = 0; i < n; i++) {
				const dx = (xs[i] ?? 0) - meanX;
				const dy = (ys[i] ?? 0) - meanY;
				num += dx * dy;
				denomX += dx * dx;
				denomY += dy * dy;
			}
			const denom = Math.sqrt(denomX * denomY);
			return denom === 0 ? NaN : num / denom;
		}
		/** 用每日 returns（PnL 增量）算与候选集的相关性，返回 max / min / per-candidate。 */
		function computeLocalSelfCorr(target, candidates) {
			const targetReturns = pnlToReturns(target);
			const targetDays = target.length;
			const perCandidate = [];
			let max = null;
			let min = null;
			for (const c of candidates) {
				const candReturns = pnlToReturns(c.records);
				const n = Math.min(targetReturns.length, candReturns.length);
				if (n < 30) {
					perCandidate.push({
						alphaId: c.alphaId,
						corr: null,
						overlapDays: n
					});
					continue;
				}
				const corr = pearson(targetReturns.slice(0, n), candReturns.slice(0, n));
				if (!Number.isNaN(corr)) {
					perCandidate.push({
						alphaId: c.alphaId,
						corr,
						overlapDays: n
					});
					if (max === null || corr > max) max = corr;
					if (min === null || corr < min) min = corr;
				} else perCandidate.push({
					alphaId: c.alphaId,
					corr: null,
					overlapDays: n
				});
			}
			return {
				targetReturns,
				targetDays,
				perCandidate,
				max,
				min
			};
		}
		//#endregion
		//#region src/client/prompts.ts
		const STORAGE_KEY = "qianxun_prompts";
		/** 已成功与服务端同步过的标记（存在即不再做一次性上迁）。 */
		const SYNCED_KEY = "qianxun_prompts_synced";
		const API_PATH = "/api/dsh-qianxun-tab/prompts";
		const MAX_CONTENT = 2e4;
		const PUSH_DEBOUNCE_MS = 300;
		function safeParse(raw) {
			if (!raw) return [];
			try {
				const arr = JSON.parse(raw);
				if (!Array.isArray(arr)) return [];
				return arr.filter((p) => p !== null && typeof p === "object" && typeof p.id === "string" && typeof p.name === "string" && typeof p.content === "string");
			} catch {
				return [];
			}
		}
		/** 读 localStorage 镜像（永不在读取路径上抛错）。 */
		function readLocal() {
			try {
				return safeParse(localStorage.getItem(STORAGE_KEY));
			} catch {
				return [];
			}
		}
		/** 写 localStorage 镜像（quota 等异常静默）。 */
		function writeLocal(list) {
			try {
				localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
			} catch {}
		}
		/** 打上「已同步」标记：此后不再把本浏览器的旧数据当作迁移源。 */
		function markSynced() {
			try {
				localStorage.setItem(SYNCED_KEY, "1");
			} catch {}
		}
		function hasSynced() {
			try {
				return localStorage.getItem(SYNCED_KEY) === "1";
			} catch {
				return false;
			}
		}
		let cache = null;
		let source = "loading";
		let loaded = null;
		let pushTimer;
		let pushPending = false;
		const listeners = /* @__PURE__ */ new Set();
		/** 当前列表（内存态；首次访问先以 localStorage 镜像兜底，避免空白闪烁）。 */
		function current() {
			if (cache === null) cache = readLocal();
			return cache;
		}
		function notify() {
			for (const listener of [...listeners]) try {
				listener();
			} catch {}
		}
		/** 订阅列表变化（服务端加载完成、增删改）。返回取消订阅函数。 */
		function subscribePrompts(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
		/** 当前数据来源：'loading' 尚未确定，'server' 服务端可用，'local' 已回落本地。 */
		function promptsSource() {
			return source;
		}
		async function fetchServer() {
			try {
				const res = await fetch(API_PATH, {
					method: "GET",
					headers: { accept: "application/json" },
					credentials: "same-origin",
					cache: "no-store"
				});
				if (!res.ok) return void 0;
				const body = await res.json();
				if (body.ok !== true || !Array.isArray(body.prompts)) return void 0;
				const prompts = safeParse(JSON.stringify(body.prompts));
				return {
					rev: typeof body.rev === "number" ? body.rev : 0,
					prompts
				};
			} catch {
				return;
			}
		}
		/** 全量推送内存态到服务端。返回是否成功。 */
		async function pushServer() {
			try {
				if (!(await fetch(API_PATH, {
					method: "PUT",
					headers: { "content-type": "application/json" },
					credentials: "same-origin",
					body: JSON.stringify({ prompts: current() })
				})).ok) return false;
				writeLocal(current());
				markSynced();
				return true;
			} catch {
				return false;
			}
		}
		/** 变更后防抖推送（仅服务端模式下生效）。 */
		function schedulePush() {
			if (source !== "server") return;
			pushPending = true;
			if (pushTimer !== void 0) clearTimeout(pushTimer);
			pushTimer = setTimeout(() => {
				pushTimer = void 0;
				if (!pushPending) return;
				pushPending = false;
				pushServer().then((ok) => {
					if (!ok) {
						source = "local";
						notify();
					}
				});
			}, PUSH_DEBOUNCE_MS);
		}
		/** 按 id 合并：base 打底，overlay 覆盖同 id 条目并追加新条目。 */
		function mergeById(base, overlay) {
			const byId = /* @__PURE__ */ new Map();
			for (const p of base) byId.set(p.id, p);
			for (const p of overlay) byId.set(p.id, p);
			return [...byId.values()].slice(-200);
		}
		/** 加载一次服务端数据（页面生命周期内只自动执行一次）。 */
		async function load() {
			const remote = await fetchServer();
			if (remote === void 0) {
				source = "local";
				cache = readLocal();
				notify();
				return;
			}
			source = "server";
			const local = readLocal();
			if (!hasSynced() && local.length > 0) {
				const merged = mergeById(remote.prompts, local);
				cache = merged;
				if (merged.length !== remote.prompts.length || merged.some((p) => !remote.prompts.some((r) => r.id === p.id && r.updated_at === p.updated_at))) {
					if (!await pushServer()) source = "local";
				} else {
					writeLocal(cache);
					markSynced();
				}
			} else {
				cache = remote.prompts;
				writeLocal(cache);
				markSynced();
			}
			notify();
		}
		/** 确保已尝试从服务端加载（幂等）。UI 挂载时调用，勿 await 阻塞渲染。 */
		function ensurePromptsLoaded() {
			loaded ??= load();
			return loaded;
		}
		/**
		* 重新拉取服务端（用于 tab 重新可见时对齐别的浏览器/窗口写入）。
		* 服务端不可用时不做任何事，本地模式下也不会覆盖内存态；
		* 有未落盘的本地改动（防抖窗口内）时跳过，避免用旧数据盖掉正在编辑的内容。
		*/
		async function refreshPrompts() {
			if (pushPending) return;
			const remote = await fetchServer();
			if (remote === void 0) return;
			source = "server";
			cache = remote.prompts;
			writeLocal(cache);
			markSynced();
			notify();
		}
		/** 读全部提示词（按 updated_at 倒序）。 */
		function listPrompts() {
			return [...current()].sort((a, b) => b.updated_at - a.updated_at);
		}
		/** 按 id 读单条。 */
		function getPrompt(id) {
			return current().find((p) => p.id === id);
		}
		/** 新增一条，返回新对象。 */
		function createPrompt(name, content = "") {
			const now = Date.now();
			const prompt = {
				id: `p-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
				name: name.trim() || "未命名提示词",
				content: content.slice(0, MAX_CONTENT),
				created_at: now,
				updated_at: now
			};
			const all = current();
			all.push(prompt);
			cache = all.slice(-200);
			writeLocal(cache);
			notify();
			schedulePush();
			return prompt;
		}
		/** 更新内容/名字，返回更新后对象；不存在返回 undefined。 */
		function updatePrompt(id, patch) {
			const all = current();
			const idx = all.findIndex((p) => p.id === id);
			if (idx === -1) return void 0;
			const cur = all[idx];
			if (patch.name !== void 0) cur.name = patch.name.trim() || cur.name;
			if (patch.content !== void 0) cur.content = patch.content.slice(0, MAX_CONTENT);
			cur.updated_at = Date.now();
			writeLocal(all);
			notify();
			schedulePush();
			return cur;
		}
		/** 删除一条。 */
		function deletePrompt(id) {
			const all = current();
			const next = all.filter((p) => p.id !== id);
			if (next.length === all.length) return false;
			cache = next;
			writeLocal(cache);
			notify();
			schedulePush();
			return true;
		}
		/** 复制提示词到剪贴板。返回是否成功。 */
		async function copyPrompt(id) {
			const p = getPrompt(id);
			if (!p) return false;
			try {
				await navigator.clipboard.writeText(p.content);
				return true;
			} catch {
				const ta = document.createElement("textarea");
				ta.value = p.content;
				ta.style.position = "fixed";
				ta.style.opacity = "0";
				document.body.appendChild(ta);
				ta.select();
				const ok = document.execCommand("copy");
				document.body.removeChild(ta);
				return ok;
			}
		}
		//#endregion
		//#region src/client/QianxunTab.tsx
		/** 千寻回测控制台——dsh-better-sidebar 的自定义 tab 内容组件（列表视图）。 */
		/** 分页默认条数与可选值。`all` = 不分页（一次性渲染全部）。 */
		const PAGE_SIZE_OPTIONS = [
			3,
			4,
			5,
			8,
			"all"
		];
		const DEFAULT_PAGE_SIZE = 3;
		/** 批次状态 → 行状态类。 */
		function stateClass(state) {
			const s = String(state).toLowerCase();
			if (s === "done" || s === "finished" || s === "complete" || s === "completed" || s === "success" || s === "succeeded") return QianxunTab_module_css_default.rowStateDone;
			if (s === "error" || s === "failed" || s === "fail" || s === "cancelled" || s === "canceled" || s === "cancel" || s === "stopped" || s === "stop" || s === "abort" || s === "aborted" || s === "halted" || s === "killed") return QianxunTab_module_css_default.rowStateError;
			if (s === "paused" || s === "pause" || s === "pausing" || s === "suspended") return QianxunTab_module_css_default.rowStatePaused;
			if (isRunning(s)) return QianxunTab_module_css_default.rowStateRunning;
			return QianxunTab_module_css_default.rowStateQueued;
		}
		/** 进度条 fill 颜色类。running 优先；终态按 stateClass；其它无色（与行首 bar 一致）。 */
		function progressFillClass(state, running) {
			if (running) return QianxunTab_module_css_default.progressRunning ?? "";
			const sc = stateClass(state);
			if (sc === QianxunTab_module_css_default.rowStateDone) return QianxunTab_module_css_default.progressDone ?? "";
			if (sc === QianxunTab_module_css_default.rowStateError) return QianxunTab_module_css_default.progressError ?? "";
			if (sc === QianxunTab_module_css_default.rowStatePaused) return QianxunTab_module_css_default.progressPaused ?? "";
			return "";
		}
		function QianxunTab(props) {
			const { visible } = props;
			const [batches, setBatches] = (0, react.useState)([]);
			const [error, setError] = (0, react.useState)(null);
			const [loading, setLoading] = (0, react.useState)(false);
			const [engineOnline, setEngineOnline] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)({});
			const [quota, setQuota] = (0, react.useState)(null);
			const [configBusy, setConfigBusy] = (0, react.useState)(false);
			const [configMsg, setConfigMsg] = (0, react.useState)(null);
			const [configMsgOk, setConfigMsgOk] = (0, react.useState)(false);
			const [concurrentInput, setConcurrentInput] = (0, react.useState)("");
			const [batchSizeInput, setBatchSizeInput] = (0, react.useState)("");
			const [prompts, setPrompts] = (0, react.useState)([]);
			const [promptsFrom, setPromptsFrom] = (0, react.useState)("loading");
			const [copyHintText, setCopyHintText] = (0, react.useState)(null);
			const promptSyncedRef = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (!visible) return;
				const sync = () => {
					setPrompts(listPrompts());
					setPromptsFrom(promptsSource());
				};
				sync();
				const unsubscribe = subscribePrompts(sync);
				const task = promptSyncedRef.current ? refreshPrompts() : ensurePromptsLoaded();
				promptSyncedRef.current = true;
				task.then(sync);
				return unsubscribe;
			}, [visible]);
			/** 新增提示词并打开编辑 tab。 */
			const onAddPrompt = (0, react.useCallback)(() => {
				const p = createPrompt("新提示词", "");
				setPrompts(listPrompts());
				props.ctx?.betterSidebar?.openTab({
					type: "qianxun-prompt",
					title: p.name,
					id: `qianxun-prompt:${p.id}`,
					meta: { promptId: p.id }
				});
			}, [props.ctx]);
			/** 点击提示词 → 打开编辑 tab。 */
			const openPrompt = (0, react.useCallback)((promptId) => {
				const p = getPrompt(promptId);
				props.ctx?.betterSidebar?.openTab({
					type: "qianxun-prompt",
					title: p?.name ?? "提示词",
					id: `qianxun-prompt:${promptId}`,
					meta: { promptId }
				});
			}, [props.ctx]);
			const [pageSize, setPageSize] = (0, react.useState)(DEFAULT_PAGE_SIZE);
			const [currentPage, setCurrentPage] = (0, react.useState)(1);
			/** 当前批次数下的总页数（pageSize='all' 时固定为 1）。 */
			const totalPages = (0, react.useMemo)(() => {
				if (pageSize === "all") return 1;
				return Math.max(1, Math.ceil(batches.length / pageSize));
			}, [batches.length, pageSize]);
			/** 当前页可见的批次（pageSize='all' 时返回全部）。 */
			const pageBatches = (0, react.useMemo)(() => {
				if (pageSize === "all") return batches;
				const start = (currentPage - 1) * pageSize;
				return batches.slice(start, start + pageSize);
			}, [
				batches,
				currentPage,
				pageSize
			]);
			/** 批次总数或页大小变化时，把 currentPage 夹紧到合法范围。 */
			(0, react.useEffect)(() => {
				if (currentPage > totalPages) setCurrentPage(totalPages);
			}, [totalPages, currentPage]);
			const refresh = (0, react.useCallback)(async () => {
				setLoading(true);
				setError(null);
				try {
					const [b, c, q] = await Promise.all([
						listBatches(),
						getConfig().catch(() => null),
						getQuota().catch(() => null)
					]);
					setBatches(b ?? []);
					setEngineOnline(true);
					if (c) {
						setConcurrentInput(String(c.concurrent ?? ""));
						setBatchSizeInput(String(c.batch_size ?? ""));
					}
					if (q) setQuota(q);
				} catch (cause) {
					setEngineOnline(false);
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setLoading(false);
				}
			}, []);
			(0, react.useEffect)(() => {
				if (!visible) return;
				refresh();
				const timer = window.setInterval(() => {
					refresh();
				}, 5e3);
				return () => window.clearInterval(timer);
			}, [visible, refresh]);
			const prevVisible = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (visible && prevVisible.current === false) refresh();
				prevVisible.current = visible;
			}, [visible, refresh]);
			const runAction = (0, react.useCallback)(async (batchNo, action) => {
				setBusy((prev) => ({
					...prev,
					[batchNo]: true
				}));
				try {
					await action();
					await refresh();
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setBusy((prev) => ({
						...prev,
						[batchNo]: false
					}));
				}
			}, [refresh]);
			const onAct = (batchNo, action) => () => runAction(batchNo, () => actOnBatch(batchNo, action));
			const onResumeBack = (batchNo) => () => runAction(batchNo, () => resumeBatch(batchNo));
			/** 打开该批次的独立详情 tab（每批次一个，可多个批次并存）。 */
			const openDetail = (0, react.useCallback)((batchNo) => {
				props.ctx?.betterSidebar?.openTab({
					type: "qianxun-detail",
					title: `${batchNo} 结果`,
					id: `qianxun-detail:${batchNo}`,
					meta: { batchNo }
				});
			}, [props.ctx]);
			const doApplyConfig = async () => {
				setConfigBusy(true);
				setConfigMsg(null);
				try {
					const body = {};
					const ci = parseInt(concurrentInput, 10);
					const bi = parseInt(batchSizeInput, 10);
					if (!Number.isNaN(ci) && ci >= 1) body.concurrent = ci;
					if (!Number.isNaN(bi) && bi >= 1 && bi <= 10) body.batch_size = bi;
					const c = await setConfig(body);
					setConfigMsg(`已应用：并发=${c.concurrent} 批大小=${c.batch_size}`);
					setConfigMsgOk(true);
					refresh();
				} catch (cause) {
					setConfigMsg(cause instanceof Error ? cause.message : String(cause));
					setConfigMsgOk(false);
				} finally {
					setConfigBusy(false);
				}
			};
			const doViewResult = async (batchNo) => {
				openDetail(batchNo);
			};
			const doDownloadResult = async (batchNo) => {
				try {
					const detail = await getBatchResult(batchNo);
					const blob = new Blob([JSON.stringify(detail, null, 2)], { type: "application/json" });
					const url = URL.createObjectURL(blob);
					const a = document.createElement("a");
					a.href = url;
					a.download = `${batchNo}-result.json`;
					a.click();
					URL.revokeObjectURL(url);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			};
			const renderRow = (batch) => {
				const batchNo = batch.id ?? batch.round;
				if (batchNo === void 0) return null;
				const isBusy = busy[batchNo] ?? false;
				const running = isRunning(batch.state);
				const done = Math.min(batch.done ?? 0, batch.total || batch.done || 0);
				const total = batch.total ?? 0;
				const pct = total > 0 ? Math.round(done / total * 100) : 0;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: QianxunTab_module_css_default.row,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: QianxunTab_module_css_default.rowHead,
						onClick: () => {
							openDetail(batchNo);
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: `${QianxunTab_module_css_default.rowBar} ${stateClass(batch.state)}` }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: QianxunTab_module_css_default.rowMain,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: QianxunTab_module_css_default.rowTop,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: QianxunTab_module_css_default.rowId,
											children: batchNo
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: `${QianxunTab_module_css_default.badge} ${stateClass(batch.state)}`,
											children: batch.state ?? "—"
										}),
										batch.name !== void 0 && batch.name !== null && batch.name !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: QianxunTab_module_css_default.rowName,
											children: batch.name
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: QianxunTab_module_css_default.spacer }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: QianxunTab_module_css_default.rowMeta,
											children: [
												done,
												"/",
												total || "?"
											]
										})
									]
								}), total > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: QianxunTab_module_css_default.progressTrack,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: `${QianxunTab_module_css_default.progressFill} ${progressFillClass(batch.state, running)}`,
										style: { width: `${pct}%` }
									})
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: QianxunTab_module_css_default.rowActions,
								onClick: (event) => event.stopPropagation(),
								children: [
									running && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: `${QianxunTab_module_css_default.iconBtn} ${QianxunTab_module_css_default.actionIco}`,
										disabled: isBusy,
										onClick: onAct(batchNo, "pause"),
										title: "暂停批次",
										"aria-label": "暂停",
										children: "⏸"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: `${QianxunTab_module_css_default.iconBtn} ${QianxunTab_module_css_default.actionIco}`,
										disabled: isBusy,
										onClick: onAct(batchNo, "resume"),
										title: "恢复批次",
										"aria-label": "恢复",
										children: "▶"
									})] }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: `${QianxunTab_module_css_default.iconBtn} ${QianxunTab_module_css_default.actionIco}`,
										disabled: isBusy,
										onClick: onResumeBack(batchNo),
										title: "断点续跑",
										"aria-label": "断点续跑",
										children: "↻"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: `${QianxunTab_module_css_default.iconBtn} ${QianxunTab_module_css_default.actionIco}`,
										disabled: isBusy,
										onClick: () => {
											doViewResult(batchNo);
										},
										title: "结果 JSON（打开独立详情 tab）",
										"aria-label": "结果 JSON",
										children: "{}"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: `${QianxunTab_module_css_default.iconBtn} ${QianxunTab_module_css_default.actionIco}`,
										disabled: isBusy,
										onClick: () => {
											doDownloadResult(batchNo);
										},
										title: "下载结果 JSON",
										"aria-label": "下载",
										children: "⇩"
									})
								]
							})
						]
					})
				}, batchNo);
			};
			const renderConfig = () => {
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: QianxunTab_module_css_default.card,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: QianxunTab_module_css_default.cardHead,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: QianxunTab_module_css_default.cardIcon,
								children: "⚙️"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: QianxunTab_module_css_default.cardTitle,
								children: "引擎配置"
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: QianxunTab_module_css_default.fieldRow,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: QianxunTab_module_css_default.fieldLabel,
									children: "并发"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: `${QianxunTab_module_css_default.input} ${QianxunTab_module_css_default.configInput}`,
									value: concurrentInput,
									placeholder: "并发槽数",
									onChange: (e) => setConcurrentInput(e.target.value)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: QianxunTab_module_css_default.fieldLabel,
									children: "批大小"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: `${QianxunTab_module_css_default.input} ${QianxunTab_module_css_default.configInput}`,
									value: batchSizeInput,
									placeholder: "每批条数",
									onChange: (e) => setBatchSizeInput(e.target.value)
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: QianxunTab_module_css_default.configBtn,
									disabled: configBusy,
									onClick: () => {
										doApplyConfig();
									},
									children: configBusy ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: QianxunTab_module_css_default.spinner }) : "应用"
								})
							]
						}),
						configMsg !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: `${QianxunTab_module_css_default.msg} ${configMsgOk ? QianxunTab_module_css_default.msgOk : QianxunTab_module_css_default.msgErr}`,
							children: configMsg
						})
					]
				});
			};
			/** 分页条：上一页 / 页码 / 下一页 / 总数 + 页大小下拉。
			* 仅在有批次且 pageSize 不是 'all' 时显示完整控件；'all' 时只展示总数。 */
			const renderPagination = () => {
				const total = batches.length;
				if (total === 0) return null;
				const all = pageSize === "all";
				const canPrev = !all && currentPage > 1;
				const canNext = !all && currentPage < totalPages;
				const sizeLabel = all ? "全部" : `每页 ${pageSize}`;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: QianxunTab_module_css_default.pagination,
					role: "navigation",
					"aria-label": "批次分页",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: QianxunTab_module_css_default.paginationBtn,
							disabled: !canPrev,
							onClick: () => {
								if (canPrev) setCurrentPage((p) => p - 1);
							},
							"aria-label": "上一页",
							title: "上一页",
							children: "‹"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: QianxunTab_module_css_default.paginationInfo,
							children: [all ? "全部" : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								"第 ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: currentPage }),
								"/",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: totalPages }),
								" 页"
							] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: QianxunTab_module_css_default.paginationTotal,
								children: [
									"· 共 ",
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: total }),
									" 批"
								]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: QianxunTab_module_css_default.paginationBtn,
							disabled: !canNext,
							onClick: () => {
								if (canNext) setCurrentPage((p) => p + 1);
							},
							"aria-label": "下一页",
							title: "下一页",
							children: "›"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: QianxunTab_module_css_default.spacer }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: QianxunTab_module_css_default.paginationSizeLabel,
							children: "页大小"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("select", {
							className: QianxunTab_module_css_default.paginationSizeSelect,
							value: pageSize === "all" ? "all" : String(pageSize),
							onChange: (e) => {
								const v = e.target.value;
								setPageSize(v === "all" ? "all" : Number(v));
								setCurrentPage(1);
							},
							title: "每页显示条数",
							"aria-label": "每页显示条数",
							children: PAGE_SIZE_OPTIONS.map((opt) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: opt === "all" ? "all" : String(opt),
								children: opt === "all" ? "全部" : opt
							}, opt))
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: QianxunTab_module_css_default.paginationSizeHint,
							children: sizeLabel
						})
					]
				});
			};
			const renderPrompts = () => {
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: QianxunTab_module_css_default.card,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: QianxunTab_module_css_default.cardHead,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: QianxunTab_module_css_default.cardIcon,
									children: "📋"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: QianxunTab_module_css_default.cardTitle,
									children: "提示词"
								}),
								promptsFrom !== "loading" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: QianxunTab_module_css_default.promptSavedTag,
									title: promptsFrom === "server" ? "存在宿主侧 $DSH_HOME/qianxun/prompts.json：同一台机器的任何浏览器、任何端口看到的是同一份" : "服务端存储不可用（非 web profile，或从其它机器访问），当前仅存在本浏览器 localStorage：换浏览器会看不到",
									children: promptsFrom === "server" ? "服务端同步" : "仅本浏览器"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: QianxunTab_module_css_default.spacer }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: QianxunTab_module_css_default.btnGhost,
									onClick: onAddPrompt,
									title: "新增提示词",
									"aria-label": "新增提示词",
									children: "＋ 新增"
								})
							]
						}),
						prompts.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: QianxunTab_module_css_default.empty,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: QianxunTab_module_css_default.emptyIcon,
								children: "📄"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: QianxunTab_module_css_default.emptyTitle,
								children: "暂无提示词"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: QianxunTab_module_css_default.emptySub,
								children: "点「＋ 新增」创建第一条。"
							})] })]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: QianxunTab_module_css_default.promptList,
							children: prompts.map((p) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: QianxunTab_module_css_default.promptItem,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
									type: "button",
									className: QianxunTab_module_css_default.promptName,
									onClick: () => openPrompt(p.id),
									title: `打开「${p.name}」编辑`,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: QianxunTab_module_css_default.promptItemIcon,
										children: "📄"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: QianxunTab_module_css_default.promptItemName,
										children: p.name
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: `${QianxunTab_module_css_default.iconBtn} ${QianxunTab_module_css_default.promptCopyBtn}`,
									onClick: () => {
										copyPrompt(p.id).then((ok) => {
											setCopyHintText(ok ? `已复制「${p.name}」` : "复制失败");
											setTimeout(() => setCopyHintText(null), 2e3);
										});
									},
									title: "复制提示词内容",
									"aria-label": "复制",
									children: "⧉"
								})]
							}, p.id))
						}),
						copyHintText !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: `${QianxunTab_module_css_default.msg} ${QianxunTab_module_css_default.msgOk}`,
							children: copyHintText
						})
					]
				});
			};
			/** 启动引擎：离线时先调常驻启动器(8766)拉起，再轮询等引擎就绪。 */
			const [engineStarting, setEngineStarting] = (0, react.useState)(false);
			const [engineBtnMsg, setEngineBtnMsg] = (0, react.useState)(null);
			const handleStartEngine = (0, react.useCallback)(() => {
				if (engineOnline === true) {
					refresh();
					setEngineBtnMsg("✓ 引擎在线");
					setTimeout(() => setEngineBtnMsg(null), 2e3);
					return;
				}
				setEngineStarting(true);
				setEngineBtnMsg("正在启动引擎…");
				fetch(`http://127.0.0.1:8766/api/start`, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-Api-Token": "qianxund-ctl"
					},
					body: "{}"
				}).then((r) => r.json().catch(() => ({}))).then((res) => {
					if (!(res?.started === true || res?.message === "via launchd kickstart" || res?.ok === true) && res?.message !== "already_running") {
						setEngineStarting(false);
						setEngineBtnMsg("⚠ 启动失败：" + (res?.error ?? res?.message ?? "未知错误"));
						setTimeout(() => setEngineBtnMsg(null), 5e3);
						return;
					}
					let tries = 0;
					const timer = window.setInterval(() => {
						tries += 1;
						fetch(`${QIANXUN_BASE}/health`, { method: "GET" }).then((r) => r.ok).catch(() => false).then((ok) => {
							if (ok) {
								window.clearInterval(timer);
								setEngineStarting(false);
								setEngineBtnMsg("✓ 引擎已启动");
								setTimeout(() => setEngineBtnMsg(null), 2500);
								refresh();
							} else if (tries >= 15) {
								window.clearInterval(timer);
								setEngineStarting(false);
								setEngineBtnMsg("⚠ 引擎启动中，请稍候再刷新");
								setTimeout(() => setEngineBtnMsg(null), 5e3);
							}
						});
					}, 1e3);
				}).catch((cause) => {
					setEngineStarting(false);
					setEngineBtnMsg("⚠ 启动器不可用：" + (cause instanceof Error ? cause.message : String(cause)));
					setTimeout(() => setEngineBtnMsg(null), 5e3);
				});
			}, [engineOnline, refresh]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: QianxunTab_module_css_default.root,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
					className: QianxunTab_module_css_default.header,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: QianxunTab_module_css_default.titleIcon,
							children: "🧠"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: QianxunTab_module_css_default.title,
							children: "千寻回测"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: QianxunTab_module_css_default.quotaChip,
							title: "今日提交 / 每日剩余配额 / 重置时间",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: QianxunTab_module_css_default.quotaLabel,
									children: "今日"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: quota?.submitted_today ?? "—" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: QianxunTab_module_css_default.quotaSep,
									children: "·"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: QianxunTab_module_css_default.quotaLabel,
									children: "剩"
								}),
								quota?.quota?.limit !== void 0 && quota.quota?.remaining !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: quota.quota.remaining }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: QianxunTab_module_css_default.quotaSep,
										children: "/"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: quota.quota.limit }),
									(() => {
										const rs = quota.quota?.reset_sec;
										const rm = rs !== void 0 && Number.isFinite(rs) ? Math.round(rs / 60) : null;
										return rm !== null ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: QianxunTab_module_css_default.quotaSep,
											children: "·"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [rm, "min"] })] }) : null;
									})()
								] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "—" })
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: QianxunTab_module_css_default.spacer }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: engineOnline ? QianxunTab_module_css_default.startEngineBtnOnline : QianxunTab_module_css_default.startEngineBtnOffline,
							onClick: handleStartEngine,
							disabled: engineStarting,
							title: engineOnline ? "引擎运行中（launchd 托管，崩溃自动重启）。点击探测状态" : engineStarting ? "正在启动引擎…" : "引擎离线。点击启动：launchd 会自动拉起（KeepAlive），稍候",
							"aria-label": "启动引擎",
							children: engineStarting ? "⚡ 启动中…" : engineOnline ? "🟢 引擎在线" : "⚡ 启动引擎"
						}),
						engineBtnMsg !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: `${QianxunTab_module_css_default.startEngineToast} ${engineBtnMsg.startsWith("✓") ? QianxunTab_module_css_default.startEngineToastOk : engineBtnMsg.startsWith("⚠") ? QianxunTab_module_css_default.startEngineToastWarn : ""}`,
							children: engineBtnMsg
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: QianxunTab_module_css_default.iconBtn,
							onClick: () => {
								refresh();
							},
							"aria-label": "刷新",
							title: "刷新",
							children: loading ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: QianxunTab_module_css_default.spinner }) : "⟳"
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: QianxunTab_module_css_default.body,
					children: [
						error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: QianxunTab_module_css_default.error,
							role: "alert",
							children: [error, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: QianxunTab_module_css_default.retryBtn,
								onClick: () => void refresh(),
								children: "重试"
							})]
						}),
						renderPagination(),
						batches.length === 0 && error === null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: QianxunTab_module_css_default.empty,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: QianxunTab_module_css_default.emptyIcon,
								children: "🗂️"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: QianxunTab_module_css_default.emptyTitle,
								children: "还没有回测批次"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: QianxunTab_module_css_default.emptySub,
								children: "可通过下方「提交批次」创建，或等待引擎产出。"
							})] })]
						}),
						pageBatches.map(renderRow),
						renderConfig(),
						renderPrompts(),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: QianxunTab_module_css_default.statusFooter,
							children: ["引擎 ", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("a", {
								href: QIANXUN_BASE,
								target: "_blank",
								rel: "noopener noreferrer",
								className: QianxunTab_module_css_default.statusFooterLink,
								children: QIANXUN_BASE
							})]
						})
					]
				})]
			});
		}
		//#endregion
		//#region src/client/AlphaPoolCard.tsx
		/**
		* AlphaPoolCard.tsx — 「Alpha 自选池 + 提交闸」卡（千寻结果页里存 alpha_id 的地方）。
		*
		* 干什么：
		*   · 输入框存 alpha_id（支持一次粘一坨：逗号 / 换行 / 空格分隔）
		*   · 表格：状态 / region / alpha_id（可一键复制）/ sharpe / fitness / ret% / to% /
		*     margin（万分之一）/ selfcorr / prodcorr / 备注（可直接在格子里写）
		*   · 「同步」按钮一次性刷新整池的状态与指标
		*   · 顶部显示「账号当日新增 active」（每天本地 12:00 重置）
		*   · 提交栏：粘 alpha_id → 先拉 check 列出 FAIL → 确认后**真的提交到平台**
		*
		* 数据从哪来：全部走引擎（`/api/alpha-pool*`）。池子落在引擎侧（跨浏览器/跨端口都在），
		* 打 BRAIN 的活也由引擎代劳——浏览器既没有凭据，也会撞 CORS。
		*
		* 降级：引擎如果还是老版本（没有这几个接口），GET 会 404。这里不报红，而是明确
		* 告诉用户「引擎需要重启才生效」，UI 其余部分不受影响。
		*
		* ⚠️ 提交红线：提交不可逆。本组件只做「人类点按钮 → 引擎执行」这一条路，
		* 引擎侧还会硬校验 confirm token。agent / 脚本不得代提。
		*/
		/** 一次最多提交几个（与引擎侧 _SUBMIT_MAX_IDS 对齐）。 */
		const SUBMIT_MAX_IDS = 5;
		/** 提交任务轮询间隔（毫秒）。 */
		const SUBMIT_POLL_MS = 4e3;
		/** 提交状态（active/unsubmit）→ 展示元信息。 */
		const STATUS_META = {
			active: {
				label: "active",
				cls: "poolActive",
				hint: "在 BRAIN 的 ACTIVE 组合里（已提交且未被踢出）"
			},
			unsubmit: {
				label: "unsubmit",
				cls: "poolUnsubmit",
				hint: "不在 ACTIVE 组合里（未提交 / 已失效）"
			},
			unknown: {
				label: "unknown",
				cls: "poolUnknown",
				hint: "这次没拿到状态（BRAIN 不可用或账号里查不到这个 id）"
			}
		};
		/** 提交结论 → 展示元信息。 */
		const SUBMIT_META = {
			queued: {
				label: "排队中",
				cls: "submitQueued"
			},
			submitted: {
				label: "已提交",
				cls: "submitOk"
			},
			blocked: {
				label: "提交被拒",
				cls: "submitBad"
			},
			failed: {
				label: "提交失败",
				cls: "submitBad"
			},
			timeout: {
				label: "提交超时",
				cls: "submitBad"
			},
			pending: {
				label: "待续查",
				cls: "submitWarn"
			}
		};
		/** 把任意 status 字符串映射到展示元信息（未知态原样显示）。 */
		function statusMeta(status) {
			const key = String(status ?? "unknown").toLowerCase();
			return STATUS_META[key] ?? {
				label: key,
				cls: "poolUnknown",
				hint: `BRAIN 状态：${key}`
			};
		}
		/** 把任意提交状态映射到展示元信息。 */
		function submitMeta(state) {
			if (state === null || state === void 0 || state === "") return null;
			return SUBMIT_META[state] ?? {
				label: state,
				cls: "submitWarn"
			};
		}
		/** `err`（fetch 抛出的错误）是否表示「引擎还没这个接口」。 */
		function isMissingEndpoint(err) {
			const msg = err instanceof Error ? err.message : String(err);
			return /qianxun 404\b/.test(msg) || /not found/i.test(msg);
		}
		/** margin 按用户口径以「万分之一」为单位显示：0.000783 → 7.83。 */
		function fmtWan(v) {
			if (typeof v !== "number" || Number.isNaN(v)) return "—";
			return String(parseFloat((v * 1e4).toPrecision(3)));
		}
		/** PASS/FAIL/WARNING/PENDING → 已有徽章类（css 模块索引带 undefined，故返回可空）。 */
		function statusBadgeCls(result) {
			const r = result.toUpperCase();
			if (r === "PASS") return QianxunTab_module_css_default.bPass;
			if (r === "FAIL") return QianxunTab_module_css_default.bFail;
			if (r === "WARNING" || r === "WARN") return QianxunTab_module_css_default.bWarn;
			return QianxunTab_module_css_default.bNone;
		}
		/** 相关性单元格：数值 + PASS/FAIL 徽章竖排，>= 死区线标红。 */
		function corrCell(value, result) {
			if (typeof value !== "number" || Number.isNaN(value)) return result ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: statusBadgeCls(result),
				children: String(result).toLowerCase()
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: QianxunTab_module_css_default.bNone,
				children: "—"
			});
			const dead = value >= PROD_CORR_DEAD_ZONE;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				className: QianxunTab_module_css_default.poolCorrCell,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: dead ? QianxunTab_module_css_default.valNeg : QianxunTab_module_css_default.valPos,
					title: dead ? `≥ 死区线 ${PROD_CORR_DEAD_ZONE}` : void 0,
					children: fmt(value)
				}), result !== null && result !== void 0 && result !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: statusBadgeCls(result),
					children: String(result).toLowerCase()
				})]
			});
		}
		/** 复制到剪贴板。优先 Clipboard API，回落 execCommand（本机 http 下两者都可用）。 */
		async function copyText(text) {
			try {
				if (navigator.clipboard !== void 0) {
					await navigator.clipboard.writeText(text);
					return true;
				}
			} catch {}
			try {
				const ta = document.createElement("textarea");
				ta.value = text;
				ta.setAttribute("readonly", "");
				ta.style.position = "fixed";
				ta.style.opacity = "0";
				document.body.appendChild(ta);
				ta.select();
				const ok = document.execCommand("copy");
				document.body.removeChild(ta);
				return ok;
			} catch {
				return false;
			}
		}
		/** 把输入的文本解析成去重保序的 alpha_id 列表（与引擎侧同口径）。 */
		function parseIds(raw) {
			const out = [];
			const seen = /* @__PURE__ */ new Set();
			for (const chunk of raw.split(/[\s,;]+/)) {
				const s = chunk.trim();
				if (/^[A-Za-z0-9]{4,16}$/.test(s) && !seen.has(s)) {
					seen.add(s);
					out.push(s);
				}
			}
			return out;
		}
		/** 从 check 响应里挑出 FAIL 项名字。 */
		function failNames(payload) {
			const checks = payload?.is?.checks;
			if (!Array.isArray(checks)) return [];
			return checks.filter((c) => String(c?.["result"] ?? "").toUpperCase() === "FAIL").map((c) => String(c?.["name"] ?? "?"));
		}
		function AlphaPoolCard(props) {
			const { visible = true, onInspect } = props;
			const [pool, setPool] = (0, react.useState)(null);
			const [stats, setStats] = (0, react.useState)(null);
			const [loading, setLoading] = (0, react.useState)(false);
			const [syncing, setSyncing] = (0, react.useState)(false);
			const [mutating, setMutating] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const [engineMissing, setEngineMissing] = (0, react.useState)(false);
			const [draft, setDraft] = (0, react.useState)("");
			const [notice, setNotice] = (0, react.useState)(null);
			const [expanded, setExpanded] = (0, react.useState)(true);
			const [noteDraft, setNoteDraft] = (0, react.useState)({});
			const [noteBusy, setNoteBusy] = (0, react.useState)(null);
			const [noteSaved, setNoteSaved] = (0, react.useState)(null);
			const noteTimers = (0, react.useRef)({});
			const [copied, setCopied] = (0, react.useState)(null);
			const [submitDraft, setSubmitDraft] = (0, react.useState)("");
			const [submitBusy, setSubmitBusy] = (0, react.useState)(false);
			const [jobId, setJobId] = (0, react.useState)(null);
			const [job, setJob] = (0, react.useState)(null);
			const [submitMsg, setSubmitMsg] = (0, react.useState)(null);
			const applyPool = (0, react.useCallback)((next) => {
				setPool(next);
			}, []);
			/** 读池子 + 当日 active（池子是本地；stats 会打一次 BRAIN，但吃引擎 5min 缓存）。 */
			const load = (0, react.useCallback)(async (opts = {}) => {
				setLoading(true);
				setError(null);
				try {
					const r = await getAlphaPool();
					setEngineMissing(false);
					applyPool(r);
				} catch (cause) {
					if (isMissingEndpoint(cause)) {
						setEngineMissing(true);
						setError(null);
					} else setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setLoading(false);
				}
				if (opts.withStats !== false) try {
					setStats(await getActiveStats());
				} catch {}
			}, [applyPool]);
			(0, react.useEffect)(() => {
				if (!visible) return;
				load();
			}, [visible, load]);
			(0, react.useEffect)(() => {
				if (!visible) return;
				const timer = window.setInterval(() => {
					getActiveStats().then(setStats).catch(() => {});
				}, 12e4);
				return () => window.clearInterval(timer);
			}, [visible]);
			(0, react.useEffect)(() => {
				if (jobId === null) return;
				let stop = false;
				const tick = async () => {
					try {
						const j = await getSubmitJob(jobId);
						if (stop) return;
						setJob(j);
						if (j.running !== true) {
							setJobId(null);
							await load();
							return;
						}
					} catch (cause) {
						if (!stop) setError(cause instanceof Error ? cause.message : String(cause));
						return;
					}
					if (!stop) window.setTimeout(() => {
						tick();
					}, SUBMIT_POLL_MS);
				};
				tick();
				return () => {
					stop = true;
				};
			}, [jobId, load]);
			/** 加：支持一次粘一坨 id。 */
			const doAdd = (0, react.useCallback)(async () => {
				const raw = draft.trim();
				if (raw === "") return;
				setMutating(true);
				setError(null);
				setNotice(null);
				try {
					applyPool(await mutateAlphaPool("add", raw));
					setDraft("");
					setEngineMissing(false);
					(async () => {
						try {
							const synced = await syncAlphaPool();
							applyPool(synced);
							setNotice(syncNotice(synced));
						} catch {
							setNotice("已加入；BRAIN 数据未拉到，可点「同步」重试");
						}
					})();
				} catch (cause) {
					if (isMissingEndpoint(cause)) setEngineMissing(true);
					else setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setMutating(false);
				}
			}, [draft, applyPool]);
			/** 删单条 / 清空。 */
			const doMutate = (0, react.useCallback)(async (action, alphaId) => {
				if (action === "clear" && !window.confirm("清空整个自选池？（只删本地名单，不动 BRAIN 上的 alpha）")) return;
				setMutating(true);
				setError(null);
				try {
					applyPool(await mutateAlphaPool(action, alphaId));
					setNotice(action === "clear" ? "已清空自选池" : `已移除 ${alphaId ?? ""}`);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setMutating(false);
				}
			}, [applyPool]);
			/** 同步：整池（ids 为空 = 全刷）或单条。 */
			const doSync = (0, react.useCallback)(async (ids) => {
				setSyncing(true);
				setError(null);
				setNotice(null);
				try {
					const r = await syncAlphaPool(ids);
					applyPool(r);
					setNotice(syncNotice(r));
					setEngineMissing(false);
				} catch (cause) {
					if (isMissingEndpoint(cause)) setEngineMissing(true);
					else setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setSyncing(false);
					getActiveStats().then(setStats).catch(() => {});
				}
			}, [applyPool]);
			/** 保存备注（1s 防抖 + 回车/失焦都会走到这里）。 */
			const saveNote = (0, react.useCallback)(async (alphaId, value) => {
				setNoteBusy(alphaId);
				try {
					applyPool(await setAlphaPoolNote(alphaId, value));
					setNoteDraft((d) => {
						if (d[alphaId] !== value) return d;
						const next = { ...d };
						delete next[alphaId];
						return next;
					});
					setNoteSaved(alphaId);
					window.setTimeout(() => {
						setNoteSaved((cur) => cur === alphaId ? null : cur);
					}, 1500);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setNoteBusy(null);
				}
			}, [applyPool]);
			const onChangeNote = (0, react.useCallback)((alphaId, value) => {
				setNoteDraft((d) => ({
					...d,
					[alphaId]: value
				}));
				const timer = noteTimers.current[alphaId];
				if (timer !== void 0) window.clearTimeout(timer);
				noteTimers.current[alphaId] = window.setTimeout(() => {
					saveNote(alphaId, value);
				}, 1e3);
			}, [saveNote]);
			/** 复制 alpha_id。 */
			const doCopy = (0, react.useCallback)(async (alphaId) => {
				if (await copyText(alphaId)) {
					setCopied(alphaId);
					window.setTimeout(() => setCopied((cur) => cur === alphaId ? null : cur), 1200);
				} else setError(`复制失败（浏览器拒绝），请手动选中 ${alphaId}`);
			}, []);
			/**
			* 提交：先拉 check 列出 FAIL，确认后才真提交（两道闸）。
			*   1) 通用确认：不可逆 + 占额度
			*   2) 若有 FAIL：额外一次确认，把 FAIL 项摊开（默认拦住，但仍可强制提）
			*/
			const doSubmit = (0, react.useCallback)(async () => {
				const ids = parseIds(submitDraft);
				if (ids.length === 0) {
					setError("没有解析出合法 alpha_id（4-16 位字母数字）");
					return;
				}
				if (ids.length > SUBMIT_MAX_IDS) {
					setError(`一次最多提交 ${SUBMIT_MAX_IDS} 个（提交不可逆，防手滑）；这次给了 ${ids.length} 个`);
					return;
				}
				setSubmitBusy(true);
				setError(null);
				setSubmitMsg("正在拉取 check（提交前预检）…");
				try {
					const lines = [];
					let failCount = 0;
					for (const id of ids) try {
						const fails = failNames(await getAlphaCheck(id));
						if (fails.length > 0) {
							failCount++;
							lines.push(`  ${id}  ✗ ${fails.join(", ")}`);
						} else lines.push(`  ${id}  ✓ 预检未见 FAIL`);
					} catch (cause) {
						lines.push(`  ${id}  ? 拿不到 check：${cause instanceof Error ? cause.message : String(cause)}`);
					}
					setSubmitMsg(null);
					const head = `真的要提交这 ${ids.length} 个 alpha 到 BRAIN 平台吗？\n\n⚠️ 不可逆：会占用提交额度，并写进账号的 ACTIVE 组合。
提交后平台要算几十分钟到几小时，期间可以离开页面。
`;
					if (!window.confirm(`${head}\n提交前预检：\n${lines.join("\n")}`)) {
						setSubmitMsg("已取消提交");
						return;
					}
					if (failCount > 0) {
						const warn = `⚠️ 其中 ${failCount} 条有 FAIL 项（平台多半会直接拒绝，白耗额度）：\n\n${lines.filter((l) => l.includes("✗")).join("\n")}\n\n确定还要提交吗？`;
						if (!window.confirm(warn)) {
							setSubmitMsg("已取消提交（有 FAIL 项）");
							return;
						}
					}
					const started = await submitAlphas(ids);
					if (started.job_id === void 0) throw new Error(started.error ?? "引擎没有返回 job_id");
					setJobId(started.job_id);
					setJob(null);
					setSubmitMsg(`已交给引擎提交（任务 ${started.job_id}）` + ((started.auto_added?.length ?? 0) > 0 ? `；${started.auto_added?.length} 个新 id 已自动加入自选池便于追踪` : ""));
					setSubmitDraft("");
					await load({ withStats: false });
				} catch (cause) {
					if (isMissingEndpoint(cause)) setEngineMissing(true);
					else setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setSubmitBusy(false);
				}
			}, [submitDraft, load]);
			/** 续查：只轮询，不再 POST（避免重复提交撞 400 / 白占额度）。 */
			const doContinuePoll = (0, react.useCallback)(async () => {
				const ids = parseIds(submitDraft);
				if (ids.length === 0) {
					setError("先把要续查的 alpha_id 粘到提交框里");
					return;
				}
				setSubmitBusy(true);
				setError(null);
				try {
					const started = await submitAlphas(ids, { pollOnly: true });
					if (started.job_id === void 0) throw new Error(started.error ?? "引擎没有返回 job_id");
					setJobId(started.job_id);
					setJob(null);
					setSubmitMsg(`已开始续查（任务 ${started.job_id}）：只查结果，不会重复提交`);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setSubmitBusy(false);
				}
			}, [submitDraft]);
			const items = pool?.items ?? [];
			const poolActive = (0, react.useMemo)(() => items.filter((it) => String(it.status ?? "").toLowerCase() === "active").length, [items]);
			if (engineMissing) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: QianxunTab_module_css_default.card,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: QianxunTab_module_css_default.cardHead,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: QianxunTab_module_css_default.cardIcon,
						children: "⭐"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: QianxunTab_module_css_default.cardTitle,
						children: "Alpha 自选池"
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: `${QianxunTab_module_css_default.msg} ${QianxunTab_module_css_default.msgErr}`,
					children: [
						"引擎还没有自选池接口（",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "/api/alpha-pool" }),
						" 返回 404）。 重启一次引擎即可生效：",
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("br", {}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "launchctl kickstart -k gui/$(id -u)/com.qianxund" })
					]
				})]
			});
			const jobItemList = job?.items ?? {};
			const jobRunning = jobId !== null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: QianxunTab_module_css_default.card,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: QianxunTab_module_css_default.cardHead,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: QianxunTab_module_css_default.iconBtn,
							onClick: () => setExpanded((e) => !e),
							"aria-expanded": expanded,
							title: expanded ? "收起" : "展开",
							children: expanded ? "▾" : "▸"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: QianxunTab_module_css_default.cardIcon,
							children: "⭐"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: QianxunTab_module_css_default.cardTitle,
							title: `池内 ${poolActive} 条 active / 共 ${items.length} 条`,
							children: [
								"Alpha 自选池（",
								pool?.count ?? 0,
								"）"
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: QianxunTab_module_css_default.spacer }),
						stats !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: stats.stale === true ? QianxunTab_module_css_default.dailyBadgeStale : QianxunTab_module_css_default.dailyBadge,
							title: "当日新增 = 当前 ACTIVE 集合 − 上一次 " + String(stats.reset_hour ?? 12) + `:00 的基准线
基准线取自 ${stats.baseline_reset_at ?? "—"}（${stats.baseline_count ?? 0} 条）\n下次重置：${stats.next_reset_at ?? "—"}（本地时间）\n局限：基准线只在有人打开这个页面时滚动，长时间不看页面期间的进出无法回溯——宁可漏算不会多算` + (stats.stale === true ? "\n⚠️ 这次没拿到 ACTIVE 列表，显示的是上次观察值" : ""),
							children: [
								"📈 今日新增 active ",
								stats.daily_new ?? 0,
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: QianxunTab_module_css_default.dailyBadgeSub,
									children: ["· 账号共 ", stats.active_count ?? "—"]
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: QianxunTab_module_css_default.btnPrimary,
							disabled: syncing || loading || (pool?.count ?? 0) === 0,
							onClick: () => {
								doSync();
							},
							title: "重新拉取整池的指标、相关性与提交状态（BRAIN 限流时可能只刷到一部分，再点一次续刷）",
							children: syncing ? "🔄 同步中…" : "🔄 同步"
						})
					]
				}), expanded && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
						className: QianxunTab_module_css_default.poolAddRow,
						onSubmit: (e) => {
							e.preventDefault();
							doAdd();
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								className: QianxunTab_module_css_default.input,
								type: "text",
								value: draft,
								onChange: (e) => setDraft(e.target.value),
								placeholder: "粘 alpha_id（可一次多个，逗号 / 换行 / 空格分隔）",
								"aria-label": "添加 alpha_id 到自选池",
								spellCheck: false,
								autoComplete: "off"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "submit",
								className: QianxunTab_module_css_default.btnPrimary,
								disabled: mutating || draft.trim() === "",
								children: "＋ 添加"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: QianxunTab_module_css_default.btnGhost,
								disabled: mutating || (pool?.count ?? 0) === 0,
								onClick: () => {
									doMutate("clear");
								},
								title: "清空自选池（只删本地名单）",
								children: "清空"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: QianxunTab_module_css_default.poolMetaLine,
						"aria-live": "polite",
						children: [
							loading && "读取中…",
							!loading && pool !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: ["最后同步：", pool.synced_at !== null && pool.synced_at !== void 0 ? new Date(pool.synced_at).toLocaleString() : "从未"] }),
							notice !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: QianxunTab_module_css_default.poolNotice,
								children: [" · ", notice]
							})
						]
					}),
					error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: `${QianxunTab_module_css_default.msg} ${QianxunTab_module_css_default.msgErr}`,
						role: "alert",
						children: [
							error,
							" —— 检查引擎是否在跑：",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "curl -s localhost:8765/health" })
						]
					}),
					pool !== null && pool.count === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: QianxunTab_module_css_default.empty,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: QianxunTab_module_css_default.emptyIcon,
							children: "⭐"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "池子还是空的：把想盯的 alpha_id 粘到上面的输入框。" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: QianxunTab_module_css_default.emptySub,
							children: "存进去后点「同步」即可看到 sharpe / fitness / ret / turnover / margin / selfcorr / prodcorr 与 active 状态；备注可以直接在表格里写。"
						})] })]
					}),
					items.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: `${QianxunTab_module_css_default.tableWrap} ${QianxunTab_module_css_default.poolTable}`,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("table", {
							className: QianxunTab_module_css_default.table,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("thead", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									children: "状态"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									children: "region"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									children: "alpha_id"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									children: "sharpe"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									children: "fitness"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									children: "ret%"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									children: "to%"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									title: "以万分之一为单位（0.000783 → 7.83）",
									children: "margin"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									children: "selfcorr"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									children: "prodcorr"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									children: "备注"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("th", {
									scope: "col",
									"aria-label": "操作"
								})
							] }) }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("tbody", { children: items.map((it) => {
								const meta = statusMeta(it.status);
								const sm = submitMeta(it.submit?.state);
								const m = it.metrics ?? {};
								const errs = it.errors ?? [];
								const noteValue = noteDraft[it.alpha_id] ?? it.note ?? "";
								return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("tr", { children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
										className: QianxunTab_module_css_default.cellStatus,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: `${QianxunTab_module_css_default.badge} ${QianxunTab_module_css_default[meta.cls] ?? ""}`,
												title: meta.hint,
												children: meta.label
											}),
											sm !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: `${QianxunTab_module_css_default.submitMarkBadge} ${QianxunTab_module_css_default[sm.cls] ?? ""}`,
												title: [
													it.submit?.error ?? "",
													(it.submit?.fails?.length ?? 0) > 0 ? `FAIL: ${it.submit?.fails?.join(", ")}` : "",
													it.submit?.at !== null && it.submit?.at !== void 0 ? `at ${it.submit.at}` : ""
												].filter(Boolean).join("\n"),
												children: sm.label
											}),
											errs.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: QianxunTab_module_css_default.poolErrDot,
												title: errs.join("\n"),
												children: "⚠️"
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										className: QianxunTab_module_css_default.cellStatus,
										children: it.region ?? "—"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
										className: QianxunTab_module_css_default.cellAlpha,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: QianxunTab_module_css_default.poolIdBtn,
											onClick: () => onInspect?.(it.alpha_id),
											title: onInspect !== void 0 ? "看 BRAIN 详细 checks" : it.alpha_id,
											children: it.alpha_id
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: QianxunTab_module_css_default.copyBtn,
											onClick: () => {
												doCopy(it.alpha_id);
											},
											title: `复制 ${it.alpha_id}`,
											"aria-label": `复制 ${it.alpha_id}`,
											children: copied === it.alpha_id ? "✓" : "⧉"
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										className: QianxunTab_module_css_default.cellNum,
										children: fmt(m.sharpe)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										className: QianxunTab_module_css_default.cellNum,
										children: fmt(m.fitness)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										className: QianxunTab_module_css_default.cellNum,
										children: fmt(m.returns, true)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										className: QianxunTab_module_css_default.cellNum,
										children: fmt(m.turnover, true)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										className: QianxunTab_module_css_default.cellNum,
										title: `margin = ${m.margin ?? "—"}`,
										children: fmtWan(m.margin)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										className: QianxunTab_module_css_default.cellNum,
										children: corrCell(it.self_corr, it.self_corr_result)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("td", {
										className: QianxunTab_module_css_default.cellNum,
										children: corrCell(it.prod_corr, it.prod_corr_result)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
										className: QianxunTab_module_css_default.cellNote,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												className: QianxunTab_module_css_default.noteInput,
												type: "text",
												value: noteValue,
												onChange: (e) => onChangeNote(it.alpha_id, e.target.value),
												onBlur: (e) => {
													saveNote(it.alpha_id, e.target.value);
												},
												onKeyDown: (e) => {
													if (e.key === "Enter") e.target.blur();
												},
												placeholder: "写点备注…",
												"aria-label": `${it.alpha_id} 的备注`,
												maxLength: 500,
												spellCheck: false
											}),
											noteBusy === it.alpha_id && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: QianxunTab_module_css_default.noteHint,
												children: "…"
											}),
											noteSaved === it.alpha_id && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: QianxunTab_module_css_default.noteHintOk,
												children: "✓"
											})
										]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("td", {
										className: QianxunTab_module_css_default.cellAction,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: QianxunTab_module_css_default.iconBtn,
											disabled: syncing,
											onClick: () => {
												doSync([it.alpha_id]);
											},
											title: "只刷新这一条",
											"aria-label": `刷新 ${it.alpha_id}`,
											children: "⟳"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											className: QianxunTab_module_css_default.iconBtn,
											disabled: mutating,
											onClick: () => {
												doMutate("remove", it.alpha_id);
											},
											title: "从自选池移除",
											"aria-label": `移除 ${it.alpha_id}`,
											children: "✕"
										})]
									})
								] }, it.alpha_id);
							}) })]
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: QianxunTab_module_css_default.submitBox,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: QianxunTab_module_css_default.submitHead,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: QianxunTab_module_css_default.submitTitle,
									children: "⚡ 提交到平台"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: QianxunTab_module_css_default.submitWarnText,
									children: [
										"不可逆 · 占提交额度 · 写进账号 ACTIVE 组合 · 单次 ≤ ",
										SUBMIT_MAX_IDS,
										" 个"
									]
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("form", {
								className: QianxunTab_module_css_default.submitRow,
								onSubmit: (e) => {
									e.preventDefault();
									doSubmit();
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										className: QianxunTab_module_css_default.input,
										type: "text",
										value: submitDraft,
										onChange: (e) => setSubmitDraft(e.target.value),
										placeholder: "粘要提交的 alpha_id（点提交后先拉 check 给你过目）",
										"aria-label": "要提交到平台的 alpha_id",
										spellCheck: false,
										autoComplete: "off",
										disabled: submitBusy || jobRunning
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "submit",
										className: QianxunTab_module_css_default.submitBtn,
										disabled: submitBusy || jobRunning || submitDraft.trim() === "",
										children: submitBusy ? "预检中…" : "⚡ 提交"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: QianxunTab_module_css_default.btnGhost,
										disabled: submitBusy || jobRunning || submitDraft.trim() === "",
										onClick: () => {
											doContinuePoll();
										},
										title: "平台上一次没算完时，只查结果、不再重复提交",
										children: "续查"
									})
								]
							}),
							submitMsg !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: QianxunTab_module_css_default.submitMsg,
								children: submitMsg
							}),
							job !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: QianxunTab_module_css_default.submitProgress,
								"aria-live": "polite",
								children: [jobRunning ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: QianxunTab_module_css_default.submitSpinner,
									children: [
										"⏳ 任务 ",
										job.job_id,
										" 进行中…"
									]
								}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
									"任务 ",
									job.job_id,
									" 已结束"
								] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: QianxunTab_module_css_default.submitJobList,
									children: Object.entries(jobItemList).map(([id, it]) => {
										const meta = submitMeta(it.state);
										return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
											className: QianxunTab_module_css_default.submitJobRow,
											children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: QianxunTab_module_css_default.submitJobId,
													children: id
												}),
												meta !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: `${QianxunTab_module_css_default.submitJobBadge} ${QianxunTab_module_css_default[meta.cls] ?? ""}`,
													children: meta.label
												}),
												it.error !== null && it.error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: QianxunTab_module_css_default.submitJobErr,
													title: it.error,
													children: it.error
												}),
												(it.fails?.length ?? 0) > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: QianxunTab_module_css_default.submitJobFails,
													title: "平台给出的 FAIL 项",
													children: it.fails?.join(", ")
												})
											]
										}, id);
									})
								})]
							})
						]
					})
				] })]
			});
		}
		/** 同步结果 → 一行人话。 */
		function syncNotice(r) {
			const parts = [];
			if (r.message !== void 0) parts.push(r.message);
			else parts.push(`已刷新 ${r.refreshed ?? 0}/${r.count} 条`);
			if (r.partial === true) parts.push(`仍有 ${r.remaining?.length ?? 0} 条没刷到，可再点一次「同步」续刷`);
			if (r.active_ok === false) parts.push("（这次没拿到 ACTIVE 列表，状态按每个 alpha 自己的 BRAIN 状态判定）");
			return parts.join("；");
		}
		//#endregion
		//#region src/client/QianxunDetailTab.tsx
		/**
		* 千寻批次详情 tab —— 展示某一批次的完整逐条回测结果。
		*
		* 由列表 tab（QianxunTab）通过 `ctx.betterSidebar.openTab({ type:'qianxun-detail',
		* title, meta:{ batchNo } })` 打开。`props.tab.meta.batchNo` 标识要展示的批次；
		* 无 batchNo 时显示“未指定批次”。5s 轮询（仅 visible 时）。
		*/
		/** 从 tab meta 读取要展示的批次号。 */
		function batchNoFromTab(props) {
			const raw = (props.tab?.meta)?.batchNo;
			return typeof raw === "string" && raw !== "" ? raw : void 0;
		}
		function QianxunDetailTab(props) {
			const { visible } = props;
			const batchNo = batchNoFromTab(props);
			const [detail, setDetail] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [loading, setLoading] = (0, react.useState)(false);
			const [busy, setBusy] = (0, react.useState)(false);
			const [jsonView, setJsonView] = (0, react.useState)(null);
			const [checkAlphaId, setCheckAlphaId] = (0, react.useState)(null);
			const [checks, setChecks] = (0, react.useState)(null);
			const [checkLoading, setCheckLoading] = (0, react.useState)(false);
			const [checkError, setCheckError] = (0, react.useState)(null);
			const [prodCorrAlphaId, setProdCorrAlphaId] = (0, react.useState)(null);
			const [prodCorr, setProdCorr] = (0, react.useState)(null);
			const [prodCorrLoading, setProdCorrLoading] = (0, react.useState)(false);
			const [prodCorrError, setProdCorrError] = (0, react.useState)(null);
			const [localAlphaId, setLocalAlphaId] = (0, react.useState)(null);
			const [localLoading, setLocalLoading] = (0, react.useState)(false);
			const [localError, setLocalError] = (0, react.useState)(null);
			const [localResult, setLocalResult] = (0, react.useState)(null);
			const [cacheStatus, setCacheStatus] = (0, react.useState)(null);
			const [activeAlphas, setActiveAlphas] = (0, react.useState)(null);
			const [backfill, setBackfill] = (0, react.useState)(null);
			const [backfillJobId, setBackfillJobId] = (0, react.useState)(null);
			const refreshCacheStatus = (0, react.useCallback)(async () => {
				try {
					const [s, a] = await Promise.all([getPnlCacheStatus(), getActiveAlphas()]);
					setCacheStatus(s);
					setActiveAlphas(a);
				} catch {}
			}, []);
			(0, react.useEffect)(() => {
				if (!visible) return;
				refreshCacheStatus();
				const timer = window.setInterval(() => {
					refreshCacheStatus();
				}, 6e4);
				return () => window.clearInterval(timer);
			}, [visible, refreshCacheStatus]);
			/** 启动回填任务：异步，不阻塞 UI。完成后自动刷新缓存状态。 */
			const doStartBackfill = (0, react.useCallback)(async () => {
				try {
					const start = await startBackfillPnls({});
					setBackfillJobId(start.job_id);
					setBackfill({
						status: "running",
						total: start.total,
						done: 0,
						errors: [],
						region: null
					});
				} catch (cause) {}
			}, []);
			(0, react.useEffect)(() => {
				if (backfillJobId === null) return;
				if (backfill === null || backfill.status === "running") {
					const timer = window.setInterval(async () => {
						try {
							const s = await getBackfillStatus(backfillJobId);
							setBackfill(s);
							if (s.status !== "running") {
								refreshCacheStatus();
								setTimeout(() => setBackfillJobId(null), 2e3);
							}
						} catch {}
					}, 2e3);
					return () => window.clearInterval(timer);
				}
			}, [
				backfillJobId,
				backfill?.status,
				refreshCacheStatus
			]);
			const load = (0, react.useCallback)(async () => {
				if (batchNo === void 0) return;
				setLoading(true);
				setError(null);
				try {
					setDetail(await getBatchResult(batchNo));
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setLoading(false);
				}
			}, [batchNo]);
			(0, react.useEffect)(() => {
				if (!visible || batchNo === void 0) return;
				load();
				const timer = window.setInterval(() => {
					load();
				}, 5e3);
				return () => window.clearInterval(timer);
			}, [
				visible,
				batchNo,
				load
			]);
			const prevVisible = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				if (visible && prevVisible.current === false) load();
				prevVisible.current = visible;
			}, [visible, load]);
			const runAction = (0, react.useCallback)(async (action) => {
				if (batchNo === void 0) return;
				setBusy(true);
				try {
					await action();
					await load();
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setBusy(false);
				}
			}, [batchNo, load]);
			const onAct = (action) => () => runAction(() => actOnBatch(batchNo, action));
			const onResumeBack = () => () => runAction(() => resumeBatch(batchNo));
			const doViewResult = async () => {
				if (batchNo === void 0) return;
				try {
					const d = await getBatchResult(batchNo);
					setJsonView(JSON.stringify(d, null, 2));
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			};
			/** 触发单 alpha 的 BRAIN check 拉取。*/
			const doCheckAlpha = (0, react.useCallback)(async (alphaId) => {
				setCheckAlphaId(alphaId);
				setCheckLoading(true);
				setCheckError(null);
				setChecks(null);
				try {
					setChecks((await getAlphaCheck(alphaId)).is?.checks ?? []);
				} catch (cause) {
					setCheckError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setCheckLoading(false);
				}
			}, []);
			const closeCheckPanel = (0, react.useCallback)(() => {
				setCheckAlphaId(null);
				setChecks(null);
				setCheckError(null);
				setCheckLoading(false);
			}, []);
			/** 拉单 alpha 的 prod correlation 数值（不死等 check）。 */
			const doFetchProdCorr = (0, react.useCallback)(async (alphaId) => {
				setProdCorrAlphaId(alphaId);
				setProdCorrLoading(true);
				setProdCorrError(null);
				setProdCorr(null);
				try {
					setProdCorr(await getAlphaProdCorr(alphaId));
				} catch (cause) {
					setProdCorrError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setProdCorrLoading(false);
				}
			}, []);
			const closeProdCorrPanel = (0, react.useCallback)(() => {
				setProdCorrAlphaId(null);
				setProdCorr(null);
				setProdCorrError(null);
				setProdCorrLoading(false);
			}, []);
			/** 本地核对 SELF_CORRELATION：与本地 PnL 缓存 ∩ ACTIVE 比（与 BRAIN 真实口径对齐）。
			* 候选集 = `cache ∩ ACTIVE - {self}`：
			* - cache = 已下载 PnL 的所有 alpha（包含已退出 active 的）
			* - ACTIVE = BRAIN 当前活跃组合（与 SELF_CORRELATION 同口径）
			* - 交集 = BRAIN 实际对比的子集
			* 首次访问会触发 qianxund 写缓存；二次秒出。 */
			const doLocalSelfCorr = (0, react.useCallback)(async (targetAlphaId) => {
				setLocalAlphaId(targetAlphaId);
				setLocalLoading(true);
				setLocalError(null);
				setLocalResult(null);
				try {
					let active = activeAlphas;
					if (active === null) {
						active = await getActiveAlphas();
						setActiveAlphas(active);
					}
					const activeSet = new Set(active.ids);
					const targetResp = await getCachedPnl(targetAlphaId);
					const cache = await getPnlCacheStatus();
					const otherIds = cache.items.map((it) => it.alpha_id).filter((aid) => aid !== targetAlphaId && activeSet.has(aid));
					if (otherIds.length === 0) {
						const activeCachedCount = cache.items.filter((it) => activeSet.has(it.alpha_id)).length;
						setLocalError(activeCachedCount === 0 ? "本地 PnL 缓存里没有任何 ACTIVE 的 alpha——需要先把 ACTIVE alpha 的 PnL 缓存到本地" : "除自己外，缓存里没有可对比的 ACTIVE alpha");
						return;
					}
					const validCands = (await Promise.all(otherIds.map(async (aid) => {
						try {
							return {
								alphaId: aid,
								records: (await getCachedPnl(aid)).records
							};
						} catch {
							return {
								alphaId: aid,
								records: []
							};
						}
					}))).filter((c) => c.records.length > 0);
					if (validCands.length === 0) {
						setLocalError("候选 PnL 全部为空，无法计算");
						return;
					}
					setLocalResult(computeLocalSelfCorr(targetResp.records, validCands));
					refreshCacheStatus();
				} catch (cause) {
					setLocalError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setLocalLoading(false);
				}
			}, [activeAlphas, refreshCacheStatus]);
			const closeLocalPanel = (0, react.useCallback)(() => {
				setLocalAlphaId(null);
				setLocalResult(null);
				setLocalError(null);
				setLocalLoading(false);
			}, []);
			const doDownloadResult = async () => {
				if (batchNo === void 0) return;
				try {
					const d = await getBatchResult(batchNo);
					const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
					const url = URL.createObjectURL(blob);
					const a = document.createElement("a");
					a.href = url;
					a.download = `${batchNo}-result.json`;
					a.click();
					URL.revokeObjectURL(url);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				}
			};
			if (batchNo === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: QianxunTab_module_css_default.root,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
					className: QianxunTab_module_css_default.header,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: QianxunTab_module_css_default.titleIcon,
							children: "🔎"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: QianxunTab_module_css_default.title,
							children: "千寻结果"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: QianxunTab_module_css_default.spacer }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: QianxunTab_module_css_default.iconBtn,
							onClick: () => {
								refreshCacheStatus();
							},
							title: "刷新",
							"aria-label": "刷新",
							children: "⟳"
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: QianxunTab_module_css_default.body,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AlphaPoolCard, { visible }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: QianxunTab_module_css_default.emptySub,
							children: "想看某个批次的逐条结果：回「千寻回测」列表，点该批次的「详情」按钮。"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: QianxunTab_module_css_default.statusFooter,
							children: ["引擎 ", QIANXUN_BASE]
						})
					]
				})]
			});
			const running = detail !== null && isRunning(detail.state);
			const done = Math.min(detail?.done ?? 0, detail?.total ?? detail?.done ?? 0);
			const total = detail?.total ?? 0;
			const pct = total > 0 ? Math.round(done / total * 100) : detail ? 100 : 0;
			/** 稳健性快评卡：基于已加载的逐条结果（无需新 API）。
			* 检查项：
			*  1. IS_LADDER_SHARPE 风险（避免给必败 alpha 浪费 check）
			*  2. prod_fresh 字段加分（薄 margin 但字段新 → 仍可推）
			*  3. 雷区字段告警（prod_corr >= 0.70 概率大）
			*/
			const renderRobustnessCard = () => {
				const results = detail?.results ?? [];
				if (results.length === 0) return null;
				const issues = [];
				const freshHits = [];
				for (const r of results) {
					const ladder = r.metrics?.sharpe;
					if (classifyLadderRisk(typeof ladder === "number" ? ladder : null) === "certain_fail") issues.push({
						alphaIdx: r.idx,
						tag: "certain_fail",
						msg: `idx ${r.idx} LADDER 必败 (sharpe=${ladder})`
					});
					const fresh = isProdFreshField(r.expression ?? null);
					if (fresh.hit && fresh.field !== void 0) freshHits.push({
						alphaIdx: r.idx,
						field: fresh.field
					});
					const dead = isDeadZoneField(r.expression ?? null);
					if (dead.hit && dead.field !== void 0) issues.push({
						alphaIdx: r.idx,
						tag: "dead_zone",
						msg: `idx ${r.idx} 字段 ${dead.field}${dead.note !== void 0 ? " · " + dead.note : ""}`
					});
				}
				const hasIssues = issues.length > 0;
				const hasFresh = freshHits.length > 0;
				if (!hasIssues && !hasFresh) return null;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: QianxunTab_module_css_default.card,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: QianxunTab_module_css_default.cardHead,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: QianxunTab_module_css_default.cardIcon,
								children: "🛡️"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: QianxunTab_module_css_default.cardTitle,
								children: [
									"稳健性快评（",
									results.length,
									" 条）"
								]
							})]
						}),
						hasIssues && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: QianxunTab_module_css_default.issueList,
							children: issues.map((it, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: `${QianxunTab_module_css_default.issueRow} ${it.tag === "certain_fail" ? QianxunTab_module_css_default.issueDanger : QianxunTab_module_css_default.issueWarn}`,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: QianxunTab_module_css_default.issueTag,
									children: it.tag === "certain_fail" ? "必败" : "雷区"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: QianxunTab_module_css_default.issueMsg,
									children: it.msg
								})]
							}, i))
						}),
						hasFresh && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: QianxunTab_module_css_default.freshList,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: QianxunTab_module_css_default.metaLine,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: QianxunTab_module_css_default.freshTag,
										children: "prod-fresh"
									}),
									freshHits.length,
									" 条字段新（prod 信号未饱和）："
								]
							}), freshHits.map((f, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: QianxunTab_module_css_default.freshRow,
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
									className: QianxunTab_module_css_default.freshField,
									children: f.field
								})
							}, i))]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: QianxunTab_module_css_default.metaLine,
							children: [
								"点击下方任一 alpha 行的 🔍 看 BRAIN 详细 checks；点击 📈 看真 prod_corr； 点击 📐 ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("b", { children: "本地" }),
								"立即算 SELF_CORRELATION（无须等 BRAIN PENDING）。"
							]
						})
					]
				});
			};
			/** 单 alpha 的 PROD_CORRELATION 拉取面板。 */
			const renderProdCorrPanel = () => {
				if (prodCorrAlphaId === null) return null;
				const max = prodCorr?.max ?? null;
				const min = prodCorr?.min ?? null;
				const deadZone = max !== null && max >= .7;
				const tier = max !== null ? classifyMargin(max) : null;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: QianxunTab_module_css_default.card,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: QianxunTab_module_css_default.cardHead,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: QianxunTab_module_css_default.cardIcon,
									children: "📈"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: QianxunTab_module_css_default.cardTitle,
									children: ["prod correlation · ", prodCorrAlphaId]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: QianxunTab_module_css_default.spacer }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: QianxunTab_module_css_default.iconBtn,
									onClick: closeProdCorrPanel,
									title: "关闭",
									"aria-label": "关闭 prod corr 面板",
									children: "✕"
								})
							]
						}),
						prodCorrLoading && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: QianxunTab_module_css_default.metaLine,
							children: "拉取中…（BRAIN 首次常空，引擎已自动重试 3 次）"
						}),
						prodCorrError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: `${QianxunTab_module_css_default.msg} ${QianxunTab_module_css_default.msgErr}`,
							children: prodCorrError
						}),
						prodCorr !== null && !prodCorrLoading && prodCorrError === null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: QianxunTab_module_css_default.prodCorrRow,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: QianxunTab_module_css_default.prodCorrLabel,
										children: "max"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: `${QianxunTab_module_css_default.prodCorrValue} ${deadZone ? QianxunTab_module_css_default.valNeg : QianxunTab_module_css_default.valPos}`,
										children: max === null ? "—" : max.toFixed(4)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: QianxunTab_module_css_default.prodCorrLabel,
										children: "min"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: QianxunTab_module_css_default.prodCorrValue,
										children: min === null ? "—" : min.toFixed(4)
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: QianxunTab_module_css_default.spacer }),
									tier !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: `${QianxunTab_module_css_default.tierBadge} ${QianxunTab_module_css_default[`tier_${tier.label}`] ?? ""}`,
										children: [
											tier.label,
											" · margin ",
											tier.margin.toFixed(4)
										]
									})
								]
							}),
							deadZone && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: `${QianxunTab_module_css_default.msg} ${QianxunTab_module_css_default.msgErr}`,
								children: [
									"⚠️ max prod_corr ≥ ",
									.7,
									" 死区线，此 alpha 大概率 submission FAIL"
								]
							}),
							!deadZone && max !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: `${QianxunTab_module_css_default.msg} ${QianxunTab_module_css_default.msgOk}`,
								children: [
									"✓ 安全边际 ",
									tier?.margin.toFixed(4) ?? "?",
									"（死区线 ",
									.7,
									"）"
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: QianxunTab_module_css_default.metaLine,
								children: [
									"候选集：",
									prodCorr.records.length,
									" 条"
								]
							})
						] })
					]
				});
			};
			/** 单 alpha 的本地 SELF_CORRELATION 核对面板。 */
			const renderLocalPanel = () => {
				if (localAlphaId === null) return null;
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: QianxunTab_module_css_default.card,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: QianxunTab_module_css_default.cardHead,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: QianxunTab_module_css_default.cardIcon,
									children: "📐"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: QianxunTab_module_css_default.cardTitle,
									children: ["本地 SELF_CORRELATION · ", localAlphaId]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: QianxunTab_module_css_default.spacer }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									className: QianxunTab_module_css_default.iconBtn,
									onClick: closeLocalPanel,
									title: "关闭",
									"aria-label": "关闭本地核对面板",
									children: "✕"
								})
							]
						}),
						localLoading && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: QianxunTab_module_css_default.metaLine,
							children: "下载 PnL 并算 Pearson…（每多 1 个候选 +1 次请求；通常 ~3s/批）"
						}),
						localError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							className: `${QianxunTab_module_css_default.msg} ${QianxunTab_module_css_default.msgErr}`,
							children: localError
						}),
						localResult !== null && !localLoading && localError === null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: QianxunTab_module_css_default.prodCorrRow,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: QianxunTab_module_css_default.prodCorrLabel,
										children: "候选数"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: QianxunTab_module_css_default.prodCorrValue,
										children: localResult.perCandidate.length
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: QianxunTab_module_css_default.prodCorrLabel,
										children: "target 日数"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: QianxunTab_module_css_default.prodCorrValue,
										children: localResult.targetDays
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: QianxunTab_module_css_default.spacer }),
									localResult.max !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: `${QianxunTab_module_css_default.tierBadge} ${localResult.max >= .7 ? QianxunTab_module_css_default.tier_tight : ""}`,
										children: ["max = ", localResult.max.toFixed(4)]
									})
								]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: QianxunTab_module_css_default.checksList,
								children: localResult.perCandidate.map((c, i) => {
									const v = c.corr;
									const isDead = v !== null && v !== void 0 && v >= .7;
									return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: QianxunTab_module_css_default.checkItem,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: QianxunTab_module_css_default.checkItemName,
												title: c.alphaId,
												children: [c.alphaId.slice(0, 14), c.alphaId.length > 14 ? "…" : ""]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: QianxunTab_module_css_default.checkItemMeta,
												children: [c.overlapDays, "d 对齐"]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: QianxunTab_module_css_default.checkItemResult,
												children: v === null || v === void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: QianxunTab_module_css_default.bNone,
													children: "n/a"
												}) : isDead ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: QianxunTab_module_css_default.bFail,
													children: v.toFixed(3)
												}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													className: QianxunTab_module_css_default.bPass,
													children: v.toFixed(3)
												})
											})
										]
									}, i);
								})
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: QianxunTab_module_css_default.metaLine,
								children: "BRAIN SELF_CORRELATION 还 PENDING 时本面板立即可读；PASS 后两者差异 ≤ 0.05 （本地 = raw daily PnL 增量 Pearson；BRAIN = 4-year rolling Pearson）。"
							})
						] })
					]
				});
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: QianxunTab_module_css_default.root,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
					className: QianxunTab_module_css_default.header,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: QianxunTab_module_css_default.titleIcon,
							children: "🔬"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: QianxunTab_module_css_default.title,
							children: [batchNo, " 结果"]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: QianxunTab_module_css_default.cacheBadge,
							title: cacheStatus === null ? "PnL 缓存加载中…" : `本地 PnL 缓存：${cacheStatus.cache_dir}\n· 共 ${cacheStatus.count} 个 alpha · ${(cacheStatus.total_bytes / 1024).toFixed(0)} KB\n` + (activeAlphas !== null ? `· 🟢 ACTIVE（与 BRAIN 同口径）${activeAlphas.count} 个\n· SELF_CORRELATION 对比基线 = 缓存 ∩ ACTIVE` : ""),
							children: [
								"📦 ",
								cacheStatus === null ? "缓存…" : `${cacheStatus.count} 个`,
								activeAlphas !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: QianxunTab_module_css_default.cacheBadgeActive,
									children: [
										"· 🟢 ",
										activeAlphas.count,
										" ACTIVE"
									]
								}),
								backfill !== null && backfill.status === "running" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: QianxunTab_module_css_default.cacheBadgeBackfill,
									children: [
										"· 🔄 ",
										backfill.done,
										"/",
										backfill.total
									]
								}),
								backfill !== null && backfill.status === "partial" && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									className: QianxunTab_module_css_default.cacheBadgePartial,
									title: "部分失败，可重试",
									children: [
										"· ⚠️ 部分 ",
										backfill.done,
										"/",
										backfill.total
									]
								}),
								backfill !== null && backfill.status === "captcha_blocked" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: QianxunTab_module_css_default.cacheBadgeCaptcha,
									title: backfill.stopped_reason ?? "BRAIN 触发人机验证",
									children: "· 🤖 captcha"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: QianxunTab_module_css_default.backfillBtn,
							onClick: () => {
								doStartBackfill();
							},
							disabled: backfill?.status === "running",
							title: backfill?.status === "running" ? `同步中：${backfill.done}/${backfill.total}` : "从 BRAIN 拉取当前 ACTIVE 列表里所有未缓存的 PnL 存到本地（多次点击可累积）",
							children: backfill?.status === "running" ? "🔄 同步中…" : "🔄 同步 ACTIVE"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: QianxunTab_module_css_default.spacer }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: `${QianxunTab_module_css_default.dot} ${isRunning(detail?.state) ? QianxunTab_module_css_default.dotRunning : detail?.state === "error" ? QianxunTab_module_css_default.dotError : QianxunTab_module_css_default.dotOk}` }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: QianxunTab_module_css_default.iconBtn,
							onClick: () => {
								load();
							},
							title: "刷新",
							"aria-label": "刷新",
							children: "⟳"
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: QianxunTab_module_css_default.body,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(AlphaPoolCard, {
							visible,
							onInspect: (alphaId) => {
								doCheckAlpha(alphaId);
							}
						}),
						error !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: QianxunTab_module_css_default.error,
							role: "alert",
							children: [error, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: QianxunTab_module_css_default.retryBtn,
								onClick: () => void load(),
								children: "重试"
							})]
						}),
						detail === null && error === null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: QianxunTab_module_css_default.empty,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: QianxunTab_module_css_default.emptyIcon,
								children: "⏳"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: loading ? "加载中…" : "等待加载…" })]
						}),
						detail !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: QianxunTab_module_css_default.summaryCard,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: QianxunTab_module_css_default.summaryRow,
									children: [
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: QianxunTab_module_css_default.batchId,
											children: batchNo
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: `${QianxunTab_module_css_default.badge} ${running ? QianxunTab_module_css_default.badgeRunning : detail.state === "error" ? QianxunTab_module_css_default.badgeError : QianxunTab_module_css_default.badgeDone}`,
											children: detail.state ?? "—"
										}),
										detail.name !== void 0 && detail.name !== null && detail.name !== "" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											className: QianxunTab_module_css_default.summaryName,
											children: detail.name
										}),
										/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: QianxunTab_module_css_default.spacer }),
										/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
											className: QianxunTab_module_css_default.summaryMeta,
											children: [
												"已测 ",
												done,
												"/",
												total
											]
										})
									]
								}), total > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: QianxunTab_module_css_default.progressTrack,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: `${QianxunTab_module_css_default.progressFill} ${running ? QianxunTab_module_css_default.progressRunning : detail.state === "error" ? QianxunTab_module_css_default.progressError : QianxunTab_module_css_default.progressDone}`,
										style: { width: `${pct}%` }
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: QianxunTab_module_css_default.progressText,
										children: [pct, "%"]
									})]
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: QianxunTab_module_css_default.toolbar,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: `${QianxunTab_module_css_default.iconBtn} ${QianxunTab_module_css_default.actionIco}`,
										disabled: busy || !running,
										onClick: onAct("pause"),
										title: "暂停批次",
										children: "⏸"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: `${QianxunTab_module_css_default.iconBtn} ${QianxunTab_module_css_default.actionIco}`,
										disabled: busy || !running,
										onClick: onAct("resume"),
										title: "恢复批次",
										children: "▶"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: `${QianxunTab_module_css_default.iconBtn} ${QianxunTab_module_css_default.actionIco} ${QianxunTab_module_css_default.actionDanger}`,
										disabled: busy,
										onClick: onAct("cancel"),
										title: "取消批次",
										children: "✕"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: `${QianxunTab_module_css_default.iconBtn} ${QianxunTab_module_css_default.actionIco}`,
										disabled: busy,
										onClick: onResumeBack(),
										title: "断点续跑",
										children: "↻"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: QianxunTab_module_css_default.spacer }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: QianxunTab_module_css_default.btnGhost,
										disabled: busy,
										onClick: () => void doViewResult(),
										title: "查看结果 JSON",
										children: "JSON"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: QianxunTab_module_css_default.btnGhost,
										disabled: busy,
										onClick: () => void doDownloadResult(),
										title: "下载结果 JSON",
										children: "⇩ 下载"
									})
								]
							}),
							jsonView !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: QianxunTab_module_css_default.card,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									className: QianxunTab_module_css_default.cardHead,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										className: QianxunTab_module_css_default.cardTitle,
										children: "结果 JSON"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										className: QianxunTab_module_css_default.iconBtn,
										onClick: () => setJsonView(null),
										title: "关闭",
										children: "✕"
									})]
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
									className: QianxunTab_module_css_default.pre,
									children: jsonView
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: QianxunTab_module_css_default.card,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
									className: QianxunTab_module_css_default.cardHead,
									children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
										className: QianxunTab_module_css_default.cardTitle,
										children: [
											"逐条结果（",
											detail.results?.length ?? 0,
											"）"
										]
									})
								}), renderMetricsTable(detail.results, {
									onCheck: (alphaId) => {
										doCheckAlpha(alphaId);
									},
									onProdCorr: (alphaId) => {
										doFetchProdCorr(alphaId);
									},
									onLocalSelf: (alphaId) => {
										doLocalSelfCorr(alphaId);
									}
								})]
							}),
							renderRobustnessCard(),
							renderProdCorrPanel(),
							renderLocalPanel(),
							checkAlphaId !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: QianxunTab_module_css_default.card,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: QianxunTab_module_css_default.cardHead,
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												className: QianxunTab_module_css_default.cardIcon,
												children: "🔍"
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												className: QianxunTab_module_css_default.cardTitle,
												children: ["BRAIN check · ", checkAlphaId]
											}),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: QianxunTab_module_css_default.spacer }),
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
												type: "button",
												className: QianxunTab_module_css_default.iconBtn,
												onClick: closeCheckPanel,
												title: "关闭",
												"aria-label": "关闭 check 面板",
												children: "✕"
											})
										]
									}),
									checkLoading && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: QianxunTab_module_css_default.metaLine,
										children: "加载中…"
									}),
									checkError !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										className: QianxunTab_module_css_default.msg + " " + QianxunTab_module_css_default.msgErr,
										children: checkError
									}),
									checks !== null && !checkLoading && checkError === null && renderChecksList(checks)
								]
							})
						] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: QianxunTab_module_css_default.statusFooter,
							children: ["引擎 ", QIANXUN_BASE]
						})
					]
				})]
			});
		}
		//#endregion
		//#region src/client/PromptEditTab.tsx
		/**
		* PromptEditTab — 提示词编辑 tab。
		* 由列表 tab（QianxunTab）点提示词名字 → openTab({type:'qianxun-prompt', meta:{promptId}})
		* 打开。内容存服务端（见 prompts.ts），text 实时可改，离开自动保存。
		*
		* 数据是异步到达的（页面刷新后恢复的 prompt tab 可能先于服务端加载完成），
		* 因此这里先同步取一次，取不到再等一次加载；一旦载入过就不再回填，
		* 以免覆盖正在编辑的内容。
		*/
		/** 从 tab meta 读提示词 id。 */
		function promptIdFromTab(props) {
			const raw = (props.tab?.meta)?.promptId;
			return typeof raw === "string" && raw !== "" ? raw : void 0;
		}
		function PromptEditTab(props) {
			const promptId = promptIdFromTab(props);
			const [prompt, setPrompt] = (0, react.useState)(null);
			const [name, setName] = (0, react.useState)("");
			const [content, setContent] = (0, react.useState)("");
			const [saved, setSaved] = (0, react.useState)(false);
			const [delBusy, setDelBusy] = (0, react.useState)(false);
			/** 已从存储载入过（载入后不再回填，避免覆盖编辑中的内容）。 */
			const loadedRef = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (promptId === void 0) return;
				loadedRef.current = false;
				setPrompt(null);
				const fill = () => {
					if (loadedRef.current) return;
					const p = getPrompt(promptId);
					if (!p) return;
					loadedRef.current = true;
					setPrompt(p);
					setName(p.name);
					setContent(p.content);
				};
				fill();
				const unsubscribe = subscribePrompts(fill);
				ensurePromptsLoaded().then(fill);
				return unsubscribe;
			}, [promptId]);
			(0, react.useEffect)(() => {
				if (prompt === null || promptId === void 0) return;
				if (name === prompt.name && content === prompt.content) return;
				const t = setTimeout(() => {
					const updated = updatePrompt(promptId, {
						name,
						content
					});
					if (updated) {
						setPrompt(updated);
						setSaved(true);
						setTimeout(() => setSaved(false), 1500);
					}
				}, 500);
				return () => clearTimeout(t);
			}, [
				name,
				content,
				prompt,
				promptId
			]);
			const onDelete = (0, react.useCallback)(() => {
				if (promptId === void 0 || delBusy) return;
				if (!window.confirm(`删除提示词「${name}」？此操作不可恢复。`)) return;
				setDelBusy(true);
				deletePrompt(promptId);
				props.ctx?.betterSidebar?.openTab({
					type: "qianxun",
					id: "qianxun",
					title: "千寻回测"
				});
				setDelBusy(false);
			}, [
				promptId,
				name,
				delBusy,
				props.ctx
			]);
			if (promptId === void 0) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: QianxunTab_module_css_default.root,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
					className: QianxunTab_module_css_default.header,
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: QianxunTab_module_css_default.titleIcon,
						children: "📋"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: QianxunTab_module_css_default.title,
						children: "提示词"
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: QianxunTab_module_css_default.body,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: QianxunTab_module_css_default.empty,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: QianxunTab_module_css_default.emptyIcon,
							children: "🗂️"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "未指定提示词：请从「千寻回测」列表点击某条提示词打开。" })]
					})
				})]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: QianxunTab_module_css_default.root,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
					className: QianxunTab_module_css_default.header,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: QianxunTab_module_css_default.titleIcon,
							children: "📋"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: QianxunTab_module_css_default.title,
							style: {
								flex: "1",
								minWidth: 0,
								overflow: "hidden",
								textOverflow: "ellipsis",
								whiteSpace: "nowrap"
							},
							children: prompt?.name ?? "提示词"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: QianxunTab_module_css_default.spacer }),
						saved && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: QianxunTab_module_css_default.promptSavedTag,
							children: "已保存"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: QianxunTab_module_css_default.iconBtn,
							onClick: () => {
								const p = getPrompt(promptId);
								if (p) navigator.clipboard.writeText(p.content);
							},
							title: "复制到剪贴板",
							children: "⧉"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: `${QianxunTab_module_css_default.iconBtn} ${QianxunTab_module_css_default.promptDelBtn}`,
							onClick: onDelete,
							disabled: delBusy,
							title: "删除此提示词",
							children: "🗑"
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
					className: QianxunTab_module_css_default.body,
					children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: QianxunTab_module_css_default.card,
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: QianxunTab_module_css_default.field,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: QianxunTab_module_css_default.fieldLabel,
									children: "名称"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									className: QianxunTab_module_css_default.input,
									value: name,
									placeholder: "提示词名字",
									onChange: (e) => setName(e.target.value)
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: QianxunTab_module_css_default.field,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: QianxunTab_module_css_default.fieldLabel,
									children: "内容（自动保存 · 最多 20000 字）"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
									className: `${QianxunTab_module_css_default.textarea} ${QianxunTab_module_css_default.promptTextarea}`,
									value: content,
									placeholder: "在这里粘贴/编辑提示词内容…",
									onChange: (e) => setContent(e.target.value)
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								className: QianxunTab_module_css_default.metaLine,
								children: [
									"更新于 ",
									prompt ? new Date(prompt.updated_at).toLocaleString() : "—",
									" · 修改后自动保存"
								]
							})
						]
					})
				})]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/**
		* 千寻回测 tab client-plugin 入口。
		*
		* 作为 dsh-better-sidebar 的自定义 tab 注册：通过 `inject: ['betterSidebar']` 声明
		* 依赖 better-sidebar 服务，在 `apply` 里调用 `ctx.betterSidebar.registerTab(...)`
		* 注册 id 为 `qianxun` 的 tab，其内容组件 QianxunTab 直连本地回测引擎 REST API。
		*/
		/** 需要 better-sidebar 服务就绪（浏览器端）后本插件才挂载。 */
		const inject = ["betterSidebar"];
		/** 注册千寻回测 tab 到 better-sidebar 侧边栏。 */
		function apply(ctx) {
			ctx.effect(() => {
				const disposers = [
					ctx.betterSidebar.registerTab({
						id: "qianxun",
						title: "千寻回测",
						single: true,
						component: (props) => (0, react.createElement)(QianxunTab, props)
					}),
					ctx.betterSidebar.registerTab({
						id: "qianxun-detail",
						title: "千寻结果",
						icon: "🔬",
						component: (props) => (0, react.createElement)(QianxunDetailTab, props)
					}),
					ctx.betterSidebar.registerTab({
						id: "qianxun-prompt",
						title: "提示词",
						icon: "📋",
						component: (props) => (0, react.createElement)(PromptEditTab, props)
					})
				];
				return () => {
					for (const dispose of disposers) dispose();
				};
			}, "dsh-qianxun-tab: register betterSidebar tabs");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
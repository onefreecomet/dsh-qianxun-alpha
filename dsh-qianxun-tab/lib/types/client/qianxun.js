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
export const QIANXUN_BASE = (() => {
    const fromQuery = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('qianxun') : null;
    return fromQuery ?? 'http://127.0.0.1:8765';
})();
async function readJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok)
        throw new Error(`qianxun ${res.status} ${res.statusText} for ${url}`);
    return res.json();
}
/** POST JSON body，作为 CORS 简单请求（text/plain 规避 8765 的 OPTIONS 501）。 */
async function postJson(url, body) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(body ?? {}),
    });
    if (!res.ok)
        throw new Error(`qianxun ${res.status} ${res.statusText} for ${url}`);
    return res.json().catch(() => ({}));
}
/** 取批次列表（引擎返回最新在前）。 */
export async function listBatches() {
    const data = await readJson(`${QIANXUN_BASE}/api/jobs`);
    if (Array.isArray(data))
        return data;
    return data?.jobs ?? [];
}
/** 取单批详情（含逐条指标）。 */
export async function getBatch(batchNo) {
    return readJson(`${QIANXUN_BASE}/api/jobs/${encodeURIComponent(batchNo)}`);
}
/** 取单批完整结果。 */
export async function getBatchResult(batchNo) {
    return readJson(`${QIANXUN_BASE}/api/jobs/${encodeURIComponent(batchNo)}/result`);
}
/** 取单 alpha 的 BRAIN check 详情（PROD_CORRELATION + 全部 checks）。
 * qianxund 端有 60s TTL 缓存。失败时抛 Error，UI 需要捕获并降级显示。 */
export async function getAlphaCheck(alphaId) {
    return readJson(`${QIANXUN_BASE}/api/alphas/${encodeURIComponent(alphaId)}/check`);
}
/** 取单 alpha 的 PnL 时间序列（10 年日频，约 2500 条）。
 * 用于浏览器内本地算 Pearson correlation，BRAIN（不等 PENDING）。 */
export async function getAlphaPnl(alphaId) {
    return readJson(`${QIANXUN_BASE}/api/alphas/${encodeURIComponent(alphaId)}/pnl`);
}
/** 取单 alpha 的本地缓存 PnL（qianxund 会自动 fallback BRAIN + 写盘）。
 * 二次调用秒出，无 BRAIN 网络往返。 */
export async function getCachedPnl(alphaId) {
    return readJson(`${QIANXUN_BASE}/api/pnl-cache/${encodeURIComponent(alphaId)}`);
}
/** 取本地 PnL 缓存列表（用于侧边栏显示已缓存数量）。 */
export async function getPnlCacheStatus() {
    return readJson(`${QIANXUN_BASE}/api/pnl-cache`);
}
/** 一键清空本地 PnL 缓存（需要 X-Clear-Token: yes-i-know 确认）。 */
export async function clearPnlCache() {
    const r = await fetch(`${QIANXUN_BASE}/api/pnl-cache-clear`, {
        method: 'POST',
        headers: { 'X-Clear-Token': 'yes-i-know' },
    });
    if (!r.ok)
        throw new Error(`qianxun ${r.status} ${r.statusText}`);
    return r.json();
}
export async function getActiveAlphas() {
    return readJson(`${QIANXUN_BASE}/api/active-alphas`);
}
/** 启动 PnL 批量回填任务（异步），返回 job_id 用于轮询。
 * Content-Type 故意用 text/plain 规避 CORS preflight（qianxund 没 OPTIONS handler）；
 * 跟 submitBatch 一致——服务端按 JSON 解析 body。 */
export async function startBackfillPnls(req = {}) {
    const r = await fetch(`${QIANXUN_BASE}/api/pnl-cache-backfill`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(req),
    });
    if (!r.ok)
        throw new Error(`qianxun ${r.status} ${r.statusText}`);
    return r.json();
}
/** 轮询回填任务进度 */
export async function getBackfillStatus(jobId) {
    return readJson(`${QIANXUN_BASE}/api/pnl-cache-backfill/${encodeURIComponent(jobId)}`);
}
/** 取单 alpha 的 prod correlation 数值。
 * qianxund 端有 60s TTL 缓存 + 首次空响应也由后端重试 3 次。 */
export async function getAlphaProdCorr(alphaId) {
    const raw = await readJson(`${QIANXUN_BASE}/api/alphas/${encodeURIComponent(alphaId)}/correlations/prod`);
    return {
        max: typeof raw.max === 'number' ? raw.max : null,
        min: typeof raw.min === 'number' ? raw.min : null,
        records: Array.isArray(raw.records) ? raw.records : [],
    };
}
/** 对批次执行控制动词（pause / resume / cancel）。 */
export async function actOnBatch(batchNo, action) {
    return postJson(`${QIANXUN_BASE}/api/jobs/${encodeURIComponent(batchNo)}`, { action });
}
/** 断点续跑：POST /api/jobs/<batch>/resume。 */
export async function resumeBatch(batchNo) {
    return postJson(`${QIANXUN_BASE}/api/jobs/${encodeURIComponent(batchNo)}/resume`, {});
}
/** 提交新批次。`expressions` 为表达式字符串或配置对象数组。 */
export async function submitBatch(body) {
    return postJson(`${QIANXUN_BASE}/api/jobs`, body);
}
/** GET /api/config —— 当前并发 / 批大小。 */
export async function getConfig() {
    return readJson(`${QIANXUN_BASE}/api/config`);
}
/** POST /api/config —— 调并发 / 批大小。body 只传要改的项。 */
export async function setConfig(body) {
    return (await postJson(`${QIANXUN_BASE}/api/config`, body));
}
/** GET /api/quota —— 今日提交数 / 每日配额。 */
export async function getQuota() {
    return readJson(`${QIANXUN_BASE}/api/quota`);
}
/** 读池子（纯本地，不打 BRAIN）。 */
export async function getAlphaPool() {
    return readJson(`${QIANXUN_BASE}/api/alpha-pool`);
}
/** 改池子：action = add | remove | clear | set。 */
export async function mutateAlphaPool(action, ids) {
    // 引擎的 POST 解析走 text/plain 简单请求（绕开 8765 的 OPTIONS 501，和其它写操作一致）。
    return (await postJson(`${QIANXUN_BASE}/api/alpha-pool`, { action, ids }));
}
/** 写某条 alpha 的备注（纯本地）。注意引擎的 action 是 note，不是改池子成员。 */
export async function setAlphaPoolNote(alphaId, note) {
    return (await postJson(`${QIANXUN_BASE}/api/alpha-pool`, {
        action: 'note', alpha_id: alphaId, note,
    }));
}
/** 同步：拉取整池（或指定 ids）的指标 / 相关性 / 状态。 */
export async function syncAlphaPool(ids) {
    return (await postJson(`${QIANXUN_BASE}/api/alpha-pool/sync`, ids ? { ids } : {}));
}
/** 账号当日新增 ACTIVE 数（每天本地 12:00 重置，吃引擎侧 5min 缓存）。 */
export async function getActiveStats(force = false) {
    return readJson(`${QIANXUN_BASE}/api/alpha-pool/active-stats${force ? '?force=1' : ''}`);
}
/**
 * ⚠️ 真提交（不可逆）。只有人类点按钮才会走到这里。
 *
 * `confirm` 是引擎侧硬性闸门：必须逐字传 CONFIRM_SUBMIT_TOKEN，否则 400。
 * agent / 脚本不得代为调用。
 */
export const CONFIRM_SUBMIT_TOKEN = 'yes-i-know';
export async function submitAlphas(ids, opts = {}) {
    const url = opts.pollOnly === true
        ? `${QIANXUN_BASE}/api/alpha-pool/submit/poll`
        : `${QIANXUN_BASE}/api/alpha-pool/submit`;
    return (await postJson(url, {
        ids, confirm: CONFIRM_SUBMIT_TOKEN,
    }));
}
/** 查提交任务进度。 */
export async function getSubmitJob(jobId) {
    return readJson(`${QIANXUN_BASE}/api/alpha-pool/submit/${encodeURIComponent(jobId)}`);
}
//# sourceMappingURL=qianxun.js.map
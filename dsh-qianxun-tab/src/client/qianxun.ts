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
  const fromQuery =
    typeof location !== 'undefined' ? new URLSearchParams(location.search).get('qianxun') : null
  return fromQuery ?? 'http://127.0.0.1:8765'
})()

/** 批次控制动词：POST /api/jobs/<batch> body.action。 */
export type QianxunAction = 'cancel' | 'pause' | 'resume'

/** GET /api/jobs 返回的一行（批次列表）。id 形如 B20260818-001。 */
export interface QianxunBatch {
  id: string
  round?: string
  name?: string | null
  state: string
  done: number
  total: number
  created_at: number
  producer?: string | null
  status?: string | null
}

/** 逐条表达式结果内的指标。 */
export interface QianxunMetrics {
  sharpe?: number | null
  fitness?: number | null
  returns?: number | null
  turnover?: number | null
  margin?: number | null
  check_status?: string | null
}

/** 一个批次内的逐条表达式结果。 */
export interface QianxunResult {
  idx: number
  status?: string | null
  alpha_id?: string | null
  expression?: string | null
  metrics: QianxunMetrics
  error?: string | null
}

/** 批次详情：GET /api/jobs/<batch> 与 GET /api/jobs/<batch>/result。 */
export interface QianxunBatchDetail {
  id: string
  name?: string | null
  round?: string
  state: string
  done: number
  total: number
  created_at: number
  by_status?: Record<string, number>
  results?: QianxunResult[]
  batch_status?: unknown
}

/** 单个 BRAIN check 项（来自 `GET /alphas/<id>/check` 的 `is.checks[]`）。
 * 字段不固定，按 check 类型可能含 `limit`/`value`/`result`/`note` 等。 */
export interface QianxunAlphaCheck {
  name: string
  result?: string | null
  value?: number | null
  limit?: number | null
  note?: string | null
  [key: string]: unknown
}

/** BRAIN `/alphas/<id>/check` 响应形状（结构子集）。 */
export interface QianxunAlphaCheckResponse {
  is?: {
    checks?: QianxunAlphaCheck[]
    [key: string]: unknown
  }
  os?: {
    checks?: QianxunAlphaCheck[]
    [key: string]: unknown
  }
  [key: string]: unknown
}

/** 列表接口的包装形状（引擎可能返回 {jobs} 或裸数组）。 */
interface JobsEnvelope {
  jobs?: QianxunBatch[]
}

async function readJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`qianxun ${res.status} ${res.statusText} for ${url}`)
  return res.json() as Promise<T>
}

/** POST JSON body，作为 CORS 简单请求（text/plain 规避 8765 的 OPTIONS 501）。 */
async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify(body ?? {}),
  })
  if (!res.ok) throw new Error(`qianxun ${res.status} ${res.statusText} for ${url}`)
  return res.json().catch(() => ({}))
}

/** 取批次列表（引擎返回最新在前）。 */
export async function listBatches(): Promise<QianxunBatch[]> {
  const data = await readJson<JobsEnvelope | QianxunBatch[]>(`${QIANXUN_BASE}/api/jobs`)
  if (Array.isArray(data)) return data
  return data?.jobs ?? []
}

/** 取单批详情（含逐条指标）。 */
export async function getBatch(batchNo: string): Promise<QianxunBatchDetail> {
  return readJson<QianxunBatchDetail>(
    `${QIANXUN_BASE}/api/jobs/${encodeURIComponent(batchNo)}`,
  )
}

/** 取单批完整结果。 */
export async function getBatchResult(batchNo: string): Promise<QianxunBatchDetail> {
  return readJson<QianxunBatchDetail>(
    `${QIANXUN_BASE}/api/jobs/${encodeURIComponent(batchNo)}/result`,
  )
}

/** 取单 alpha 的 BRAIN check 详情（PROD_CORRELATION + 全部 checks）。
 * qianxund 端有 60s TTL 缓存。失败时抛 Error，UI 需要捕获并降级显示。 */
export async function getAlphaCheck(alphaId: string): Promise<QianxunAlphaCheckResponse> {
  return readJson<QianxunAlphaCheckResponse>(
    `${QIANXUN_BASE}/api/alphas/${encodeURIComponent(alphaId)}/check`,
  )
}

/** 单条 PnL 记录（来自 BRAIN `/alphas/{id}/recordsets/daily-pnl`）。
 * qianxund 已经把 records 序列化为 `{"date": "YYYY-MM-DD", "pnl": float}`。 */
export interface QianxunPnlRecord {
  date: string
  pnl: number
}

/** 单 alpha PnL 时间序列响应。 */
export interface QianxunPnlResponse {
  records: QianxunPnlRecord[]
}

/** 取单 alpha 的 PnL 时间序列（10 年日频，约 2500 条）。
 * 用于浏览器内本地算 Pearson correlation，BRAIN（不等 PENDING）。 */
export async function getAlphaPnl(alphaId: string): Promise<QianxunPnlResponse> {
  return readJson<QianxunPnlResponse>(
    `${QIANXUN_BASE}/api/alphas/${encodeURIComponent(alphaId)}/pnl`,
  )
}

/** 本地缓存的 PnL 命中：返回的 records 与 QianxunPnlResponse 同形；附带 cache_hit + 元信息。 */
export interface QianxunCachedPnlResponse extends QianxunPnlResponse {
  alpha_id?: string
  region?: string | null
  downloaded_at?: string
  source?: string
  cache_hit: boolean
}

/** 取单 alpha 的本地缓存 PnL（qianxund 会自动 fallback BRAIN + 写盘）。
 * 二次调用秒出，无 BRAIN 网络往返。 */
export async function getCachedPnl(alphaId: string): Promise<QianxunCachedPnlResponse> {
  return readJson<QianxunCachedPnlResponse>(
    `${QIANXUN_BASE}/api/pnl-cache/${encodeURIComponent(alphaId)}`,
  )
}

/** 单个缓存条目元信息。 */
export interface QianxunCachedPnlItem {
  alpha_id: string
  size_bytes: number
  region: string | null
  downloaded_at: string | null
}

/** 本地缓存全局状态。 */
export interface QianxunPnlCacheStatus {
  count: number
  total_bytes: number
  cache_dir: string
  items: QianxunCachedPnlItem[]
}

/** 取本地 PnL 缓存列表（用于侧边栏显示已缓存数量）。 */
export async function getPnlCacheStatus(): Promise<QianxunPnlCacheStatus> {
  return readJson<QianxunPnlCacheStatus>(`${QIANXUN_BASE}/api/pnl-cache`)
}

/** 一键清空本地 PnL 缓存（需要 X-Clear-Token: yes-i-know 确认）。 */
export async function clearPnlCache(): Promise<{ cleared: number }> {
  const r = await fetch(`${QIANXUN_BASE}/api/pnl-cache-clear`, {
    method: 'POST',
    headers: { 'X-Clear-Token': 'yes-i-know' },
  })
  if (!r.ok) throw new Error(`qianxun ${r.status} ${r.statusText}`)
  return r.json() as Promise<{ cleared: number }>
}

/** BRAIN 当前 ACTIVE 状态的 alpha_ids 列表（缓存 5 min）。
 * 这是 BRAIN SELF_CORRELATION 的真实对比基线——本地核对必须用它过滤，
 * 否则会把 BRAIN 已踢出活跃组合的 alpha 算进去，结果虚高。 */
export interface QianxunActiveAlphasResponse {
  count: number
  ids: string[]
  fetched_at: string
  cache_hit: boolean
}

export async function getActiveAlphas(): Promise<QianxunActiveAlphasResponse> {
  return readJson<QianxunActiveAlphasResponse>(`${QIANXUN_BASE}/api/active-alphas`)
}

/** PnL 缓存批量回填任务：启动请求体 */
export interface QianxunBackfillStartRequest {
  /** 暂未启用 region 过滤（ACTIVE 列表不带 region）；保留字段供未来 */
  region?: string | null
}

/** 启动回填返回 */
export interface QianxunBackfillStartResponse {
  job_id: string
  total: number
  skipped_cached: number
  poll_url: string
}

/** 任务状态 */
export type QianxunBackfillStatus = 'running' | 'done' | 'partial' | 'error' | 'captcha_blocked'

/** 轮询返回 */
export interface QianxunBackfillState {
  status: QianxunBackfillStatus
  total: number
  done: number
  errors: string[]
  region: string | null
  started_at?: number
  finished_at?: number
  stopped_reason?: string
}

/** 启动 PnL 批量回填任务（异步），返回 job_id 用于轮询。
 * Content-Type 故意用 text/plain 规避 CORS preflight（qianxund 没 OPTIONS handler）；
 * 跟 submitBatch 一致——服务端按 JSON 解析 body。 */
export async function startBackfillPnls(req: QianxunBackfillStartRequest = {}): Promise<QianxunBackfillStartResponse> {
  const r = await fetch(`${QIANXUN_BASE}/api/pnl-cache-backfill`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify(req),
  })
  if (!r.ok) throw new Error(`qianxun ${r.status} ${r.statusText}`)
  return r.json() as Promise<QianxunBackfillStartResponse>
}

/** 轮询回填任务进度 */
export async function getBackfillStatus(jobId: string): Promise<QianxunBackfillState> {
  return readJson<QianxunBackfillState>(`${QIANXUN_BASE}/api/pnl-cache-backfill/${encodeURIComponent(jobId)}`)
}

/** 单条 prod correlation 记录。BRAIN 返回两种形状：
 * - 数组格式（旧版）：[corr, alpha_id, ?]
 * - 对象格式：[{"corr": ..., "alpha_id": ...}, ...]（qianxund 直接透传）
 * 本类型做兼容。 */
export interface QianxunProdCorrRecord {
  corr?: number
  alpha_id?: string
  [key: string]: unknown
}

/** 单 alpha prod correlation 响应。max/min 可能为 null（BRAIN 端点首次常空）。 */
export interface QianxunProdCorrResponse {
  max: number | null
  min: number | null
  records: QianxunProdCorrRecord[]
}

/** 取单 alpha 的 prod correlation 数值。
 * qianxund 端有 60s TTL 缓存 + 首次空响应也由后端重试 3 次。 */
export async function getAlphaProdCorr(alphaId: string): Promise<QianxunProdCorrResponse> {
  const raw = await readJson<Record<string, unknown>>(
    `${QIANXUN_BASE}/api/alphas/${encodeURIComponent(alphaId)}/correlations/prod`,
  )
  return {
    max: typeof raw.max === 'number' ? raw.max : null,
    min: typeof raw.min === 'number' ? raw.min : null,
    records: Array.isArray(raw.records) ? raw.records as QianxunProdCorrRecord[] : [],
  }
}

/** 对批次执行控制动词（pause / resume / cancel）。 */
export async function actOnBatch(
  batchNo: string,
  action: QianxunAction,
): Promise<unknown> {
  return postJson(`${QIANXUN_BASE}/api/jobs/${encodeURIComponent(batchNo)}`, { action })
}

/** 断点续跑：POST /api/jobs/<batch>/resume。 */
export async function resumeBatch(batchNo: string): Promise<unknown> {
  return postJson(`${QIANXUN_BASE}/api/jobs/${encodeURIComponent(batchNo)}/resume`, {})
}

/** 提交新批次。`expressions` 为表达式字符串或配置对象数组。 */
export async function submitBatch(body: {
  settings: unknown
  expressions: unknown[]
  name?: string
  producer?: string
  cap?: number
}): Promise<unknown> {
  return postJson(`${QIANXUN_BASE}/api/jobs`, body)
}

/** 引擎运行配置。 */
export interface QianxunConfig {
  concurrent?: number
  batch_size?: number
  total_concurrency?: number
  slots?: number
  per_slot?: number
}

/** 引擎配额信息。 */
export interface QianxunQuota {
  date?: string
  submitted_today?: number
  quota?: {
    limit?: number
    remaining?: number
    reset_sec?: number
  } | null
}

/** GET /api/config —— 当前并发 / 批大小。 */
export async function getConfig(): Promise<QianxunConfig> {
  return readJson<QianxunConfig>(`${QIANXUN_BASE}/api/config`)
}

/** POST /api/config —— 调并发 / 批大小。body 只传要改的项。 */
export async function setConfig(body: { concurrent?: number; batch_size?: number }): Promise<QianxunConfig> {
  return (await postJson(`${QIANXUN_BASE}/api/config`, body)) as QianxunConfig
}

/** GET /api/quota —— 今日提交数 / 每日配额。 */
export async function getQuota(): Promise<QianxunQuota> {
  return readJson<QianxunQuota>(`${QIANXUN_BASE}/api/quota`)
}

// ───────────────────────────── Alpha 自选池 ─────────────────────────────
//
// 池子存在引擎侧（<engine>/data/alpha_pool.json），不是 localStorage：
// DSH Desktop 每次启动可能换端口，localStorage 按 origin 隔离，换端口就丢。
// 打 BRAIN 的部分（指标 / 相关性 / 提交状态）也由引擎代劳——浏览器没有凭据。

/** 自选池里单个 alpha 的指标（与批次结果的 QianxunMetrics 同形）。 */
export type QianxunPoolMetrics = QianxunMetrics

/** 单条自选 alpha 的完整信息（引擎 alpha_pool_service 的 item 契约）。 */
export interface QianxunPoolItem {
  alpha_id: string
  /** active = 在 BRAIN ACTIVE 组合里；unsubmit = 不在；unknown = 两个来源都没拿到。 */
  status?: 'active' | 'unsubmit' | 'unknown' | string | null
  /** BRAIN 原文状态（ACTIVE / UNSUBMITTED / …），排障用。 */
  brain_status?: string | null
  metrics?: QianxunPoolMetrics
  /** SELF_CORRELATION check 的 value / result。 */
  self_corr?: number | null
  self_corr_result?: string | null
  /** PROD_CORRELATION check 的 value / result。 */
  prod_corr?: number | null
  prod_corr_result?: string | null
  region?: string | null
  expression?: string | null
  date_created?: string | null
  /** 用户自己写的备注（纯本地，不打 BRAIN）。 */
  note?: string | null
  /** 最近一次提交尝试的结论（引擎侧提交闸写的）。 */
  submit?: QianxunSubmitMark | null
  submitted_at?: string | null
  added_at?: string | null
  updated_at?: string | null
  /** 数据来源：brain / brain-check / db（引擎本地库兜底）/ cache。 */
  source?: string | null
  /** 逐条非致命错误（BRAIN 限流、check 仍 PENDING 等）。 */
  errors?: string[]
}

/** 池子条目上记的提交结论。 */
export interface QianxunSubmitMark {
  /** queued=已排队；submitted=成功；blocked=check 没过被拒；
   * failed=判定失败；timeout=轮询 404；pending=超预算待续查。 */
  state?: 'queued' | 'submitted' | 'blocked' | 'failed' | 'timeout' | 'pending' | string | null
  at?: string | null
  /** 被拒/失败时平台给出的 FAIL 项名字。 */
  fails?: string[]
  error?: string | null
}

/** GET /api/alpha-pool/active-stats 的响应：账号当日新增 ACTIVE 数。 */
export interface QianxunActiveStats {
  ok?: boolean
  /** true = 这次没拿到 ACTIVE 列表，返回的是上次观察值。 */
  stale?: boolean
  active_count?: number | null
  /** 当日（本地 12:00 起）新进入 ACTIVE 的条数。 */
  daily_new?: number
  daily_new_ids?: string[]
  baseline_reset_at?: string | null
  baseline_count?: number
  observed_at?: string | null
  reset_hour?: number
  next_reset_at?: string | null
}

/** POST /api/alpha-pool/submit 的响应（异步任务，返回 job_id 去轮询）。 */
export interface QianxunSubmitStart {
  ok?: boolean
  job_id?: string
  mode?: 'submit' | 'poll' | string
  ids?: string[]
  /** 提交时自动补进自选池的 id（方便追踪）。 */
  auto_added?: string[]
  poll_url?: string
  error?: string
}

/** 单个 alpha 在提交任务里的状态。 */
export interface QianxunSubmitJobItem {
  state?: string | null
  http?: number
  polls?: number
  fails?: string[]
  error?: string | null
  body?: string
  updated_at?: string | null
}

/** GET /api/alpha-pool/submit/<job_id> 的响应。 */
export interface QianxunSubmitJob {
  ok?: boolean
  job_id?: string
  mode?: string
  ids?: string[]
  items?: Record<string, QianxunSubmitJobItem>
  running?: boolean
  started_at?: string | null
  finished_at?: string | null
  error?: string
}

/** GET/POST /api/alpha-pool 的响应。 */
export interface QianxunPoolResponse {
  ok?: boolean
  count: number
  ids: string[]
  items: QianxunPoolItem[]
  updated_at?: string | null
  synced_at?: string | null
  pool_path?: string
}

/** POST /api/alpha-pool/sync 的响应：在池子快照上补同步进度。 */
export interface QianxunPoolSyncResponse extends QianxunPoolResponse {
  refreshed?: number
  /** true = 还有没刷到的（超时或单点失败），再点一次会续着刷。 */
  partial?: boolean
  remaining?: string[]
  /** ACTIVE 列表这次是否真的拿到了（false 时 status 只能靠 BRAIN 单 alpha 状态）。 */
  active_ok?: boolean
  active_count?: number | null
  message?: string
}

/** 读池子（纯本地，不打 BRAIN）。 */
export async function getAlphaPool(): Promise<QianxunPoolResponse> {
  return readJson<QianxunPoolResponse>(`${QIANXUN_BASE}/api/alpha-pool`)
}

/** 改池子：action = add | remove | clear | set。 */
export async function mutateAlphaPool(
  action: 'add' | 'remove' | 'clear' | 'set',
  ids?: string | string[],
): Promise<QianxunPoolResponse> {
  // 引擎的 POST 解析走 text/plain 简单请求（绕开 8765 的 OPTIONS 501，和其它写操作一致）。
  return (await postJson(`${QIANXUN_BASE}/api/alpha-pool`, { action, ids })) as QianxunPoolResponse
}

/** 写某条 alpha 的备注（纯本地）。注意引擎的 action 是 note，不是改池子成员。 */
export async function setAlphaPoolNote(
  alphaId: string,
  note: string,
): Promise<QianxunPoolResponse> {
  return (await postJson(`${QIANXUN_BASE}/api/alpha-pool`, {
    action: 'note', alpha_id: alphaId, note,
  })) as QianxunPoolResponse
}

/** 同步：拉取整池（或指定 ids）的指标 / 相关性 / 状态。 */
export async function syncAlphaPool(ids?: string[]): Promise<QianxunPoolSyncResponse> {
  return (await postJson(`${QIANXUN_BASE}/api/alpha-pool/sync`, ids ? { ids } : {})) as QianxunPoolSyncResponse
}

/** 账号当日新增 ACTIVE 数（每天本地 12:00 重置，吃引擎侧 5min 缓存）。 */
export async function getActiveStats(force = false): Promise<QianxunActiveStats> {
  return readJson<QianxunActiveStats>(
    `${QIANXUN_BASE}/api/alpha-pool/active-stats${force ? '?force=1' : ''}`,
  )
}

/**
 * ⚠️ 真提交（不可逆）。只有人类点按钮才会走到这里。
 *
 * `confirm` 是引擎侧硬性闸门：必须逐字传 CONFIRM_SUBMIT_TOKEN，否则 400。
 * agent / 脚本不得代为调用。
 */
export const CONFIRM_SUBMIT_TOKEN = 'yes-i-know'

export async function submitAlphas(
  ids: string[],
  opts: { pollOnly?: boolean } = {},
): Promise<QianxunSubmitStart> {
  const url = opts.pollOnly === true
    ? `${QIANXUN_BASE}/api/alpha-pool/submit/poll`
    : `${QIANXUN_BASE}/api/alpha-pool/submit`
  return (await postJson(url, {
    ids, confirm: CONFIRM_SUBMIT_TOKEN,
  })) as QianxunSubmitStart
}

/** 查提交任务进度。 */
export async function getSubmitJob(jobId: string): Promise<QianxunSubmitJob> {
  return readJson<QianxunSubmitJob>(
    `${QIANXUN_BASE}/api/alpha-pool/submit/${encodeURIComponent(jobId)}`,
  )
}

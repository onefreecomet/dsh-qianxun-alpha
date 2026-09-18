# 更新日志 (Changelog)

本项目版本号跟随 GitHub Release tag：`v0.1.0` / `v0.2.0` / `v0.3.0` / `v2.0`

---

## v2.0 (2026-09-18)

主题：**把「盯 alpha」和「提交 alpha」搬进侧边栏**。此前提交只能去 BRAIN 网页手点，
一条要转几十分钟到几小时；候选 alpha 的指标和相关性也得一页页翻。

### ⭐ Alpha 自选池（新）
- 「千寻结果」页新增 **Alpha 自选池卡**：粘 alpha_id（支持一次多个，逗号/空格/换行分隔）即入库
- 池子落在**引擎侧** `data/alpha_pool.json`（不是 localStorage）——DSH Desktop 每次启动可能换端口，
  localStorage 按 origin 隔离会丢；放服务端后换浏览器/换端口都在
- 表格 12 列一眼看全：**状态 / region / alpha_id（⧉ 一键复制）/ sharpe / fitness / ret% / to% /
  margin（万分之一）/ selfcorr / prodcorr / 备注 / 操作**
- **状态二值**：`active`（在 BRAIN ACTIVE 组合里）vs `unsubmit`；BRAIN 抖动拿不到 ACTIVE 列表时
  标 `unknown`，**绝不把「没拿到」当成「空集合」**（否则整池假红灯）
- **备注列**可直接在格子里写：1s 防抖自动保存 + 回车/失焦立即保存
- **🔄 同步**一次刷新整池。设计成**可续刷**：单次请求有 90s 时间预算，边算边落盘，
  BRAIN 限流时返回已完成部分并提示「还剩 N 条」，再点一次接着刷
- 本地兜底：BRAIN 拿不到指标时用引擎自己的 `alphas` 表补，表格不至于空着

### ⚡ 一键提交到平台（新）
- 自选池下方「⚡ 提交到平台」栏：粘 alpha_id → **先拉 check 把 FAIL 项摊在确认框里** → 确认后才真提交
- **两道确认**：通用确认（不可逆/占额度）+ 有 FAIL 时额外一次（默认拦住，可强制提）
- 协议按官方顾问论坛实测的**两段式 long-poll** 实现：
  `POST /alphas/{id}/submit`（201 进队列 / 400 已在队列 / 403 未过 check）
  → `GET` 同一地址轮询（200+Retry-After 继续等 / 200 无 Retry-After = 成功 / 403 判失败 / 404 超时）
- **异步任务**：返回 `job_id`，页面 4s 轮询逐条进度，不用挂着等
- **续查**：轮询超时间预算标 `pending`，点「续查」只 GET **不重复 POST**（避免白占额度、撞 400）
- **安全闸**（防误触也防自动化）：
  - 必须带 `confirm="yes-i-know"` 字面量，缺了直接 400
  - 单次最多 5 个 id；**串行**提交（这个接口 429 极凶，并发就是自找限流）
  - 提交后自动把 id 入池便于追踪；结论落回条目（`queued/submitted/blocked/failed/timeout/pending`）
  - **agent / 脚本不得调用本端点** —— 这是人类专属闸门

### 📈 当日新增 active（新）
- 顶部徽标由「池内 N active」改为 **「📈 今日新增 active N · 账号共 M」**
- 口径：以上一次**本地 12:00** 的 ACTIVE 集合为基准线，当日新增 = 当前集合 − 基准线；跨过 12:00 自动重置
- 已知局限（已写进 hover 提示）：基准线只能在有人打开页面时滚动，长时间不看页面期间的进出无法回溯，
  **宁可漏算也不会多算**

### 🐛 修复
- **`get_alpha_check` 首次调用拿到空 body 就直接 `resp.json()` → JSONDecodeError**：
  BRAIN 的 `/alphas/{id}/check` **首次调用常返回 200 但 body 为空**（平台在后台现算 check）。
  后果是侧边栏 🔍「BRAIN check」面板第一次点永远是空的、自选池的 selfcorr/prodcorr 第一次同步永远是「—」，
  得再点一次才有。现按同文件里 `get_alpha_correlations_prod` 的既有做法**对空响应显式重试 3 次**；
  三次都空则明确报错，不返回空壳冒充「这个 alpha 没有 check」
- **`requirements.txt` 的 loguru 版本约束从未存在**：原写 `loguru>=2.7`，而 PyPI 上 loguru 最高 0.7.x
  （`pip install -r requirements.txt` 必失败）→ 改 `loguru>=0.7.0`
- **`qianxun_mcp.py` 去个人化**：接入示例里硬编码了构建者的本机绝对路径（`/Users/<user>/QianXun/...`）
  → 改为 `$DEVKIT/engine/qianxun_mcp.py`

### 🔧 引擎
- 新增便捷视图 **`sims_by_batch`**（启动时幂等创建）：`simulations` 表本身没有 `batch_no` 列
  （只有 `task_run_id`），agent/脚本习惯按批次号查明细，反复踩 `no such column: batch_no`；
  视图把 JOIN 藏起来，直接 `select * from sims_by_batch where batch_no='B20260918-006'`
- ACTIVE 列表缓存抽成 `_active_ids_cached()`，自选池与 `/api/active-alphas` 共用同一份 5 分钟缓存，
  同一件事不打两次 BRAIN

### 🧪 测试
- 新增 `tests/`（纯 stdlib，不联网、不碰 BRAIN、**绝不真提交**）：**43 个用例**
  - 提交协议 12 例：闸门（缺 confirm / 错 confirm / 超 5 个）、201→成功、403→列出 FAIL、
    400→转轮询、429 退避、Retry-After、网络异常重试、轮询超预算标 pending、续查不发 POST、串行多 id
  - 当日 active 7 例：首次基准线记 0、新增计数、被踢出不虚增、跨 12:00 重置、拿不到标 stale、UTC 换算
  - 备注 4 例：roundtrip + 落盘 + 404 + 纯本地不打 BRAIN
  - 池子与 check 重试 20 例
  - 跑法：`python -m unittest discover -s tests -t .`

### 📦 仓库结构
- **侧边栏插件源码入库**：新增 `dsh-qianxun-tab/`（TS 源码 + 已构建 `lib/` + 安装说明）
- **ARC 回测扩展不入库**：`arc_service.py` / `arc_runner.py` / `arc_ui.html` 系从第三方
  「ARC 回测交付包」移植，本仓库为 public，故加入 `.gitignore` 永不对外分发。
  `qianxund.py` 对 ARC 的接线是隔离扩展模式（import 失败只告警并禁用），
  因此缺这几个文件时引擎功能完整、只是没有 `/arc` 页面；公开版的 `backtestd_ui.html`
  同步移除了指向 `/arc` 的导航链接
- `*.bak` / `*.bak_*` 本地改造快照一并加入 `.gitignore`

---

## v0.3.0 (2026-08-27)

### ⚡ 一键启动引擎 — 真正一键拉起
- 新增 **常驻启动器 `qianxund-start-server.py`**（HTTP 127.0.0.1:8766，launchd `com.qianxund-start` 托管，永远在线）
- 侧边栏「⚡ 启动引擎」按钮**真正能启动引擎**：点击 → 启动器 `POST /api/start` → launchd kickstart 拉起 qianxund → 轮询等就绪
- 离线时按钮显示"⚡ 启动中…"+ 禁用，成功转绿"🟢 引擎在线"，失败给明确提示
- 引擎由 launchd `com.qianxund`（KeepAlive）托管，崩溃自动重启（实测 kill 后 3 秒拉起）

### 📋 提示词模块（侧边栏新增）
- 侧边栏新增「📋 提示词」卡片（`prompts.ts` + `PromptEditTab.tsx`）：
  - 名字列表 + ⧉ 一键复制按钮
  - 点击列表项 → 新开 tab 编辑（名称 + 内容，500ms 防抖自动保存）
  - 🗑 删除功能 + 状态提示
- 提示词存浏览器 `localStorage`（`qianxun_prompts` key，上限 200 条/20000 字），不依赖后端

### 🚀 提交批次 → Web UI + JSON 导入
- 侧边栏「🚀 提交批次」卡片**迁移到 Web UI** `http://127.0.0.1:8765/ui`
- Web UI 新增「📥 导入 JSON」按钮：
  - 支持 3 种 AI 输出格式：完整 BRAIN 格式 `{settings, expressions, name}` / 裸数组 / 裸字符串
  - 点击后 settings + expressions + 批次名自动填入表单
- 侧边栏空位由「📋 提示词」模块接管

### 🎨 侧边栏 UI 优化
- **引擎配置卡片**精简：标题去掉"/ 配额"、输入框紧凑化（72px 居中）、删冗余"当前并发"行
- **配额 chip 移到 header 最上方**：`🧠 千寻回测 · 今日0·剩—`，紧跟标题
- 删除 header 左侧冗余的"引擎在线"文字（右侧按钮已显示状态）
- **默认并发 6 / 批大小 8**（launchd plist + 启动器同步修改）

### 🐛 修复
- 引擎离线状态检测：前端 `/health` 探测 + 启动器 `/api/status` 双确认
- 引擎配置卡片移除未使用的 `config` state（避免 TS 告警）
- 启动器 `start_engine()`：优先 `launchctl kickstart`（而非 spawn），确保引擎回到 KeepAlive 托管

### 📦 涉及文件
- 新增 `qianxund-start-server.py` + `~/Library/LaunchAgents/com.qianxund-start.plist`
- 新增 `prompts.ts` + `PromptEditTab.tsx`（提示词模块）
- 新增 `index.ts` 注册 `qianxun-prompt` tab
- 修改 `~/Library/LaunchAgents/com.qianxund.plist`（并发 3→6，批大小 10→8）
- 修改前端 `QianxunTab.tsx` / `QianxunTab.module.css`
- 修改 `backtestd_ui.html`（Web UI 新增 JSON 导入）

---

## v0.2.0 (2026-08-22)

### 🆕 新功能
- **Web UI check 功能**：`http://127.0.0.1:8765/ui` 原生控制台支持 🔍 BRAIN check / 📈 prod corr / 📐 本地 SELF_CORRELATION
- **提示词模块**：侧边栏「📋 提示词」卡片（名字列表 + 复制按钮 + 点击开 tab 编辑、自动保存、删除）
- **提交批次移至 Web UI**：侧边栏的提交表单搬到 `8765/ui`，带 📥 JSON 导入（支持 3 种 AI 输出格式）
- **launchd 自启动**：qianxund 由 launchd 托管（`com.qianxund`，RunAtLoad + KeepAlive）
- 侧边栏「⚡ 启动引擎」按钮（早期版：仅复制启动命令）

### 🐛 修复
- 移除代码中"Mac 版"标签（项目实际跨平台 macOS/Linux/Windows）
- `direction_radar.py` 硬编码 Windows 路径 → `os.path.join`
- `backtestd_ui.html` `lg.lines` null check（修复 TypeError）

### 🔧 架构
- 跨平台安装说明（macOS/Linux/Windows 完整步骤）
- 侧边栏批次卡片：行点击直接打开详情 tab（移除压缩的下拉菜单）

---

## v0.1.0 (2026-08-20)

### 🎉 首次发布
- 千寻回测 Python 引擎（`qianxund.py` + `qianxun_engine/`）
- DSH 侧边栏集成：批次列表（分页）、逐条结果、引擎健康监控
- 本地 PnL 缓存（`~/.dsh/qianxun/pnl/`）+ ACTIVE 同步
- 本地 SELF_CORRELATION（JS Pearson，与 BRAIN 同口径）
- BRAIN check / prod corr 代理端点（60s 缓存）
- CLI（`qianxun_cli.py`）：login/submit/status/wait/analyze/resume
- README 中英双版 + MIT License
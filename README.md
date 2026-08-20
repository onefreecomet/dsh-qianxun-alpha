# 千寻回测 (Qianxun Backtest)

WorldQuant BRAIN 回测引擎的**本地代理 + DSH 侧边栏集成**。在 DeepSeek Harness 侧边栏里直接管理回测批次、查看结果、一键提交、本地即时计算自相关性。

---

## 这个项目解决什么问题

### 没有千寻时，AI 回测是怎么样的

```
AI 生成表达式
    ↓
AI 调 BRAIN API 提交回测（直接调 brain API，每次都要认证）
    ↓
等 BRAIN 跑完（分钟到小时不等，状态是 PENDING）
    ↓
AI 再调 BRAIN 拿结果（JSON 响应，人看很累）
    ↓
AI 再调 BRAIN 拿 check 结果（SELF_CORRELATION 还是 PENDING，又要等）
    ↓
AI 手动判断 prod_corr < 0.70 才值得提交（但 PENDING 拿不到值）
    ↓
AI 每次都要重复整个流程，无法批量管理
```

**没有可视化**：AI 跑完一批，人不知道结果是什么，得切到 BRAIN 网页一个个查。
**无法批量管理**：AI 跑 100 个批次，人没有地方看进度和状态。
**自相关性是个黑箱**：SELF_CORRELATION 要等几小时甚至几天，AI 无法实时决定是否提交。
**重复劳动**：每次回测都要重新认证 BRAIN、发请求、解析响应。

### 有了千寻后，AI 回测变成什么样

```
AI 生成表达式
    ↓
AI 调千寻 REST API 提交回测（本地代理，不直接碰 BRAIN，零认证负担）
    ↓
千寻侧边栏实时显示进度：✅ 完成 5/10 · 🟡 运行中 3/10 · ❌ 失败 2/10
    ↓
千寻本地缓存 BRAIN PnL 数据，秒级响应（不用等 BRAIN）
    ↓
AI 调千寻 /api/pnl-cache/ 拿本地 PnL → 本地算 Pearson → 立即知道自相关性
    ↓
AI 调千寻 /api/alphas/<id>/check → 拿 BRAIN 的 check 结果（prod_corr 真值、所有 check 项）
    ↓
AI 立即判断：prod_corr < 0.70 → 安全提交；SELF_CORRELATION > 0.70 → 丢弃
    ↓
AI 批量管理：一键同步 ACTIVE、批量下载 PnL、批量提交回测
```

**有可视化**：侧边栏 3 行/页显示批次进度，点击展开详情。
**批量管理**：AI 调千寻 REST API，一次批量提交，分页查看，暂停/恢复/取消。
**自相关性即时计算**：下载 ACTIVE alpha PnL → 浏览器内算 Pearson → 毫秒级结果。
**本地缓存**：PnL 数据存本地磁盘，断网也能算。

---

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                    你的电脑 (localhost)                   │
│                                                         │
│  ┌──────────────────────┐     ┌──────────────────────┐  │
│  │  qianxund            │◄───│  DSH Web GUI          │  │
│  │  (Python daemon)     │     │  (浏览器侧边栏)        │  │
│  │  :8765               │     │  :3080                │  │
│  │                      │     │                        │  │
│  │  ├ /api/jobs         │     │  千寻回测 tab:          │  │
│  │  ├ /api/pnl-cache/*  │     │  • 批次列表 (分页 3/页) │  │
│  │  ├ /api/active-alphas│     │  • 逐条结果详情          │  │
│  │  └ /api/alphas/*     │     │  • 📈 prod corr        │  │
│  └──────────┬───────────┘     │  • 📐 本地 SELF_CORR   │  │
│             │                 │  • 🛡️ 稳健性快评        │  │
│             │                 │  • 📥 JSON 导入          │  │
└─────────────┼─────────────────┴────────────────────────┘
              │ HTTPS
              ▼
┌─────────────────────────────────────────────────────────┐
│         api.worldquantbrain.com (BRAIN 平台)             │
└─────────────────────────────────────────────────────────┘
```

- **qianxund**：Python daemon，代理 BRAIN API，提供本地 PnL 缓存 + ACTIVE 过滤
- **DSH 插件**：侧边栏 UI，显示在 DeepSeek Harness 右侧栏「千寻回测」tab

---

## 功能清单（按解决的问题分类）

### 1. 批次管理与可视化

**问题**：AI 跑完一批，人不知道结果是什么，得切到 BRAIN 网页一个个查。

**解决**：
- 侧边栏显示所有批次列表（每页 3 个，分页）
- 每行显示：批次名、状态（✅/❌）、进度条、完成数
- 点击任意批次行 → 直接打开详情 tab，不用再跳转
- 详情 tab 包含：逐条 alpha 结果（sharpe、fitness、turnover、margin）
- 支持暂停 / 恢复 / 断点续跑 / 取消

### 2. 一键提交回测

**问题**：AI 每次都要自己构造 settings JSON、发 HTTP 请求、处理响应。

**解决**：
- 侧边栏内「🚀 提交批次」卡片：填写 settings + 表达式 → 提交
- 📥 JSON 导入：AI 输出 JSON 文件，一键导入表单（支持 3 种格式）
- 支持：完整 BRAIN 格式、裸数组、裸字符串

### 3. 实时结果查看

**问题**：回测完后，要切到 BRAIN 网页才能看结果。

**解决**：
- 详情 tab 逐条结果表：sharpe、fitness、turnover、margin、check 状态
- 每行结果后有三个操作按钮：
  - 🔍 查 BRAIN check 详细（所有 check 项 PASS/FAIL）
  - 📈 拉取 prod correlation 真值（不用等 BRAIN PENDING）
  - 📐 本地计算 SELF_CORRELATION（见下面）

### 4. 本地自相关性即时计算

**问题**：BRAIN 的 SELF_CORRELATION 检查通常要几小时到几天才出来，AI 无法实时决定是否提交。

**解决**：
- 首次点击 📐 → 从 BRAIN 下载目标 alpha 的 PnL（10年日频，~100KB）→ 存本地磁盘
- 二次点击 → 毫秒级响应（直接读本地）
- 浏览器内用**纯 JS Pearson** 计算与所有 ACTIVE alpha 的相关性
- 结果 max = 本地 SELF_CORRELATION（与 BRAIN 同口径，差异 ≤ 0.05）
- 跟 BRAIN SELF_CORRELATION 的区别：本地是全期计算，BRAIN 是 4-year rolling

**重要**：通过「🔄 同步 ACTIVE」一次下载全 ACTIVE alpha 的 PnL，之后所有计算完全离线。

### 5. prod correlation 真值获取

**问题**：BRAIN 的 PROD_CORRELATION 检查也经常是 PENDING，AI 不知道是否超过 0.70 死区线。

**解决**：
- 点击 📈 → 直接调 BRAIN `/alphas/{id}/correlations/prod` 拿真值
- 显示：max / min / margin（0.70 - max）
- 超过死区线 → 红色警告；低于死区线 → 绿色安全

### 6. 稳健性评估

**问题**：AI 不知道哪些 alpha 已经死了（prod_corr > 0.70、LADDER 必败、字段雷区）。

**解决**：
- 详情 tab 自动显示「🛡️ 稳健性快评」
- 基于 alpha 表达式实时计算：
  - LADDER 必败：sharpe < 1.58 的 alpha 被标记为"必败"
  - prod-fresh 字段提示：使用新字段的 alpha 标记为"新"
  - 雷区字段告警：使用已知 prod_corr > 0.70 的字段的 alpha 标记为"雷区"

### 7. 同步 ACTIVE alpha 列表

**问题**：不知道 BRAIN 当前 ACTIVE 的 alpha 列表是什么，无法做批量对比。

**解决**：
- 侧边栏 header「📦 62 个 · 🟢 61 ACTIVE」实时显示
- 「🔄 同步 ACTIVE」一键下载全 ACTIVE alpha 的 PnL 到本地缓存
- 之后所有本地 SELF_CORRELATION 计算都与 BRAIN 同口径

---

## 安装（3 步，跨平台）

### 1. 安装 Python 引擎

**macOS / Linux：**
```bash
git clone https://github.com/onefreecomet/dsh-qianxun-alpha.git
cd dsh-qianxun-alpha
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

**Windows（PowerShell）：**
```powershell
git clone https://github.com/onefreecomet/dsh-qianxun-alpha.git
cd dsh-qianxun-alpha
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

配置凭据（二选一）：

```bash
# 方式 A：环境变量（推荐，跨平台通用）
export WQ_USERNAME='你的BRAIN邮箱'
export WQ_PASSWORD='你的BRAIN密码'
# Windows PowerShell: $env:WQ_USERNAME='...'; $env:WQ_PASSWORD='...'

# 方式 B：系统 keyring（GUI 登录时自动存入）
python3 qianxund.py login
```

### 2. 启动引擎

```bash
# macOS / Linux
python3 qianxund.py serve --port 8765 --concurrent 3 --batch-size 10

# Windows（PowerShell）
python qianxund.py serve --port 8765 --concurrent 3 --batch-size 10
```

验证（所有平台通用）：
```bash
curl http://127.0.0.1:8765/health
# 或 Windows PowerShell：
# Invoke-RestMethod http://127.0.0.1:8765/health
```

### 3. 安装 DSH 插件 + 重启

```bash
dsh plugin add @deepseek-ai/dsh-qianxun-tab --profile web
dsh plugin add dsh-qianxun-server --profile web
```

重启 DSH（按你的平台选一个）：

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.deepseek.dsh-web

# Linux（systemd）
systemctl --user restart com.deepseek.dsh-web

# Windows（PowerShell）
# 方法 1：任务管理器里结束 dsh-web 进程，然后重新启动
# 方法 2：如果有 launchd-like 服务：
#   net stop com.deepseek.dsh-web && net start com.deepseek.dsh-web
# 方法 3：直接在终端运行 dsh web
```

打开 http://127.0.0.1:3080，右侧栏应出现「千寻回测」tab。

---

## DSH 侧边栏功能详解

### 首次使用：同步 ACTIVE

侧边栏 header 有「📦 X 个 · 🟢 Y ACTIVE」徽章 + 「🔄 同步 ACTIVE」按钮。

点击「🔄 同步 ACTIVE」：
- 从 BRAIN 拉取当前所有 ACTIVE alpha 的 PnL 数据
- 存到 `~/.dsh/qianxun/pnl/`（磁盘持久化，断网也能用）
- 之后所有 📐 本地 SELF_CORRELATION **完全离线**

### 批次列表

每页显示 3 个批次（可调整 3/4/5/8/全部）。每个批次卡片包含：
- 批次号 + 状态 badge（✅ COMPLETE / ❌ STOPPED）
- 批次名（如 "GBR 17个"）
- 进度条 + 完成数
- 操作按钮（见下）

**行操作按钮**：
- ↻ 断点续跑（中断后继续）
- {} 查看结果 JSON
- ⇩ 下载结果 JSON
- ↻ 刷新

**点击任意批次行 → 直接打开详情 tab**（不展开下拉菜单）。

### 详情 tab

打开详情后：
- **摘要**：批次号 + 状态 + 已测数
- **逐条结果表**：alpha_id、表达式、sharpe、fitness、turnover、margin、check 状态
- **🛡️ 稳健性快评**：LADDER 必败 / 字段 prod-fresh / 雷区字段告警
- **操作按钮**：⏸ 暂停 / ▶ 恢复 / ↻ 断点续跑 / JSON / 下载

**每行结果后有三个操作按钮**（与 BRAIN 深度交互）：
- 🔍 **BRAIN check**：调 `/alphas/{id}/check`，显示所有检查项 PASS/FAIL/WARNING
- 📈 **prod corr**：调 `/alphas/{id}/correlations/prod`，显示 max/min + margin 计算
- 📐 **本地 SELF_CORRELATION**：从本地 PnL 缓存算 Pearson（ACTIVE 过滤）

### 📥 JSON 导入

在「🚀 提交批次」卡片右上角有「📥 导入」按钮。

支持 3 种 AI 输出的 JSON 格式：

```json
// 格式1：完整 BRAIN 格式（推荐）
{
  "settings": {"universe":"TOP1000","delay":1,"neutralization":"SUBINDUSTRY","decay":5},
  "expressions": ["rank(close)", "-rank(close)"],
  "name": "ai-batch-test"
}

// 格式2：裸数组
["rank(returns)", "-rank(ts_mean(close, 20))"]

// 格式3：裸字符串
"rank(close) - rank(volume)"
```

点导入 → 表单自动填好 → 点「提交」→ 引擎跑。

### 引擎 UI 链接

侧边栏右下角「引擎 http://127.0.0.1:8765」是蓝色超链接，点击打开 qianxund 原生看板（`/ui`）。

---

## CLI 用法（不用 DSH 的场景）

```bash
# 登录验证
python qianxund.py login

# 提交回测（自动去重已跑过的表达式）
python qianxun_cli.py submit outputs/gem_usa_01.json --producer ai

# 查状态
python qianxun_cli.py status B20260819-001

# 等完成
python qianxun_cli.py wait B20260819-001 --timeout 3600

# 分析结果
python qianxun_cli.py analyze B20260819-001 --limit 30

# 断点续跑（意外中断后补跑）
python qianxun_cli.py resume B20260819-001
```

---

## API 参考

千寻 qianxund 引擎（端口默认 8765）提供：

| 方法 | 端点 | 说明 | 缓存 |
|---|---|---|---|
| GET | `/api/jobs` | 批次列表 | — |
| POST | `/api/jobs` | 提交批次 `{settings, expressions, name}` | — |
| GET | `/api/jobs/<id>` | 批次详情（逐条 results）| — |
| POST | `/api/jobs/<id>` | `{"action":"cancel"/"pause"/"resume"}` | — |
| GET | `/api/pnl-cache/<id>` | 本地 PnL（miss 时自动拉 BRAIN + 写盘）| 60s |
| GET | `/api/pnl-cache` | 已缓存 alpha 列表 | — |
| POST | `/api/pnl-cache-backfill` | 启动 ACTIVE 同步（返回 job_id）| — |
| GET | `/api/pnl-cache-backfill/<job_id>` | 同步进度 | — |
| GET | `/api/alphas/<id>/check` | BRAIN 所有 check 项 | 60s |
| GET | `/api/alphas/<id>/correlations/prod` | prod corr 数值 | 60s |
| GET | `/api/alphas/<id>/pnl` | BRAIN PnL 原始代理 | — |
| GET | `/api/active-alphas` | ACTIVE alpha_ids | 5min |
| POST | `/api/pnl-cache-clear` | 清空 PnL 缓存 | — |

---

## 安全

| 项目 | 说明 |
|---|---|
| BRAIN 凭据 | 仅从 `WQ_USERNAME` / `WQ_PASSWORD` 环境变量或系统 keyring 读取，**不入源码** |
| PnL 缓存 | 存在 `~/.dsh/qianxun/pnl/`，**不出本机**，已加 `.gitignore` |
| qianxund 通信 | 默认 `127.0.0.1:8765`，仅监听本机 |
| BRAIN 限流 | 429 自动退避（5s），同步任务用 1 worker 串行 |
| prod corr 预筛 | 60s 缓存，避免反复调 BRAIN |

⚠️ `~/.dsh/qianxun/pnl/` 是 BRAIN PnL 数据的本地副本（10年日频，每 alpha 约100KB），**不要上传到任何地方**（已加 `.gitignore` 排除）。

---

## 故障排查

| 问题 | 原因 | 解决 |
|---|---|---|
| 侧边栏无「千寻回测」tab | DSH 插件未安装 | `dsh plugin add ... --profile web` + 重启（见安装第 3 步） |
| 引擎显示离线 | qianxund 未运行 | `python3 qianxund.py serve --port 8765`（macOS/Linux）或 `python qianxund.py serve --port 8765`（Windows） |
| 400 Bad Request | BRAIN 访问限制 | 检查 universe 是否在账户权限内 |
| 429 Rate Limit | BRAIN 限流 | 等待 60s，同步任务自动处理 |
| captcha 错误 | BRAIN 触发人机验证 | 去 BRAIN 浏览器手动解谜后重试 |
| SELF_CORRELATION 全 0 | PnL 缓存为空 | 点「🔄 同步 ACTIVE」 |
| 📐 按钮无响应 | BRAIN PnL 拉取失败 | 检查 BRAIN 登录状态 |
| Windows 路径报错 | 使用了旧版 Windows 硬编码路径 | 更新到最新版（已修复），确保 `data/` 在项目目录下 |
| Linux DSH 重启 | 不知道怎么重启 DSH | `systemctl --user restart com.deepseek.dsh-web` 或手动结束 dsh-web 进程后重启 |

---

## 目录结构

```
dsh-qianxun-alpha/
├── qianxund.py              ← Web 守护进程入口（REST API + Web 看板）
├── qianxun_cli.py           ← CLI 入口（login/submit/status/wait/analyze/radar）
├── qianxun_engine/          ← 核心引擎（api client + storage + scheduler）
│   ├── api/
│   │   ├── client.py        ← BRAIN API 客户端（认证/重试/rate limit）
│   │   └── config.py        ← 配置（env / keyring）
│   ├── scheduler/
│   │   └── runner.py        ← 批次调度器（multi-sim + 并发控制）
│   └── storage/
│       └── database.py      ← SQLite 持久化
├── data/                    ← 运行时数据（.gitignore）
├── pnl/                     ← PnL 缓存（.gitignore，严禁入库）
├── requirements.txt
├── .gitignore
└── README.md
```

---

**License**: MIT

# 千寻回测 (Qianxun Backtest)

WorldQuant BRAIN 回测引擎的**本地代理 + DSH 侧边栏集成**。在 DeepSeek Harness 侧边栏里直接管理回测批次、查看结果、核对自相关性——全部走本机代理，不依赖网页。

**核心价值**：BRAIN 的 SELF_CORRELATION / PROD_CORRELATION 常是 `PENDING`（等几小时到几天）。千寻在本地即时算出这些值，AI 自动跑批次时**不用等 BRAIN**。

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

## 安装（3 步）

### 1. 安装 Python 引擎

```bash
git clone https://github.com/onefreecomet/qianxun.git
cd qianxun
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
```

配置凭据（二选一）：

```bash
# 方式 A：环境变量（推荐，不写文件）
export WQ_USERNAME='你的BRAIN邮箱'
export WQ_PASSWORD='你的BRAIN密码'

# 方式 B：系统 keyring（GUI 登录时自动存入）
python3 qianxund.py login
```

### 2. 启动引擎

```bash
python3 qianxund.py serve --port 8765 --concurrent 3 --batch-size 10
# 验证
curl http://127.0.0.1:8765/health
```

### 3. 安装 DSH 插件

```bash
dsh plugin add @deepseek-ai/dsh-qianxun-tab --profile web
dsh plugin add dsh-qianxun-server --profile web
launchctl kickstart -k gui/$(id -u)/com.deepseek.dsh-web
```

打开 http://127.0.0.1:3080，右侧栏应出现「千寻回测」tab。

---

## DSH 侧边栏功能

### 首次使用：同步 ACTIVE

侧边栏顶部 header 有「📦 X 个 · 🟢 Y ACTIVE」徽章，旁边「🔄 同步 ACTIVE」按钮：

- 从 BRAIN 拉取当前所有 ACTIVE alpha 的 PnL 数据存到 `~/.dsh/qianxun/pnl/`
- 之后所有 📐 本地 SELF_CORRELATION **秒出**，完全离线

### 批次管理

| 操作 | 说明 |
|---|---|
| 点击批次行 | 直接打开详情 tab |
| ⏸ / ▶ / ↻ | 暂停 / 恢复 / 断点续跑 |
| `{}` | 在新 tab 查看结果 JSON |
| ⇩ | 下载结果 JSON |

### 详情 tab

| 功能 | 说明 |
|---|---|
| 逐条结果表 | alpha_id、表达式、sharpe、fitness、turnover、margin、check |
| 🔍 BRAIN check | 详细检查项（PROD_CORRELATION / SELF_CORRELATION / 各项 PASS/FAIL） |
| 📈 prod corr | 真 prod correlation 数值（绕过 PENDING） |
| 📐 本地 SELF_CORRELATION | 与全 ACTIVE 对比，即时算出相关性 |
| 🛡️ 稳健性快评 | LADDER 必败检测、prod-fresh 字段提示、dead-zone 字段告警 |

### 📥 JSON 导入

在「🚀 提交批次」卡片右上角「📥 导入」按钮，支持 3 种 JSON 格式：

```json
// 格式1：完整 BRAIN 格式（推荐）
{"settings": {"universe":"TOP1000","delay":1,"neutralization":"SUBINDUSTRY","decay":5},
 "expressions": ["rank(close)", "-rank(close)"],
 "name": "ai-batch-test"}

// 格式2：裸数组
["rank(returns)", "-rank(ts_mean(close, 20))"]

// 格式3：裸字符串
"rank(close) - rank(volume)"
```

### 引擎 UI 链接

侧边栏右下角「引擎 http://127.0.0.1:8765」是超链接，点击在新 tab 打开 qianxund 原生看板（`/ui`）。

---

## 本地 SELF_CORRELATION 核对

这是核心功能——**BRAIN SELF_CORRELATION 还是 PENDING 时就能立即算出相关性**。

### 原理

1. 从本地缓存（`~/.dsh/qianxun/pnl/`）拉目标 alpha 的 PnL 日频序列
2. 从本地缓存拉所有 ACTIVE alpha 的 PnL（用 ACTIVE 过滤，与 BRAIN 同口径）
3. 浏览器内用**纯 JS Pearson** 计算相关性
4. 显示结果：max = 本地 SELF_CORRELATION

### 为什么有用

| BRAIN SELF_CORRELATION | 本地计算 |
|---|---|
| 通常 PENDING（几小时~几天）| **毫秒级**（纯本地）|
| 等到 PASS/FAIL 才能决定 | **立即**决定是否值得提交 |
| 可能误报（PENDING 时返回 null）| 0.70 死区线可立即判断 |

### 缓存机制

- PnL 缓存存在 `~/.dsh/qianxun/pnl/`，磁盘持久化
- 首次点 📐 → BRAIN 拉 → 写盘 → 二次秒出
- 「🔄 同步 ACTIVE」→ 批量拉全 ACTIVE → **完全离线计算**
- 跨批次对比：用全 ACTIVE 过滤（与 BRAIN 同口径），不只是当前 batch peers

---

## CLI 用法（不用 DSH 的场景）

```bash
# 登录验证
python qianxund.py login

# 提交回测（自动去重已跑过的表达式）
python qianxund_cli.py submit outputs/gem_usa_01.json --producer ai

# 查状态
python qianxund_cli.py status B20260819-001

# 等完成
python qianxund_cli.py wait B20260819-001 --timeout 3600

# 分析结果
python qianxund_cli.py analyze B20260819-001 --limit 30

# 断点续跑（意外中断后补跑）
python qianxund_cli.py resume B20260819-001
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
| 侧边栏无「千寻回测」tab | DSH 插件未安装 | `dsh plugin add @deepseek-ai/dsh-qianxun-tab --profile web` + 重启 |
| 引擎显示离线 | qianxund 未运行 | `python3 qianxund.py serve --port 8765` |
| 400 Bad Request | BRAIN 访问限制 | 检查 universe 是否在账户权限内 |
| 429 Rate Limit | BRAIN 限流 | 等待 60s，同步任务自动处理 |
| captcha 错误 | BRAIN 触发人机验证 | 去 BRAIN 浏览器手动解谜后重试 |
| SELF_CORRELATION 全 0 | PnL 缓存为空 | 点「🔄 同步 ACTIVE」 |
| 📐 按钮无响应 | BRAIN PnL 拉取失败 | 检查 BRAIN 登录状态 |

---

## 目录结构

```
qianxun/
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

# 更新日志 (Changelog)

本项目版本号跟随 GitHub Release tag：`v0.1.0` / `v0.2.0` / `v0.3.0` …

---

## v0.3.0 (2026-08-27)

### ⚡ 启动引擎 — 真正一键拉起
- 新增 **常驻启动器 `qianxund-start-server.py`**（HTTP 127.0.0.1:8766，launchd `com.qianxund-start` 托管，永远在线）
- 侧边栏「⚡ 启动引擎」按钮**真正能启动引擎**：点击 → 启动器 `POST /api/start` → launchd kickstart 拉起 qianxund → 轮询等就绪
- 离线时按钮显示"⚡ 启动中…"+ 禁用，成功转绿"🟢 引擎在线"，失败给明确提示
- 引擎由 launchd `com.qianxund`（KeepAlive）托管，崩溃自动重启（实测 kill 后 3 秒拉起）

### 🎨 侧边栏 UI 优化
- **引擎配置卡片**精简：标题去掉"/ 配额"、输入框紧凑化（72px 居中）、删冗余"当前并发"行
- **配额 chip 移到 header 最上方**：`🧠 千寻回测 · 今日0·剩—`，紧跟标题
- 删除 header 左侧冗余的"引擎在线"文字（右侧按钮已显示状态）
- **默认并发 6 / 批大小 8**（launchd plist + 启动器同步修改）

### 🐛 修复
- 引擎离线状态检测：前端 `/health` 探测 + 启动器 `/api/status` 双确认
- 引擎配置卡片移除未使用的 `config` state（避免 TS 告警）

### 📦 涉及文件
- 新增 `qianxund-start-server.py` + `~/Library/LaunchAgents/com.qianxund-start.plist`
- 修改 `~/Library/LaunchAgents/com.qianxund.plist`（并发 3→6，批大小 10→8）
- 修改前端 `QianxunTab.tsx` / `QianxunTab.module.css`

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
# @deepseek-ai/dsh-qianxun-tab

把「千寻回测控制台」做成 **dsh-better-sidebar 的自定义 tab** 的独立 client-plugin 包。

- 通过 `ctx.betterSidebar.registerTab({ id: 'qianxun', … })` 在
  dsh-better-sidebar (≥v0.4) 的侧边栏注册 tab（`千寻回测` / `千寻结果` / `提示词`）。
- tab 内容组件直连本地千寻回测引擎 REST API（默认 `http://127.0.0.1:8765`，
  可用 URL 参数 `?qianxun=` 覆盖）：批次列表、逐条结果详情、控制（暂停/恢复/取消/断点续跑）、
  手动提交、5 秒轮询。
- **v2.0 新增**（在「千寻结果」页）：
  - ⭐ **Alpha 自选池**：存 alpha_id → 12 列表格（状态 / region / alpha_id（⧉ 复制）/ sharpe /
    fitness / ret% / to% / margin（万分之一）/ selfcorr / prodcorr / 备注 / 操作）；
    备注可直接在格子里写；`🔄 同步` 一次刷新整池
  - 📈 **今日新增 active**：以上一次本地 12:00 的 ACTIVE 集合为基准线，跨 12:00 自动重置
  - ⚡ **提交到平台**：先拉 check 把 FAIL 项摊在确认框里，再两道确认才真提交；
    异步任务 + 逐条进度；「续查」只轮询不重复 POST。
    ⚠️ 提交不可逆，**agent / 脚本不得代为调用**（引擎侧硬校验 `confirm` token）

## 结构

```
src/
  index.ts            Node（宿主）半区：提示词服务端存储 + /api/dsh-qianxun-tab/prompts 路由
  css-modules.d.ts    *.module.css 类型声明
  web-server.ts       宿主侧 webServer 服务类型
  client/
    index.ts           client 半区入口：inject:['betterSidebar'] + apply(ctx) 里 registerTab
    QianxunTab.tsx     批次列表 tab
    QianxunDetailTab.tsx  批次详情 / 千寻结果 tab（挂 AlphaPoolCard）
    AlphaPoolCard.tsx  v2.0：Alpha 自选池 + 提交闸
    PromptEditTab.tsx  提示词编辑 tab
    QianxunTab.module.css
    qianxun.ts         CORS 安全 REST 客户端（自选池/提交/当日 active 都在这）
    format.tsx        指标格式化、check 徽章、逐条结果表
    wq-eval.ts        提交前评估常量（margin 档位、prod 死区线、雷区字段）
    better-sidebar.ts 本地结构性 betterSidebar 服务类型
cordis.patch.yml      dsh.bundle.patch 挂载层
tsconfig.json / tsdown.config.ts
lib/                  构建产物：index.js（宿主）+ client.js（浏览器 bundle）+ types/
```

## 安装

本仓库自带已构建的 `lib/`，可以直接从本地路径装：

```bash
dsh plugin add /path/to/dsh-qianxun-alpha/dsh-qianxun-tab --profile web
```

> 注意：本包的 `package.json` 目前是 `"private": true`，所以**不能**发布到 npm。
> 若要走 `dsh plugin add @deepseek-ai/dsh-qianxun-tab` 那种按包名安装，需要先去掉 `private`
> 并发布到 registry。

## CORS 关键

引擎 `GET` 直接 fetch 即可（`Access-Control-Allow-Origin: *`）；写操作（`POST`）因引擎对
`OPTIONS` 返回 501，需用 `Content-Type: text/plain;charset=UTF-8` 携带 JSON body（CORS 简单请求，
不触发预检）。见 `src/client/qianxun.ts`。

## 构建

`src/` 是 deepseek-harness monorepo 里的包（`packages/extensions/ui-qianxun-tab`），
它的 `tsdown.config.ts` 复用 monorepo 的共享 client-bundle 预设（`../../client/tsdown.client.ts`），
**因此离开 monorepo 无法直接构建**。在 monorepo 内：

```sh
node_modules/.bin/tsc -b --force packages/extensions/ui-qianxun-tab/tsconfig.json
pnpm --filter @deepseek-ai/dsh-qianxun-tab run bundle
```

产物：`lib/index.js`（宿主半区）、`lib/client.js`（浏览器 client bundle）、`lib/types/**/*.d.ts`。

构建后有个收尾步骤：`lib/client.js` 里 CSS region 注释会带上一段**构建机的绝对路径**，
提交前裁成相对路径，避免把本机路径带进公开仓库：

```sh
sed -i '' 's|/Users/<you>/deepseek-harness/packages/extensions/ui-qianxun-tab/||g' lib/client.js
```

## 挂载到运行中的 web

作为独立 client-plugin 进 profile：安装该包后，`cordis.patch.yml`（`dsh.bundle.patch`）把
node 空 apply 挂进 bundle stack；client 半区通过 `exports["./client"]` / `dsh.client.platform=web`
被发现，并在 `apply` 里向 `ctx.betterSidebar` 注册 tab——于是 better-sidebar 侧边栏出现
「千寻回测」tab。

client bundle 是**运行时按需从磁盘读取**的（`/api/plugins/<id>/client.js`），
所以改完 `lib/client.js` **刷新页面即可生效**，不必重启 DSH；只有改 Node 半区
（`lib/index.js`）才需要重启。

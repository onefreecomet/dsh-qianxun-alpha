---
name: wq-qianxun-ai-loop-mac
description: "千寻 headless（Mac 版）AI 迭代挖掘闭环。当用户要求「生成一批 alpha 表达式 / 按 GEM 原理生成 N 个 / 批量回测 / 读取回测结果分析 / 下一轮定向再生成 / AI批次导入 / 迭代挖因子」且运行环境是 macOS 时使用。覆盖：GEM 多数据字段表达式生成规则、qianxun_cli.py 批量回测命令、本地 SQLite 库读取、信号灯分析口径与定向再生成方法。目标是把「AI 生成 → CLI 回测 → 读库分析 → 策略纪要 → 定向再生成」的循环标准化，任何会话的 AI 都能按同一套协议执行。"
---

# 千寻 AI 迭代挖掘闭环（Mac headless 版，wq-qianxun-ai-loop-mac）

## Overview

本 skill 是 `wq-qianxun-ai-loop` 的 **macOS 移植版**。Windows 千寻的「AI批次」功能
核心引擎（BRAIN API 封装 + 批量回测调度 + SQLite 存储）是平台无关的纯 Python，
已裁剪为 `qianxun_engine/` 包 + `qianxun_cli.py` 命令行入口，Mac 上无需安装
PySide6、无需千寻 GUI，AI 直接通过 CLI 驱动完整闭环：

    AI 生成表达式 JSON → qianxun_cli submit 批量回测 → 入库
    → analyze 读库 + radar 信号灯 → 策略纪要 → 定向再生成下一轮

核心资产：
- `../references/gem_rules.md`：GEM 表达式生成规则（词根配对、六类构造、字段包装、FASTEXPR 约束、JSON 文件格式）
- `../references/qianxun_schema.md`：SQLite schema（表结构、指标口径、读库 SQL）
- `../references/iteration_protocol.md`：迭代协议（批次号、生产者、去重、策略纪要模板、配额纪律）
- `../qianxun_cli.py`：CLI 入口（本目录的上级目录，即 qianxun-mac/ 根）

## 前置：凭据（环境变量）

Mac 上只走环境变量，不写进任何文件：
```bash
export WQ_USERNAME='BRAIN账号邮箱'
export WQ_PASSWORD='BRAIN密码'
# 建议加进 ~/.zshrc 或 ~/.bashrc
```
验证：`python qianxun_cli.py login` 输出「✅ 登录成功」。

## 工作流决策树

用户意图 → 走哪一步：

1. **「生成一批表达式」**（含"按 GEM 原理生成 N 个"）→ Step 1 生成表达式
2. **「回测完了，分析结果」** / 「读库看看这批怎么样」→ Step 3 读库分析
3. **「下一轮」** / 「根据结果再生成」→ Step 4 定向再生成（先读上一轮纪要）
4. **「提交这批跑一下」** → Step 2 直接跑 CLI

## Step 1：生成表达式（GEM 规则）

按 `../references/gem_rules.md` 执行：

1. **先拉真实字段列表**（BRAIN API `get_datafields` 或平台 UI），字段名必须精确匹配 dataset，禁止臆造
2. **算子名查表**：打开 `../references/operators_reference.md`（82 个 REGULAR 算子官方清单），算子名必须精确匹配，禁止编造；优先高频组合（ts_rank/ts_zscore/ts_delta/rank/zscore/winsorize）
3. 按词根语义配对（call-put / pos-neg / act-est / buy-sell / acquire-disposal 等，完整对立表见 gem_rules.md）
4. **模板库参考**：打开 `../references/templates_reference.md`（17 部分社区实战模板），按研究目标选模板、替换占位符
5. 对每对字段按构造方式生成表达式（比率 (A-B)/(A+B)、差值、乘积、加总、变化率差、事件驱动）
6. VECTOR 字段先 `vec_avg` 包装；默认 `winsorize(ts_backfill(x,120), std=4)` 包装
7. 输出 **JSON 包装文件**（qianxun_cli submit 直接可跑，settings 内嵌自动填充）：
   ```json
   {"settings": {"region": "USA", "universe": "TOP3000", "delay": 1,
    "neutralization": "SUBINDUSTRY", "truncation": 0.08, "decay": 1},
    "expressions": [{"expression": "...", "decay": 1, "rationale": "一句中文理由"}]}
   ```
   settings 取值查 `../references/settings_reference.md`
8. 生成前查库去重：submit 时 CLI 自动跳过已回测过的表达式（expr_key 指纹），无需手动处理

## Step 2：提交回测（CLI 直调）

AI 在终端（或 subprocess）直接跑，全部输出可见：

```bash
python qianxun_cli.py submit outputs/gem_xxx.json --producer 阿法
# 可选：--batch-size 8 --concurrent 3（默认即 8/3）；--db 指定其他库
```

- CLI 自动：去重 → 生成批次号 B+YYYYMMDD-序号 → 批量回测（多线程调度，429 自动退避）→ 回填 alpha 详情入库 → 批次 completed
- **批次完成检测**：
  1. `python qianxun_cli.py wait <批次号> --timeout 3600`（前台阻塞；超时返回非 0，可再 wait 或查 status）
  2. `python qianxun_cli.py status --batch <批次号>`（随时查）
- **断点续跑**：意外中断后 `python qianxun_cli.py resume <批次号>` 补跑 pending 模拟
- **批次号规则**：submit 输出会打印批次号（如 B20260818-001），记下它，后面 analyze/radar/wait 都用它

## Step 3：读库分析（必跑信号灯）

按 `../references/qianxun_schema.md` 执行：

1. 库文件：默认 `data/alpha_machine.db`（qianxun-mac 根目录下；--db 可指定）
2. 只读方式查询（AI 只读不写，回测/回填由 CLI 负责）
3. 按批次号取结果：`python qianxun_cli.py analyze <批次号> --limit 50`（已按 |sharpe| 降序输出表格）
4. **跑信号灯系统**（Direction Radar，来源 WQ 论坛帖 39319955780887）：
   ```bash
   python qianxun_cli.py radar <批次号> --passed N --total M
   ```
   输出四色信号 + DSI 分 + 依据 + 护栏触发 + 建议行动：
   - 🟢 GREEN：均值显著 >1 且稳定 → 加码深挖、细化参数
   - 🟡 YELLOW：证据不足/小样本/单高个/算子族单一 → 谨慎继续、拓宽鱼饵
   - 🔴 RED：信号弱 → 做一次结构性改动再评估
   - ⚫ DEAD：三重证据齐备（样本够大 AND 均值低 AND 天花板低）→ 记录 anti-pattern 换方向
   - 护栏（防误杀）：小样本保护 / 天花板保护 / 双峰保护 / 三重证据 / 趋势保护
5. 结合信号灯结果看明细：|sharpe| 分布、check_status、margin、turnover、returns；重点看**无 FAIL 红牌**的候选（WARNING 黄牌不阻断）
6. 输出策略纪要（见 `../references/iteration_protocol.md` 模板），信号灯结论放纪要开头

## Step 4：定向再生成

按 `../references/iteration_protocol.md` 执行：
- 依据 Step 3 的信号灯结论定向：
  - GREEN → 同方向细化（decay/truncation/窗口/构造变体）
  - YELLOW（算子族 ≤2）→ 先拓宽算子族和构造方式，别急着判死
  - RED → 做一次结构性改动（换字段组合/构造/算子类型）再评估
  - DEAD → 换 dataset 或换信号逻辑，记录 anti-pattern
- 禁止盲目重撒；每轮要有明确假设，批量按信号灯阶段定（探测 100-200 / 加码 200-500 / 结构改动 100）
- **批次内对照（必须）**：每批首条放上一轮最优做 control 对照位；加码轮留 5-10% 反向/消融证伪位（iteration_protocol.md §8）
- **单变量纪律**：一轮只动一个维度（字段对/构造/settings 三选一，iteration_protocol.md §9）
- 保持批次协议：新文件新批次，不覆盖旧批次
- 好候选过 submission check（可用 wq-alpha-robustness-search skill）才能提交

## Step 5（可选增强）：论文预搜索

对"有苗头但证据不足"的方向（YELLOW），可选做论文预搜索：
用 WebSearch 按字段描述关键词搜近年学术论文（优先 2020+），提取经济学逻辑，
写进 idea 后定向再生成，给表达式搭学术地基。注意 token 消耗大，只对值得深挖的方向做。

## 纪律（硬性）

- **批量按信号灯阶段定**：用户一天可跑 5000 次，配额不是约束。探测轮 100-200 / 加码轮 200-500 / 结构改动轮 100；无效探索（DEAD）及时止损换方向
- **可归因纪律**：每批带 control 对照位与证伪位（§8）、一轮只动一个维度（§9）、分析收尾过陷阱检查（§10）、差一点点但有价值的候选记方向种子（§11）
- **字段真实性**：任何表达式字段名必须来自真实 dataset 字段列表
- **只读分析**：AI 读库用只读连接，不写库（回测/回填由 CLI 负责）
- **提交红线**：未经用户明确确认绝不提交 alpha（本 CLI 只做 simulation，不做 submission）
- **凭据纪律**：账号密码只在环境变量里，禁止写进 JSON/脚本/纪要

## Resources

- `../references/gem_rules.md`：生成表达式前必读（词根表、六类构造、示例）
- `../references/templates_reference.md`：模板库（17 部分社区实战模板）
- `../references/operators_reference.md`：算子查表（82 个 REGULAR 算子官方清单）
- `../references/settings_reference.md`：settings 查表（region/universe/中性化/decay/truncation）
- `../references/qianxun_schema.md`：读库前必读（schema、SQL、指标口径）
- `../references/iteration_protocol.md`：策略纪要模板 + 迭代纪律
- `../qianxun_cli.py`：CLI 帮助：`python qianxun_cli.py --help`

# GEM 表达式生成规则

GEM = 多数据字段（Gem），核心是「至少两个字段、利用字段间的经济含义关系组合出新指标」。
与一阶（单字段 × 算子）互补：一阶扫场用，GEM 挖字段关系用。

## 1. 词根语义配对

把字段 id 按下划线拆 token（`insd3_form4_bnum` → `["insd3","form4","bnum"]`），
两个字段满足以下条件即配对：
1. **公共前缀 ≥ 2 个 token**（如 `insd3_form4_`）
2. 剩余 token 中存在对立词根

### 完整对立词根表（PAIRS）

| 组 | 词根对 |
|----|--------|
| 期权方向 | call ↔ put |
| 情感极性 | positive ↔ negative、pos ↔ neg |
| 实际 vs 预期 | actual ↔ estimated、act ↔ est、actual ↔ expected |
| 交易方向 | buy ↔ sell、buying ↔ selling、purchase ↔ sale |
| 报价 | bid ↔ ask |
| 持仓 | long ↔ short |
| 级别 | high ↔ low |
| 流向 | in ↔ out、up ↔ down、up ↔ dn（down 缩写，analyst15 实测）、inflow ↔ outflow |
| 内幕交易 | acquire ↔ disposal、acquire ↔ dispose |
| 财务 | asset ↔ liability、revenue ↔ expense、income ↔ expense、receivable ↔ payable |
| 期限 | current ↔ noncurrent、shortterm ↔ longterm、short_term ↔ long_term |
| 盈亏 | credit ↔ debit、profit ↔ loss、gain ↔ loss |
| 其他 | borrow ↔ lend、issuer ↔ holder、bullish ↔ bearish、upgrade ↔ downgrade、open ↔ close、opening ↔ closing |

### 前缀对立（PREFIX_PAIRS）

一方以 X 开头、另一方以 Y 开头，**且去掉首字母后其余部分相同**才配对
（排除 bnum↔svol 这种单位错配）：
- `b` ↔ `s`（buy/sell 缩写，如 bnum↔snum、bvol↔svol）
- `buy` ↔ `sell`
- `long` ↔ `short`

## 2. 六类构造方式

输入 A、B 为两个字段（已包装的表达式片段）：

| 方式 | 表达式 | 语义 |
|------|--------|------|
| 比率 | `(A - B) / (A + B)` | 净占比（最常用，如净买入占比） |
| 差值 | `(A) - (B)` | 净变动 |
| 乘积 | `(A) * (B)` | 规模/金额 |
| 加总 | `(A) + (B)` | 综合指标 |
| 变化率差 | `ts_delta(A, 20) - ts_delta(B, 20)` | 两字段动能差异 |
| 事件驱动 | `if_else(A > B, A, 0)` | 条件触发 |

默认推荐：比率 + 差值（信息量高、噪音低）。其余按研究假设选用。

## 3. 字段包装规则

- VECTOR 类型字段必须先 `vec_avg(fid)` 转 MATRIX 才能参与算术
- 默认包装：`winsorize(ts_backfill(field_expr, 120), std=4)`（与千寻一阶一致）
- 包装后的配对表达式示例：
  `(winsorize(ts_backfill(insd3_form4_bnum, 120), std=4) - winsorize(ts_backfill(insd3_form4_snum, 120), std=4)) / (winsorize(ts_backfill(insd3_form4_bnum, 120), std=4) + winsorize(ts_backfill(insd3_form4_snum, 120), std=4))`

## 3b. 反转挖掘（Sharne 对称性，实战验证 2026-08-14）

**强负信号是白捡的候选**：Sharpe 对称，`-alpha` 的 sharpe = `-(alpha 的 sharpe)`。
-1.5x 的信号在表达式外层加负号 `-(expr)` 反转后就是 +1.5x；平台 check 的 LOW_SHARPE 看正方向，反转可救活负信号。

每轮分析后必做：扫描库内 `sharpe < -0.7` 的表达式（跨批次、去重），生成 `-(expr)` 反转版 + 原字段的正向结构变体（换 rank/group_rank/衰减窗口，解决 turnover/集中权重/2Y 问题）。

实测案例：totalliab 归一化 ts_rank22 原 sharpe=-1.57（B20260813-003），反转预期 +1.57，几乎直接过平台线 1.58。

## 4. FASTEXPR 语法硬约束

- 单行表达式，无分号结尾
- 字段名必须精确匹配所选 dataset 的真实 datafield id
- 只使用 BRAIN 标准算子（`ts_` 前缀时序、`group_` 分组、`rank/zscore/quantile/normalize` 等横截面）
- 非法字符（中文、Python 语法、多余括号）直接导致模拟失败，浪费配额
- **禁止科学计数法**：`1e-9`、`1E-5` 这类写法平台不认（实测报 `Unexpected character 'e'`，整批 90+ 个失败）。需要加微小常数时用普通小数（如 `0.001`）或直接省略；生成后必须做语法自检（正则 `\d+e[+-]?\d+`）
- 生成后自检清单：无科学计数法、无分号、无中文、括号配平、字段名全部来自真实字段集

## 5. 输出文件格式（千寻 AI批次 Tab 可导入）

JSON 包装格式（**推荐，AI 生成必须带 settings，用户导入后无需手填模拟参数**），UTF-8：

```json
{
  "settings": {
    "region": "USA",
    "universe": "TOP3000",
    "delay": 1,
    "neutralization": "SUBINDUSTRY",
    "truncation": 0.08,
    "decay": 1
  },
  "expressions": [
    {"expression": "(A - B) / (A + B)", "decay": 1, "rationale": "净买入占比，内部人行为信号"},
    {"expression": "ts_rank((A) - (B), 22)", "decay": 1, "rationale": "净变动 22 日排名"}
  ]
}
```

- `settings`：千寻导入时自动填充 UI（region/universe/delay/neutralization/truncation/decay/pasteurization）。
  **中性化值必须用平台当前大写枚举**（SUBINDUSTRY / MARKET / SECTOR / REVERSION_AND_MOMENTUM / STATISTICAL / CROWDING 等，
  大小写不敏感匹配但建议直接大写）；region 必须是 REGIONS 内合法值，universe 必须在该 region 的合法列表内。
- `expressions`：每条含 expression（必填）、decay（缺省 1）、rationale（一句中文理由，对账/分析用）
- 千寻解析器兼容旧格式：纯 JSON 数组 / 字符串数组 / 每行一个的纯文本（无 settings 时用户手动填参数）

## 6. 生成前必做

1. 拉真实字段列表（`get_datafields(dataset_id, region, universe, delay)`）
2. 查千寻库已回测表达式，跳过重复（`completed_expression_keys`）
3. 若字段无对立词根可配对，换 dataset 或提示用户加词根表

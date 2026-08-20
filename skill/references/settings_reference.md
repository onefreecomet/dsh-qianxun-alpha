# BRAIN Simulation Settings 参考

> 来源：官方 Learn 文章（project020 本地抓取，2026-07-17）+ 千寻 settings_registry
> （平台 get_platform_setting_options 实测，2026-08-07）。
> AI 生成表达式文件的 settings 块时，**所有取值必须符合本表**，特别是中性化用大写枚举。

## 1. 总览

Settings 是模拟的全局参数，决定"在什么市场、用什么数据时点、怎么处理仓位"。
千寻 AI 批次 Tab 导入文件时自动填充，AI 生成时必须写对。

参数：language、instrumentType、region、universe、delay、decay、truncation、
neutralization、pasteurization、nanHandling、unitHandling、testPeriod。

## 2. Region 与 Universe（千寻合法值，平台实测）

Universe = 交易标的池（按日均成交额选出的流动性最高的一批股票）。
不同 region 的 universe 不同，**universe 必须属于该 region 的合法列表**：

| Region | 合法 Universe |
|--------|--------------|
| USA | TOP3000、TOP2000、TOP1000、TOP500、TOP200、ILLIQUID_MINVOL1M、TOPSP500 |
| GLB | TOP3000、MINVOL1M、MINVOL10M、TOPDIV3000 |
| EUR | TOP2500、TOP1200、TOP800、TOP400、ILLIQUID_MINVOL1M、TOPCS1600 |
| ASI | MINVOL1M、MINVOL10M、ILLIQUID_MINVOL1M、TOP500 |
| CHN | TOP2000U |
| KOR | TOP600 |
| HKG | TOP800、TOP500 |
| IND | TOP500 |
| MEA | TOP400、TOP300 |
| DEU | TOP500 |
| GBR | TOP700 |
| AMR | TOP600（用户补充，平台无选项） |
| TWN / JPN / EDU | TOP3000、TOP2000、TOP1000、TOP500、TOP200（兜底） |

默认 universe = 列表第一个（USA=TOP3000）。缺省推荐 TOP3000（高流动性）。

## 3. Delay（数据时点）

Delay = 从"看到数据"到"成交"的滞后天数：
- **Delay 0（D0）**：当天盘中用最新数据交易，捕捉隔夜收益/突发事件的快信号
  - 只有部分 dataset 有 D0 字段；目前仅 USA、EUR、CHN 有 D0
  - 换手更高，需要更高 Sharpe 和 returns 覆盖成本
  - 建议用流动性高的 universe（TOP1000 及以上）
  - 好 D0 alpha 在 D1 下应保留部分表现
- **Delay 1（D1）**：用前一日数据、次日交易，标准稳健选择
- **千寻默认 delay=1**，AI 生成无特殊理由用 1

## 4. Decay（信号衰减）

对过去 n 天做线性衰减平滑（衰减加权平均），降低换手：
- 合法值：整数 n ≥ 0；负数/小数会破坏模拟
- 提示：decay 可降换手，但过大衰减信号
- 千寻默认 1；高换手表达式可试 5-22

## 5. Truncation（单股权重上限）

组合中单只股票的最大权重：
- 合法值：0 ≤ x ≤ 1（0 = 不限）；超范围破坏模拟
- 推荐：0.05 到 0.1（5%-10%），防过度暴露单股
- 千寻默认 0.08

## 6. Neutralization（中性化，核心）

把 alpha 向量按分组去均值，实现多空中性，控制市场/行业风险暴露。

### 各类型含义

| 类型 | 含义 |
|------|------|
| MARKET | 全市场去均值（alpha - mean(alpha)），市场中性 |
| SECTOR | 按板块分组去均值 |
| INDUSTRY | 按行业分组去均值 |
| SUBINDUSTRY | 按子行业分组去均值（最细） |
| COUNTRY | 按国家分组（EUR/ASI/GLB 可用） |
| REVERSION_AND_MOMENTUM | 反转+动量风险因子中性（新） |
| STATISTICAL | 统计风险因子中性（新） |
| CROWDING | 拥挤度风险因子中性（新） |
| FAST / SLOW / SLOW_AND_FAST | 快/慢/快慢风险因子中性（新） |
| NONE | 不做中性化（仅当表达式内已手动 group_neutralize 时才用） |

### 千寻合法值（按 region，平台实测）

- USA/CHN/KOR/HKG/IND/DEU/GBR/TWN/JPN/EDU：NONE、REVERSION_AND_MOMENTUM、
  STATISTICAL、CROWDING、FAST、SLOW、MARKET、SECTOR、INDUSTRY、SUBINDUSTRY、SLOW_AND_FAST
- GLB/EUR/ASI：上述 + COUNTRY
- MEA：NONE、MARKET、SECTOR、INDUSTRY、SUBINDUSTRY、COUNTRY
- AMR：NONE、MARKET、SECTOR、INDUSTRY、SUBINDUSTRY（用户补充）

**大小写必须是大写枚举**（SUBINDUSTRY 不是 subindustry）。

### 按数据集类型的官方推荐

| 数据集类别 | 推荐中性化 | 理由 |
|-----------|-----------|------|
| Fundamental（基本面） | INDUSTRY | 公司基本面影响因行业而异 |
| Analysts（分析师） | INDUSTRY | 同基本面逻辑 |
| News（新闻） | SUBINDUSTRY | CEO 变更对同行业不同公司影响不同 |
| Insider（内部人） | INDUSTRY、SUBINDUSTRY | 同上 |
| Sentiment（情绪） | INDUSTRY、SUBINDUSTRY | 同上 |
| Social Media（社交媒体） | INDUSTRY、SUBINDUSTRY | 同上 |
| Earnings（财报） | INDUSTRY | 同基本面逻辑 |
| Short Interest（做空） | INDUSTRY | 推荐 |
| Institutions（机构） | SECTOR、INDUSTRY | 视数据类型 |
| Options（期权） | MARKET、SECTOR | 期权影响跨行业相近 |
| Price Volume（价量） | MARKET、SECTOR | 通用逻辑，行业中性化反而降表现 |
| Macro（宏观） | MARKET、SECTOR、INDUSTRY | 宏观事件跨子行业差异不大 |
| Model（模型） | 全试 | 视子类而定 |

### group_neutralize 关系

- Settings 里的 Neutralization 与 `group_neutralize(x, group)` 等价
- 若表达式最后一步是 `group_neutralize`，则 Settings 应设 NONE + Decay 0 + Truncation 0
- 通用纪律：永远选一个中性化值，除非表达式已手动包含

## 7. Pasteurization（数据清洗）

- ON（默认）：不在所选 universe 内的标的输入值置为 NaN（只保留 universe 内数据）
- OFF：保留全部可用输入；手动用 `pasteurize(x)` 算子
- 用横截面/group 算子时建议 ON

## 8. NaN Handling

- ON：NaN 按算子类型处理（时序全 NaN 返回 0；group 返回组值），覆盖率更高但有歧义
- OFF（默认）：保留 NaN，需手动处理（如 `is_nan(ts_zscore(x,252)) ? ... : ...`）
- 千寻默认 ON

## 9. Unit Handling

- VERIFY：表达式里单位不兼容（如 price + volume）时给警告
- 千寻默认 VERIFY

## 10. AI 生成文件的推荐 settings 模板

```json
{
  "settings": {
    "region": "USA",
    "universe": "TOP3000",
    "delay": 1,
    "neutralization": "SUBINDUSTRY",
    "truncation": 0.08,
    "decay": 1
  }
}
```

选择规则：
- region/universe/delay 由用户研究范围决定（问用户或按批次主题）
- neutralization 按上面"数据集类别推荐表"选（基本面/分析师/内幕/情绪 → INDUSTRY 或 SUBINDUSTRY；
  价量/期权 → MARKET 或 SECTOR；不确定 → SUBINDUSTRY）
- truncation 0.05-0.1，默认 0.08；decay 默认 1，高换手方向试 5-22
- delay 默认 1；只有用户明确要 D0 方向才用 0（并确认 dataset 有 D0 字段）

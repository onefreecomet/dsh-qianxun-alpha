# 千寻数据库 schema 与读库指南

## 1. 库文件位置

- **Mac headless 版**：`qianxun-mac/data/alpha_machine.db`（qianxun_cli.py 默认路径，可用 `--db` 指定其他库）
- Windows 千寻（源码运行）：`project026_AlphaMachine/data/alpha_machine.db`
- Windows 千寻（打包版）：`project026_AlphaMachine/dist_vNN/AlphaMachine/data/alpha_machine.db`，每个 dist 独立 data
- 确认版本：`ls dist_v* | sort -V | tail`，别凭记忆
- 程序可能正在运行（SQLite 支持多读单写），AI 读库用**只读模式**避免锁冲突：
  ```python
  import sqlite3
  conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
  conn.row_factory = sqlite3.Row
  ```

## 2. 核心表结构

### alphas（回测成功的 alpha，主表）

| 列 | 含义 |
|----|------|
| alpha_id | 平台 ID（主键） |
| expression | 表达式原文 |
| sharpe | 夏普比率（IS 模拟期） |
| returns | 模拟期收益（小数，0.0195 = 1.95%） |
| fitness | 综合分数 |
| turnover | 换手率 |
| margin | 边际（小数，0.0016 = 16 bps） |
| long_count / short_count | 多空数量 |
| decay / region / neutralization | 参数快照 |
| date_created | 创建日期 |
| pnl_json | 日度 PnL JSON |
| check_pc | 最近 submission check 的 PROD_CORRELATION |
| check_failed | FAIL 项（逗号分隔；NULL/空 = 无 FAIL） |
| check_status | pass / warn / fail（warn = 无 FAIL 但 \|pc\|>0.7） |
| batch_no | AI 批次号（B+YYYYMMDD-序号，对账锚点） |
| retrieved_at | 回填时间 |

### ai_batches（AI 批次元数据）

| 列 | 含义 |
|----|------|
| batch_no | 批次号（主键） |
| producer | 生产者（哪个 AI / 人） |
| dataset_id / region | 来源数据集 / 区域 |
| expression_count | 该批表达式数 |
| status | pending / running / completed / failed |
| note | 备注（导入时去重统计等） |
| created_at / updated_at | 时间 |

### task_runs（任务）

id、name、kind（first_order/second_order/third_order/gem/ai_batch）、
config_json、status、total、success、failed、**batch_no**

### simulations（每条模拟）

task_run_id、expression、decay、settings_json、expr_key（去重指纹）、
alpha_id、status（pending/submitted/completed/failed）、progress、last_error

### submissions（提交历史）

alpha_id、status_code、message、ok（1=成功）、submitted_at

### ai_control（AI 协作控制，单行 v61+）

mode（manual/auto，是否 AI 接管）、auto_loop（0/1 自动循环）、
max_rounds（最大轮次）、max_per_round（单轮上限）、current_round（已完成轮次）、
ai_state（空闲/生成中/回测中/分析中/停止中）、stop_requested（1=用户请求停止）

### ai_commands（AI 命令队列 v61+）

command（run_batch/stop/set_mode）、payload（JSON：{path, producer}）、
status（pending/executed/cancelled）、created_at、executed_at

### ai_timeline（AI 操作时间线 v61+）

ts、level（info/success/warn）、message（保留 200 条）

## 3. 常用读库 SQL

```sql
-- 按批次取结果（按 |sharpe| 降序，AI 分析主查询）
SELECT * FROM alphas WHERE batch_no=? ORDER BY ABS(sharpe) DESC;

-- 某批次统计
SELECT COUNT(*) AS n, SUM(CASE WHEN check_status IN ('pass','warn') THEN 1 ELSE 0 END) AS ok
FROM alphas WHERE batch_no=?;

-- 未提交的可用候选（过 check 且未提交）
SELECT * FROM alphas a
WHERE a.batch_no=?
  AND a.check_status IN ('pass','warn')
  AND NOT EXISTS (SELECT 1 FROM submissions s WHERE s.alpha_id=a.alpha_id AND s.ok=1)
ORDER BY ABS(a.sharpe) DESC;

-- 全部批次列表（对账）
SELECT * FROM ai_batches ORDER BY created_at DESC;

-- 已回测表达式指纹（生成时去重用）
SELECT DISTINCT expr_key FROM simulations WHERE status='completed' AND expr_key IS NOT NULL;
```

## 4. 指标分析口径

- **硬卡**：CLUSTER_TEST=ERROR / FAIL 红牌 → 不可用。**CLUSTER_TEST=WARNING 黄牌
  （LOW_2Y_SHARPE、UNITS、POWER_POOL_CORRELATION、MATCHES_* 等）不阻断**，
  pass 和 warn 都可提交（实测验证）
- |sharpe| 分布：中位数 vs 头部；GLB/IND 等小盘区可接受更低
- margin：> 0 且越大越好（bps）；turnover：过高（>20%）费用侵蚀
- returns 与 sharpe 一致性：高 sharpe 负 returns 要警惕
- check_pc：|pc| > 0.7 记 warn（警示但可提交）；无 FAIL 是底线

## 5. 分析输出（回给用户/纪要）

对每轮批次输出：
1. 总览：回测成功 N / 去重跳过 M / 过 check 无红牌 X
2. 分布：|sharpe| 前 10 名单（alpha_id + expression + sharpe + margin + check）
3. 模式挖掘：有效字段族（哪些配对方向表现好）、有效构造方式（比率 vs 差值 vs 其他）、
   无效方向（全 FAIL / 低 sharpe 的淘汰）
4. 下一轮建议：聚焦什么、换什么 dataset、加什么词根

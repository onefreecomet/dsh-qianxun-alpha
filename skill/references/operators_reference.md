# BRAIN 算子参考（REGULAR，82 个）

> 来源：`get_operators` API 实时抓取（2026-08-13）。AI 生成 alpha 表达式时，
> **算子名必须精确匹配本表**，禁止编造；参数个数按签名约定。

## 签名约定（按分类）

| 分类 | 签名约定 |
|------|---------|
| 时序 Time Series（ts_ 前缀） | `ts_op(x, window)`，window 为回看周期 |
| 横截面 Cross Sectional | `op(x)` 或 `op(x, y)`，对截面排序/标准化 |
| 算术 Arithmetic | `op(x, y, ...)` 或 `op(x)`，元素级运算 |
| 逻辑 Logical | `op(x, y)`，返回 0/1 |
| 分组 Group（group_ 前缀） | `op(x, group)` 或 `group_op(group, x)`，需配合 group 索引 |
| 向量 Vector（vec_/vector_ 前缀） | `vec_op(x)`，作用在 VECTOR 字段 |
| 变换 Transformational | 见各自说明 |

## 速查表（82 个，按分类）

### Time Series（时序，29 个）

| 算子 | 作用 |
|------|------|
| `days_from_last_change` | Calculates the number of days since the last change in the value of a given variable. |
| `hump` | Limits amount and magnitude of changes in input (thus reducing turnover) |
| `jump_decay` | If there is a huge jump in current data compare to previous one |
| `kth_element` | Returns the K-th value from a time series by looking back over a specified number of (‘d’) days, with the option to ignore certain values. Commonly used for backfilling missing data. |
| `last_diff_value` | Returns the most recent value of x from the past d days that is different from the current value of x. |
| `ts_arg_max` | Returns the number of days since the maximum value occurred in the last d days of a time series. If today's value is the maximum, returns 0; if it was yesterday, returns 1, and so on. |
| `ts_arg_min` | Returns the number of days since the minimum value occurred in a time series over the past d days. If today's value is the minimum, returns 0; if it was yesterday, returns 1, and so on. |
| `ts_av_diff` | Calculates the difference between a value and its mean over a specified period, ignoring NaN values in the mean calculation. In short, it returns x – ts_mean(x, d) with NaNs ignored. |
| `ts_backfill` | Replaces missing (NaN) values in a time series with the most recent valid value from a specified lookback window, improving data coverage and reducing risk from missing data. |
| `ts_corr` | Calculates the Pearson correlation between two variables, x and y, over the past d days, showing how closely they move together. |
| `ts_count_nans` | Counts the number of missing (NaN) values in a data series over a specified number of days. |
| `ts_covariance` | Calculates the covariance between two time-series variables, y and x, over the past d days. Useful for measuring how two variables move together within a specified historical window. |
| `ts_decay_linear` | Applies a linear decay to time-series data over a set number of days, smoothing the data by averaging recent values and reducing the impact of older or missing data. |
| `ts_delay` | Returns the value of a variable x from d days ago. Use this operator to access historical data points by specifying the desired time lag in days. |
| `ts_delta` | Calculates the difference between a value and its delayed version over a specified period. Useful for measuring changes or momentum in time-series data. |
| `ts_max` | Returns max value of x for the past d days |
| `ts_mean` | Calculates the simple average (mean) value of a variable x over the past d days. |
| `ts_min` | Returns min value of x for the past d days |
| `ts_product` | Returns the product of the values of x over the past d days. Useful for calculating geometric means and compounding returns or growth rates. |
| `ts_quantile` | Calculates the ts_rank of the input and transforms it using the inverse cumulative distribution function (quantile function) of a specified probability distribution (default: Gaussian/normal). This helps to normalize or reshape the distribution of your data over a rolling window. |
| `ts_rank` | Ranks the value of a variable for each instrument over a specified number of past days, returning the rank of the current value (optionally adjusted by a constant). Useful for normalizing time-series data and highlighting relative performance over time. |
| `ts_regression` | Returns various parameters related to regression function |
| `ts_scale` | Scales a time series to a 0–1 range based on its minimum and maximum values over a specified period, with an optional constant shift. |
| `ts_std_dev` | Calculates the standard deviation of a data series x over the past d days, measuring how much the values deviate from their mean during that period. |
| `ts_step` | Returns a counter of days, incrementing by one each day. |
| `ts_sum` | Sum values of x for the past d days. |
| `ts_target_tvr_decay` | Tune "ts_decay" to have a turnover equal to a certain target, with optimization weight range between lambda_min, lambda_max |
| `ts_target_tvr_delta_limit` | Tune "ts_delta_limit" to have a turnover equal to a certain target with optimization weight range between lambda_min, lambda_max. Also, please be aware of the scaling for x and y. Besides setting y as adv20 or volume related data, you can also set y as a constant. |
| `ts_zscore` | Calculates the Z-score of a time series, showing how far today's value is from the recent average, measured in standard deviations. Useful for standardizing and comparing values over time. |

### Cross Sectional（横截面，8 个）

| 算子 | 作用 |
|------|------|
| `normalize` | Centers a daily cross section by subtracting the market mean; optionally divide by the cross sectional standard deviation and clamp the result to [?limit, +limit]. NaNs are ignored in mean/std. |
| `quantile` | Ranks and shifts a vector of Alpha values, then applies a chosen statistical distribution (gaussian, cauchy, or uniform) to reduce outliers. The sigma parameter controls the scale of the output. |
| `rank` | Ranks the values of the input x among all instruments, returning numbers evenly spaced between 0.0 and 1.0. Useful for normalizing data and reducing the impact of outliers. |
| `scale` | Scales the input so that the sum of absolute values across all instruments equals a specified book size. Allows separate scaling for long and short positions using optional parameters. |
| `scale_down` | Scales all values in each day proportionately between 0 and 1 such that minimum value maps to 0 and maximum value maps to 1. Constant is the offset by which final result is subtracted |
| `vector_neut` | For given vectors x and y, it finds a new vector x* (output) such that x* is orthogonal to y |
| `winsorize` | Winsorize limits values in a data to within a specified number of standard deviations from the mean, reducing the impact of extreme outliers. Note: recommended std values range from 2 to 5: std = 2, 3, 4, 5 removes approximately 4.5%, 0.27%, 0.01%, and 0.0001% of extreme values, respectively (higher std removes fewer extremes). |
| `zscore` | Z-score is a numerical measurement that describes a value's relationship to the mean of a group of values. Z-score is measured in terms of standard deviations from the mean |

### Arithmetic（算术，16 个）

| 算子 | 作用 |
|------|------|
| `abs` | Returns the absolute value of a number, removing any negative sign. |
| `add` | Adds two or more inputs element wise. Set filter=true to treat NaNs as 0 before summing. |
| `densify` | Converts a grouping field of many buckets into lesser number of only available buckets so as to make working with grouping fields computationally efficient |
| `divide` | Returns x divided by y (x / y). Note: dividing by zero raises an error; to avoid it, use divide(x, add(y, 0.0001)); adding a small epsilon to the denominator prevents divide-by-zero errors. |
| `inverse` | Returns the reciprocal of x (1 / x). Note: errors when x = 0; to avoid it, use inverse(add(x, 0.0001)); adding a small epsilon prevents divide-by-zero errors. |
| `log` | Calculates the natural logarithm of the input value. Commonly used to transform data that has positive values. |
| `max` | Maximum value of all inputs. At least 2 inputs are required |
| `min` | Minimum value of all inputs. At least 2 inputs are required |
| `multiply` | Multiplies two or more inputs element wise. Set filter=true to treat NaNs as 0 before multiplication |
| `power` | Returns x raised to the power of y (x ^ y). Note: power(x, y) can drop the sign of x when y is non-integer; use signed_power(x, y) to preserve the sign of x. |
| `reverse` |  - x |
| `sign` | Returns the sign of a number: +1 for positive, -1 for negative, and 0 for zero. If the input is NaN, returns NaN.  Input: Value of 7 instruments at day t: (2, -3, 5, 6, 3, NaN, -10) Output: (1, -1, 1, 1, 1, NaN, -1) |
| `signed_power` | x raised to the power of y such that final result preserves sign of x |
| `sqrt` | Returns the non-negative square root of x. Equivalent to power(x, 0.5). Note: for x < 0 the result is undefined; to retain the sign of x, use signed_power(x, 0.5) instead. |
| `subtract` | Subtracts inputs left to right: x ? y ? … Supports two or more inputs. Set filter=true to treat NaNs as 0 before subtraction. |
| `to_nan` | Convert value to NaN or NaN to value if reverse=true |

### Logical（逻辑，11 个）

| 算子 | 作用 |
|------|------|
| `and` | Returns 1 ('true') if both inputs are 1 ('true'). Otherwise, returns 0 ('false'). |
| `equal` | Returns 1 ('true') if input1 and input2 are the same. Otherwise, returns 0 ('false'). |
| `greater` | Returns 1 ('true') if input1 is a larger than input2. Otherwise, returns 0 ('false'). |
| `greater_equal` | Returns 1 ('true') if input1 is a larger or the same as input2. Otherwise, returns 0 ('false'). |
| `if_else` | The if_else operator returns one of two values based on a condition. If the condition is true, it returns the first value; if false, it returns the second value. |
| `is_nan` | If (input == NaN) return 1 else return 0 |
| `less` | Returns 1 ('true') if input1 is a smaller than input2. Otherwise, returns 0 ('false'). |
| `less_equal` | Returns 1 ('true') if input1 is a smaller or the same as input2. Otherwise, returns 0 ('false'). |
| `not` | Returns the logical negation of x. Returns 0 when x is 1 (‘true’) and 1 when x is 0 (‘false’). |
| `not_equal` | Returns 1 ('true') if input1 and input2 are different numbers. Otherwise, returns 0 ('false'). |
| `or` | Returns 1 if either input is true (either input1 or input2 has a value of 1), otherwise it returns 0. |

### Group（分组，9 个）

| 算子 | 作用 |
|------|------|
| `group_backfill` | Fills missing (NaN) values for instruments within the same group by calculating a winsorized mean of all non-NaN values over the past d days. The winsorized mean is computed by trimming extreme values based on a specified standard deviation multiplier (std, default 4.0). |
| `group_cartesian_product` | Merge two groups into one group. If originally there are len_1 and len_2 group indices in g1 and g2, there will be len_1 * len_2 indices in the new group. |
| `group_max` | Maximum of x for all instruments in the same group. |
| `group_mean` | Calculates the harmonic mean of a data field within each specified group. |
| `group_min` | All elements in group equals to the min value of the group. |
| `group_neutralize` | Neutralizes Alpha values within each specified group by subtracting the group mean from each value. Groups can be industry, sector, country, or any custom grouping. |
| `group_rank` | Ranks each element within its group based on the input field, assigning a value between 0.0 and 1.0. This helps compare items within the same group, such as stocks in the same industry. |
| `group_scale` | Normalizes values within each group to a range between 0 and 1, making data comparable across different groups. |
| `group_zscore` | Calculates the Z-score of each value within its group, showing how far each value is from the group mean in terms of standard deviations. Useful for comparing values relative to their group. |

### Vector（向量，7 个）

| 算子 | 作用 |
|------|------|
| `vec_avg` | Calculates the mean (average) of all elements in a vector field for each instrument and date, converting vector data to a single matrix value. |
| `vec_count` | Number of elements in vector field x |
| `vec_max` | Maximum value form vector field x |
| `vec_min` | Minimum value form vector field x |
| `vec_range` | Difference between maximum and minimum element in vector field x |
| `vec_stddev` | Standard Deviation of vector field x |
| `vec_sum` | Calculates the sum of all values in a vector field. |

### Transformational（变换，2 个）

| 算子 | 作用 |
|------|------|
| `bucket` | The bucket operator creates custom groups by dividing data into buckets (ranges) based on ranked values of any data field. These buckets can then be used with group operators like group_neutralize, group_rank, group_zscore etc. |
| `trade_when` | The trade_when operator changes Alpha values only when a specific condition is met, keeps previous values otherwise, and can close positions by assigning NaN under an exit condition. It is useful for reducing turnover and controlling when trades are executed. |

## 补充：接口非全量，社区验证可用算子

`/operators` 接口只返回 82 个 REGULAR 算子，**并非平台全量**。以下算子不在接口
返回里，但**论坛帖大量真实使用**（2026-08-13 实测），平台实际支持，AI 生成时可用：
ts_ir、regression_neut、regression_proj、sigmoid、ts_weighted_decay、ts_moment、
ts_kurtosis、ts_skewness、ts_entropy、ts_median、ts_max_diff、ts_percentage、
ts_target_tvr_hump、ts_target_tvr_delta_limit、ts_decay_exp_window、ts_co_skewness、
ts_co_kurtosis、ts_partial_corr、ts_triple_corr、ts_theilsen、ts_poly_regression、
ts_vector_neut、ts_min_max_cps、group_count、group_sum、group_normalize、group_extra、
group_vector_neut、hump、hump_decay、tail、nan_out、purify、keep、fraction、clamp、
right_tail、left_tail、truncate、scale_down、inst_pnl、densify、sta1_top3000c20、
ts_stddev（双 d，不是 std_dev）、vec_norm、vec_zscore

> 千寻 expression_builder 内置的 sigmoid / ts_decay_exp_window / ts_moment /
> vector_norm / vector_sum 同样社区验证可用，无需慎用。

## 高频组合建议（来自实战）

- **时序**：`ts_rank` / `ts_zscore` / `ts_delta` / `ts_sum` / `ts_std_dev` 是因子研究主力
- **横截面**：`rank` / `zscore` / `normalize` / `winsorize` 是标配预处理
- **套娃**：`rank(ts_op(x, w))` 或 `ts_rank(ts_op(x, w), 60)` 是经典反因子/动量手法
- **VECTOR 字段**：必须先用 `vec_avg(x)` 转 MATRIX 才能参与算术

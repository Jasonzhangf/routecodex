# HEARTBEAT / DELIVERY / Clock 路由

## 索引概要
- L1-L13 `scope`：三机制职责边界。
- L15-L20 `heartbeat`：heartbeat 标准执行顺序。
- L22-L25 `delivery`：DELIVERY 证据要求。
- L27-L29 `clock`：异步等待策略。
- L31-L33 `stop-rule`：终止条件。

## 职责边界
- `HEARTBEAT.md`：巡检任务定义与停止条件。
- `DELIVERY.md`：本轮执行结果与证据链。
- `clock`：异步等待后的定时回查。

## Heartbeat 标准顺序
1. 读取 `HEARTBEAT.md`。
2. 先核对上次交付是否完整。
3. 有缺口就直接继续修复（不是只汇报）。
4. 更新 `DELIVERY.md`。
5. 执行 review 并落盘证据。

## DELIVERY 证据要求
- 每条声明必须有可复核文件路径。
- “更新后再次 review”必须有时间序证明。
- 空文件/缺失文件不能标记完成。

## Clock 规则
- 只要是未知时长异步任务，必须设置 clock 回查。
- 汇报后不能停，需通过 clock 自动续跑。

## 终止规则
- 缺 `HEARTBEAT.md`：heartbeat 立即停止。
- 未满足证据闭环：不允许宣称完成。

# Servertool 生命周期路由（sm / heartbeat / clock）

## 索引概要
- L1-L7 `scope`：覆盖范围。
- L9-L17 `sm-lifecycle`：sm 生命周期。
- L19-L27 `heartbeat-delivery`：heartbeat/DELIVERY 执行顺序。
- L29-L34 `clock-rule`：异步等待规则。
- L36-L41 `authoritative-docs`：权威文档。

## 覆盖范围
适用于：自动续轮、tmux 注入、heartbeat 巡检、定时回查。

## sm 生命周期
1. 仅识别 `sm` marker（旧 `stopMessage` 语法已移除）。
2. 清理优先、最后一条有效。
3. 注入失败必须清理状态，防止循环。
4. 解析失败 fail-closed，不污染有效状态。

## heartbeat / DELIVERY 顺序
1. 读取 `HEARTBEAT.md`。
2. 先核对上次交付完整性。
3. 有缺口就继续修复，不只汇报。
4. 更新 `DELIVERY.md` 后执行 review 并落盘证据。

## clock 规则
- 未知时长异步任务必须设置回查提醒。
- 汇报后不停止，按提醒自动续跑。

## 权威文档
- `docs/stop-message-auto.md`
- `docs/design/servertool-stopmessage-lifecycle.md`
- `docs/design/reasoning-stop-lifecycle.md`
- `docs/design/servertool-unified-skeleton.md`
- `docs/routing-instructions.md`

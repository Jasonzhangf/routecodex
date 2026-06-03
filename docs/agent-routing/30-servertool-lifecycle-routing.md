# Servertool 生命周期路由（stopless / followup）

## 索引概要
- L1-L7 `scope`：覆盖范围。
- L9-L17 `stopless-lifecycle`：stopless 生命周期。
- L19-L24 `followup-boundary`：followup 边界。
- L26-L31 `removed-features`：已移除功能禁区。
- L33-L38 `authoritative-docs`：权威文档。

## 覆盖范围
适用于：servertool stopless 自动续轮、stop followup 重建、tmux 注入边界。

## stopless 生命周期
1. 当前 stopless 默认开启，默认注入三轮递进执行质询提示，默认次数 3；旧默认 `继续执行` 只作为 legacy exact-match 输入并在 Rust 中升级。
2. `/goal active` 时收到 `finish_reason=stop`：不自动续轮。
3. `/goal non-active` 时收到 `finish_reason=stop`：自动注入执行质询提示，要求判断目标是否完成；未完成必须调用工具，已完成必须给证据。
4. 非 `/goal` 时收到 `finish_reason=stop`：自动注入执行质询提示，要求判断目标是否完成；未完成必须调用工具，已完成必须给证据。
5. 注入失败必须清理状态，防止循环。

## followup 边界
1. followup 只能基于 origin snapshot 重建。
2. 不得从当前污染 payload 猜测补偿。
3. 不得绕过 Hub Pipeline req/resp process 的 Rust 工具治理。
4. 失败必须 fail-fast，禁止吞异常或降级。

## 已移除功能禁区
- clock / reminder / 定时回查功能已移除，禁止重新接入。
- heartbeat / DELIVERY 巡检功能已移除，禁止重新接入。
- 新需求不得通过 TS 或 servertool 旁路恢复上述功能。

## 权威文档
- `docs/stop-message-auto.md`
- `docs/design/servertool-stopmessage-lifecycle.md`
- `docs/design/rcc-unified-fence-marker-spec.md`
- `docs/design/servertool-rust-only-architecture.md`
- `docs/routing-instructions.md`

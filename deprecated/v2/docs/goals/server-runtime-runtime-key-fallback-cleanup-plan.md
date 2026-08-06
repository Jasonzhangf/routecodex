# Server Runtime Runtime-Key Fallback Cleanup Plan

## 1. 目标与验收标准

目标：审计并收口 `src/server/runtime/http-server` 中 provider runtime key 解析链路的 fallback 语义，物理移除会把未知 provider binding / runtime key 静默解析成 fallback 字符串的错误实现。

验收标准：
- runtime key selection 与 provider selection 的控制信号保持同一 request/pipeline 内一致，不出现 `providerProtocol` / runtime key 冲突。
- 未解析到 runtime key 时 fail-fast，不能回退到 raw provider key、fallback 参数或猜测 normalize 结果。
- direct / relay / provider switch 路径都不通过 runtime resolver 自行补偿协议或 provider 选择。
- 每个改动 slice 有红测或 source gate 先锁住错误，再绿化并提交。

## 2. 范围与边界

In scope:
- `src/server/runtime/http-server/runtime-manager.ts`
- `src/server/runtime/http-server/index.ts`
- `src/server/runtime/http-server/executor/provider-runtime-resolver.ts`
- 与 runtime key fallback 相关的 executor / converter 调用点
- 对应 function map / mainline call map / verification map / architecture gate
- 聚焦测试与必要在线样本重放

Out of scope:
- 不改 direct 请求体清洗。
- 不改请求历史拼接。
- 不改 provider-specific compat。
- 不改 Virtual Router selection 规则，除非证据证明 selection 与 runtime metadata 写入不是原子动作且本 slice 必须修正。

## 3. 设计原则

- no fallback：runtime key 缺失就是错误，不允许 fallback 成 providerKey 或任意 hint。
- 单一 owner：runtime key 解析只允许一个 owning resolver，调用方不得重复 normalize / 猜测 / 补偿。
- metadata 与 payload 分流：runtime control 只能走 MetadataCenter / runtime carrier，不得进入 provider/client normal payload。
- 最小切片：先锁红测，再删一处错误语义；不做大重写。

## 4. 技术方案

初始审计对象：
- `RouteCodexHttpServer.resolveRuntimeKeyForProviderBinding`
- `ProviderRuntimeManager.resolveRuntimeKey`
- `resolveProviderRuntimeOrThrow`
- `buildProviderContextForResponseConversion`
- provider failure / retry execution plan 中的 runtimeKey 传递点

候选修复方向：
- 移除 `resolveRuntimeKey(providerKey, fallback)` API 中的 `fallback` 参数。
- 把 unresolved provider binding 明确表达为 `undefined` / typed error，由唯一 resolver 抛错。
- 删除调用方对 raw providerKey、normalized providerKey、normalized runtimeKey 的 retry-like probing。
- 如需要，补 `VrRoute04SelectedTarget` 与 runtime metadata 写入的原子性测试。

## 5. 风险与规避

- 风险：现有测试可能把“fallback provider”命名用于合法 provider switch，不等同于 forbidden fallback。
- 规避：先读测试语义，区分 provider pool failover 与 runtime key fallback。
- 风险：response conversion 只需要 provider context，不一定是 request send runtime。
- 规避：单独测试 response conversion unresolved provider 行为，不把 response-side context 构造误删成不可用。

## 6. 测试计划

必须覆盖：
- red test：未知 provider binding 不得解析成 fallback/raw key。
- focused unit：runtime manager / provider runtime resolver / request executor runtime resolve。
- architecture gate：fallback denylist、function-map compile gate。
- type/build：`npx tsc --noEmit --pretty false`、`npm run build:base`。
- diff hygiene：`git diff --check`。
- 若影响 live runtime：使用真实端口样本重放，确认 provider switch 后不再出现 runtime protocol conflict。

## 7. 实施步骤

1. 只读审计 function map、mainline call map、verification map，确认唯一 owner。
2. 读现有 runtime-key / failover / provider-response-converter 测试，避免误删合法 provider switch。
3. 写最小红测或 architecture gate，确认当前错误先红。
4. 移除一个 runtime-key fallback 语义点并绿化。
5. 跑标准 gates。
6. 更新 `note.md`，只 stage 本 slice 相关文件并提交。

## 8. 完成定义

- runtime-key fallback slice 已提交。
- 工作树只剩无关预存脏文件。
- 有测试或 live 样本证据证明 runtime key 不再靠 fallback 补偿。

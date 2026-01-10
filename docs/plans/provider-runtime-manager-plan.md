# Provider Runtime Manager & Virtual Router 协作设计

> 本文在 Provider v2 配置与路由拆分基础上，细化「全局 Provider 运行时状态管理」与 Virtual Router/Provider 的职责分工。

## 1. 角色与边界

### 1.1 Virtual Router（调度者）

- 只负责：
  - 根据请求上下文、路由配置和历史错误信息，**决定**哪些 providerKey 需要进入冷却/拉黑窗口。
  - 在每次路由选择时，读取当前 Provider 运行时视图，过滤掉不可用的 providerKey。
- 不再持有权威的黑名单/冷却状态：
  - 不直接维护可写的 `providerCooldowns` 映射。
  - 不持久化 provider 健康状态，只消费 ProviderRuntimeManager 暴露的只读视图。

### 1.2 ProviderRuntimeManager（状态持有者）

- 作为 ManagerDaemon 下的一个模块（暂定 `ProviderManagerModule` 或对现有 `HealthManagerModule` 的扩展），负责：
  - 维护全局 Provider 运行时状态（对所有 providerKey）。
  - 接收 Virtual Router 的「状态决策事件」（例如建议冷却/拉黑），并将其应用到状态表。
  - 接收 providerErrorCenter 的事件流，更新统计信息和健康状态。
  - 将状态持久化到磁盘，并在 server 启动时恢复。
  - 对 Virtual Router 和 Provider runtime 暴露统一的只读视图。

### 1.3 Provider Runtime（执行者）

- 每个 provider 的 HTTP/runtime 实现，在真正发起上游请求前：
  - 可选地查询 ProviderRuntimeManager 的视图（例如 `isAvailable(providerKey)`）。
  - 如果被标记为 blacklisted/cooldown，可快速短路（本地 4xx/5xx）或让 Virtual Router 在选路阶段直接排除。
- 可以在内部增加额外防御逻辑，但**全局生效**的冷却/拉黑以 ProviderRuntimeManager 的状态为准。

---

## 2. 状态模型

### 2.1 ProviderRuntimeState

> 仅示意核心字段，实际实现可根据需要扩展。

```ts
type ProviderStatus = 'healthy' | 'cooldown' | 'blacklisted' | 'degraded';

interface ProviderRuntimeState {
  providerKey: string;            // 例如 antigravity.geetasamodgeetasamoda.claude-sonnet-4-5
  providerId: string;             // 例如 antigravity
  modelId?: string;               // 例如 claude-sonnet-4-5

  status: ProviderStatus;
  cooldownExpiresAt?: number;     // ms since epoch
  blacklistExpiresAt?: number;    // ms since epoch

  lastErrorCode?: string;         // 例如 HTTP_400 / TOOL_PROTOCOL_ERROR
  lastErrorAt?: number;           // ms since epoch

  errorCounters?: {
    http4xx?: number;
    http5xx?: number;
    timeout?: number;
    auth?: number;
    protocol?: number;
  };

  lastUsedAt?: number;            // 最近一次成功命中的时间
}
```

### 2.2 全局快照与本地文件

- 内存视图：
  ```ts
  type ProviderRuntimeTable = Map<string, ProviderRuntimeState>; // key = providerKey
  ```
- 磁盘持久化：
  - 全局快照（可选）：`~/.routecodex/state/providers/<serverId>/providers.jsonl`
  - 每 provider 本地状态（推荐）：
    - `~/.routecodex/provider/<id>/runtime-state.json`
    - `~/.routecodex/provider/<id>/events.jsonl`（ProviderErrorEvent / 手动操作日志）
- TTL 约束：
  - 所有 `cooldownExpiresAt` / `blacklistExpiresAt` 必须**硬性截断**在 24 小时以内：
    - 写入前：`expiresAt = min(now + requestedTtl, now + 24h)`。
  - 启动恢复时，自动丢弃 `expiresAt <= now` 的条目。

---

## 3. 接口设计

### 3.1 Virtual Router → ProviderRuntimeManager（决策与通知）

Virtual Router 不直接改写内部 cooldown map，而是发送「运行时控制事件」：

```ts
type ProviderRuntimeAction =
  | { type: 'propose_cooldown'; providerKey: string; ttlMs: number; reason?: string }
  | { type: 'propose_blacklist'; providerKey: string; ttlMs: number; reason?: string }
  | { type: 'clear_runtime_state'; providerKey: string; reason?: string };

interface ProviderRuntimeController {
  applyAction(action: ProviderRuntimeAction): void;
}
```

特性：

- Virtual Router 只负责「建议」：
  - 比如在 series 冷却策略决定某 providerKey 需要 300 秒冷却时，发出 `propose_cooldown`。
  - 若需要手动清理某个 providerKey 的状态，可发送 `clear_runtime_state`。
- ProviderRuntimeManager 是唯一实际更新 ProviderRuntimeTable 的组件：
  - 可以合并多条建议（例如连续的冷却提案，只保留 TTL 更长者或使用统一策略）。
  - 可以将自动冷却与手动拉黑整合在同一份状态中。

### 3.2 ProviderErrorEvent 流

ProviderRuntimeManager 同时需要直接消费 ProviderErrorEvent，用于统计与自动动作：

```ts
interface ProviderErrorConsumer {
  reportError(event: ProviderErrorEvent): void;
}
```

行为示例：

- `reportError` 更新 `lastErrorCode` / `lastErrorAt` / `errorCounters`。
- 根据规则（例如连续 N 次 5xx）自动发起 `propose_cooldown` 或 `propose_blacklist`。

### 3.3 ProviderRuntimeManager → Virtual Router & Provider runtime（视图）

对 Virtual Router 和 Provider runtime 只暴露只读视图接口：

```ts
interface ProviderRuntimeView {
  getState(providerKey: string): ProviderRuntimeState | undefined;
  isRoutable(providerKey: string): boolean;
}
```

约定：

- `isRoutable` 判定逻辑至少包含：
  - 如果 `status === 'blacklisted'` 且 `blacklistExpiresAt > now` → false。
  - 如果 `status === 'cooldown'` 且 `cooldownExpiresAt > now` → false。
  - 其他情况视为 true（或根据 `status==='degraded'` 加权处理，具体策略可后续扩展）。

Virtual Router 在选路时只调用 `isRoutable` / `getState`，不直接改写状态。

Provider runtime 可以在发起请求前调用 `isRoutable` 做一次最终检查（可选）。

---

## 4. 事件流与调用时序

### 4.1 错误 → 状态更新 → 下一次选路

1. Provider 发生错误，上报 `emitProviderError({ ..., providerKey, error })`。
2. `providerErrorCenter` 将 `ProviderErrorEvent` 广播给：
   - Virtual Router（用于路由统计、series 策略等）。
   - ProviderRuntimeManager（用于统计与状态更新）。
3. Virtual Router 根据当前策略计算出建议动作：
   - 例如：series 熔断认为 `antigravity.*.claude-sonnet-4-5` 需要冷却 60s。
   - 调用 `ProviderRuntimeController.applyAction({ type: 'propose_cooldown', providerKey, ttlMs: 60000, reason })`。
4. ProviderRuntimeManager：
   - 根据 `reportError` 和 `applyAction` 更新 `ProviderRuntimeTable`。
   - 将更新后的状态写回对应 provider 的 `runtime-state.json`，并按需写全局 snapshot。
5. 下一次请求到达 Virtual Router：
   - 从 routing 得到候选 providerKey 列表。
   - 对每个候选调用 `runtimeView.isRoutable(providerKey)`，过滤掉不可用的 provider。
   - 在剩余集合上做负载均衡与路由选择。

### 4.2 手动拉黑 / 解除拉黑

1. CLI/HTTP 调用（例如 `rcc provider blacklist ...`）：
   - 转换为 `ProviderRuntimeAction`，调用 `ProviderRuntimeController.applyAction`。
2. ProviderRuntimeManager 更新 ProviderRuntimeTable 并持久化。
3. 后续所有路由命中前都会通过 `isRoutable` 看到新的状态，无需 Virtual Router 知晓具体操作来源。

---

## 5. 持久化与重启行为

1. Server 启动时：
   - ProviderRuntimeManager：
     - 扫描 `~/.routecodex/provider/*/runtime-state.json`。
     - 合并为全局 `ProviderRuntimeTable`，丢弃所有 `expiresAt <= now` 的条目。
   - Virtual Router Engine：
     - 通过注入的 `ProviderRuntimeView` 在首次构造时就能看到恢复后的状态。

2. 运行中：
   - 每次状态变化（自动冷却/手动拉黑/解除）：
     - 更新内存 map。
     - 异步保存到对应 provider 目录的 `runtime-state.json`（best-effort）。
     - 可选保存全局 snapshot（用于快速对比或调试）。

3. 关闭时：
   - ManagerDaemon 停止各模块：
     - ProviderRuntimeManager 可选择做一次 `compact()`，清理过期事件并写入最新快照。

---

## 6. 渐进式接线计划（概述）

> 具体执行任务写入 `task.md`，这里只列高层步骤。

1. 在 sharedmodule 中定义 `ProviderRuntimeView` / `ProviderRuntimeAction` 类型（仅接口，不改现有逻辑）。
2. 在 host 侧实现 ProviderRuntimeManager（内存版 + 基本落盘，不影响当前健康/冷却逻辑）。
3. 将 Virtual Router Engine 内部的 providerCooldowns 写入逻辑迁移为对 ProviderRuntimeManager 的 action 调用：
   - Engine 只发出 `propose_cooldown` / `propose_blacklist`，不直接改写本地 map。
4. 在 Virtual Router 选路路径中改用 `ProviderRuntimeView.isRoutable` 过滤候选 providerKey。
5. 将持久化逻辑从 sharedmodule 的 healthStore 挪到 host 的 ProviderRuntimeManager（engine 只消费 view，不再直接持久化 health snapshot）。 


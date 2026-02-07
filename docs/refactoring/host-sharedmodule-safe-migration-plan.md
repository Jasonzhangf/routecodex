# Host + sharedmodule 架构重整：安全渐进切换方案

> 对应 bd：`routecodex-73`

## 1. 目标与边界

本方案只做“安全迁移 + 渐进切换”，不做一次性重写。

- 目标架构：`block` 负责能力，`app` 负责编排；统一控制面（CLI/HTTP/WS）由 `app` 承载。
- 双轨范围：
  - Host：`src/index.ts`、`src/server/runtime/http-server/`、`src/manager/`。
  - sharedmodule：`llmswitch-core` 的 Hub/VirtualRouter/compat 协议面。
- 红线：保持单一路径 `HTTP -> Hub Pipeline -> Provider V2 -> Upstream`，禁止旁路。

## 2. 安全切换原则（必须满足）

1. **双实现共存**：旧逻辑保持可用，新逻辑用开关接入。
2. **先影子后接管**：先 shadow 比对，再小流量接管，再全量。
3. **每步可回滚**：每一阶段都提供“一键回旧路径”的开关。
4. **可观测先行**：切换前必须有成功率、错误率、延迟、工具调用一致性指标。
5. **配置驱动**：切换策略通过配置/环境变量，不靠临时代码分支。

## 3. 切换控制面设计（统一骨架）

新增统一切换骨架（由 `app` 读取）：

```json
{
  "architecture": {
    "appKernel": "v1|v2",
    "controlBus": "v1|v2",
    "controlWs": { "enabled": false, "mode": "observe|active" },
    "hostBlocks": {
      "runtimeBootstrap": "v1|v2",
      "providerRuntime": "v1|v2",
      "controlPlane": "v1|v2"
    },
    "sharedmodule": {
      "hubCompatProfile": "stable|canary",
      "virtualRouterPolicy": "stable|canary"
    }
  }
}
```

说明：
- `v1` = 现网实现；`v2` = 新 block/app 实现。
- `observe` = 只监听状态，不接管控制；`active` = 接管控制指令。

## 4. 逐步迁移阶段（Host + sharedmodule 双轨）

### Phase 0：冻结基线（1-2 天）

- 产出：现网调用链、关键入口、失败类型基线。
- 动作：补齐核心指标与快照字段（requestId、route、providerProtocol、tool-call pairing）。
- 退出条件：可稳定复现实例问题，并可定位层级（host/sharedmodule/provider/upstream）。

### Phase 1：AppKernel 骨架接入（不改行为）

- Host：引入 `AppKernel`（生命周期、模块装配、依赖注入），但内部仍调用 v1 server 逻辑。
- sharedmodule：不改运行逻辑，仅补充版本/能力探针接口。
- 开关：`architecture.appKernel=v2`。
- 回滚：切回 `v1`。

### Phase 2：Host Block 化拆分（功能等价）

- 从 `http-server/index.ts` 抽出 block：
  - `runtime-bootstrap-block`
  - `provider-runtime-block`
  - `control-plane-block`
  - `http-adapter-block`
- 要求：对外 API、日志字段、错误语义保持一致。
- 开关：`hostBlocks.*=v2`（可单块灰度）。
- 回滚：单块回切 `v1`，不影响其他块。

### Phase 3：统一 ControlBus（CLI/HTTP 先统一）

- `app` 内新增 `control-bus`（typed command/event），CLI 与 daemon-admin HTTP 共用。
- WS 暂不接管，仅监听事件。
- 开关：`architecture.controlBus=v2`，`controlWs.mode=observe`。
- 回滚：`controlBus=v1`。

### Phase 4：WS 控制面灰度

- 增加 `/daemon/ws`：状态推送、命令回执、订阅流。
- UI 从轮询迁移到“WS 优先 + HTTP fallback”。
- 开关：`controlWs.enabled=true`。
- 灰度：仅 dev/指定账号/指定 serverId。
- 回滚：关闭 WS，恢复 HTTP 轮询。

### Phase 5：sharedmodule canary（策略/compat）

- sharedmodule 对 `compat profile`、`routing policy` 做 canary 通道。
- host 透传 `stable|canary` 选择，不在 provider 层做语义修补。
- 开关：`sharedmodule.hubCompatProfile=canary`、`virtualRouterPolicy=canary`。
- 回滚：切回 `stable`。

### Phase 6：收敛与删旧（最后阶段）

- 条件：至少 2 周稳定、无 P0 回归、same-shape 回放全绿。
- 动作：删除 v1 分支代码、清理临时开关、固化文档与测试矩阵。

## 5. 灰度与回滚矩阵

按优先级从小到大：

1. 本地 dev（单人）
2. CI replay（same-shape + control provider）
3. 小流量 canary（按 providerKey / route / alias）
4. 全量

每一级都必须满足：

- 成功率不低于基线
- P95 延迟不高于基线阈值
- 工具调用配对错误为 0（`tool_call`/`tool_result`）
- Provider 400/500 不新增结构性错误

回滚动作标准化：

- 配置回切（优先）→ 热重载
- 若热重载失败：进程重启并强制 `v1/stable`
- 回滚后自动导出 diff 快照用于复盘

## 6. 验证清单（每阶段必跑）

1. Host：`npm run build:dev` + `npm run install:global`
2. Sharedmodule 变更时：`npm --prefix sharedmodule/llmswitch-core run build`
3. 回放：
   - 失败 same-shape 回放（目标 provider）
   - unaffected control 回放（非目标 provider）
4. 控制面：CLI/HTTP/WS（若启用）状态一致性检查
5. 错误流：`providerErrorCenter + errorHandlingCenter` 事件完整

## 7. README 自动区改造（配套）

为根 README 与 `src/README.md` 增加自动区标记：

- `<!-- AUTO:ARCH:BEGIN --> ... <!-- AUTO:ARCH:END -->`
- `<!-- AUTO:CALLGRAPH:BEGIN --> ... <!-- AUTO:CALLGRAPH:END -->`

构建时生成：

- 模块目录树（host/sharedmodule）
- app/block 调用关系摘要
- 当前开关矩阵（默认值 + 说明）

手写内容保留在手动区，自动区禁止人工直接编辑。

## 8. 执行顺序建议（安全版）

建议按以下顺序推进（每步可单独合并）：

1. Phase 0 + 指标基线
2. Phase 1（AppKernel）
3. Phase 2（Host Block）
4. Phase 3（ControlBus）
5. Phase 4（WS 灰度）
6. Phase 5（sharedmodule canary）
7. Phase 6（删旧收敛）

---

该方案优先保证“可回滚与可观测”，确保在不中断服务的前提下完成架构升级。

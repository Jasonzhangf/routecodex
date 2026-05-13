# 端口模式与协议路由设计（Port Mode & Protocol Routing）

> 目标：为 WebUI 重构审计提供唯一设计真源，定义端口级模式切换与协议级路由行为。

## 索引概要
- L1-L8 `purpose`：设计目标与范围
- L10-L30 `architecture-constraint`：架构硬约束
- L32-L50 `port-modes`：端口模式定义（Router / Provider）
- L52-L68 `protocol-behavior`：协议行为定义（Direct / Relay / Auto）
- L70-L88 `config-schema`：配置 schema 设计
- L90-L108 `runtime-pipeline`：运行时管线变更
- L110-L128 `webui-design`：WebUI 交互设计
- L130-L148 `admin-api`：Admin API 设计
- L150-L165 `migration`：迁移策略
- L167-L180 `verification`：验证门禁

---

## 1. 架构硬约束

### 1.1 Router 模式链路不可跳过
```
inbound → chat semantic mapping → chat process → virtual router → provider
```
Router 模式下，inbound 结束后已转为 chat 协议，必然经过 virtual router 做完整路由决策。**Router 模式内不存在 Direct/Relay 选择空间**——所有 Router 端口都走 relay 路径。

### 1.2 Provider 模式不进路由
```
inbound → (协议判断) → 直连 provider 或 协议转换 → provider
```
Provider 模式绕过 virtual router，直接从 inbound 连接到 provider。**Direct/Relay/Auto 选择仅在 Provider 模式端口存在**。

### 1.3 链路唯一性
- HTTP server → llmswitch-core Hub Pipeline → Provider → Hub Pipeline → client
- 端口模式在 HTTP server 层决策，决定是否进入 Hub Pipeline 的路由阶段
- 不新增旁路链路

---

## 2. 端口模式定义

### 2.1 Router 模式（路由模式）
| 属性 | 值 |
|------|-----|
| 行为 | 完整路由链路 |
| 链路 | inbound → chat → virtual router → provider |
| 协议行为 | 无子选择（必然 relay） |
| 适用场景 | 需要多 provider 负载均衡、协议转换路由 |

### 2.2 Provider 模式（直连模式）
| 属性 | 值 |
|------|-----|
| 行为 | 绕过 virtual router，直连 provider |
| 链路 | inbound → (协议判断) → provider |
| 协议行为 | Direct / Relay / Auto |
| 适用场景 | 固定 provider 绑定，追求低延迟 |

---

## 3. 协议行为定义（仅 Provider 模式）

### 3.1 Direct（直连）
- **触发条件**：入站端点协议 == provider 协议
- **链路**：inbound → snapshot hook → provider
- **约束**：不同协议时走 Direct 会 fail-fast 报错

### 3.2 Relay（中继）
- **触发条件**：入站端点协议 != provider 协议
- **链路**：inbound → 协议转换 → provider
- **约束**：同协议走 Relay 允许但不推荐（多一层无用转换）

### 3.3 Auto（自动）
- **行为**：runtime 自动判断
  - 同协议 → Direct
  - 跨协议 → Relay
- **默认行为**：Provider 模式端口的推荐默认值

---

## 4. 配置 Schema 设计

### 4.1 端口配置层级
```
httpserver.ports[].mode: "router" | "provider"
httpserver.ports[].protocolBehavior: "direct" | "relay" | "auto"  // provider 模式生效
httpserver.ports[].providerBinding: string                         // provider 模式下必填
```

### 4.2 配置示例
```jsonc
{
  "httpserver": {
    "ports": [
      {
        "port": 5000,
        "host": "0.0.0.0",
        "mode": "provider",
        "protocolBehavior": "auto",
        "providerBinding": "openai.gpt-4o"
      },
      {
        "port": 10000,
        "host": "0.0.0.0",
        "mode": "router"
      }
    ]
  }
}
```

### 4.3 字段说明
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `port` | number | 是 | 监听端口 |
| `host` | string | 是 | 监听地址 |
| `mode` | `"router"` \| `"provider"` | 是 | 端口模式 |
| `protocolBehavior` | `"direct"` \| `"relay"` \| `"auto"` | provider 模式必填 | 协议行为 |
| `providerBinding` | string | provider 模式必填 | 绑定的 provider key（如 `openai.gpt-4o`） |

### 4.4 验证规则
- `mode=router` 时，`protocolBehavior` 和 `providerBinding` 不可设置
- `mode=provider` 时，`providerBinding` 必填且在 provider 池中存在
- `protocolBehavior=direct` 且请求协议 != provider 协议时，fail-fast 报错
- 端口不可重复

---

## 5. 运行时管线变更

### 5.1 请求入口分流（HTTP Server 层）

```
HTTP Request → RouteCodexHttpServer
  ├── port.mode = "router"
  │     → HubPipeline.execute(request)  // 完整路由
  │
  └── port.mode = "provider"
        ├── protocolBehavior = "auto"
        │     ├── 同协议 → snapshot hook → provider.call()
        │     └── 跨协议 → 协议转换 → provider.call()
        ├── protocolBehavior = "direct"
        │     └── snapshot hook → provider.call()
        └── protocolBehavior = "relay"
              └── 协议转换 → provider.call()
```

### 5.2 核心修改点

| 修改位置 | 变更内容 |
|---------|---------|
| `src/server/runtime/http-server/types.ts` | `ServerConfigV2` 新增 `ports[]` 配置 |
| `src/server/runtime/http-server/port-config-types.ts` | 端口配置类型定义（新增） |
| `src/server/runtime/http-server/port-config-validator.ts` | 端口配置验证（新增） |
| `src/server/runtime/http-server/port-registry.ts` | 多端口生命周期管理（新增） |
| `src/server/runtime/http-server/provider-direct-pipeline.ts` | Provider 直连流水线（新增） |
| `src/server/runtime/http-server/daemon-admin/ports-handler.ts` | Admin API /admin/ports（新增） |
| `src/server/runtime/http-server/request-executor.ts` | 新增端口模式分流逻辑 |
| `src/server/runtime/http-server/http-server-bootstrap.ts` | 端口配置解析与验证 |
| `sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline.ts` | 新增 `processMode: "provider-direct"` |
| `src/server/runtime/http-server/routes.ts` | 多端口路由注册 |

### 5.3 Provider 直连流水线（新增）
```
inbound → resolveProviderBinding → checkProtocolMatch
  ├── match (direct)  → snapshot hook → sendToProvider → snapshot hook → outbound
  └── no match (relay) → semantic map → sendToProvider → semantic unmap → outbound
```
snapshot hook 使用现有的 `DebugCenter` / `StageRecorder` 机制，不做额外 payload 裁剪。

---

## 6. WebUI 交互设计

### 6.1 页面布局
```
┌─────────────────────────────────────────────────────────────┐
│  端口管理                                          [+ 添加端口] │
├──────┬────────┬──────────┬─────────────────┬───────────────┤
│ 端口  │ 模式    │ 协议行为   │ 绑定 Provider    │ 操作           │
├──────┼────────┼──────────┼─────────────────┼───────────────┤
│ 5000 │ Provider │ Auto ▼   │ openai.gpt-4o ▼ │ [保存] [删除]  │
│ 8080 │ Router   │ -        │ -                │ [保存] [删除]  │
│10000 │ Router   │ -        │ -                │ [保存] [删除]  │
└──────┴────────┴──────────┴─────────────────┴───────────────┘
```

### 6.2 交互规则
- **添加端口**：弹出表单，输入 port/host/mode/protocolBehavior/providerBinding
- **模式切换**：Router ↔ Provider 时，相关字段联动显示/隐藏
- **Provider 绑定**：下拉从 provider 池读取（通过 `GET /admin/providers`）
- **保存**：调用 `PUT /admin/ports/:port` 更新配置，立即生效
- **删除**：调用 `DELETE /admin/ports/:port`，停止该端口监听

---

## 7. Admin API 设计

### 7.1 `GET /admin/ports`
列出所有端口配置与状态。

```jsonc
{
  "ports": [
    {
      "port": 5000,
      "host": "0.0.0.0",
      "mode": "provider",
      "protocolBehavior": "auto",
      "providerBinding": "openai.gpt-4o",
      "status": "running",
      "activeConnections": 3
    }
  ]
}
```

### 7.2 `PUT /admin/ports/:port`
更新或创建端口配置。Body 同配置 schema。

### 7.3 `DELETE /admin/ports/:port`
删除端口配置，停止该端口监听。

### 7.4 `GET /admin/providers`
返回可用 provider 列表（供 WebUI 下拉选择）。

### 7.5 安全约束
- Admin API 复用现有 daemon-admin 认证中间件
- 端口变更操作记录审计日志

---

## 8. 迁移策略

### 8.1 向后兼容
- 现有单端口配置（`httpserver.port`）自动映射为 `ports[0]`，mode 默认 `router`
- 无 `ports[]` 配置时，行为与当前完全一致

### 8.2 迁移步骤
1. **Phase 1**：新增 `ports[]` 配置解析 + 兼容旧配置
2. **Phase 2**：实现 Provider 模式直连流水线
3. **Phase 3**：实现 Admin API（CRUD ports）
4. **Phase 4**：WebUI 端口管理页面

---

## 9. 验证门禁

### 9.1 单元测试
- [ ] 配置解析：`ports[]` 正确解析，旧 `port` 兼容展开
- [ ] 验证规则：非法配置 fail-fast
- [ ] 端口模式分流：Router 进 pipeline，Provider 走直连

### 9.2 集成测试
- [ ] Router 端口：请求正常路由到多个 provider
- [ ] Provider + Auto：同协议直连、跨协议 relay
- [ ] Provider + Direct：跨协议请求 fail-fast
- [ ] 多端口并行：两个端口同时工作互不干扰

### 9.3 WebUI 验证
- [ ] 端口列表正确展示状态
- [ ] 添加/编辑/删除端口实时生效
- [ ] Provider 下拉列表正确读取
- [ ] 模式切换字段联动正确

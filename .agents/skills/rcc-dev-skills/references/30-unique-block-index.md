# 30 Unique Functional Block Index（全局唯一功能块索引）

## 索引概要
- L1-L9 `purpose`：唯一功能块防重复。
- L10-L112 `blocks`：功能块 -> 所有权 + 接口。

## 功能块索引

| ID | 功能块 | 唯一所有权 | 输入/输出 |
|---|---|---|---|
| U01 | HTTP 协议入口 | `routes.ts` | HTTP -> HubRequest |
| U02 | 元数据组装 | `executor-metadata.ts` | request -> metadata |
| U03 | Hub Pipeline 编排 | `hub-pipeline.ts` | HubRequest -> stage pipeline |
| U04 | chat-process 工具治理 | `resp_process_stage1_tool_governance.rs` | model text/tool -> governed output |
| U05 | 路由分类 | `classifier.rs` | features -> route candidates |
| U06 | 候选过滤 | `selection.rs` | targets + state -> available |
| U07 | 负载算法 | `load_balancer.rs` | candidates + weights -> chosen |
| U08 | sticky 状态存储 | `routing_state/store.ts` + rust store | session/conversation -> sticky state |
| U09 | provider runtimeKey 映射 | `http-server-runtime-providers.ts` | runtimeKey -> provider instance |
| U10 | provider send | `executor-provider.ts` | provider payload -> upstream resp |
| U11 | provider-switch 策略 | `retry-engine.ts` | error -> next attempt |
| U12 | outbound 兼容转换 | `req_outbound_stage3_compat/*` | standardized req -> provider req |
| U13 | response finalize | `resp_process_stage2_finalize.rs` | upstream resp -> client resp |
| U14 | 工具文本收割 | `hub_reasoning_tool_normalizer.rs` | assistant text -> tool_calls |
| U15 | SSE 输出封装 | `hub_resp_outbound_sse_stream.rs` | node output -> sse events |
| U16 | stopMessage 状态机 | `stop-message-auto.ts` + rust semantics | marker/state -> followup action |
| U17 | tmux 注入执行 | `client-injection-flow.ts` | followup text -> tmux stdin |
| U18 | quota/cooldown 健康约束 | `quota` + `health manager` | provider health -> availability |
| U19 | daemon admin 配置写入 | `providers-handler*.ts` | API patch -> config reload |
| U20 | provider scope 裁剪 | `provider-routing-scope.ts` | routing config -> active provider set |

## 编排关系（简）

U01 -> U02 -> U03 -> (U04/U05/U06/U07) -> U09 -> U10 -> U13 -> client

旁路能力：
- servertool/stopMessage：U16 -> U17
- 故障恢复：U11 + U18

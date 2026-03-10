# req_process_stage1_tool_governance

**目标**：对标准化 Chat 请求执行工具过滤、MCP 策略治理以及最终的 `ProcessedRequest` 生成。

**输入**
- `StandardizedRequest`（来自 `req_inbound`）。
- request metadata（entryEndpoint、stream、providerProtocol 等）。

**输出**
- `ProcessedRequest`（包含 processingMetadata）。
- 记录治理摘要（ToolGovernanceEngine summary）。

**依赖**
- `runHubChatProcess`（内部串 `runChatRequestToolFilters` + `ToolGovernanceEngine`）。
- 环境变量可控制治理行为（如 STREAM hints）。

**错误落点**
- 治理失败将返回 `nodeResult.success=false`，HubPipeline 需记录 stage id 并可继续路由（按 fail-fast 策略决定）。

**下一步**
- `req_process_stage2_route_select`：根据治理后的请求做虚拟路由。

# req_process_stage2_route_select

**目标**：调用 `VirtualRouterEngine` 选择目标 provider/模型，将结果写回 metadata 与请求主体（model 覆写、processMode、toolCallIdStyle 等）。

**输入**
- `StandardizedRequest` 或 `ProcessedRequest`。
- Normalized request metadata（entryEndpoint、routeHint、stream 等）。

**输出**
- `TargetMetadata`、`RoutingDecision`、`RoutingDiagnostics`。
- 更新后的请求对象（model/parameters/metadata）。

**依赖**
- `VirtualRouterEngine.route`。
- `applyTargetMetadata`、`applyTargetToSubject` 的标准逻辑。

**错误落点**
- 未找到目标或配置缺失时抛出 Error；需要记录 stage id 以帮助定位配置问题。

**下一步**
- `req_outbound_stage1_semantic_map`：使用目标 metadata 构建 provider 特定 payload。

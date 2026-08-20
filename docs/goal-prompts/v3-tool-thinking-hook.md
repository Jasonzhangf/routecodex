/goal

目标：按 [v3-tool-thinking-hook-plan.md](../goals/v3-tool-thinking-hook-plan.md) 实现 V3 `tool-thinking` Hook Skeleton；先完成 Phase 1 visible `reasoning_content`，完成真实响应质量验证后再评估 Phase 2 private projection。

说明：本任务不需要再写新的提示词，直接按实现文档执行。

实现文档：

`docs/goals/v3-tool-thinking-hook-plan.md`

执行规范：

- 先查 MemoryPalace、resource/function/mainline/module/verification maps，锁唯一 owner、固定 Req04/Resp03/Resp04 hook 边界，再改代码。
- 请求侧只在最终 provider-facing 工具列表的合法 description 字段注入文档中的完整 `<toolreason>` 格式合同；禁止改 tool parameters、arguments、metadata、handler、SSE 或 provider codec。
- 响应侧重点处理不完美模型输出：先 canonical normalize，再 collect、associate、recover、normalize、redact；无论恢复成功与否，raw `<toolreason>` 不得到达客户端；不得猜测、复制或从 tool arguments/tool output 反推理由。
- Phase 1 只映射为可见 `reasoning_content`，供客户端监测；不得提前实现或宣称 private reasoning content。
- Stopless、reasoningStop、stop_schema、routing、retry、health、continuation control 与 tool-thinking 分离；禁止 fallback、静默吞错、请求侧 cleanup、outbound 补偿。
- 先写 red fixtures，再实现唯一 owner；改后执行定向测试、架构/resource/module gates、构建、安装、聚合重启、provider-request dry-run、旧样本/真实入口 replay；证据不足不得宣称完成。
- 本任务不再生成新的 `/goal` prompt；直接按实现文档推进并在结束时给出变更、验证、剩余风险、下一步。

验证：

- 配置/manifest/hook owner 与 payload-boundary gate。
- Req04 exact injection/idempotence tests。
- Resp03 complete、missing-close、empty、nested、duplicate、multi-tool、unbound、wrong-source recovery tests。
- Client JSON/SSE raw-marker redaction tests与 provider-facing request dry-run。
- Phase 1 visible `reasoning_content` end-to-end replay。
- 构建、全局安装、managed restart、全部 listener health、旧样本/真实入口 replay。
- 完成运行时验证后才启动 DSH Review；review 失败按 finding 修复并重跑受影响闭环。

完成标准：

- `tool-thinking` 可配置开关；关闭时 payload 行为不变。
- 开启时只修改工具 description 注入提示，不改变工具接口。
- Resp03 对不完美响应有确定性恢复和硬剥离；raw marker、内部 parser 状态、hook 身份不泄漏。
- Phase 1 `reasoning_content` 对客户端可见且内容格式为 `调用工具 <tool_name>，因为 <reason>`。
- 原工具调用语义、Stopless 生命周期、主线节点边界不变。
- 所有必跑验证和 live evidence 完成；Phase 2 private projection 仅记录为后续独立阶段，不冒充已完成。

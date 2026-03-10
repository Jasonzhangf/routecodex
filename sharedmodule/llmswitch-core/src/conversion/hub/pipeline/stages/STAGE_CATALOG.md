# Stage Catalog (Responses Baseline)

| Flow | Stage ID | Purpose | Protocols |
|------|----------|---------|-----------|
| req_inbound | req_inbound_stage1_format_parse | Format adapter parses raw payload into `FormatEnvelope`. | openai-responses, anthropic-messages, gemini-chat |
| req_inbound | req_inbound_stage2_semantic_map | Semantic mapper converts FormatEnvelope → ChatEnvelope with bridge policies. | openai-responses, anthropic-messages, gemini-chat |
| req_inbound | req_inbound_stage3_context_capture | Capture Responses context (tools/input/response_format) for outbound reuse. | openai-responses |
| req_process | req_process_stage1_tool_governance | Run tool filters + ToolGovernanceEngine, emit ProcessedRequest. | all hub protocols |
| req_process | req_process_stage2_route_select | VirtualRouterEngine routing and metadata attachment. | all hub protocols |
| req_outbound | req_outbound_stage1_semantic_map | ChatEnvelope → FormatEnvelope using stored context + target metadata. | openai-responses, anthropic-messages, gemini-chat |
| req_outbound | req_outbound_stage2_format_build | FormatEnvelope → provider wire JSON. | openai-responses, anthropic-messages, gemini-chat |
| resp_inbound | resp_inbound_stage1_sse_decode | Decode provider SSE stream or annotate passthrough. | all hub protocols |
| resp_inbound | resp_inbound_stage2_format_parse | Parse provider response JSON into FormatEnvelope. | all hub protocols |
| resp_inbound | resp_inbound_stage3_semantic_map | Map provider response → ChatCompletion-like payload. | all hub protocols |
| resp_process | resp_process_stage1_tool_governance | Apply response-side tool governance. | all hub protocols |
| resp_process | resp_process_stage2_finalize | Finalize payload + build ProcessedRequest. | all hub protocols |
| resp_outbound | resp_outbound_stage1_client_remap | Map canonical response to client protocol JSON. | openai-chat, openai-responses, anthropic-messages |
| resp_outbound | resp_outbound_stage2_sse_stream | Produce client SSE stream or wrap JSON response. | openai-chat, openai-responses, anthropic-messages, gemini-chat |

> 说明：Responses 作为默认骨架，其他协议可覆写同名 stage 的实现，但必须复用相同的 stage id 与 README 结构。

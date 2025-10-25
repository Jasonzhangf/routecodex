# Chat Pipeline Rectification Plan

Goal
- Enforce clean separation of concerns: llmswitch handles protocol in/out only; workflow owns OpenAI Chat standard validation and stream control; compatibility handles vendor-specific tweaks only; providers do no shaping.
- After llmswitch, all requests and responses are OpenAI Chat standard across endpoints. Workflow forces provider-side non-stream and re-emits streaming for clients when requested.

Scope (Phase 1 – Chat only)
- Do not touch Responses/Messages endpoints yet. Focus on Chat path to remove cross-protocol fallbacks and centralize validation/stream control in workflow.

Design
- llmswitch
  - Input: Convert any client protocol (Chat/Responses/Anthropic) to OpenAI Chat request (messages/model/tools/tool_choice/stream).
  - Output: Keep as OpenAI Chat for now (endpoint-specific out-conversion comes in later phases).
- workflow (OpenAI standard gate)
  - Request-side
    - Validate OpenAI Chat request strictly (roles, tool_calls, function.arguments as JSON string, tool schemas when available).
    - Record originalStream flag and force provider-side `stream=false`.
  - Response-side
    - Validate OpenAI Chat response strictly (choices[].message, tool_calls shape, finish_reason, usage).
    - For now return non-stream JSON to handler; handler continues streaming. Next phase migrates streaming into workflow.
- compatibility
  - Only vendor-specific minimal mapping and thinking text cleaning.
  - No cross-protocol conversions; do not reshape standard Chat beyond cleaning.
- provider
  - Send non-stream JSON; no parsing or reshaping.

Acceptance Criteria
- All inputs into workflow are OpenAI Chat standard.
- workflow rejects malformed Chat requests early and enforces provider non-stream.
- workflow rejects malformed Chat responses early; handler streams only valid Chat response.
- StreamingManager remains Chat-only (no cross-protocol fallbacks).

Tasks
1) Add strict request/response validators to workflow
   - File: `src/modules/pipeline/modules/workflow/streaming-control.ts`
   - Request: validate model/messages/tools/tool_calls; set `originalStream`, force `stream=false`.
   - Response: validate choices[].message/tool_calls/finish_reason; (thinking cleaning stays in compatibility for now).
2) Keep handler streaming decision by original client flag (unchanged)
   - Chat handler continues to use `req.body.stream` for output streaming.
3) Ensure StreamingManager is Chat-only (already done)
   - No Anthropic/Responses fallbacks; only Chat JSON + Readable passthrough.
4) Defer moving streaming into workflow to Phase 2
   - Extract `OpenAIChunkEmitter` later and migrate handler->workflow streaming.

Notes
- Add DEBUG-only capture points later if needed (before-provider, after-compat) to aid diagnostics.


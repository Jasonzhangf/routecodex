# Mock Provider 样本规范

## 目标
- 在无真实 provider 配置的环境下，通过样本回放验证 RouteCodex Host 行为。
- 样本与真实请求共享结构，可直接覆盖 `provider-request` → `provider-response` 链路。
- 提供可扩展的命名和落盘规范，支持多入口/多 provider。

## 目录结构
参见 `samples/mock-provider/README.md`，包含以下层级：
- `openai-chat/`、`openai-responses/`、`anthropic-messages/`：按入口划分。
- 每个入口下按 `{providerId}-{model}-{timestamp}-{seq}.{request|response}.json` 存放。
- `_registry/index.json`：全局索引用于查找/验证。

## reqId 命名
格式：`{入口}-{providerId}-{model}-{YYYYMMDD}T{HHmmss}-{序号}`。Mock Provider 将该 `reqId` 作为主键，根据请求入口/模型/时间/序号匹配样本。

示例：`openai-chat-glm-key1-gpt-4-20251204T120000-001`。

## 落盘流程
1. 运行真实请求，确保 `~/.routecodex/codex-samples` 写入 `provider-request` & `provider-response` JSON。
2. 使用即将提供的脚本 `npm run mock:extract -- --req <reqId>` 拷贝两份文件到 `samples/mock-provider/<入口>/`，自动重命名。
3. 脚本更新 `_registry/index.json`，记录入口、providerId、model、tags。
4. 若需要手动添加标签，可编辑 registry 中对应条目。

## Mock Provider 工作方式（设计）
- 初始化阶段读取 `_registry/index.json`，构建 `{reqId => {request, response}}` 映射。
- 处理请求时，按当前请求的入口/providerId/model/reqId 查询样本；若匹配失败，可按 providerId+model 的最近样本 fallback（可选）。
- 支持 Streaming：response.json 中可携带 `sseEvents`，mock provider 将按顺序输出。
- 支持错误模拟：response.json 中可定义 `error` 字段（HTTP status、body），用于触发断言。

## CI 用例
- GitHub Action：设置 `ROUTECODEX_MOCK_SAMPLES_DIR=samples/mock-provider`, `ROUTECODEX_USE_MOCK=1`。
- Local CI：同样通过环境变量启用 mock provider，回放真实样本。
- 定期更新：在添加新的 provider 功能后，录制对应样本并提交，以防止回归。

## 回归标签
- `invalid_name`：Responses 入站工具名称必须经共享 normalizer。
- `missing_output`：输出 builder 需保证 `output_text` 与 `output[]` 同步生成。
- `missing_tool_call_id`：tool call ID 保持请求原值，不再由 Responses bridge 兜底。
- `require_fc_call_ids`：当 config 要求 `fc_*` 样式时，由共享 `responses-tool-utils` 负责归一。

## 待办
- `scripts/mock-provider/extract.mjs`: 从 ~/.routecodex/codex-samples 复制样本。
- `scripts/mock-provider/validate.mjs`: 校验命名、字段完整性。
- `MockProviderRuntime`: 读取目录并充当 provider。

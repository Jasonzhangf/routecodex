# ProviderComposite 测试方法

本文档给出 ProviderComposite（兼容层内聚）变更后的测试建议，用于统一回归与新增用例编写方式。

## 1. 构建与基础回归

- 构建：`npm run build`
- 蓝图回归：`npm test -- tests/pipeline/blueprint-regression.test.ts --runInBand`
  - 说明：该用例基于用户的 codex-samples 快照与用户配置动态生成蓝图，校验不同 providerProtocol 的节点签名。
  - 若环境未配置样本/用户配置会自动跳过。

## 2. 协议守卫与形状断言（新增建议）

新增 `tests/provider/provider-composite-guards.test.ts`（建议：在后续 PR 中加入），覆盖：

- `ERR_PROTOCOL_MISMATCH`：
  - 构造请求体并注入 runtime metadata（providerType 与 providerProtocol 显式不匹配），
  - 调用 `ProviderComposite.applyRequest` → 断言抛错；
  - 同理 `applyResponse`。

- `ERR_COMPAT_PROTOCOL_DRIFT`：
  - 模拟 compat 插件输出非预期形状（如 openai-chat 协议下没有 `messages` 或 `choices`），
  - 断言 `applyRequest/Response` 抛错。

伪代码示例：

```ts
import { ProviderComposite } from '../../src/providers/core/composite/provider-composite.js';
import { attachProviderRuntimeMetadata } from '../../src/providers/core/runtime/provider-runtime-metadata.js';

test('protocol mismatch fails fast', async () => {
  const body: any = { model: 'gpt-4o', messages: [] };
  attachProviderRuntimeMetadata(body, {
    requestId: 'req_x', providerType: 'anthropic', providerProtocol: 'openai-chat'
  });
  await expect(
    ProviderComposite.applyRequest(body, { providerType: 'anthropic', dependencies: anyDeps })
  ).rejects.toThrow(/ERR_PROTOCOL_MISMATCH/);
});
```

## 3. 家族聚合回归（openai 协议族）

针对 `glm/lmstudio/iflow`：

- 入站：构造 openai-chat 形状请求 + 注入 runtime metadata（providerType='openai', providerId='glm' 等），
  - 断言：最小清理生效（如 GLM 删除 tools[].function.strict/无 tools 时删除 tool_choice）。
- 返回：构造上游 JSON 响应，调用 `applyResponse`，
  - 断言：非流式响应黑名单仅在非 `/v1/responses` 入口时生效（依据 metadata.entryEndpoint）。

针对 `qwen`：

- 断言聚合器保持 OpenAI 形状，不走“input/parameters”改形状路径。

## 4. SSE 路径验证（Responses）

- 使用 ResponsesHttpProvider 发送请求（或模拟 sendRequestInternal 的 SSE 分支），
- 断言：
  - Provider 对 Host 返回 JSON（内部会将上游 SSE 解析为 JSON），
  - 不透传 `__sse_stream`，Client 方向 SSE 由 llmswitch-core 管理。

## 5. 验证脚本适配说明

`npm run build:verify` 当前蓝图依赖独立 virtualRouter 节点；本次变更将虚拟路由器并入 llmswitch-core，
因此需要更新验证脚本或切换到新的蓝图：

- 方案 A：更新脚本以读取 BasePipeline 注入的 `providerProtocol` 元信息；
- 方案 B：提供新的验证蓝图（不依赖独立 virtualRouter 节点），通过 `orchestrator.resolve(entry, { providerProtocol, processMode })` 选择。

待测试蓝图更新后，本用例将纳入 CI。

## 6. 全局 Dry-Run（路径 & 快照）

为方便批量验证兼容层/虚拟路由/ProviderComposite 的执行路径，新增脚本
`scripts/pipeline-dry-run.mjs`：

```
npm run build
node scripts/pipeline-dry-run.mjs \
  --config ~/.routecodex/config.json \
  --samples ~/.routecodex/codex-samples \
  --out demo-results/pipeline-dryrun
```

- 脚本会使用 `PipelineAssembler` + `VirtualRouterModule` 组装流水线，
  并从 `codex-samples/openai-chat|openai-responses|anthropic-messages` 中读取
  `*_http-request.json` 逐条重放（默认每类全部，可用 `--limit` 限制）。
- Provider 阶段仍通过现有 ProviderComposite/HTTP provider 走完整链路，但因为使用
  本地请求不会访问真实上游；所有快照写入 `--out/snapshots`（可通过
  `ROUTECODEX_SNAPSHOT_BASE` 自定义）。
- 每个请求都会生成 `summary.json` 结构，包含 `routeName`、`pipelineId`、
  provider target、执行耗时以及 `pathSignature`（按节点顺序汇总）。
- 快照沿用 `llmswitch-core` 的 `pipeline.aggregate`、`compat.pre/post`、
  `provider.request/response`，可直接在现有界面或分析脚本中解析。

通过该 dry-run 输出的路径数据，可以快速核对“虚拟路由 → chat-process →
provider-composite → provider-http → response-process”的实际执行链，
避免在没有真实上游的环境中手动重复验证。

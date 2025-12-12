## CI Golden 样本库

`samples/ci-goldens/` 内置了一套最小化的请求样本，覆盖目前已经打通的三条聊天入口：

```
samples/ci-goldens/
  openai-chat/
    glm/
      meta.json
      request.sample.json
  openai-responses/
    fai/
      meta.json
      request.sample.json
  anthropic-messages/
    glm-anthropic/
      meta.json
      request.sample.json
```

每个目录直接包含阶段快照里抽取的 `request.sample.json`（等价于
`*_req_outbound_stage2_format_build.json.body`），以及 `meta.json`，注明来源
stage、providerId 与捕获时间。CI 或本地始终可以依赖这些样本来跑最基本的
roundtrip/工具校验，而不需要访问真实 provider。

### `npm run test:golden`

命令会按照下面的顺序执行：

1. `node scripts/tools/capture-provider-goldens.mjs --custom-only --update-golden`
   - 优先读取 `~/.routecodex/golden_samples/new/<entry>/<provider>/`；
   - 若用户目录缺失，则自动回退到 `samples/ci-goldens/...`；
   - 最后才会使用 `samples/chat-blackbox/**/request-basic.json` 做最小回放。
   - 结果写入 `~/.routecodex/golden_samples/provider_golden_samples/**`，供 Provider
     单测与 mock 回放使用。
2. `node scripts/mock-provider/run-regressions.mjs`
   - 使用仓库内 `samples/mock-provider/_registry` 的样本，通过 mock provider
     执行一轮端到端回放；
   - 默认启用 `ROUTECODEX_MOCK_ENTRY_FILTER=all`，确保 chat/responses/anthropic
     都被验证。

如果检测到 `~/.routecodex/codex-samples`，脚本会提示可以运行
`node scripts/mock-provider/capture-from-configs.mjs` 将真实请求转成 mock 回放样本。
该命令会根据本地 `~/.routecodex/provider/**/config*.json` 与
`~/.routecodex/golden_samples/new/**` 生成新的 `samples/mock-provider/...`
目录，并刷新 `_registry/index.json`。随后再次执行 `npm run test:golden` 即可把
“真实” provider 行为也纳入回归。

### 如何补充新的 provider 样本

1. 在本地 `routecodex` 服务上真实跑通一次请求，确认
   `~/.routecodex/golden_samples/new/<entry>/<provider>/request.sample.json` 已生成。
2. 运行 `npm run sync:ci-goldens`（或直接执行
   `node scripts/tools/sync-ci-goldens.mjs --entry <entry> --provider <id>`）把刚产生的
   样本复制到 `samples/ci-goldens/<entry>/<provider>/`，脚本会自动生成/刷新 `meta.json`
   并用 `source: "ci-goldens"` 标识。
3. 运行 `npm run test:golden`，确认新的样本能够被
   `capture-provider-goldens.mjs` 消费并写入
   `~/.routecodex/golden_samples/provider_golden_samples/<provider>/<entry>/`。
4. 如需把同一份请求加入 mock provider 回放，可执行
   `node scripts/mock-provider/capture-from-configs.mjs --filter <providerId>`，
   该命令会复用刚才的 `request.sample` 生成 `samples/mock-provider/...` 记录。

> 注意：CI goldens 只存储对齐 chat 入口输入字段的最终 JSON，不包含任何密钥或本地路径。
> 如需测试特定机密字段，请在本地运行 `capture-provider-goldens` 并利用私有
> `~/.routecodex/golden_samples/new/**`，不要把敏感样本提交到仓库。

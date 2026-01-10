# Provider v2 配置与路由拆分落地计划

## 目标与约束

- 将现有「virtualrouter 内联 providers + routing」改为：
  - Provider 配置：按 provider 维度拆分到 `~/.routecodex/provider/<id>/config.v2.json`。
  - Routing 配置：保留在主配置（或单独 routing 文件）中，仅描述 route → pool → providerKey 关系。
- v2 配置通过 `version: "2.0.0"` 与 v1 完全区分，不影响已有 v1 配置（`config.v1.json` / `config.json.virtualrouter.providers`）。
- 正式运行路径**不做 v1/v2 兼容合并**：v2 模式只读 provider v2 配置；v1 配置仅供迁移脚本和回溯分析使用。
- 不改动 llmswitch-core 的 VirtualRouter 接口：仍然通过 `bootstrapVirtualRouterConfig(virtualrouter)` 喂入统一的 VirtualRouterInput。

---

## 目录与文件布局（Provider 侧）

1. 顶层 Provider 目录

- 路径：`~/.routecodex/provider`
- 启动行为：
  - 若目录不存在：启动时自动创建。
  - 若存在：每个子目录代表一个 provider 实例（`<providerId>` 或 `<providerId>-<profile>`）。

2. 单个 Provider 目录结构（示例：`~/.routecodex/provider/antigravity`）

- 静态配置（v2）：
  - 文件：`config.v2.json`
  - 样例：
    ```json
    {
      "version": "2.0.0",
      "providerId": "antigravity",
      "type": "gemini-cli-http-provider",
      "providerType": "gemini",
      "baseURL": "https://daily-cloudcode-pa.sandbox.googleapis.com",
      "auth": {
        "mode": "oauth",
        "oauthProviderId": "antigravity",
        "tokenFile": "~/.routecodex/auth/antigravity-oauth-1-geetasamodgeetasamoda.json"
      },
      "models": [
        {
          "id": "claude-sonnet-4-5-thinking",
          "maxTokens": 64000,
          "maxContext": 148000,
          "supportsStreaming": true
        }
      ],
      "compat": {
        "profile": "chat:gemini",
        "options": {}
      },
      "tags": ["gemini", "cli", "antigravity"]
    }
    ```
- 本地 runtime 状态（后续阶段接入）：
  - `runtime-state.json`：当前 providerKey 级别的健康 / 拉黑 / 冷却状态快照。
  - `events.jsonl`：ProviderErrorEvent / 手动操作事件流。

3. 与现有 provider 配置的关系

- 如目录下存在 `config.v1.json`，它只在 v1 模式或迁移脚本中使用；v2 模式**只读 `config.v2.json`**。
- v1 → v2 的对齐由独立脚本完成（例如 shadow/对比脚本），正式 server/CLI 代码不包含自动迁移或合并逻辑。

---

## 主配置（config.json）与 Routing 拆分

1. config.json 角色简化

- 保留：
  - server 端口、日志选项等 host 级配置。
  - virtualrouter 的 routing 结构或指向 routing 文件的引用。
- 不再要求在 `config.json` 内联 provider 列表：
  - v2 模式下忽略 `virtualrouter.providers` 字段（如存在，仅用于 v1 fallback）。
- 新增模式开关（示例）：
  ```json
  {
    "virtualrouterMode": "v2",
    "virtualrouter": {
      "routing": {
        "default": {
          "pools": [
            { "id": "primary", "targets": ["antigravity.claude-sonnet-4-5-thinking"] }
          ]
        }
      }
    }
  }
  ```

2. VirtualRouterInput 组合逻辑（v2 模式）

- 启动时步骤：
  1. 扫描 `~/.routecodex/provider`：
     - 如不存在则创建空目录。
     - 对每个子目录：若存在 `config.v2.json`：解析为 `ProviderConfigV2`；否则跳过（无隐式迁移）。
  2. 从 `config.json` / routing 文件读取 routing 配置。
  3. 组合为 VirtualRouterInput：
     - `providers`: 仅来自上述 ProviderConfigV2 集合。
     - `routing`: 来自 routing 配置（route → pools[] → targets[]）。
  4. 调用 `bootstrapVirtualRouterConfig(input)`，生成 VirtualRouterConfig 交给 HubPipeline。

---

## Provider v2 CLI 管理（rcc provider …）

> 仅定义接口与交互流程，具体实现另行分阶段落地。

1. 命令结构

- `rcc provider list`
- `rcc provider add`
- `rcc provider change <providerId>`
- `rcc provider delete <providerId>`

2. add/change 交互流程（统一）

- 询问 providerId（例如 `antigravity`），检查对应目录是否存在。
- 选择 provider 类型：
  - `gemini-http-provider` / `gemini-cli-http-provider` / `responses-http-provider` / `openai-http-provider` / `anthropic-http-provider` / `mock-provider` 等。
- baseURL 与 endpoint 区分说明，并询问 baseURL（针对常见类型给默认值）。
- 选择认证方式：
  - `api_key`：输入 key 名称（env 名或 token 文件路径），选择新增/覆盖。
  - `oauth`：选择/输入 `oauthProviderId`，说明会复用现有 OAuth 流程。
- 模型列表配置：
  - 至少一个模型：输入 modelId，设置 maxTokens / maxContext / supportsStreaming 等，可回车接受默认建议值。
  - 支持追加多个模型。
- compat 配置：
  - 从已支持的 compat profile 列表中选择（例如 `none` / `chat:gemini` / `chat:responses` 等）。
- 预览：
  - 在终端打印拟写入的 `config.v2.json`，高亮关键字段。
- 确认：
  - 用户确认后写入/覆盖 `~/.routecodex/provider/<id>/config.v2.json`。

3. list/delete 行为

- list：
  - 扫描所有 `config.v2.json`，输出 providerId/type/baseURL/模型数量等摘要。
- delete：
  - 询问确认后：
    - 仅删除 `config.v2.json`（保留 runtime-state 调试），或
    - 删除整个 `~/.routecodex/provider/<id>` 目录（可作为高级选项，默认不做）。

---

## 落地阶段计划

> 实际执行顺序将写入 `task.md`，这里给出高层分期。

1. 阶段 1：定义 VirtualRouterInput 与 ProviderConfigV2 schema
   - 在 host 层显式定义 VirtualRouterInput 类型（providers + routing），抽离出当前 loader 中的隐式结构。
   - 定义 `config.v2.json` 的 TypeScript 接口与基础校验逻辑。

2. 阶段 2：Provider v2 loader（只读，不接入 runtime）
   - 实现扫描 `~/.routecodex/provider` 的 ProviderConfigV2 loader（**只读取显式 `config.v2.json`**，不做自动迁移）。
   - 编写单元测试：确保 loader 对合法 v2 配置的读取行为稳定、可预期；迁移逻辑由单独脚本负责。

3. 阶段 3：Routing loader 与 VirtualRouterInput 组合器
   - 提取/实现 routing loader（从 config.json 或独立 routing 文件读取 route → pools → targets）。
   - 实现组合器：从 ProviderConfigV2 + routing 构造 VirtualRouterInput。
   - 在测试中以 “shadow 模式” 对比 v1 与 v2 VirtualRouterInput，确保结构一致。

4. 阶段 4：接入 runtime（v2 模式开关）
   - 在 `routecodex-config-loader` 中添加 `virtualrouterMode` 分支：
     - `v1`：保持现有 monolithic 行为。
     - `v2`：调用新组合器构建 VirtualRouterInput。
   - 在 dev 环境下以 v2 模式运行全部现有验证脚本（e2e toolcall / routing-instructions / errorsamples 等），确认行为等价。

5. 阶段 5：CLI 支持（rcc provider …）
   - 实现 `rcc provider list/add/change/delete` 子命令。
   - 将 CLI 与 ProviderConfigV2 loader 共用同一 schema/校验。
   - 编写基础交互测试，确保 CLI 对配置文件的读写与 loader 保持一致。

6. 阶段 6：默认切换与清理
   - 在确认 v2 模式稳定后，将默认 `virtualrouterMode` 切换为 `v2`，保留 v1 fallback 若干版本。
   - 在文档和 config 模板中标记 v1 provider 配置为 deprecated，但不立即删除实现，以便回退。 

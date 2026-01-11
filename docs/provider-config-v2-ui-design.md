# Provider 管理视图（基于 Config V2）的 UI 设计草案

> 目标：在现有 Daemon / Token 管理 UI 之外，增加一层 **“基于 Config V2 的 Provider 管理视图”**。  
> 前端完全通过 API 读取 Config V2 的声明性配置，只读展示，不直接改 runtime，也不在 UI 内做 routing / tool 语义。

---

## 1. 数据来源与边界

- **数据来源**
  - Config V2 中的 provider 定义（未来的 `provider-v2-loader` + `virtual-router-builder` 的输出），预期字段包括：
    - `providerId` / `runtimeKey`
    - `providerFamily`（`openai` / `anthropic` / `gemini` / `glm` / `antigravity` …）
    - `protocol`（`openai-chat` / `openai-responses` / `gemini-chat` / `anthropic-messages` …）
    - 绑定的 `targetRuntime` / route key
    - 默认模型 / model aliases / series（`thinking` / `claude` / `gemini-pro` …）
    - quota 策略 / cooldown 策略（如果在 V2 里挂）
    - flags：`enabled` / `disabled`、`beta`、`internal-only` 等

- **边界约束**
  - UI 只读 Config V2 的**声明性配置**，不直接操作虚拟路由 runtime。
  - 真正的合并 / 组装仍然走 `bootstrapVirtualRouterConfig`，UI 只是把结果可视化。
  - 不在这个视图里做工具语义或 routing 逻辑，只展示：
    - “有哪些 provider”
    - “它们绑定到哪些 runtime / route / credential”

---

## 2. UI 入口：Providers (Config V2) 子视图

- 顶层 Tab 仍然是 `Providers`（复用 daemon/token 管理 UI）。
- 在 `Providers` Tab 内增加二级切换：
  - `Runtime health`：现有视图，展示虚拟路由 runtime 的健康状态（metrics、429 冷却等）。
  - `Config V2`：**新视图**，只从 Config V2 读取 provider 定义，做表格 + 详情的只读展示。

> 设计原则：Runtime health = “实际运行状态”；Config V2 = “声明性配置视图”。两者同屏，但逻辑解耦。

---

## 3. Config V2 Providers 视图布局

### 3.1 顶部 Summary 区

- **聚合统计**
  - Providers 总数：`N`（从 Config V2 统计）
  - 各 family 数量：OpenAI / Anthropic / Gemini / Antigravity / GLM …
  - Enabled vs Disabled：`N_enabled` / `N_disabled`
- **Config 路径信息**
  - 显示 Config V2 的主配置文件路径（只读），例如：
    - `config/virtualrouter.v2.json`
    - 或其它 V2 入口文件（如 modules 配置）

### 3.2 Provider 列表（主表格）

- 建议列：
  - **Provider ID**：如 `antigravity.jasonqueque.gemini-3-pro-low`
  - **Family**：`Gemini` / `OpenAI` / `Anthropic` / `GLM` / `Antigravity` …
  - **Protocol**：`gemini-chat` / `openai-responses` / `anthropic-messages` …
  - **Runtime**：虚拟路由 runtime key（如 `antigravity.jasonqueque`）
  - **Default route / series**：如 `default/thinking-primary`、`default/claude-series`
  - **Enabled**：`Yes` / `No`
  - **Source**：Config 文件标识（例如 `virtualrouter.v2.json#providers[3]`）
  - **Bound credential**：从 daemon/credentials 关联过来的 credential 名称（只读，展示非敏感信息）

- 行级操作（设计层面，仅发起只读 API 调用）：
  - **Preview route**
    - 调用 `/config/providers/v2/:id/preview-route`
    - 展示该 provider 在虚拟路由中的匹配规则 / fallback 方案（人类可读文本）
  - **View health**
    - 切换到 `Runtime health` 子视图并带过滤条件，只看该 provider 的健康 + 429 情况
  - **不提供直接 enable/disable**
    - 避免在 UI 中直接修改 Config V2，保持“配置文件是唯一真相”的原则。
    - 如果未来需要变更，可考虑“生成 patch 文件”而不是在线修改。

### 3.3 Provider 详情（侧边栏 / Modal）

点击表格某行，右侧弹出详情区域，包含：

- **基础信息**
  - Provider ID / Runtime / Family / Protocol
  - 所属 route / series（如 `route: "default"`, `series: "gemini-pro"`）

- **模型配置**
  - 默认模型：如 `defaultModel: "gemini-3-pro-low"`
  - 允许模型列表：`allowedModels: [...]`
  - 模型别名映射：如 `thinking`, `fast`, `long-context` 等到具体 model 的映射

- **Quota / Cooldown 策略（如果在 Config V2 中声明）**
  - per-minute / per-hour 限额（静态配置）
  - series cooldown 策略（与 virtual router 概念对齐，但数据来自 config）

- **Credentials 绑定**
  - 展示关联的 credential 引用（例如 `credentialsRef: "antigravity-oauth-2-jasonqueque.json"`）
  - 只显示文件名 / project_id 等非敏感字段。
  - 提供“查看凭证详情”按钮：
    - 切换到 `Credentials` Tab，并自动筛选对应 credential。

- **只读说明**
  - 在详情底部加一行固定提示：
    - `All fields are read-only; edits must go through Config V2 files and a full RouteCodex reload.`

---

## 4. 后端 API 规划（只读，供 UI 使用）

> 仅为 UI 设计预留接口，不在本任务中实现。  
> 真正实现时需要同时满足：本地访问安全 + 不泄露敏感字段（例如密钥）。

- `GET /config/providers/v2`
  - 返回 provider 列表，示例形态：
  ```jsonc
  [
    {
      "id": "antigravity.jasonqueque.gemini-3-pro-low",
      "family": "gemini",
      "protocol": "gemini-chat",
      "runtimeKey": "antigravity.jasonqueque",
      "route": "default",
      "series": "gemini-pro",
      "enabled": true,
      "source": "virtualrouter.v2.json#providers[3]",
      "defaultModels": ["gemini-3-pro-low"],
      "credentialsRef": "antigravity-oauth-2-jasonqueque.json"
    }
  ]
  ```

- `GET /config/providers/v2/:id`
  - 返回单个 provider 的完整配置，包括：
    - 基础信息
    - 模型列表 / 别名
    - quota 配置
    - override 标记
    - 可选 notes / description

- `GET /config/providers/v2/:id/preview-route`
  - 返回该 provider 在虚拟路由中的匹配 / fallback 逻辑（已经由后端渲染为人类可读文本）。
  - 用于前端详情中的 “Preview route” 区块。

> 暂不设计任何 `POST` / `PATCH` API，未来若需要可以扩展为“生成配置 patch 文件”而不是直接改动 Config V2。

---

## 5. 与现有 Daemon / Token UI 的关系

- **Daemon / Token 管理 UI**
  - 负责 token、credentials、health、quota 的运行时视图：
    - Daemon 状态（进程 / uptime / 监听端口）
    - Token / Quota 使用情况、429 冷却
    - Credentials 列表与验证
    - Runtime health（per provider / per series）

- **Config V2 Provider 管理视图**
  - 负责 “有哪些 provider 以及它们在 Config V2 中如何声明”：
    - Provider ID / family / protocol / runtime / route / series
    - Config 来源文件
    - 声明性的 quota / cooldown 策略
    - 绑定到哪个 credential

- **两者的关联方式**
  - 通过 `runtimeKey` + `credentialsRef` 进行关联：
    - 在 Providers (Config V2) 视图中展示绑定的 credential 名称。
    - 在 Credentials 视图中可以反查“这个 credential 被哪些 provider 使用”。
  - Runtime 健康信息仍然来自虚拟路由实际状态，Config V2 视图不直接读 health，而是通过跳转 / filter 进行联动。

---

## 6. 后续实现路线（高层 TODO，仅做规划）

1. **后端只读 API 草案实现**
   - 在 daemon / host 中实现 `/config/providers/v2*` 只读接口。
   - 确保敏感字段（密钥、token 值）不会出现在返回数据中。
2. **在现有 `daemon-admin-ui.html` 里接入 Providers(Config V2) 子视图**
   - 添加二级 Tab 切换。
   - 用静态假数据先跑通布局，再替换为 API 请求。
3. **与 Credentials / Runtime health 联动**
   - Providers 视图中点击 credential / health 操作时，跳转到对应 Tab 并带筛选条件。
4. **Config V2 ready 之后对齐实际 schema**
   - 一旦 Config V2 schema 固定，更新此文档中的字段命名与示例。
   - 清理临时字段，保持“Config 驱动”原则：UI 只读配置，不干预 llmswitch-core 的路由 / 工具逻辑。


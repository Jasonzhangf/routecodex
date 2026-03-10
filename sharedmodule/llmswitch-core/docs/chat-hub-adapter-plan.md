## Chat Hub 协议转换重构设计

> 目的：保持现有三阶段（入站→Chat治理→出站）流程不变，仅在入/出站各自的“解析+映射”内部抽象，解决指令、tool ids 等字段不对称问题，并提供缺失字段记录能力。

### 1. 目录与模块
新建 `src/conversion/hub/`，内容：
1. `types/ChatEnvelope.ts`：统一 Chat 中心骨架（messages、tools、toolOutputs、metadata）。
2. `format-adapters/<protocol>/`：语法解析与重建，负责从原协议 JSON → `FormatEnvelope`，以及逆过程。
3. `semantic-mappers/<protocol>.json`：字段映射表，描述协议字段 ↔ Chat 语义字段的对应关系与策略。
4. `pipelines/inbound.ts`、`pipelines/outbound.ts`：按阶段驱动 adapter，与现有核心治理对接，支持配置化阶段顺序与 passthrough。
5. `test/hub/`：闭环测试（JSON + SSE）及 codex 样本回放。

### 2. ChatEnvelope 与缺失字段
```ts
interface ChatEnvelope {
  messages: ChatMessage[];
  tools?: ChatToolDef[];
  toolOutputs?: ChatToolOutput[];
  metadata: {
    context: AdapterContext;              // providerId, entryEndpoint, profile 等
    missingFields?: MissingField[];       // 记录入站丢失或降级的字段
  };
}

interface MissingField {
  path: string;                           // 协议字段路径
  reason: string;                         // 例如 unsupported-role / downgraded-system
  originalValue?: unknown;                // 需要恢复时使用
}
```
`AdapterContext` 仅承载路由信息，不向 payload 注入数据。

### 3. 阶段划分与快照
沿用当前三阶段，通过 `hub/registry.ts` 配置阶段顺序，并可为特定协议声明 passthrough（例如已是 Chat 形状的负载直接跳过解析）。每次转换输出快照：
| Pipeline | Stage | 说明 |
| --- | --- | --- |
| Inbound | `format_parse` | FormatAdapter 解析原协议为 FormatEnvelope（可配置跳过） |
| Inbound | `semantic_map_to_chat` | 根据映射表生成 ChatEnvelope，登记 missingFields |
| Inbound | `inbound_passthrough` | （可选）当协议声明 passthrough 时直接返回 ChatEnvelope |
| Outbound | `semantic_map_from_chat` | ChatEnvelope → FormatEnvelope，优先查 Chat，缺失字段回查 missingFields |
| Outbound | `format_build` | FormatAdapter 生成目标协议 JSON |
| Outbound | `outbound_passthrough` | （可选）直通 provider payload（例如已是目标格式） |
| SSE | `sse_parse` / `sse_build` | 仅对 FormatEnvelope 做事件拆装 |

快照文件命名：`req_<id>_<stage>.json`，包含 payload、meta、missingFields。

### 4. FormatAdapter 接口
```ts
interface FormatAdapter {
  parseRequest(original: any, ctx: AdapterContext): FormatEnvelope;
  buildRequest(envelope: FormatEnvelope, ctx: AdapterContext): any;
  parseResponse(original: any, ctx: AdapterContext): FormatEnvelope;
  buildResponse(envelope: FormatEnvelope, ctx: AdapterContext): any;
}
```
FormatEnvelope 只保存协议语法（例如 responses input[]、anthropic content[]），不碰语义。

### 5. 字段映射（SemanticMapper）
- 每个协议提供 JSON 描述，例如：
```json
{
  "instructions": {
    "from": "format.body.instructions",
    "to": "chat.system[0].content",
    "policy": "first-to-instructions-others-to-user"
  },
  "tool_call_id": {
    "from": "format.body.input[].call_id",
    "to": "chat.messages[].tool_calls[].id",
    "policy": "normalize-function-call-id"
  }
}
```
- 运行时 loader 解析 JSON，调用策略库（normalize、truncate、downgrade 等）。入站/出站共用同一映射定义，实现镜像。
- 当某字段在 format 中找不到时，记录 MissingField；出站阶段若 Chat 中缺该字段，则回查 MissingField 或应用默认策略（如 persona）。

### 6. 缺失字段恢复
- 入站遇到无法直译的字段（如 responses 的系统消息被降级）→ 记录 MissingField (`reason: "downgraded-system"`，附原文)。
- 出站 `semantic_map_from_chat` 先读取 ChatEnvelope；若无数据，再查询 MissingField 列表，根据 `reason` 决定恢复或忽略。
- 无法恢复时抛出明确错误（携带 path + reason），替换当前模糊的 “Instructions are not valid” 调试体验。

### 7. SSE 解耦
- SSE 输入/输出仅处理 FormatEnvelope，不再触碰 Chat 语义。由配置决定是否 streaming；format adapter 提供 `toSseEvents` / `fromSseEvents` 辅助工具。

### 8. 测试与上线策略
1. 在新目录实现骨架与 responses adapter，写 JSON/SSE 闭环测试（引用 codex 样本）。
2. 验证通过后，为其他协议按顺序迁移；每迁移一个协议增加 golden fixture。
3. 所有协议切换完成后，替换现有 conversion 调用点；feature flag 控制上线。

### 9. 与现有流程的衔接
- 核心 Chat 治理模块保持不变，仅更换 inbound/outbound 入口函数。
- 工具治理、分层路由、SSE 管线仍使用现有逻辑；此次重构只影响“协议 ↔ Chat”转换代码。

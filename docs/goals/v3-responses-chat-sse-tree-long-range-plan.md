# V3 Responses / Chat SSE 树结构长程完成计划

状态：long-range execution plan

关联设计：`docs/goals/v3-responses-chat-sse-tree-design.md`

## 1. 总目标与完成验收

完成 RouteCodex V3 的独立 SSE/object pipeline，第一阶段覆盖 OpenAI Responses 与 OpenAI Chat；Gemini 不在本任务范围内，Anthropic 在这两个协议完成后再处理。

最终链路必须是：

```text
provider wire JSON/SSE
  -> independent SSE transport object
  -> protocol typed tree
  -> normalized Hub object
  -> protocol typed tree
  -> client JSON/SSE projection
```

完成时必须满足：

1. Direct 与 Relay 都先经过独立 SSE 模块，再连接客户端或进入后续协议投影。
2. Responses 具备全局 response/container、item、item subtype、content-part、tool/function、reasoning/output、usage/terminal 的分层树；每个 item 类型有独立 typed node、事件集合、reducer state 和 hook 输入。
3. Chat 具备 chunk、choice、delta、role/content/reasoning、tool/function call、finish reason、usage、terminal 的分层树。
4. normalized object 是唯一语义真源；不得保存或重放 raw JSON 字符串。未知字段必须进入显式 typed extension/order 结构，或在 owning parser 处显式报错。
5. 同协议双向转换满足 `decode(encode(tree)) == tree`，保留 identity、顺序、类型、terminal 状态和建模后的 extension 字段。
6. JSON 与 SSE 是同一 normalized object 的两种投影。内部可以按 item 处理和触发 hook；普通 JSON 输出仍必须是一个合法 JSON 文档，per-item JSON 只有在明确的 NDJSON/等价协议下才允许。
7. hook 只承担两种语义：外部类型通知、业务内容/字段改写。routing、retry、health、debug、snapshot、scope、continuation、error 等控制语义只走 typed side-channel、MetadataCenter 或 Error chain。
8. SSE transport error 进入统一 `ErrorErr01SourceRaised -> ErrorErr06ClientProjected` 错误链；不能被转换成成功、静默丢弃或由 outbound 补偿。
9. 历史 Direct hooks、Direct 兼容逻辑、Relay hooks、SSE 错误导出和 MetadataCenter 接线全部有唯一 owner、测试和 evidence。
10. Responses/Chat 的 Direct、Relay 模拟全流水线均通过 success、non-terminal、terminal、malformed、rewrite、transport-error 正反测试。

## 2. 范围与边界

### 范围内

- `v3/crates/routecodex-v3-sse` 独立 transport/object 模块。
- OpenAI Responses 与 OpenAI Chat 的 inbound parser、typed tree、reducer、normalized object、outbound JSON/SSE projector。
- Direct passthrough 与 Relay Hub pipeline。
- 类型通知 hook、内容改写 hook、历史 Direct hook 恢复。
- SSE transport error 导出、Error chain 接线、MetadataCenter 边界审查。
- resource/function/mainline/verification map、测试设计、wiki/manifest/evidence 的同步。

### 范围外

- Gemini。
- Responses 与 Chat 完成前的 Anthropic runtime 实现。
- 与本边界无关的 provider 兼容修复。
- fallback、silent cleanup、response repair、重复 parser、旁路 executor。
- 源码和模拟流水线未通过前的安装、重启和在线切换。

## 3. 不变量与设计原则

1. SSE transport 只负责 bytes、UTF-8、field、frame、data 合并、buffer/limit、EOF/error lifecycle；不解析 JSON、事件语义、tool、terminal、retry 或路由。
2. Responses 与 Chat 使用各自真实协议树，不共享伪 DTO；共享的只有 transport object 和明确的通用 object-consumer contract。
3. 每个关键字段、item、choice、delta、terminal、hook 有唯一树节点和唯一 owning parser/builder；只允许相邻 pipeline 节点转换。
4. normalized object 不保存 raw JSON。允许 parser 边界短暂拥有输入字节/文本，但不能把原文作为 round-trip 真源。
5. 未知协议字段必须通过显式 extension/order 字段表达；不能用 `Other(Value)`、通用 map 或 raw string 逃避归一化。
6. 控制面与业务 payload 物理隔离；MetadataCenter 不接收协议 payload，provider/client body 不携带内部 metadata/error/debug/scope/control 状态。
7. Direct 保持 same-protocol 语义并只消费 Direct-owned transport/hooks；Relay 走 Hub 主链；两边不能各自维护第二套语义 parser。
8. 同协议转换可逆；跨协议转换是明确 projection，不得虚称可逆，也不得隐式丢失真实语义。
9. 错误显式暴露，禁止 fallback、静默吞错、成功投影、handler/SSE/outbound 补偿。
10. Rust 是语义 runtime owner；TypeScript 只能保留薄 I/O/bridge 壳。

## 4. 技术计划与文件范围

- Transport owner：`v3/crates/routecodex-v3-sse/src/lib.rs`、manifest、unit tests。
- Direct owner：`v3/crates/routecodex-v3-runtime/src/kernel/direct_runtime_helpers_stream.rs`、`direct_sse_consumers.rs`。
- Responses owner：`v3/crates/routecodex-v3-runtime/src/hub_v1/responses_sse_tree.rs`、Responses provider event codec/materializer、typed-tree tests。
- Chat owner：`v3/crates/routecodex-v3-runtime/src/hub_v1/openai_chat_sse_tree.rs`、Chat provider/relay codec/materializer、typed-tree tests。
- Hook owner：由 `docs/goals/v3-sse-hook-metadata-center-inventory.md` 与现有 hook registry 指定的 consumer/registry；禁止在 handler/outbound 复制 hook 逻辑。
- Error owner：现有 ErrorErr01–ErrorErr06 chain；SSE transport/codec/schema failures 从 ErrorErr01/02 进入，由统一 runtime policy 分类。
- Metadata owner：现有 MetadataCenter resource/function/mainline map；只允许内部控制 side-channel。
- Architecture owner：`docs/architecture/v3-resource-operation-map.yml`、`v3-function-map.yml`、`v3-mainline-call-map.yml`、`v3-verification-map.yml` 与关联设计/库存文档。

每次编辑前后都必须核对对应模块的 owner、owned/allowed/forbidden paths、相邻 caller/callee、resource edge 和 required gates。

## 5. 风险与处置

| 风险 | 处置 |
|---|---|
| raw JSON 通过便利字段重新进入 | typed API、静态扫描、禁止 raw replay 的红测 |
| 未知字段或顺序丢失 | explicit extension/order 字段、双向 fixture |
| item/choice identity 丢失 | response id + output index + item id、choice index 的 key contract 与交错事件测试 |
| transport error 被误判为成功 terminal | Error chain 正反测试、EOF/`[DONE]`/malformed 区分测试 |
| Direct/Relay 形成重复 parser | resource/mainline edge gate、唯一 owner 扫描 |
| hook 通过 payload metadata 改控制状态 | owning boundary fail-fast、metadata leakage negative tests |
| malformed frame 被静默接受 | parser/transport explicit error，禁止 keepalive/普通 text 归类补偿 |
| 既有编译基线干扰判断 | 只修唯一 owning boundary，单独记录 baseline 与 feature evidence，不扩大语义范围 |

## 6. 验证矩阵

1. SSE crate：framing、event/data、多行 data、UTF-8、JSON validity、`[DONE]`、不完整 frame、limit、transport error。
2. Responses tree：container、每个支持的 item subtype、content part、交错事件、extension、JSON/SSE projection、same-protocol round trip。
3. Chat tree：choice、delta、role/content/reasoning、tool/function call、finish reason、usage、terminal、extension、JSON/SSE projection、round trip。
4. Direct consumer：历史改写、类型通知、内容替换、兼容逻辑、malformed、transport-error export。
5. Relay provider：Responses/Chat inbound、item/choice 粒度、hook 顺序、terminal、projection、错误。
6. 全流水线：Direct 与 Relay 各覆盖 success、failure、non-terminal、already-terminal；每类正反测试成对存在。
7. 控制面：provider/client payload 不出现 MetadataCenter、Error、debug、scope、routing、retry、continuation 等内部控制字段；payload 不得反向重建控制状态。
8. 架构门禁：resource/function/mainline/verification map、hook registry、relay hook resources、raw JSON/replay、非相邻转换、重复 DTO、fallback、`git diff --check`。
9. Rust workspace build 与 verification map 要求的 targeted/full tests。
10. 源码门禁通过后，用全局安装版本按项目规则 restart，验证全部成员端口，并在线重放旧/真实样本；运行版本必须与验证变更一致。
11. 全部实现、构建、安装/重启、在线验证通过后，才启动 DSH Review；review 不是前置验证替代，任何代码修改都会使旧 evidence/PASS 失效并要求重跑受影响闭环。

## 7. 有序执行步骤

1. 读取 MemoryPalace、当前 run/claims、resource/function/mainline/verification maps、设计文档和 hook inventory，确认唯一 owner 与 worktree。
2. 完成独立 SSE transport object contract，并先固化 red tests 再实现。
3. 完成 Responses typed inbound tree、item subtype、normalized object、JSON/SSE outbound builder。
4. 完成 Chat typed inbound tree、choice/delta/tool subtype、normalized object、JSON/SSE outbound builder。
5. 完成共享 object consumer contract：类型通知与业务内容改写。
6. 将 Direct frame handling 全部切换到独立 SSE module 与 Direct consumers；transport error 接入 Error chain。
7. 将 Relay Responses/Chat parsing/materialization 切换到同一 object contract；删除重复 raw-string semantic path。
8. 审计并接线历史 Direct hooks、Relay hooks、SSE error export、MetadataCenter side-channel。
9. 执行完整验证矩阵；失败只回唯一 owner 修复，并同步 maps/evidence。
10. 执行 build、全局安装/restart、在线旧样本 replay。
11. 执行 DSH Review；若有 finding，修复后重新执行受影响验证与 review。
12. 生成最终 handoff：变更、验证证据、剩余风险、未完成项、运行版本和完成结论。

## 8. Definition of Done

只有在所有 acceptance criteria 和 verification matrix 有证据、Responses/Chat 的 Direct/Relay 模拟流水线全部通过、独立 SSE module 是唯一 transport parser owner、normalized typed object 是唯一语义源、raw JSON replay 路径消失、控制面隔离通过、maps/docs 与代码同步、在线验证完成、最终 review/handoff 完成后，才允许将长程任务标记为 complete。只完成设计、只通过单测、只完成一个协议或只完成 Direct/Relay 一侧都不算完成。

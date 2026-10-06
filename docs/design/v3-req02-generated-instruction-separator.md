# REQ02 归一化指令分隔符的来源与逆向消费

这是编码前的窄设计准入。未修改产品代码。父活动候选为 `/Volumes/Intel/playground/routecodex/req02-main336-combined-r15-20261004`，base 为 `3d2fa062c9933a48e726591f78a32f2e30aee67b`。本树仅审本文件；不能把父候选未完成实现作为本设计的验收对象。

## 证实的缺口

父候选 `.execution/gemini-parent-r15-builtin-red.log` 的真实公开 SDK consumer 4 PASS / 1 FAIL。Gemini 原生两段 `systemInstruction.parts` 归一成 Chat parts A、换行、B。当前标准 emitter 又将归一化换行发成第三个原生 part。原始文本、当前文本和归一化生成的分隔符没有独立来源类别。不能按 `text == "\n"` 删除 part。用户输入的换行和新插入的当前 part 必须保留。

已有设计 `v3-req02-lossless-instruction-segments.md` 已审通过，要求同一 builder 记录每个实际来源叶子。项目 request graph `docs/architecture/dagpipe/v3.operation_runner.request.graph.json` 已有 normalization -> canonical -> standard projection 的 inverse-context/current-association 资源边。本补链不增加节点、控制流程、raw registry、payload metadata 或 continuation。

## 固定链与唯一 owner

1. REQ02 `SystemInstructionBuilder` 在实际生成分隔符时，记录同一 typed `FieldMapping`，使用既有字段算子 ID、原 instruction container 的 source path、实际 emitted separator destination，并以 `semantics = normalization_instruction_separator` 区分 generated contribution。引用不存业务文本。源路径仅指生成该贡献的真实 instruction owner，不伪造客户端叶子。原始 source leaf 的 mappings 保持不变。
2. `CurrentFieldAssociations` 按 mapping index 跟踪此贡献，复用现有 Remove/Insert/Move 操作，不建第二套位置状态。Replace 仍读取当前业务数据。原 pair 不可变。
3. shared instruction inverse/helper 消费来源类别及当前 destination。目标 native instruction 形状支持独立 parts 时，仅取消仍等于 builder 发出形状的生成贡献；这个形状是固定 join 编码合同 `{"type":"text","text":"\n"}`，不是以文本发现来源。客户端输入的换行没有 generated mapping，必保留。生成 contribution 经当前 Replace 改为其他形状或文本时也成为当前语义，必保留。删除 mapping 或 part 不复活旧贡献。
4. 标准 Outbound emitter 按当前 Chat parts 顺序投影。原来源 part 与 opaque siblings 使用当前 typed mapping，插入的新 part 无原来源但仍正常投影。不从原 source parts 顺序重放，不恢复完整 raw 请求，不调用 Direct 整请求 facade。对于原生 Gemini 标准投影，消费同一 instruction inverse 的来源规则；跨协议 scalar/text join 继续消费全部 canonical parts，以保留既有连接字节。
5. 原 Runtime/Error/SSE 继续接收结果或真实失败并释放请求资源。instruction 算子不选择 provider、不重试、不接触客户端连接。

## 消融与范围

实施限定共享算子库 `field_operator_instructions.rs`、必要的 instruction inverse/helper、既有 typed mapping 消费与 Gemini 标准 instruction emitter。删掉被替换的无来源全量 native instruction part 投影分支，不保留旧路径。协议表示差异只按原注册 instruction transform 识别；不得按模型、工具名或换行值选择来源。

## 适用终点和验收

使用公开 REQ01 capture -> REQ02 SDK normalization -> public Relay projection consumer：

- 原生多段 instruction 完整对象等价，原 builtin 与 function 声明来源仍全覆盖。
- 相同原始文本、客户端原始换行、生成分隔符并存：只取消有 generated typed 来源且未改动的归一贡献。
- Insert、Move、Remove、Replace 后 current part 顺序和完整内容保留，opaque sibling 跟随真实原 part 来源；被删除贡献不复活。
- 当前生成分隔符改成业务内容时保留；新插入的合法换行保留。
- 既有 Direct instruction/current-values 与跨协议完整字节回归不变；公开失败及请求资源终态沿原 Error/Runtime owner，不引入拒绝策略。
- 正向修复与反向撤回再红，并记录精确源码输入、真实计数/exit。作者完整 REQ02 HTTP/WS 及两模型 exec/patch/MCP 黑盒仍是实现 review/接线前的门禁。本设计 PASS 不授予接线或交付。

本设计独占树是本目标资源；证据收取且实现使用后，由本目标在节点交付或明确 drop 时回收。审查发现业务或架构缺口时先修设计，不写产品代码。

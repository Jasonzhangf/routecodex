# 23 Servertool Hook Dev Debug Flow

## 何时用
- 你要真正开始替换 servertool TS 业务语义，而不是只讨论目标骨架。
- 你要 debug stopless / reasoning_stop / followup / reenter / hook injection / schema validation。
- 你要判断“现在能不能删 TS”或“现在为什么还不能删 TS”。

## 一眼执行主流程

```text
锁目标文档/wiki/mainline
  -> 补红测/红 gate 证明活 TS 语义仍存在
  -> 分 slice 下沉 Rust owner
  -> 白盒 focused tests
  -> 黑盒必经路径 tests
  -> 旧样本 / live replay
  -> mainline/function-map 从 pending 改 anchored
  -> 物理删除 TS 业务语义
  -> note.md -> MEMORY.md -> lessons/skills
```

- 少一步都不能宣称“servertool Rust-only 闭环完成”。
- `binding pending` 期间，只能宣称目标/骨架锁定或局部 slice 已下沉，不能宣称主线 Rust-only 已完成。
- 目标真源和执行真源必须双锁：
  - wiki/mainline/manifest 锁“应该长什么样”
  - `references/22` / `references/23` / lessons 锁“开发和 debug 该怎么做”
  - 任何稳定流程若只在 wiki、goal、`note.md` 或聊天里出现，视为沉淀未完成

## 真源
- 目标骨架：`docs/architecture/wiki/servertool-hook-skeleton-mainline-source.md`
- 机器主线：`docs/architecture/mainline-call-map.yml` 的 `servertool.hook_skeleton.mainline`
- 迁移计划：`docs/goals/servertool-rustification-implementation-plan.md`
- closeout 计划：`docs/goals/servertool-hook-skeleton-rust-only-closeout-plan-2026-06-22.md`
- Rust owner 方向：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/`
- Hub runtime owner：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/`
- TS 壳层：`sharedmodule/llmswitch-core/src/servertool/`

## 先判当前阶段
1. 文档锁定阶段
- 目标节点、顺序编号、required/optional、case matrix、mainline/wiki/manifest 已写明。
- 允许 `binding pending`；不允许伪造 Rust builder / function-map owner。

2. 骨架落地阶段
- Rust 已有 hook contract / scheduler / validator。
- 只能宣称“骨架能力存在”，不能宣称 request/response runtime 已替换完成。

3. 主线替换阶段
- 响应端：intercept -> schema validate -> hook response inject -> followup/reenter -> finalize。
- 请求端：result parse -> text rewrite -> tool inject -> finalize。
- 黑盒必须证明 client-visible CLI roundtrip 真实经过。

4. 删除 TS 阶段
- Rust owner symbols、单测、白盒、黑盒、旧样本 replay 全齐。
- function-map / verification-map / mainline binding 才能从 pending 改 anchored。
- 之后才允许物理删除 TS 业务语义。

## 开发顺序
1. 先锁骨架，不先改 runtime
- 确认 wiki/mainline/goal 文档已经表达目标顺序与边界。
- 若缺 request/response/error 节点名、requiredness、case matrix，先补文档。

2. 先补红测和红 gate
- 单元测试先锁当前缺口。
- 黑盒先锁必经之路和 negative direct path。
- 需要删除 TS 时，先补 audit gate 证明“活 TS 语义仍存在”。

3. 只改唯一 owner
- hook scheduler / phase validation / merge rule 改 Rust `servertool-core`
- Hub request/response orchestration 改 Rust `router-hotpath-napi`
- TS 只允许 native wrapper、JSON bridge、IO shell

4. 先白盒，再黑盒
- 白盒：Rust contract / scheduler / parser / effect planner focused tests
- 黑盒：client -> provider -> client CLI -> request restore -> provider roundtrip
- backend followup/reenter 另跑 effect path 黑盒

5. 最后删 TS
- 只有当 Rust 主线已真实承载排序、schema、terminal、tool inject、followup/reenter decision，才删 TS 对应业务文件/逻辑。
- 删前先 grep owner；删后补 gate 防复活。

## 标准开发闭环
1. 先审计，不先宣称 Rust-only
- 先量化活 TS 主线还在哪：`engine.ts`、`server-side-tools-impl.ts`、`execution-dispatch-outcome-shell.ts`、`followup/registry shell`。
- 若 gate 只是检查“Rust export 存在”，不能把 gate 绿当成“业务已 Rust-only”。

2. 先锁目标文档，再开始替换
- wiki/mainline/manifest 锁目标顺序、required/optional、case matrix。
- skill 锁实施顺序、debug 切段、删 TS 准入条件。
- 整个开发/debug 主流程本身也必须沉淀到 skill，而不是只写在目标文档里。
- `binding pending` 期间只允许写目标，不允许伪造已落地绑定。

3. 再补红 gate，证明 TS 活语义仍存在
- 用 audit spec / verify script 明确禁止 TS 排序、schema 判定、terminal 判定、followup payload 构造、tool output 手拼。
- 没有红 gate，就无法证明后续删除真的删到了活语义。

4. 分 slice 下沉到 Rust owner
- `servertool-core` 收 phase contract / scheduler / validator / merge。
- `router-hotpath-napi` 收 request/response runtime orchestration。
- TS 只剩 native wrapper、JSON bridge、CLI/HTTP/process IO shell。

5. 每个 slice 都要白盒 + 黑盒
- 白盒锁 phase 行为、错误分支、空 schema、invalid schema、already-terminal、multi-hook merge。
- 黑盒锁 client-visible CLI 必经之路和 direct negative。
- 旧样本 replay 或 live replay 是最终证据，不是可选项。

6. 最后改 map，再删 TS
- 只有 Rust 符号、测试、黑盒、旧样本 replay 全齐，`mainline` 才能从 `binding pending` 改 anchored。
- 然后物理删 TS 业务语义，并补 gate 防复活。

## Debug 切段法
1. 先拿样本
- 先查 `~/.rcc/codex-samples/` 或测试 fixture，锁 requestId、端口、provider、entry protocol。
- 没样本，不下结论。

2. 再判入口类型
- relay Hub path 还是 same-protocol direct/provider-direct。
- direct negative 必须先排除；direct 命中时不要去查 hook skeleton 不生效。

3. 再判卡在哪个骨架节点
- 响应没拦住：查 `ServertoolRespHook01Intercepted`
- schema 问题：查 `ServertoolRespHook02SchemaValidated`
- client exec_command 不对：查 `ServertoolRespHook03HookResponseInjected`
- followup/reenter 乱了：查 `ServertoolRespHook04FollowupPlanned` / `ServertoolRespHook05ReenterDispatched`
- request restore 不对：查 `ServertoolReqHook01ResultParsed` / `02` / `03` / `04`

4. 再反查唯一 owner
- 先查 wiki/mainline/owner registry。
- 再 grep Rust symbol / NAPI export / TS thin wrapper。
- 若 1-2 次查询还定位不到，先补 map，不直接改代码。

4.1 continuation 先判 owner，再判 hook
- 如果样本是 `/v1/responses.submit_tool_outputs`、`previous_response_id` 或 relay/direct continuation，先回到 Responses continuation owner，确认 `entryKind + continuationOwner + scope`。
- hook 只看当前请求的 tool result / response event；不要把 continuation store/restore 问题归到 servertool hook。
- `ServertoolReqHook01ResultParsed` 的“restore”只表示把 shell `exec_command` 的普通 tool result 还原成当前轮模型可见的 hook result，不表示重放历史 continuation。
- 对称配对要同时检查两侧：如果响应侧 `ServertoolRespHook03HookResponseInjected` 已经投影成 shell，那请求侧就必须在 `ServertoolReqHook01ResultParsed -> 02 -> 03 -> 04` 里把同一轮结果还原成 built-in tool 形状；如果响应侧还没投影，说明不该提前做请求侧恢复。两边错位就是上下文对不上。
- continuation 与 stopless 顺序锁：必须先 restore/materialize request truth（Responses continuation owner），再做 stopless 3-round no-schema 判定；响应侧必须先做完 stopless interception / schema / projection，再由 continuation owner 写回 canonical context。如果先存后拦，下一轮恢复出来的是旧 shape，注入的 schemaGuidance / repeatCount / feedback 会全丢；如果先拦后恢，3-round no-schema 判定拿不到真实当前轮上下文。判别证据：1）response 端是否产出标准 `exec_command`；2）第二轮 submit 时是否仍能从请求里取到上一轮 stopless 注入的 `schemaFeedback/repeatCount`；3）continuation store 里是否只保存了最终 project 后的 response，而不是原始 provider payload。
- 对 `/v1/responses`，response-side continuation save 不能只回写旧 request 壳；必须保存“上一版 request context + 当前 response delta”，其中 delta 至少覆盖最终 client-visible tool surface（如 stopless 投影后的 `exec_command` / required_action tool calls）。否则下一轮 restore 会丢 `payload.tools/context.toolsRaw`，stopless contract 与 tool visibility 一起断。
- SSE 是 transport-only。排查 stopless/continuation 时不得把 `handler-response-sse.ts`、SSE frame projector、stream closeout 当 schema judgment、tool restore、continuation save/restore 或 tool list injection owner；SSE 只能验证 framing/metadata isolation/JSON-SSE equivalence for finalized semantic body。如果修复需要改 SSE 才能让 stopless 过，先判为 wrong owner，回到 response governance、continuation owner 或 request hook owner。
- Responses continuation save 的过渡 TS 锚点只能在 response dispatch / lifecycle bridge 的 outbound 起点，不能在 `handler-response-sse.ts`。`forceSSE` JSON-to-SSE 和 relay SSE stream 都必须先经 lifecycle bridge 保存 finalized response truth，再交给 SSE 传输层写帧；SSE handler 不得 import `responses-response-bridge.js`。

5. 最后固化 red test
- 真实样本先落 fixture 或 focused case。
- 修复必须让 red -> green，再 replay 旧样本。

6. closeout feature-map 的 allowed_paths 选文件要避开 verify 脚本中的 builder 字符串
- 如果 `allowed_paths` 里放了包含 canonical builder 名称的 gate 脚本，`function-map` 的 builder 定义门禁会把字符串命中误判成 allowed-path 重定义。
- 只把真正的 owner 源文件和纯测试文件放进 `allowed_paths`；验证脚本留在 `required_gates`。

6. Native build 和黑盒顺序不能反
- 只要黑盒依赖新 NAPI 导出，必须先完成 `build-native-hotpath`，再跑 Jest / CLI 黑盒。
- 不要把 native build 和这些黑盒并行执行；否则很容易读到旧 `.node`，出现一串 `native unavailable` 假失败。
- 遇到 `buildClientExecCliProjectionOutputJson native unavailable`、`planServertoolEngineSkipJson native unavailable`、`inspectStopGatewaySignal native unavailable` 这类成串报错，先确认 build 是否已完成并重新串行跑黑盒。

7. live replay 要先看首轮，再看续轮
- stopless / reasoningStop 的 live probe 先判首轮是否产出标准 `exec_command(routecodex hook run reasoningStop ...)`，再判有没有 raw `reasoningStop` 泄漏，最后才看续轮是否因 `Responses conversation expired or not found`、provider 4xx 或样本失活失败。
- 不要把 probe 进程的最终退出码直接当成骨架回退；首轮命中标准 CLI 投影才是响应 hook 骨架是否工作的主证据。
- 若续轮失败，先确认是不是会话寿命/样本过期，再决定是否需要重跑样本，而不是先改代码。

8. stopless session 真源只认 request truth
- `stopless` 的 loop identity 只能来自 `requestTruth.sessionId`；禁止在 runtime control、NAPI stopless plan、CLI projection 或 MetadataCenter side-channel 再复制第二份 `sessionId`。
- 发现 `metadata.sessionId`、`runtime.sessionId`、adapter 本地字段回退拼装 stopless session，直接按错误实现处理并物理删除。

## 单轮开发/调试执行模板
1. 锁目标
- 先确认 wiki/mainline/manifest 仍表达当前目标；若目标变了，先改文档再改 runtime。

2. 审计活 TS
- 明确这轮要收缩的 TS 语义在哪个文件、哪几个分支、对应哪个 Rust owner slice。

3. 先红
- 先补 focused red test 或 audit gate，证明当前 TS 活语义还在，或当前 Rust owner 缺失。

4. 下沉 Rust owner
- 只改 Rust contract / NAPI bridge / TS thin shell 对应的唯一 owner 链，不在 TS 再补第二套决策。

5. 串行验证
- Rust focused tests。
- NAPI bridge focused tests。
- `build-native-hotpath`。
- Jest / CLI focused blackbox，必须 `--runInBand`。
- audit / architecture / rust-only verify gates。

6. 回放样本
- 用旧样本 replay 或 live probe 证明不是只对单测修好。

7. 回写 skills
- 稳定步骤进 `23`；可复用卡片进 lessons；raw 证据才留 `note.md`。

## 串行验证顺序
0. 先站对 Rust workspace
- `cargo test -p ...` 必须在 `sharedmodule/llmswitch-core/rust-core/` 下执行。
- 在 repo 根直接跑如果报 `could not find Cargo.toml`，这是 workspace 站位错误，不是 slice 红测。

1. `cargo test -p servertool-core <slice> -- --nocapture`
2. `cargo test -p router-hotpath-napi <bridge-test> -- --nocapture`
3. `node sharedmodule/llmswitch-core/scripts/build-native-hotpath.mjs`
4. `PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/jest/bin/jest.js <focused suites> --runInBand`
5. `PATH=/opt/homebrew/opt/node@22/bin:$PATH node scripts/verify-servertool-rust-only.mjs`
6. 需要时再补：
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-mainline-manifest-sync`
- `npm run verify:architecture-wiki-sync`

- 顺序反了，尤其是把第 3 步和第 4 步并行或颠倒，容易得到假性的 `native unavailable` 失败。

## 标准证据链
1. 文档证据
- wiki/mainline/manifest 与目标一致。

2. 白盒证据
- Rust focused unit tests。
- phase / requiredness / ordering / effect merge / schema validation / malformed CLI stdout。

3. 黑盒证据
- normal response
- abnormal response
- empty schema / no_schema
- invalid schema
- terminal
- non-terminal
- already-terminal
- direct negative

4. 运行时证据
- 旧样本 replay 或 live replay。
- 证明不是只对单测修好。

## Skills 沉淀闭环
1. 这次如果新增了稳定开发步骤，要回写 `23`
- 例如新的 slice 顺序、debug 切段法、删 TS 准入条件、黑盒必经路径。

2. 这次如果新增了可复用排障卡片，要回写当月 lessons
- 例如某类 hook schema 失配、followup/reenter 误入 direct path、CLI stdout malformed 的固定判法。
- NAPI build/Jest 串行要求、哪类 `native unavailable` 属于假失败，也属于 lesson，不是一次性备注。

3. 只进 `note.md` 的内容必须是 raw
- 临时样本、一次性日志、尚未证实的猜测、单次 shell 命令输出。

4. 已验证后必须升级
- 稳定流程 -> `references/23-servertool-hook-dev-debug-flow.md`
- 通用技能写法/沉淀边界 -> `references/60-note-memory-flow.md` / `references/80-skill-routing-convention.md`
- 单月经验卡 -> `references/92-lessons-2026-06.md` 或后续月份 lessons
- 若这轮形成了新的标准开发/调试主流程、ASCII 流程图、串行验证口径或“先改目标文档再替换 runtime”的固定顺序，默认先升级 skill，再把 raw 证据留给 `note.md`。

5. 不回写 skill 就不算流程闭环
- 只修代码、只补测试、只写 note，不足以算“开发和 debug 流程已沉淀入 skills”。

## 删 TS 的准入条件
- request/response hook skeleton 都已有 Rust runtime owner。
- `servertool.hook_skeleton.mainline` 不再是 `binding pending`。
- `hub.servertool_hook_skeleton` 可真实绑定到 Rust symbols/tests。
- direct negative、followup/reenter、CLI roundtrip 黑盒都过。
- 旧 TS 文件没有剩余业务判定，只剩 IO 壳；否则不能删。

## 反模式
- 文档还没锁就开始大改 runtime。
- 用 TS 再补一层排序/requiredness/schema/terminal 判定。
- 只跑 unit 不跑黑盒。
- 没旧样本 replay 就宣称闭环。
- `binding pending` 还在时就把 mainline/function-map 写成已实现。
- TS 文件还承载 engine/registry/followup decision，却宣称“0 TS 业务语义”。
- 把 skill 流程写在聊天里但不回写 repo；下次继续做时又要重新口述。
- 在 SSE writer / SSE bridge / stream closeout 里修 stopless schema、continuation restore/save、tool list preservation 或 hook projection；这属于传输层承载逻辑语义，必须退回唯一 owner 修。

## 验证
- `cargo test -p servertool-core`
- `cargo test -p router-hotpath-napi servertool --lib`
- `npm run verify:servertool-rust-only`
- `npm run verify:function-map-compile-gate`
- `npm run verify:architecture-mainline-call-map`
- `npm run verify:architecture-mainline-manifest-sync`
- `npm run verify:architecture-wiki-sync`
- 新增/相关 servertool focused blackbox

## 闭环收尾顺序（推荐硬性）
1. `npm run build:min`（含 verify:servertool-rust-only + function-map compile gate）
2. `routecodex restart --port <port>` + `/health`
3. live probe / 旧样本 replay
4. note.md -> MEMORY.md -> lessons/skills
- 任何一步不绿，先在该步定位，不要跳到下一步。
- `verify:servertool-rust-only` 必须跑在 build:min 链路里，不要把它单独提出 build:min 然后跳过架构/function-map gate。

## 相关 references
- [22-servertool-hook-skeleton-workflow.md](./22-servertool-hook-skeleton-workflow.md)
- [21-change-workflow.md](./21-change-workflow.md)
- [40-owner-registry.md](./40-owner-registry.md)
- [70-gate-discovery.md](./70-gate-discovery.md)

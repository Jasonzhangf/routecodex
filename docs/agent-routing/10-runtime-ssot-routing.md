# 运行时与真源边界路由

## 索引概要
- L1-L7 `scope`：覆盖范围。
- L9-L18 `ssot`：核心真源与禁止事项。
- L20-L27 `layer-responsibility`：三层职责。
- L28-L31 `hubpipeline-judgment`：HubPipeline TS 违规三层判定（可执行判定标准）。
- L33-L44 `hubpipeline-index`：HubPipeline TS 真源归属路径索引。
- L46-L48 `authoritative-docs`：权威文档索引。

## 覆盖范围
适用于：路由语义、tool 治理、pipeline 编排、provider 传输层边界类改动。

## 真源与禁止事项
1. 路由与工具语义真源：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/`。
2. Host 仅做编排与桥接，不重写 llmswitch 语义。
3. Provider 仅做 transport/auth/retry/compat，不解析业务语义。
4. 禁止 fallback 兜底和“跨层补一版逻辑”。
5. 执行期错误策略真源归 `Virtual Router policy`；禁止再保留独立 `error-handling center` / event bus 第二中心。`RequestExecutor` 与 `servertool engine` 只能消费 Router decision，不得各自重写 retry/reroute/backoff/fail 语义。
6. 文本工具 harvest 必须容器优先：先识别并 mask wrapper/fence，再解析内部顶层工具壳；正文 prose/shell/patch body 只保留或透传，不得参与猜测式恢复。
7. Provider-specific 提示词只允许调整“上游怎么吐”，不能在 Provider 层重写 harvest 语义；真正的收割边界仍在 chat-process Rust 真源。
8. DeepSeek tools 的当前主路径真源仍是**文本 fence / 文本工具壳**；不要把“要求 upstream 直接输出原生标准 function call”当成主策略。允许客户端侧桥接成标准 `function_call`，但 provider upstream 仍按文本协议治理与验收。

## 三层职责（Block / App / UI）
- Block：基础能力唯一真源。
- App：只编排，不重写 Block 细节。
- UI：只展示状态，不承载业务规则。


## HubPipeline TS 违规三层判定

### 判定顺序（依次，命中即停）

**① 被 pipeline stage index.ts 直接调用的 TS 函数（非薄壳）→ 违规，必须在 Rust**

pipeline stage 文件（`stages/req_inbound/.../index.ts`、`stages/req_process/.../index.ts`、`stages/resp_process/.../index.ts` 等）调用的 TS 函数，如果该函数自身包含：
- 对 messages/payload/tool_calls 的遍历、过滤、归一、删除等语义变换
- 不是仅做 JSON parse/serialize 包装
- 不是仅做类型边界转换

→ 违规。必须将语义迁入 Rust，TS 仅保留调用壳。

**② 直接 transform request/response messages / tool_calls / payload 字段的 TS 代码 → 违规**

即使该函数只被其他 TS 模块调用，不直接出现在 pipeline stage index，只要它：
- 对 message.content / tool_calls / payload 字段做删除、过滤、归一、重写
- 包含硬编码规则（如模板文本、字段名映射、空值判断）

→ 违规。应审视调用链后迁 Rust。

**③ 编排逻辑（选择/组合 native 调用 + 副作用调用） → 可接受，但需满足**

- 纯调度：决定"哪个 native 函数在哪个条件分支被调用"
- 无 payload 语义变换：不在编排层对消息内容做变换
- 至少一层走 native：编排分支中必有 `*WithNative()` 调用
- 有测试覆盖

不满足以上三条的编排 TS 也应收缩。

### Thin Wrapper 允许特征
以下形式均属可接受薄壳：
```ts
// 仅 JSON parse/serialize 包装
export function fooWithNative(input: SomeType): OtherType {
  return JSON.parse(nativeFoo(JSON.stringify(input))) as OtherType;
}

// 仅类型边界转换
export function bar(input: UnknownInput): KnownOutput {
  return nativeBar(input) as KnownOutput;
}

// 单行 return native 调用
export function baz(opts: Opts) { return nativeBaz(opts); }
```

### HubPipeline TS 真源归属（路径索引）
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/shared_response_compat.rs` → 消息过滤、空 assistant 过滤、mirror 检测、tool_call id 归一
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/req_process_stage1_tool_governance.rs` → req_process 工具治理主入口
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/resp_process_stage1_tool_governance.rs` → resp_process 工具治理主入口
- `sharedmodule/llmswitch-core/src/conversion/hub/process/*.ts` → 编排层薄壳，仅允许条件分支调度
- `sharedmodule/llmswitch-core/src/router/virtual-router/engine-selection/native-*.ts` → 100% 薄壳，不含业务逻辑

## 权威文档索引
- `docs/ARCHITECTURE.md`
- `docs/error-handling-v2.md`
- `docs/routing-instructions.md`

## 架构索引与门禁
- 关键功能定位先查 `docs/architecture/function-map.yml`
- 最小验证栈先查 `docs/architecture/verification-map.yml`
- 架构规则先落模板，再升为门禁；至少保持以下验证栈可用：
  - `npm run verify:architecture-ci`
  - 逐项排查时再拆跑单项 gate：
  - `npm run verify:architecture`
  - `npm run verify:function-map-coverage`
  - `npm run verify:function-map-paths`
  - `npm run verify:function-map-boundary-mentions`
  - `npm run verify:function-map-owner-uniqueness`
  - `npm run verify:function-map-canonical-builder-definitions`
  - `npm run verify:function-map-forbidden-mentions`
  - `npm run verify:function-map-required-tests`
  - `npm run verify:architecture-fallback-denylist`
  - `npm run verify:architecture-feature-id-anchors`
  - `npm run verify:architecture-nonadjacent-conversion`
  - `npm run verify:architecture-feature-anchor-coverage`
  - `npm run verify:architecture-duplicate-dto-patterns`
    - `HubReq* / HubResp* / VrRoute* / ErrorErr*` 禁止 warning-only 重复；Rust truth、TS alias、本地 envelope 同名都直接失败
  - `npm run verify:architecture-provider-specific-leaks`
  - `npm run verify:architecture-thin-wrapper-only`
  - `npm run verify:architecture-metadata-leak-boundary`
  - `npm run verify:architecture-error-chain-bypass`
  - `npm run verify:architecture-owner-queryability`
  - `npm run verify:architecture-feature-map-growth-discipline`
  - `npm run verify:architecture-forbidden-path-growth`
  - `npm run verify:architecture-adjacent-builder-naming`
- 相关真源：
  - `docs/architecture/README.md`
  - `docs/architecture/function-map.yml`
  - `docs/architecture/verification-map.yml`

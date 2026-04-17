# 运行时与真源边界路由

## 索引概要
- L1-L7 `scope`：覆盖范围。
- L9-L18 `ssot`：核心真源与禁止事项。
- L20-L27 `layer-responsibility`：三层职责。
- L29-L35 `authoritative-docs`：权威文档索引。

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

## 权威文档索引
- `docs/ARCHITECTURE.md`
- `docs/error-handling-v2.md`
- `docs/routing-instructions.md`

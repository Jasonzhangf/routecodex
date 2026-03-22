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

## 三层职责（Block / App / UI）
- Block：基础能力唯一真源。
- App：只编排，不重写 Block 细节。
- UI：只展示状态，不承载业务规则。

## 权威文档索引
- `docs/ARCHITECTURE.md`
- `docs/error-handling-v2.md`
- `docs/routing-instructions.md`

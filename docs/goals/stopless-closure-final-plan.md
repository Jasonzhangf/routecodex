# Stopless 最终收口实现文档

## 目标

1. **VR stopless followup 必须走 thinking 路由**：classifier 读取 `serverToolFollowup` 标记，让 stopless 续轮下一轮走 `thinking` 而非 `tools`
2. **Schema guidance 文本含 JSON 样本**：CLI stdout 的 `continuation_prompt` 在 `NoSchema/InvalidSchema` 触发时附带简短 JSON 示例
3. **Client 无感残留清理**：确认 `exec_command` 客户端可见性策略，必要时重命名或移除
4. **编译构建全局安装重启**：所有改动落地并验证

## 变更 1：VR stopless followup 走 thinking

### 根因
当前 `classifier.rs` 路由判断只基于 `latest_message_from_user`：
- stopless followup 下一轮消息是 `tool` role → `latest_message_from_user = false` → 不走 thinking
- stopless followup 设置了 `serverToolFollowup=true` 但 classifier 不读此标记

### 改点
文件：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/classifier.rs`

在 `classify()` 函数中，读取 `features.metadata` 的 `serverToolFollowup` 标记：
```rust
// 在 let thinking_from_user = ... 之前加：
let stopless_followup = features
    .metadata
    .get("serverToolFollowup")
    .and_then(|v| v.as_bool())
    .unwrap_or(false);

let thinking_from_user = latest_message_from_user || stopless_followup;
```

同时在 `RoutingFeatures` 的 `build_routing_features` 函数中，把 `metadata` 完整传入（已传入 `metadata_copy`），确保 classifier 能读到 `serverToolFollowup`。

### 红测
```rust
// 新增测试：
fn stopless_followup_routes_to_thinking_even_without_user_text() {
    let mut features = RoutingFeatures::default();
    features.latest_message_from_user = false;
    features.has_tool_call_responses = true;
    features.metadata = serde_json::json!({ "serverToolFollowup": true });
    // ... classifier.classify(&features) ...
    assert_eq!(result.route_name, "thinking");
    assert!(result.reasoning.contains("thinking:user-input"));
}
```

## 变更 2：Schema guidance 文本含 JSON 样本

### 根因
当前 `stopless_prompt.rs::resolve_stopless_continuation_prompt` 只生成自然语言引导文本，不含 JSON 样本。模型看到"继续做下一步"但不知道 stop schema 具体怎么写。

### 改点
文件：`sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stopless_prompt.rs`

在 `NoSchema` 和 `InvalidSchema` 触发的 prompt 末尾追加简短 JSON 样本（不超过 200 chars）：

```rust
(StoplessContinuationTrigger::NoSchema, "first") => {
    "继续做下一步；先把手头能确认的结果拿回来。\n\n（参考格式：{\"stopreason\":0,\"reason\":\"已完成\",\"has_evidence\":1,\"evidence\":\"命令输出\"}）"
}
```

**约束**：
- 样本只出现在 `NoSchema` / `InvalidSchema` 触发的 first/middle 轮
- final 轮不出现（已经给过多次机会）
- 样本中不暴露 `forcestop` / `continue_needed` 等进阶字段
- 必须通过 `assert_no_forbidden_token` 检查

### 红测
扩展现有 `no_schema_first_round_is_natural_user_language` 测试，验证样本存在且不含禁词。

## 变更 3：Client 无感残留清理

### 根因
`exec_command(routecodex hook run reasoning_stop ...)` 仍在客户端 tool call list 里可见，客户端能看到 RouteCodex server 的存在。

### 分析
Jason 原始需求："对客户端无感，要把它（工具执行）的部分抹掉，让模型不知道我们注入了提示词"

当前状态：
- ✅ CLI 命令参数不含 continuationPrompt/schemaGuidance
- ✅ CLI stdout 不含 servertool/stopless 等禁词
- ✅ auto-injected stop hook pair 被 rewrite 成用户文本
- ✅ `__servertool_cli_projection` metadata 已移除
- ⚠️ `exec_command` tool call 本身在 client response 里可见

### 决策
`exec_command` 是 RouteCodex 内置客户端工具（用于各种 servertool CLI projection，不只是 stopless）。不能简单移除。

**正确做法**：stopless CLI projection 已经被 rewrite 成用户文本，不进 tool call 历史。客户端在 final chat response 里看到的是"用户文本"（rewrite 后的 continuation_prompt），不是 `exec_command` tool call。

需验证：当前 rewrite 路径是否完整覆盖 stopless CLI projection 的所有路径（`buildServertoolCliProjectionForToolCall` / `buildServertoolCliProjectionForAutoFlow`）。

### 红测
扩展 `hub_req_inbound_tool_call_normalization.rs` 的 rewrite 测试，验证 stopless CLI projection 结果被完整 rewrite 成 user text，客户端看不到 `exec_command` tool call。

## 变更 4：编译构建全局安装重启

### 命令
```bash
PATH=/opt/homebrew/opt/node@22/bin:$PATH pnpm run build:min
node scripts/build-core.mjs
PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh
```

### 验证
- `routecodex --version` 递增
- `127.0.0.1:5555` / `5520` / `10000` /health 全绿
- Live relay stopless 请求：3 次 stopless 续轮后最终停止，VR log 每次 `reason=thinking:user-input`

## 验证 gates

```bash
# Rust
cargo test -p servertool-core stopless --lib -- --nocapture
cargo test -p router-hotpath-napi virtual_router_engine --lib -- --nocapture

# TS
npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --noEmit --pretty false
npx tsc --noEmit --pretty false
node --experimental-vm-modules ./node_modules/.bin/jest tests/servertool/stopless-cli-continuation.spec.ts tests/servertool/stopless-prompt.client-visible.spec.ts --runInBand

# Architecture
npm run verify:function-map-compile-gate
npm run verify:servertool-rust-only
git diff --check
```

## 完成标准

1. VR classifier 红测通过，stopless followup 下一轮走 `thinking`
2. schema guidance 文本含 JSON 样本且不含禁词
3. client rewrite 测试通过，客户端看不到 `exec_command` tool call
4. 编译构建全局安装，live 3 端口健康
5. Live relay stopless 复测：3 次续轮后 budget exhausted 最终停止

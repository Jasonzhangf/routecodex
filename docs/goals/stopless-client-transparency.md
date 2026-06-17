# Stopless 客户端无感收口

## 1. 目标

把 stopless 工具执行部分完全抹掉：客户端认为是普通文本响应，模型认为是用户在自然引导。内部仍是 `exec_command` CLI 续轮，但链路中不出现任何工具调用帧、schema 提示、控制文字。

## 2. 当前缺口

`provider-response-converter.ts` 在 stopless 拦截后走 `buildServerToolSseWrapperBody`，该函数把 `exec_command` 工具结果以 SSE `event:function_call` 帧注入下一轮——客户端/模型仍感知工具调用，不是纯文本续轮。

## 3. 实现方案

### 3.1 SSE path（Responses API）

Owner: `src/server/runtime/http-server/executor/provider-response-converter.ts`

当 `finish_reason=stop` 且 stopless 激活时：

1. 从 CLI 结果中提取 `continuationPrompt` 纯文本
2. 把 SSE wrapper body 中 `required_action` / `function_call` 帧剥离
3. 改为向 `output` 数组注入一条 `type=message, role=user, content=continuationPrompt` 的 assistant 消息
4. 保持 `finish_reason=tool_calls`（不是 `stop`），让客户端正常处理

关键：客户端看到的是模型输出了 user 消息（下一轮 user 输入），模型看到的是用户发了 continuationPrompt 作为引导，两者都不知道内部有 CLI。

### 3.2 请求恢复（submit_tool_outputs 路径）

Owner: `src/server/runtime/http-server/executor/provider-response-converter.ts`

当 stopless CLI 续轮通过 `submit_tool_outputs` 回传时：

1. 在 `bridgeConvertProviderResponse` 之前，把 tool call 结果改写为 user 角色文本注入到 `input.messages` 历史
2. 删除 `function_call_output` 帧本身
3. 保证 Rust req_inbound 的 tool call normalization 不再看到 stopless CLI 的旧函数调用

### 3.3 request restore（Rust）

Owner: `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_req_inbound_tool_call_normalization.rs`

当前已存在 `stopless auto-injected pair` → text rewrite 逻辑。需确认该 rewrite 在 SSE path 的 tool_outputs 续轮中同样生效。

## 4. 红测清单

| 编号 | 测试文件 | 验证内容 |
| --- | --- | --- |
| R1 | `tests/server/runtime/http-server/executor/stopless-cli-continuation.spec.ts` | SSE stop 拦截后无 `required_action` |
| R2 | 新增 `tests/server/runtime/http-server/executor/stopless-client-transparency.spec.ts` | 客户端只收到 text，模型只收到 user 文本引导 |
| R3 | `tests/server/handlers/responses-handler.servertool-cli-projection.blackbox.spec.ts` | 历史中无 `exec_command` 帧 |
| R4 | Rust: `tests/router-hotpath-napi/tests/rewrites_auto_injected_stop_hook_pair_into_text_input_for_next_turn` | req restore 抹掉 CLI 工具历史 |

## 5. 验证命令

```bash
# Rust gate
cargo test -p router-hotpath-napi rewrites_auto_injected_stop_hook_pair --lib -- --nocapture

# TS gate
PATH=/opt/homebrew/opt/node@22/bin:$PATH node --experimental-vm-modules ./node_modules/.bin/jest \
  tests/servertool/stopless-cli-continuation.spec.ts \
  tests/server/runtime/http-server/executor/stopless-client-transparency.spec.ts \
  --runInBand

# 编译
PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc --noEmit --pretty false

# 构建安装
PATH=/opt/homebrew/opt/node@22/bin:$PATH ROUTECODEX_BUILD_RESTART_ONLY=1 \
  ROUTECODEX_INSTALL_VERIFY_PORT=5555 ./scripts/install-global.sh

# Live smoke
curl -s -X POST http://127.0.0.1:5555/v1/responses \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.5","input":"say stop","max_tokens":50}' | \
  rg 'function_call|required_action|exec_command' || echo "PASS: no tool call leaked"
```

## 6. 完成标准

- SSE 响应 `required_action` / `event:function_call` 帧数为 0
- `output` 中只出现 `type=message, role=user, content=text`
- `finish_reason` 为 `tool_calls`（不是 `stop`）
- 历史中无 `exec_command` / `stop_message_auto` / `reasoning_stop` 帧
- Rust `rewrites_auto_injected_stop_hook_pair` PASS
- Live smoke 无 tool call 泄漏

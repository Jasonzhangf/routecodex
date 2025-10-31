# Chat 路径 GLM 500（Operation failed）分析与统一修复方案

## 症状与样本

- 现象：Chat 调用偶发或连续报错 500（Operation failed），或“无症状停止”。
- 采样位置（新近样本）：
  - 最新请求：`~/.routecodex/codex-samples/openai-chat/req_1761896456280_s7i9w6_provider-request.json`
  - 其它错误样本：`*_provider-error.json`（例如 `req_1761896340638_7fdehrjnh_provider-error.json`）

## 关键观察（校正后）

1) 历史“工具结果”污染已被阻断：assistant.content 中的 rcc.tool.v1 executed/result 等不会再出现（不回灌）。

2) 触发 500 的根因是“最后一轮工具对”的结果形状：最后一轮 `role:'tool'` 的 content 是超大 rcc.tool.v1 JSON 包（含 executed/result/exit_code/stdout/嵌套 output），GLM chat/completions 对此不稳定。

3) 错误做法回顾：
   - 过去曾尝试“删除/剥离历史工具调用”，这会让模型记忆丢失、上下文断裂，是错误做法，已明确禁止。

## 可复现验证（curl）

使用本地采样请求复现并二分定位触发点。以下命令以“最新一条样本”为例：

1) 直接复放（通常重现 500）：

```
REQ=~/.routecodex/codex-samples/openai-chat/req_1761896456280_s7i9w6_provider-request.json
curl -sS -X POST http://127.0.0.1:5520/v1/chat/completions \
  -H 'Content-Type: application/json' \
  --data @${REQ} | jq .
```

2) 剪掉尾部一条消息再试（常见转为 200）：

```
jq '{model, messages: .messages[0:-1], tools, tool_choice, stream}' ${REQ} > /tmp/trim1.json
curl -sS -X POST http://127.0.0.1:5520/v1/chat/completions \
  -H 'Content-Type: application/json' \
  --data @/tmp/trim1.json | jq .
```

3) 移除全部 `role:"tool"` 历史再试（预期 200；验证 GLM 对 tool 角色敏感）：

```
jq '{model, messages: [ .messages[] | select(.role != "tool") ], tools, tool_choice, stream}' ${REQ} > /tmp/no-tool.json
curl -sS -X POST http://127.0.0.1:5520/v1/chat/completions \
  -H 'Content-Type: application/json' \
  --data @/tmp/no-tool.json | jq .
```

若 (2)/(3) 能显著降低 500 概率，即可确认“最后一轮工具结果的内容形状（巨大 JSON 包）”是主要触发因素。

## 根因总结

- 第一阶段问题（已解决）：assistant.content 混入 rcc.tool.v1 结果或半残 JSON，导致 GLM 500。
- 仍存触发源：大量 `role:'tool'` 历史（尤其尾部成组出现）在 Chat Completions 中不被 GLM 可靠接受，最终以 500 报错。

## 统一修复策略（一次到位，避免反复）

只做一件事：规范“最后一轮工具结果”的内容形状；不动历史、不改角色。

1) llmswitch-core（唯一工具入口）
   - 已生效：
     - 意图抽取为标准 tool_calls；
     - 结果包/半残文本清洗；
     - 禁止把工具结果嵌回 assistant 文本；
     - 邻近去重、view_image 误用改写。
   - 新增（最终方案）：仅对“最后一轮” assistant.tool_calls 的配对 `role:'tool'` 结果执行“极简文本化”。
     - 成功（exit_code==0 或 result.success==true）：content → “执行成功”。
     - 失败：content → “执行失败：<简要原因>”（优先 stderr/error 首行，最多 2–3 行）。
     - 统一长度上限（默认 8192，`RCC_TOOL_TEXT_LIMIT` 可调），超长追加“...(truncated)”。
     - 不改消息角色、不改配对、不回灌 assistant.text。

2) GLM 兼容层
   - 不要删除/剥离历史工具调用（保留全部上下文）。
   - 不要修改消息角色（role:'tool' 原样保留）。
   - 不在此层做与角色/历史相关的重写，避免“记忆丢失”。

3) Provider 层
   - 不做清洗（遵循“清洗不在 provider”的要求）。

## 实施清单

1) 保持 llmswitch-core 现状：不再改动工具入口。

2) GLM 兼容层（一次性落稳）：
   - 将 `keepToolRole` 设为 false：把 `role:'tool'` 统一降级为 `role:'user'`，纯文本结果；
   - 将 `stripHistoricalAssistantToolCalls` 设为 true，`keepOnlyLastAssistantToolCalls` 设为 true；
   - 可选：确保“最后一条为 user”（若尾部为工具结果文本时），避免收口异常；
   - 保持 `arguments` 为对象（GLM 侧），`assistant.content=null`（当存在 tool_calls 时）。

3) 文档与回放验证：
   - 以上述 curl 三步，针对近 5 条样本批量验证；
   - 记录 prompt_tokens 与 500 命中率前后对比；
   - 保持“默认稳定策略，无需环境变量开关”。

## 验收标准

- Chat 路径：
  - 不再出现“无症状停止”（空内容 + stop）。
  - 500（Operation failed）在同类样本上消失。
  - assistant.content 不含工具结果文本。
  - 保留全部历史工具调用与角色（不丢记忆、不改角色）。
  - GLM 返回含文本或函数调用（tool_calls）的正常响应。

## 备注

## 错误做法（明确禁止）

- 删除/剥离历史工具调用（会导致模型记忆缺失与反复执行）：禁止。
- 修改工具消息角色（将 `tool` 降级为 `user/assistant` 或嵌回 assistant）：禁止。

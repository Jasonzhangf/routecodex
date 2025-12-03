# llmswitch → sharedmodule/llmswitch-core 迁移计划（草案）

本计划仅列出迁移清单与步骤，不在本分支实施迁移。审批通过后再执行。

## 目标与边界

- 目标：将现有位于主包 `src/modules/pipeline/modules/llmswitch/*` 的逻辑，全面迁移/收敛到 `sharedmodule/llmswitch-core`，确保：
  - OpenAI Chat 与 Responses 输入/输出路径复用相同的转换与工具封装逻辑；
  - 工具引导、参数解析、结果封装在 sharedmodule 内统一实现；
  - 与 GLM 的兼容处理限于 provider 兼容层（glm-compatibility），SSE 实现保持标准协议，不混入 provider 逻辑；
  - 删除主包内冗余/过时的 llmswitch 层，主包仅做协议对接与调用；
- 边界：
  - 不改变既有业务语义与行为，严格遵循改造前逻辑，仅调整实现位置与依赖路径；
  - 构建顺序遵循 AGENTS 指南：先构建 `sharedmodule/llmswitch-core`，再构建主包并安装/发布；

## 迁移清单（文件/模块）

需要迁移/归并进 `sharedmodule/llmswitch-core` 的逻辑类别（以功能为单位列出）：

1) OpenAI Chat/Responses 请求归一化与工具引导
- 工具引导（系统提示）统一，强调：
  - 使用 OpenAI tool_calls 标准（`assistant.tool_calls[].function.name/arguments`）；
  - `arguments` 为 JSON 字符串，`shell.command` 优先 argv（数组）；
  - 含重定向/管道/heredoc 的命令需 `bash -lc` 包裹；
  - 不在普通文本中输出伪 XML/标签式工具描述；
- 具体文件（源）：
  - `src/modules/pipeline/modules/llmswitch/anthropic-openai-converter.ts`
  - `src/modules/pipeline/modules/llmswitch/conversion/codecs/anthropic-openai-codec.ts`
  - 以及主包中任何残留的 llmswitch normalizer/adapter 引用
- 目标位置（归一）：
  - `sharedmodule/llmswitch-core/src/conversion/shared/openai-normalize.ts`
  - `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts`

2) 工具调用参数解析与修复
- 统一 lenient JSON 解析，支持 JSON 字符串、宽松 JSON（单引号/未引号键）、`key=value` 行、以及 `command` 为字符串或数组；
- 针对含 `>`, `>>`, `|`, `<<` 等元字符的 argv，自动包裹 `bash -lc`，避免嵌套包裹；
- 针对 `cat > file` 无 stdin 情况，避免卡顿：改写为 `: > 'file'` 或指导使用 heredoc；
- 消除历史上“参数缺失/被裁剪”的问题，不做字段剔除；
- 统一实现位置：
  - `sharedmodule/llmswitch-core/src/conversion/shared/openai-normalize.ts`
  - `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts`

3) 工具执行结果封装（Chat 与 Responses 一致）
- 采用完整结构化 JSON 包装（示例：`rcc.tool.v1`），包含：
  - `tool { name, call_id }`、`arguments`（宽松解析后回填）、`executed { command, workdir }`、
  - `result { success, exit_code, duration_seconds, stdout, stderr, output_raw|output_parsed }`、
  - `summary { lines_out, lines_err, truncated }`；
- Chat 与 Responses 路径保持一致，避免“raw 仅模型不识别”的问题；
- 统一实现位置：
  - Chat 出口构建在 sharedmodule，Responses 入/出同样复用 sharedmodule 的打包器；

4) GLM 兼容层（仅在 provider 兼容中处理）
- Chat/Responses → GLM 请求映射：
  - 输出遵循 GLM 官方 schema（`message.content|null`、`message.tool_calls[].function.{name,arguments}`），`arguments` 仍为 JSON 字符串；
  - 去除强校验与字段裁剪；
  - 失败样本兜底（仅限兼容层且可配置）：当返回含异常片段时，去掉首个 `:` 之后的拼接片段做文本回传（仅失败路径）；
- GLM 响应 → OpenAI 映射：
  - 统一返回工具调用与文本，避免 “nrr/no response requested”；
  - SSE 维持标准事件序列；
- 实现位置：`src/providers/compat/glm-compatibility.ts`

5) 主包内引用与注册清理
- 清除/替换主包对本地 llmswitch 的引入与注册：
  - `src/server/handlers/chat-completions.ts`：不再使用本地 llmswitch normalizer，改为调用 sharedmodule；
  - `src/server/conversion/responses-mapper.ts` 与 `src/server/protocol/openai-adapter.ts`：移除本地转换器依赖；
  - `src/modules/pipeline/core/*` 注册/装配中移除本地 llmswitch 项；

## 迁移步骤（分阶段执行）

阶段 A：依赖与构建链
- 确认 `sharedmodule/llmswitch-core` 具备完整构建与导出；
- 执行顺序（严格遵循）：
  1) `cd sharedmodule/llmswitch-core && npm ci && npm run build`
  2) 回到仓库根：`npm ci && npm run build`
  3) 发布/安装：使用 `npm pack` + `npm install -g <tgz>` 方式（不使用 `npm link`）；

阶段 B：主包清理与替换（不改变行为，仅换实现来源）
- 删除/停用主包本地 llmswitch 模块注册；
- chat/responses 处理器改为调用 sharedmodule 的统一转换；
- Provider 中仅保留 GLM 兼容层，不做请求/响应协议改写；

阶段 C：验证与捕获
- Chat 工具调用 E2E：非流/流式，验证 `tool_calls` 正确产生、工具结果 JSON 封装完整；
- Responses 工具调用 E2E：非流/流式，确认 required_action 与 tool_result 序列完整；
- GLM 端对齐：重点验证 `1213` 错误不再发生（不裁剪字段），失败样本采用兼容兜底策略；
- 样本核对：
  - `~/.routecodex/codex-samples/openai-chat/` 与 `responses-replay/` 下 provider-request/response、sse 日志；

阶段 D：文档与开关收敛
- 更新“GLM compatibility 对齐说明”文档，明确请求与响应字段映射；
- 合并冗余开关，形成单一策略：
  - 工具参数宽松解析默认开启；
  - 结构化工具结果 JSON 默认开启；
  - GLM 失败样本文本拼接兜底可通过环境变量开关；

## 回滚策略

- 分支隔离：所有改动在迁移分支内进行；
- 如 E2E 未过，直接回滚分支或 revert 提交；
- 保留关键环节捕获样本，便于快速定位与回退。

## 审批后的执行事项（待批）

- 按阶段 A/B/C/D 逐步实施；
- 每阶段结束 push，并提供样本/日志链接与变更说明，供下一步审批。


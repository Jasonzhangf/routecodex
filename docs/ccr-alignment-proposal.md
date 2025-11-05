Title: CCR 逻辑对齐方案（仅方案，待审批后实施）

目标
- 不改变我们的“所有协议 → OpenAI 统一治理”的主路径；在策略与行为上与 CCR 的 Transformer 思路对齐。
- 优先遵从 AGENTS 指南：唯一入口在 sharedmodule/llmswitch-core，服务器/兼容层不重复实现工具处理。

一、对齐点（Must）
- 工具使用策略（参数级引导）
  - 在 OpenAI 侧治理时（processChatRequestTools），根据模型/Provider 策略设置 tool_choice：
    - 默认：若 tools 存在，tool_choice='auto'（已具备，保留）。
    - 可选策略（与 CCR 的 tooluse 对齐）：
      - 对某些提供商/模型（如 deepseek-chat）可按配置强制 tool_choice='required' 提升工具调用概率。
      - 提供集中配置键，例如 config/conversion/llmswitch-profiles.json 或 env RCC_TOOL_CHOICE_PROFILE=*。
  - 不在 server 端点/兼容层做此策略，统一在 llmswitch-core 的治理入口执行。

- 工具参数容错（与 CCR enhancetool 思想对齐）
  - 我们已在 normalize 与 bridge 中对 function.arguments 做 JSON 严格解析与修正；对齐方向：
    - 提供一个“非流”容错开关（与 CCR enhancement 行为一致）：
      - 当开启时：聚合工具参数并做宽松 JSON 修补（json5/逗号容错等），必要时取消/收束工具流式回传，改为完整统一 JSON。
      - 默认关闭；仅在已知模型/场景下通过配置启用。
  - 入口：统一放在 llmswitch-core（响应 canonicalize 前/后一个明确点），避免分散。

（更新）统一开关与默认策略
- 增加 RCC_TOOL_ENHANCE（默认=1），全局启用“响应侧工具增强容错/聚合”。
- 生效位置：
  - 非流：响应 canonicalize 之前/之后的“修补层”（具体点待实现评审决定）；
  - 流：OpenAI Chat SSE 处理链（仅吞并工具增量，不影响普通文本 delta）。
- 记录：详见 docs/tooling-flow-and-semantics.md 的“Enhancetool 模式”章节。

- Anthropic reasoning/特殊字段处理的最小化策略
  - 对齐 CCR：仅在兼容层做 provider 特有字段（reasoning_content 等）清洗/映射，不做工具文本收割。
  - 我们保留既有的 reasoning 映射模块，确保与 CCR 的“仅做必要映射”一致。

二、优化点（Should）
- 文本指引与参数引导的边界
  - CCR 主要依赖参数级引导（tool_choice），不插入通用工具指引文本。


三、需要删除/合并的冗余（Could）
- 去重“工具指引与增强”实现只保留 v2/guidance（单处事实来源）：
  - 删除/合并 v2/conversion/shared/tool-governor.ts 内的同款 buildSystemToolGuidance/augmentOpenAITools 重复实现（若仍存在），仅引用 v2/guidance/index.ts。
  - 目的：唯一事实来源，减少分歧。

- 端点/兼容层的任何工具处理逻辑（若有历史残留）应清理（遵从唯一入口原则）。

四、实施计划（待批后执行）
1) 策略开关与配置
  - 根据配置为特定 provider/model 设定 tool_choice（required/auto）。
  - 新增 RCC_TOOL_ENHANCE（默认=1）读取与透传，决定“响应侧工具容错/聚合”行为。

2) 参数容错（非流模式）
  - 在响应 canonicalize 之前加入“可选的宽松 parser”（JSON5/逗号/尾逗号/单双引号修补），仅在 produceRequiredAction 或非流模式时启用；
  - 提供明确的 telemetry：多少次修补、修补长度、原始/修补差异；
  - 关闭逐片段透出“工具调用增量”，改为聚合后一致交付（与 CCR enhancetool 对齐）。

3) 去重实现
  - 移除或合并 tool-governor 内重复的指引/增强逻辑，所有引用统一指向 v2/guidance。

4) 验证与回归
  - 使用 ~/.routecodex/codex-samples 下的 openai-chat、openai-responses、anthropic-messages 采样，验证：
    - 注入点只出现一次；
    - tool_choice 在目标模型生效（SSE 中可见 tool_calls 起始速率变化）；
    - 容错开启时工具调用增量被吞并，最终以完整块返回；
    - 关闭文本注入时，仍能通过参数引导触发工具调用。

五、逐项对齐清单（执行顺序建议）
- 开关与配置（Must）
  - [ ] 新增 RCC_TOOL_ENHANCE（默认=1），文档与示例配置同步更新；
  - [ ] 新增 tool_choice profile（按 provider/model 可配置 required/auto），默认 auto。

- 非流响应容错（Must）
  - [ ] 在响应 canonicalize 附近增加“宽松 JSON 解析与修补”层（JSON5/quote/逗号修补）;
  - [ ] 修补统计与诊断字段落盘（requestId、repaired、repair_kind、diff_len 等）。

- 流式工具吞并（Must）
  - [ ] OpenAI Chat SSE 路径吞并 delta.tool_calls 增量，按 index 聚合，最终一次性交付完整 tool_calls；
  - [ ] 普通文本 delta 不受影响（仅吞并工具增量）；
  - [ ] 采样验证（*_sse-events.log 与 *_govern-*.json）。

 

- 去重实现（Could）
  - [ ] tool-governor 内如仍有重复“指引/增强”实现，统一引用 v2/guidance。


五、当前差异矩阵（我们 vs CCR）
- 文本指引：我们有；CCR 无通用文本（仅 Agent 专用）。建议：提供模式化开关，默认 strict，可降为 minimal/off。
- tool_choice：CCR 有（tooluse）；我们默认 auto，建议为特定模型可配置 required。
- 容错增强：CCR 有（enhancetool）；我们有严格解析与小修复，建议新增“非流容错开关”。
- 本地执行：CCR 仅执行 Agent 工具；我们不走本地 Agent handler（保持现状）。

六、无需触碰的既有优势
- 单一入口（governTools）与 OpenAI 统一治理路径，有助于一致性与可观测性。
- shell 安全与稳定性（自动 bash -lc 折叠与写入禁止）是必须保留的强约束。

备注
- 本文档仅为方案与序列澄清，不包含代码改动。待你审批后，我再按顺序提交最小修改 PR 并提供采样对照。

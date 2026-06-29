# SSE Rustification Closeout Plan

## 1. 目标与验收标准

目标：把 `sharedmodule/llmswitch-core/src/sse/` 从“TS 里仍有语义兜底/补洞/错误吞掉”收口到“只剩可迁移 Rust 的明确协议转换边界”，然后按模块迁移到 Rust native owner。

验收标准：
- SSE TS 层不再保留 fallback / salvage / provider-specific patch / silent error swallow / synthetic truth generation。
- `scripts/architecture/verify-sse-architecture-boundary.mjs` 能阻止已删除的错误语义复活。
- 每个删除切片都有正向或反向 Jest 边界测试。
- 每个验证通过切片都独立提交，避免被其他 worker 回滚。
- 未碰 servertool / Hub Pipeline / Virtual Router 并行改动，除非 Jason 明确授权。

## 2. 范围与边界

In scope:
- `sharedmodule/llmswitch-core/src/sse/**`
- SSE 专用测试：`tests/sharedmodule/*sse*.spec.ts`、`tests/sharedmodule/anthropic-*sse*.spec.ts`、`tests/sharedmodule/responses-*sse*.spec.ts`
- SSE 架构门禁：`scripts/architecture/verify-sse-architecture-boundary.mjs`
- 必要的 SSE function/verification map 补充，仅限明确缺口。

Out of scope:
- `sharedmodule/llmswitch-core/src/servertool/**`
- Rust servertool crates / servertool docs / servertool gates
- Hub Pipeline 非 SSE 主线迁移
- Virtual Router 非 SSE 选路语义
- package / lockfile 改动，除非本 SSE gate 必需

## 3. 设计原则

- No fallback：发现坏输入、坏 wire、缺 truth、不可序列化对象时显式失败。
- No semantic salvage：部分流、坏 JSON、缺 id/model/role/tool id 不能被拼成成功响应。
- No provider-specific in shared SSE：DeepSeek/GLM/Minimax/Qwen 等差异不得进入通用 SSE。
- No silent error swallow：writer/parser/serializer/builder 失败必须可观察并向调用方失败。
- Physical deletion：死 helper、旧 wrapper、未使用安全壳必须物理删除，并加门禁防复活。
- Rust target：TS 清理后，剩余合法语义按 codec/serializer/parser/builder/sequencer 模块迁移到 Rust。

## 4. 当前已完成基线

已提交的 SSE cleanup 切片：
- `0a88dc97f refactor(sse): remove deepseek patching`
- `2bf6616ac refactor(sse): remove stream salvage fallback`
- `9ee808d0d refactor(sse): remove anthropic salvage fallback`
- `f70608f9d refactor(sse): remove responses usage fallback`
- `1df6cd095 refactor(sse): remove chat function args fallback`
- `07f9b2136 refactor(sse): remove responses chunk fallback`
- `6d96999ad refactor(sse): remove responses id fallback`
- `5c8957f1b refactor(sse): remove gemini role fallback`
- `50824cb4f refactor(sse): remove responses parse salvage`
- `df617cab4 refactor(sse): remove responses timestamp salvage`
- `91b209741 refactor(sse): stop writer error swallowing`
- `94395bd22 refactor(sse): remove dead shared helpers`
- `444b46c79 refactor(sse): remove registry model fallback`
- `f8aae358a refactor(sse): remove anthropic tool input fallback`
- `c4f16b5c7 refactor(sse): remove anthropic message fallback`
- `a1de710a9 refactor(sse): require anthropic fields`

## 5. 技术方案与文件清单

Phase A: 完成 TS cleanup 扫尾
- 扫描命令：`rg -n "catch \\{|fallback|兜底|降级|return null|return false|best effort|noop|Never throw|salvage|unknown|Date\\.now\\(\\)" sharedmodule/llmswitch-core/src/sse -S`
- 对每个命中做三分法：
  - 合法观测/时间统计：保留，不宣称问题。
  - 协议默认且有规范依据：保留并加注释/测试。
  - fallback/salvage/补真相/吞错：删除并补测试 + gate。

Phase B: 锁门禁
- 扩展 `scripts/architecture/verify-sse-architecture-boundary.mjs`。
- 禁止旧 marker 复活：`unknown` model fallback、synthetic id、tool input stringify fallback、parse salvage、timestamp Date.now salvage、writer onError-only swallow。
- 如扫描命中范围过宽，使用精确旧表达式 marker，避免误报正常 `unknown` 类型注解。

Phase C: Rust rewrite 分模块顺序
- 1. `shared/serializers/*`：Responses/Anthropic/Gemini/Chat wire serializer，最小输入输出，最容易做 parity。
- 2. `sse-to-json/parsers/sse-parser.ts`：已有 native parser 入口，收缩 TS wrapper 为 native call + IO。
- 3. `sse-to-json/builders/*`：response materialize/state builder，按 protocol 分模块迁移，先 Anthropic/Gemini，再 Chat/Responses。
- 4. `json-to-sse/sequencers/*`：事件序列生成，先 Anthropic/Gemini，再 Chat/Responses。
- 5. `registry/sse-codec-registry.ts` / `shared/writer.ts`：最终保留薄 IO 壳，语义识别和 codec contract 下沉 Rust。

## 6. 风险与规避

- 风险：误把合法协议默认值删掉。
  规避：每个切片先查类型/调用路径，补负向测试证明旧 fallback 不再成功。
- 风险：影响 servertool 并行工作。
  规避：只提交 SSE 路径；如主 index 有其他 staged 内容，使用临时 index 提交。
- 风险：门禁 marker 误报。
  规避：marker 使用旧实现的精确字符串，不用过宽关键词。
- 风险：Rust 迁移时 TS/Rust 双真源并存。
  规避：迁一块关一块，TS 只留 native wrapper，不保留第二份语义实现。

## 7. 验证矩阵

每个切片必跑：
- 定向 Jest：`npm run jest:run -- --runTestsByPath <new-or-focused-spec> --runInBand`
- SSE 架构门禁：`npm run verify:sse-architecture-boundary`
- TS 编译：`PATH=/opt/homebrew/opt/node@22/bin:$PATH npx tsc -p sharedmodule/llmswitch-core/tsconfig.json --pretty false`
- Diff 格式：`git diff --check -- <changed-sse-files>`

必要时补跑：
- SSE 相关测试集合：`npm run jest:run -- --runTestsByPath <all-touched-sse-specs> --runInBand`
- Rust native gate：仅当 Rust SSE/native 文件改动时执行对应 crate tests。

## 8. 实施步骤

1. 确认 SSE 工作区干净，列出其他 worker 脏文件但不触碰。
2. 扫描剩余 fallback/salvage/silent-error markers。
3. 选择最小切片，先理解 owner 和协议合同。
4. 删除错误语义，补负向测试，补架构 gate。
5. 跑验证矩阵。
6. 用临时 index 提交该切片，仅包含 SSE 文件。
7. `git add` 对齐主 index 中本切片文件，避免 mixed 状态。
8. 重复直到 TS cleanup 没有明确错误语义残留。
9. 切入 Rust rewrite，按 Phase C 顺序迁移 native truth。

## 9. 完成定义

- `sharedmodule/llmswitch-core/src/sse` 中无明确 fallback/salvage/silent-error/synthetic-truth 残留。
- SSE architecture gate 覆盖本轮删除过的所有反模式。
- 所有新增/修改测试通过。
- 每个切片有独立 commit。
- Rust rewrite 入口明确：TS 只剩 IO/wrapper/orchestration，协议语义 owner 已准备下沉 Rust。

# REQ02 可执行字段配置合同

你的工作树 `/Volumes/Intel/playground/routecodex/dagpipe-req02-profile-20261002`，base `3a72ad813`。你不是独自工作，不覆盖他人编辑，不执行Collab；每条command显式workdir/先cd这棵树，apply_patch用绝对路径。不审计其他worktree/历史整链。

任务是配置设计，禁止产品代码：为四种协议补齐REQ02字段算子执行所需的已声明client_request_to_chat配置。唯一允许写：docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml；docs/design/v3-unified-operation-runner-design.md中REQ02字段方向合同；docs/goals/req02-profile-result-20261002.md。父编排负责review后组合到算子树。

已确认：main尚未包含不可变commit768a9565c的direction_bindings/transform_id；旧字段库依赖它们，直接接入会把messages/tools容器记录opaque但无法正确归一。不能在代码中根据protocol名字补猜测分支。你只需读 `git diff 3a72ad813..768a9565c -- docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml` 并核对相关row；不要再定位原因。旧候选配置仅是已知参考，不代表当前已审。

具体输出：逐row用apply_patch补REQ02必需的client_request_to_chat绑定，包括OpenAI messages/tools、Anthropic messages/tool_choice/tools、Gemini contents/systemInstruction/tools/toolConfig/generationConfig/role/media字段，以及其他由旧库确实消费的request归一化配置。typed binding明确source/destination/operator@version/shape/semantics/transform_id/failure_class。保持structure_only/parent_owned和唯一path消费合同，不添加重复row。typed参数schema仅补需要的请求方向。不得加入chat_to_provider、response方向、REQ06 @2、执行mode或continuation规则；这些有其他owner。不要整份旧profile覆盖main。

完成 iff：本范围配置来源和每个绑定有明确算子对应，保留当前main其余设计；四协议归一化不需要协议名猜测。执行 `npm run verify:v3-operation-runner-dagpipe`、`npm run test:v3-operation-runner-red-fixtures`、`git diff --check`，记录通过/失败和具体待review差异。这只是设计配置，不声称算子/真实caller已通过。缺需要的typed字段就按设计明确列出，不通过fallback绕过。不commit/merge/push/install/restart。

直接实现这份配置diff和结果文档。主设计之外不新增平行治理框架。

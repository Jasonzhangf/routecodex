/goal
目标：完成 V4 请求链三节点插件 SSE In -> Responses Inbound -> ChatProcess，修复阻塞测试，对齐 V3 基础功能。

说明：本任务不再写新的提示词，直接按实现文档执行。

实现文档：
docs/goals/v4-request-chain-plugin-plan.md

执行规范：
- 真源唯一在 Rust：V4 contract + skeleton + standard plugins + runtime 均以 Rust 实现为准
- 不做 fallback / silent strip / 控制面入 payload；malformed input 与控制面泄漏必须 fail-fast
- 请求链三节点只做相邻转换：SSE In 仅 frame->JSON，Responses Inbound 仅协议 normalize，ChatProcess 仅请求侧工具治理
- 不做模型 admission 与路由（VR 负责），不进入响应链
- P0 禁脚本批量替换：所有源码语义修改必须用 apply_patch 逐文件手工修改
- 不动 V3 server、不重启 V4 server、不改主 tree / 其他 dirty worktree；继续在本 worktree 修改
- 修改后必须重新计算 plan_hash 并同步 contracts

验证：
- cargo 定向测试：skeleton / runtime l2_runtime / standard-plugins 全绿
- Cordis CLI tests 13 passed
- V4 architecture verify gate：通过且 --red-self-test 全绿
- git diff --check 通过
- map 同步：resource-operation-map / function-map / verification-map / node-graph contract / frozen consumer registry 无 missing edge

完成标准：
- Node 02 SSE In、Node 03 Responses Inbound、Node 04 ChatProcess 三插件绑定准确 node_id / role_id / position
- plan_hash 与 Rust 真源一致；阻塞测试全部转绿
- DoD 全部满足，无 fallback、无响应链越界、无控制面泄漏

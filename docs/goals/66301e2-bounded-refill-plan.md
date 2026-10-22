# Chat Process 有界续杯实施计划

工作项：66301e2。状态：实施计划已落盘；本轮只交付计划和提示词，未实施产品代码。

## 目标与权威输入

用户已选定 Chat Process 为策略 owner。完整治理后的响应满足「非工具调用、非错误、没有非空 summary」，且还有连续续杯额度时，执行续杯。默认新增一次，0关闭，非负整数N最多新增N次。用户接受短会话被额外续杯的有限成本。不得用任务完成度分类或自然语言关键词替换这个明确条件。

用户已审阅设计并指定配置放在 `internal.toml`。业务图见同目录 `66301e2-bounded-refill-dag.md`，本计划与该图共同构成实施输入。旧的每server配置提案、纯评估阶段限制、依赖task/goal状态才能续杯的方案均被本次明确范围替代。退役的广义Stopless仍不恢复。

独立规划依据：已完成的独立OAuth `gpt-6.1-sol` medium计划 `/private/tmp/rcc-66301e2-implementation-plan.md`。首选Gemini4 Argon medium本次返回配额错误后按规则回退。本计划保留其已确认源代码事实，按用户新指令将配置归属收敛至internal.toml；不采用旧提案中的额外终态例外。不得把这份实施计划当作实现或验收通过。

实施必读：当前项目AGENTS、`.appsdk/requirements.json`、rcc-dev-skills、架构四张map、上述DAG和当前任务笔记。需求基线是本功能现有树中的版本20；执行前只检查受影响条目和新用户指令，发现更新就采用当前有效内容。受影响约束包括错误／客户端解耦、数据控制分离、禁止隐式fallback、治理后可交付性、末候选失败策略及finish reason保真。新增续杯需求是用户明确授权变更，实施时沿现有需求文件追加本功能条目，不放宽既有错误和工具保真约束。

## 配置合同

唯一产品配置源：`v3/crates/routecodex-v3-config/src/internal.toml`。

```toml
[chat_process.refill]
max_consecutive_refills = 1
```

- 由 `internal.rs` 的现有内部配置解析owner读取，提供typed只读策略。数字不得在消费侧再写第二个默认源。
- 0合法并关闭自动续杯。负数、浮点数、字符串不接受。使用现有内部配置的解析／校验模式，不新增配置框架。
- 不增加用户config、server override、环境变量或动态写API。配置值全局一致，运行计数按请求独立。
- 当前internal.toml通过 `include_str!` 编译进binary。改值须重建并加载，不承诺运行时热更新。
- 内部配置只保存策略常量，不保存计数、请求身份、取消状态等运行事实。

## 行为与控制合同

1. 只在完整attempt治理完成后检查，不能逐SSE fragment触发。错误分支优先，消费当前执行的typed错误，不读取残留日志字段。
2. Chat Process持有共享判断；Direct的已注册hook与Relay复用同一判断。协议适配仅提供标准事实，不按协议复制续杯策略。
3. `has_summary`只来自归一化后已有的显式非空summary。空数组、空串、纯空白不算；不扫描普通正文猜总结。源summary与RCC自行合成的reasoning/toolreason summary须区分，不能用合成字段反过来禁止续杯。实现前在图/map中列明字段映射。
4. 不伪造工具、不将finish reason改成tool_calls或stop。合法非stop终态保留原值；按本功能明确条件决策，不暗中增加“长度不足”“像计划文字”等判据或未经声明的特殊终态分支。
5. 原始请求计数0；每次真正发起新续杯执行时加1。默认最多原始执行加一次续杯。一次续杯内部的provider恢复不重复扣次数、不重置已有次数。
6. 工具调用、summary、取消或额度耗尽结束当前自动链。新客户端请求另起计数0。并发请求、会话和端口不共享计数。
7. 次数和动作通过typed Runtime资源／处置传递，不进入业务metadata；不从payload、debug snapshot或日志反推控制事实。
8. Chat Process构造正常续请求，保留原工具声明、历史、assistant结果、call ID及配对工具结果。建议续杯指令：继续执行尚未完成的任务；需要工具时直接调用工具；如果任务已完成，请给出完成总结。
9. Runtime消费续杯处置并进入正常Request主线。不能只设 `FollowupRequired` 标记，不能走web-search专用捷径、旁路调用Provider或自造客户端工具。
10. 中间轮不得提前发客户端完成事件。前序业务内容须保留在续杯历史与最终业务结果中，不能仅记日志或覆盖为末轮正文。最终真实工具和终态由现有标准投影表达。
11. 真实provider／传输／处理错误沿既有typed Error链恢复，保留原原因、实际上游状态及内部599等来源。耗尽遵循现有请求传输终止合同。续杯额度耗尽本身不是provider错误，不触发冷却、惩罚或切provider。

## 已确认结构与待补边

当前 `resp_chat_process_03_governed.rs` 有完整响应治理、工具分支及servertool动作。通用 `FollowupRequired` 不证明已有通用续跑执行器；实际续跑主要绑定具体web-search路径，通用Runtime followup仍有设计待接项。

实施必须补齐这一条声明主线：

完整治理结果 → Chat Process共享续杯决策 → typed执行处置 → 请求Chat Process构造续请求 → Runtime新执行 → 保留各轮内容 → 最终标准交付。

原Request、Response、Error图保持独立。每次续杯是新执行，静态图内不得造回边。先将草案绑定到现有operation/resource/caller与gate，再进入红测。不能将草案中的拟新增边报告为已运行。

## 实施分工与顺序

共8项。当前产品实施与行为验收0/8；DAG和本计划是前置设计产物。

| 工作项 | 产物与owner | 依赖 |
|---|---|---|
| T1 | 编排者恢复66301e2、确认工作树及需求，把用户变更绑定到现有需求和图/map | 无 |
| T2 | 图owner补齐续杯控制、请求重入、内容累积的operation/caller/gate绑定，并校验SESE | T1 |
| T3 | 实现worker先添加公开入口红测，证明旧实现未发出第二轮请求 | T2 |
| T4 | Config与Chat Process唯一owner实现internal策略读取、标准事实与共享判断 | T3 |
| T5 | Runtime和请求Chat Process owner实现typed计数、正常重入、取消、内容累积与交付 | T4 |
| T6 | 作者完成受影响测试、真实consumer工具往返、候选构建与适用运行验收 | T5 |
| T7 | 独立Reviewer在完整milestone自验后审查整体功能与架构；修复finding并复核 | T6 |
| T8 | 交付owner完成适用CI、main集成、远端回执、集成后运行验收、issue与资源收口 | T7 |

同层无冲突准备工作可并行。策略与运行闭环之间存在真实依赖，不拆成两个独立策略owner。执行／观察用新建GCM worker，Plan／Review沿当前宿主技能的模型路由，禁止内置spawn替代。Planner、实施者、Reviewer分离。主编排者负责解阻、验收和最终交付，不把worker报告直接当完成。

## 最小充分红测与黑盒

先用可控上游和真实公开HTTP入口取得行为红证据：上游第一轮返回非空、无工具、无summary的完整响应；旧实现只请求一次，新实现应发起续杯。编译缺少新类型不算本功能的唯一红证据。

| 稳定测试ID（拟新增） | 关键断言 |
|---|---|
| `refill_limit_zero_public` | internal策略值0时仅一次请求，原响应保真 |
| `refill_default_one_tool_roundtrip_public` | 默认1：续请求含完整原历史与前轮assistant内容；返回真实工具；客户端实际执行并以同call ID回传结果；后续响应可用 |
| `refill_default_exactly_two_public` | 两轮均无工具／summary，恰好原始加一次续杯；无第三次；前后内容均保留 |
| `refill_limit_three_public` | 上限3时最多原始加三次；不按provider尝试次数多扣或重置 |
| `refill_summary_tool_suppression_public` | 原生工具或源非空summary不续杯；空白summary仍可续；RCC合成summary不冒充源summary |
| `refill_error_chain_public` | 第一轮或续杯轮的真实错误进入既有Error链；成功恢复后按本轮结果判断；原错不改、候选切换不多扣续杯次数 |
| `refill_concurrent_cancel_public` | 并发请求及不同端口计数隔离；取消后不再发起新请求 |
| `refill_direct_relay_content_parity_public` | 两条执行路径共用策略；前序正文、工具参数／身份／call ID、配对历史和真实非stop终态不丢失、不伪造 |

实现时在现有runtime公开入口测试target登记这些用例，建议复用 `no_response_adjudication_blackbox` 的真实listener／可控上游设施。若该target不适合，使用verification map已有公开consumer target，并同步记录准确命令，不能只提交source-string测试。

拟用公开命令（落实到真实target后确认filter实际执行非零测试）：

```sh
node v3/scripts/run-v3-cargo-test.mjs -p routecodex-v3-runtime --test no_response_adjudication_blackbox refill_ -- --test-threads=1 --nocapture
npm run verify:v3-dagpipe-governance
npm run verify:v3-architecture-ci
```

Config测试须通过现有内部配置解析owner证明0/1/3与非法类型，测试注入只替换typed策略输入，不新增生产配置覆盖口。完整验收至少包含默认1的真实Codex consumer工具执行与配对后续请求；受控标记测试只证明传输，不能当自然任务完成样本。

## 工作树、集成与交付

现有本功能独占树：`/Volumes/Intel/playground/routecodex/66301e2`，分支 `codex/66301e2-bounded-refill`。它已经存在，不要再次创建或同域另开一棵。当前只有设计文档未提交，不得清掉。基于唯一集成分支 `codex/e63d2f2-postfilter-empty`，当时该分支已组合origin/main；包含PR433的响应修复依赖。后续先读取当前Git和远端状态，不沿旧状态猜测PR433是否合并。

`e63d2f2`及其他issue树属于独立工作或受保护资源，不编辑、不删除、不手工抄文件。若需要更新base，沿标准Git合流，并只重验输入变化影响的证据。遇到冲突或拒绝保留原错，由编排者处理。

完整milestone作者自验与适用运行验收后做一次独立整体Review，PASS及适用CI后集成main。运行变更须按项目正式构建／全局安装／restart／真实入口回放／样本审计完成，分别报告证据。restart只调用正式通道一次并事先说明中断；失败查因，不用stop/start或自行接管替代，不宣称health证明已加载。

本计划不授权操作AppSDK/Collab daemon，不发送跨聊天消息，不终止tmux或其他长任务。不得将私有生产日志、payload或凭据发送外部模型。只给Planner/Reviewer必要源码、规则及脱敏证据。

完成条件是：有真实红绿与工具往返、适用架构gate和Review／CI、main及远端回执、集成后运行验收与样本审计、canonical solution receipt及issue disposition、自有资源清理。分支提交、候选安装或Review PASS都不是单独完成条件。未通过的环节保留open和恢复条件。

## 当前下一步

本轮到此交付文档，不启动实现。用户把同目录的实施提示词交给执行者后，执行者直接恢复T1并按本计划推进，不重复生成一层计划／提示词，不重复申请已明确的范围内授权。若发现新的真实需求冲突，只停受影响项并交回具体证据；不扩大为task/goal系统重构。

# Magpie 用例迁移与 operator 完备总体计划

## 目标与固定边界

使用 Magpie 已有协议案例补强 RouteCodex 的黑盒行为覆盖。先建立 live mock-provider 基线矩阵，再按实际缺口完善 operator 和静态配置，最后推进既有骨架＋operator＋配置的表示重构。

本计划保留产品架构、固定阶段及职责边界。实现迁移到声明的唯一 owner 时同步实际 caller edges。Direct、Relay、Provider Compat、SSE 和 Error 继续遵守现有职责。测试设施位于产品链路外，不增加第二套转换或执行引擎。

用户授权来源：2026-10-12 当前对话，用户确认 clone → live mock provider → 基线矩阵 → operator 完备 → 既有表示重构，并明确“我们的架构不改”；随后要求总体计划、本次执行目标落盘、设置 goal 并开始执行。

## 已确认输入

- 参考仓库：`https://github.com/yetone/magpie`。
- 本地只读参考 clone：`/Volumes/extension/code/magpie`；MIT，提取实质代码或 fixture 时保留来源和许可。
- 实现使用最新 `origin/main` 或本任务唯一集成分支；参考 clone 不是执行依赖。
- 需求真源：`.appsdk/requirements.json` v6，适用 active 条目为 `routecodex-protocol-compatibility-normalization`、`routecodex-client-provider-error-decoupling`、`routecodex-no-implicit-fallback-bypass-payload-tunneling`。
- 现有四张 V3 maps、协议字段矩阵、`protocol_tables.rs` 和 `tables/*.json` 为 owner、字段范围和映射真源。旧文档与有效需求不一致时，断言采用有效需求并记录差异。
- 独立规划记录：`/Volumes/Intel/playground/routecodex/.worker-runs/magpie-live-matrix-20261012-0435/plan.md`。来源为 fresh `oauth/gpt-6.1-sol` read-only Planner。

未登记请求字段不是失败条件：已知字段按登记映射投影，其余业务值保持 opaque 原值及逆向关联，不静默丢弃。请求和响应保留可表示内容，映射缺口不增加本地准入边界。Provider 错误只进入内部 typed Error；耗尽后可检测地终止该请求传输，不生成替代错误或空成功。禁止 live 猜测修复、隐式 fallback 和跨 owner 旁路。

## 阶段与交付

| 阶段 | 交付 | 完成依据 | 当前状态 |
|---|---|---|---|
| P0：来源与静态清单 | 参考 clone、operator/config 候选、来源和需求差异 | 许可和唯一 owner 可追踪；区分已有、缺实现、缺 live 证据 | 已完成；本仓库独立执行 |
| P1：live 基线矩阵 | 四协议 mock provider、真实 RCC HTTP runner、case corpus、基线报告 | 16 协议格及适用 JSON/SSE、工具往返、错误恢复和请求耗尽 | 2026-10-17 完整 58/58 PASS；PR #415 待 CI 和合并 |
| P2：operator 与配置补齐 | 矩阵失败对应的最小 owner 修复 | 原始失败、红绿配对、受影响矩阵和适用 runtime 证据 | M0 修复已通过完整矩阵，待 main 交付；Gemini 静态表消费者已通过四格公开入口 |
| P3：既有表示重构 | 现有骨架下的 operator＋配置表示迁移 | 真实节点执行转换；同一 corpus 保持语义；控制资源不进入业务值 | M1 正在迁移 Node06 标准 Outbound 投影；REQ02 独立推进，不互相等待无关接口 |

当前关键路径：交付 M0 矩阵基线 → 验收 M1 真实 Outbound 节点 → 按节点继续既有骨架迁移。旧函数 wrapper、静态图校验、单测或矩阵通过均不能单独证明 SDK 节点已接线。完整矩阵证据为 `/Volumes/Intel/playground/routecodex/.worker-runs/magpie-node-flow-20261012/live-self-contained58-native-complete-20261017/summary.json`；当前执行与资源事实记录在同 run 的 `CRITICAL-PATH-ORDER-20261017.md`。以上均不是生产安装或 restart 证据。

P1 的“基线轮完成”表示通过、失败、未覆盖和执行器故障均已区分，不要求先修 runtime 使全绿。测试设施自身缺陷必须修正；业务缺口保留原始结果，进入 P2。不得改 golden、skip 或吞错来把基线改绿。

## 静态能力分组

| 职责 | 静态内容 | 当前 owner | 仍需证明 |
|---|---|---|---|
| 请求/响应无损归一化 | 协议、方向、canonical 字段、role/part、扩展归属 | 相邻 Inbound codec | 全字段/历史/缺失/null 保真 |
| 请求/响应投影 | rename、白名单、值映射、已登记 transform 引用 | 相邻 Outbound codec＋现有协议表 | provider wire/client 结果 |
| 工具治理与转换 | namespace 命名、custom wrapper、可逆参数规则 | Req04/Resp03＋相邻 codec | 原请求声明绑定、并行参数、工具执行与下一轮 |
| media | URL/file-id/inline bytes/MIME 和目标表示分支 | 相邻 media/tool-output codec | 数据、位置、类型与历史保真 |
| reasoning/usage/业务终态 | 字段映射、签名归属、cache 计数、finish reason | 相邻 codec/Chat Process | 签名、分片、计数和终态 |
| provider 私有调整 | profile、provider/model 适用范围、已登记参数 | Provider Compat | 私有规则不越界 |

请求级声明集合、身份关联、路由、健康、冷却和重试继续由既有 typed resources 承载。静态配置不保存运行状态，不通过业务 payload 重建控制状态。来源代码证明候选机制存在，不证明 operator 已完备。

## P1 行为路径与矩阵

测试客户端通过真实 HTTP 监听入口访问 RCC。请求和响应分别经过当前已声明主线，Provider transport 访问 runner 拥有的 loopback mock。Error 仍走独立 typed 链。测试抓取只作为证据，不参与产品决策。精确节点顺序以当前 maps 为准，不恢复已退役 continuation 能力。

核心为四入口 × 四上游：Chat、Responses、Anthropic Messages、Gemini。四个同协议格测默认 Direct，十二个跨协议格测 Relay；明确配置的同协议 Relay 单列。JSON/SSE、工具、media、reasoning、usage、终态和故障按适用路径增加。

每个 case 保存来源测试、输入、mock 原始响应、provider 捕获、client 原始结果、成功/失败/副作用断言和适用条件。目标表示限制、未登记字段缺口和真实失败分别建模。对外 release 准备前不增加 SHA、checksum、冻结材料或候选身份校验。

Magpie 只作为 corpus 和实现参考。expected 按 RCC 需求独立定义，runner 不调用 RCC codec 或 Magpie converter 生成断言。不同契约要显式记录：不迁移合成工具结果、角色提醒修补、参数默认包装、删字段重试、签名猜测或隐式权限扩展。

用户后续明确要求本仓库自包含，并在 mock 完成后移除其 CI 接入。P1 保留本仓库的 mock、corpus、独立断言和手动矩阵命令。常规 CI 不执行本次新增的 mock support/matrix 链，不拉取 Magpie。参考 clone、固定版本和许可证用于开发参考及来源追踪，不是本地执行前置条件。显式指定参考源码的审计能力独立保留；默认本地检查只证明仓库 corpus 的有效性。

## 执行与收口

本轮执行目标见 `magpie-live-matrix-execution-goal.md`。项目代码在最新 `origin/main` 的外置独占 worktree 开发。worker 按文件 ownership 并行；独立 Reviewer 在完整 milestone 的作者自检和黑盒验收后执行一次整体审查。

仅运行受影响测试与项目适用 gates，不把静态门禁当 live 证据。候选、已安装 runtime、基线、review、集成和远端回执分别报告。测试设施的集成不宣称 runtime 业务缺口修复。

复用未变输入的有效证据。每个完整可交付 milestone 在作者验收后做一次整体独立 Review，再完成适用 CI、main 合并和资源收口；内部节点和普通提交不单独派审。源码、测试、候选运行、Review、main 和生产生效分别记录，不相互推断。

保留有效基线证据，清理自有测试实例和临时配置；不动生产服务、真实 provider 配置、他人进程或 worktree。参考 clone 保留供 P2/P3 使用。长期目标按各阶段交付推进，不以 P1 完成声称总体 operator 完备。

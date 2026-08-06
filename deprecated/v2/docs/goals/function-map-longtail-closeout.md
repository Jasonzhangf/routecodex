# Function Map Longtail Closeout Plan

## 目标与验收标准

目标：把 `note.md` 中 36 条未登记模块改造清单收敛为可执行的 P0/P1/P2 closeout 计划，先修复已知 map 漂移，再为高风险长尾模块补齐 `feature_id -> owner_module -> allowed_paths -> forbidden_paths -> canonical_builders -> required_tests -> required_gates` 闭环，提升全仓“唯一真源可查询性”，防止链路多重实现与 gate 漂移。

验收标准：

- 2 个已知漂移项先闭环：`vr.route_availability_floor`、`quota.unified_control_surface`。
- 长尾模块按模块族而不是按零散文件完成首轮登记，优先完成 `manager/routing`、`daemon-admin handlers`、`CLI command surface`。
- 每个新登记 feature 都同时具备 `function-map.yml`、`verification-map.yml`、源码锚点、`canonical_builders`、至少 1 个定向 gate/test。
- TS 薄壳不得再被登记为语义 owner；owner 必须优先指向 Rust / Hub / Provider 真源层。
- 对纯 `d.ts` / types / constants / glue 壳层给出“只做 doc 索引、不注册 feature”的明确边界。
- closeout 后，`function-map` 能作为高风险模块的唯一定位索引，而不是目录清单或注释清单。

## 范围与边界

In scope：

- 修复已登记 feature 的漂移/错登记/gate 失真（不含 `apply_patch` 与 `stopless` 专项）。
- 把 36 条未登记模块清单按 P0/P1/P2 重排成可执行分组。
- 为高风险模块族定义首轮 `feature_id`、owner 候选、allowed/forbidden 边界、builder 命名约束、建议 gate。
- 更新配套文档与 skills 规则，使后续新增链路必须同步登记。

Out of scope：

- 本轮不要求一次性补完所有长尾 feature 的代码与测试实现。
- 本轮不做与清单无关的架构重写。
- 本轮不为纯类型声明、常量壳、build glue 强行制造 feature。
- 本轮不新增 fallback、兼容双路径、临时 allowlist 来掩盖 owner 漂移。

## 设计原则

- 先修漂移，再补数量；gate 不可信时，长尾登记越多噪音越大。
- feature 按“唯一行为闭环”切，不按目录切，不按文件切。
- owner 优先 Rust / Hub / Provider 真源；TS 仅允许 `bridge` / `projector` / `entry shell` 身份存在。
- 一条运行链路的入口、投影、恢复、结果回写，应尽量在同一 feature family 内闭环，防止跨目录重复 owner。
- 不做 fallback；缺锚点、缺 builder、缺 gate 时直接报错，不靠注释/约定放行。
- map 的目标是“全局快速定位 + 防重复实现”，不是“尽量多登记文件”。

## 技术方案

权威输入：

- `note.md:15846`
- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- `docs/design/pipeline-type-topology-and-module-boundaries.md`
- `AGENTS.md`

### P0：必须先收口的漂移项

1. `vr.route_availability_floor`
   - 问题：proposed feature 只有纸面声明，缺真实 builder 定义，anchor/gate 失真。
   - 动作：要么补足真实 owner builder 与锚点，要么降级/重写 map 条目为真实已存在的 contract；禁止继续保留“注释占位 feature”。
   - owner 候选：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/selection.rs`。

2. `quota.unified_control_surface`
   - 问题：TS forwarder builder 名与 Rust native 真名过近，导致 owner 查询与 forbidden path 误报。
   - 动作：map 中 canonical builder 必须直接对齐 Rust 控制面真名；TS 仅保留 bridge 命名，禁止再写成 owner 语义。
   - owner 候选：Rust quota host / native proxy 真源层。

### P1：优先登记的长尾模块族

1. `manager.routing_control_surface`
   - 原因：与 virtual router 选择语义最近，最容易出现多重实现。
   - owner 候选：`src/manager/routing/**` 中真正编排 owner；若仅桥接，则 owner 仍应回指 Rust VR 真源。
   - gate 重点：禁止与 `vr.route_selection` / `vr.route_availability_floor` 语义重叠。

2. `manager.health_runtime` / `manager.token_runtime` / `manager.quota_lifecycle`
   - 原因：管理面最容易散落 lifecycle / cache / admin / runtime 多重入口。
   - gate 重点：限制“进入 quota / 排除 quota / 恢复 quota / 管理 quota 生命周期”只能经统一 control surface。

3. `daemon_admin.command_handlers`
   - 原因：入口多、动作散、经常带状态写入，最容易出现 hidden owner。
   - gate 重点：按 handler family 建 feature，不按单个命令切碎。

4. `server.http_runtime_entry` / `server.responses_handler_family`
   - 原因：请求入口、协议投影、SSE/JSON 边界容易与 Hub semantics 混写。
   - gate 重点：server 只能是 entry/projection shell，不得拥有 Hub 工具治理语义。

5. `cli.command_surface`
   - 原因：CLI 是用户可见入口，若不登记，命令路径容易散落重复。
   - gate 重点：命令只做参数解析/调度，不得成为业务 owner。

### P2：次级长尾，后补或只做索引

1. `monitoring` / `message-center` / `provider-sdk` / `bootstrap` / `app lifecycle`
   - 先登记真正有独立状态机/协议边界的模块；其余维持 doc index。

2. `config` / `constants` / `build-info` / `server-factory`
   - 只有形成独立行为闭环时才注册 feature；否则只记录在文档索引。

3. `types` / `d.ts` / 单纯 re-export / build glue
   - 明确不登记 feature，只做 doc 索引。

## 建议 feature 分组与落盘顺序

1. 先修 P0 两项，恢复 gate 可信度。
2. 再补 `manager/routing` 模块族，优先消除与 VR 的职责重叠。
3. 再补 `daemon_admin` 与 `server/http handler` 模块族。
4. 再补 `cli.command_surface` 与其相关 entry shell。
5. 最后处理 monitoring/config/bootstrap/constants/types，其中薄壳保持 doc-only。

## 风险与规避

| 风险 | 规避 |
|---|---|
| 为了补数量把薄壳登记成 owner | 增加 owner 规则：TS shell 不得作为 owner_module |
| 同一行为被拆成多个 feature 导致重复修改 | 按行为闭环建 family feature，不按目录碎切 |
| gate 指向死文件或注释占位 | 新增 gate：删除路径/缺 builder 直接 fail |
| Rust 真源与 TS 桥接命名混淆 | builder 命名区分 `*Quota` / `*Bridge` / `*Projection` 角色 |
| 长尾补登记过程中再次引入 fallback | 强制 fail-fast，不允许 allowlist 掩盖真 owner 缺失 |

## 测试计划

定向 gate：

- `npm run verify:architecture-feature-map-growth-discipline`
- `npm run verify:architecture-feature-anchor-coverage`
- `npm run verify:function-map-coverage`
- `npm run verify:function-map-paths`

补充建议 gate：

- duplicate-owner / cross-family keyword overlap gate：拦截 `manager/*`、`virtual-router/*`、`server/*` 同时声明相同行为 owner。
- deleted-path reference gate：拦截 `required_tests` / `required_gates` / `allowed_paths` 指向已删除文件。
- TS-owner ban gate：高风险 feature 若 owner_module 落在 TS shell，则直接 fail。

测试闭环要求：

- 每新增 1 个 feature，至少补 1 条 verifier 或定向 red/green test。
- 每个 feature 的 `canonical_builders` 至少命中 2 个真实源码位置，其中至少 1 个命中真源 owner。
- 高风险 feature 要有 build + contract + integration 至少三类验证。

## 实施步骤

1. 修复 `vr.route_availability_floor`、`quota.unified_control_surface` 两个漂移项。
2. 把 36 条清单压缩成模块族 feature 表，避免逐文件登记。
3. 在 `function-map.yml` 为 P1 模块族建立首轮 `feature_id` 与 owner/allowed/forbidden/canonical_builders`。
4. 在 `verification-map.yml` 为对应 feature 建立 unit/contract/integration/smoke/build 闭环。
5. 为新增 feature 补源码锚点与最小 gate，先红后绿。
6. 为 TS shell / bridge / projector 制定统一命名后缀，避免与 Rust owner builder 重名。
7. 增加 deleted-path / duplicate-owner / TS-owner-ban 三类 gate。
8. 把最终分层规则同步到全局 coding principles skill 与本地架构技能，作为后续增量提交强制规则。

## 完成定义

- `function-map` 中已知漂移项清零。
- 高风险模块族已具备首轮可查询 owner 索引，而不是目录散点。
- gate 能直接拦住“死路径引用、注释占位 feature、TS 壳冒充 owner、重复 owner”四类问题。
- 后续新增运行链路必须同步更新 map + verification + verifier/test，否则无法通过 gate。
- 全仓功能定位能力提升到“先查 map 再改代码”，减少重复实现和重复修改。

# V4 Phase 2 Track B：PluginManager、Inspector 与 Admin

## 目标与验收

实现 `routecodex-v4-plugin-manager`、`routecodex-v4-runtime-inspector` 和
`routecodex-v4-admin`，使候选插件计划可以编译、验证、显式发布并被只读检查。
候选失败不改变 active；已发布运行失败不自动回旧版本；Admin 不拥有业务语义、
Cordis 生命周期或插件排序/权限判定。

验收证据：

- candidate create/compile/validate/dry-run/publish/discard 状态机有 typed API；
- stale base、并发 publish、未验证 candidate、mount smoke 失败均 fail-fast；
- publish 只有一个原子 active pointer 变化，audit 记录 actor/action/base/candidate/
  result/hash；
- Inspector 只投影 active/candidate/failed/lifecycle/audit，不读取业务 payload；
- L2/L6 正反测试、架构 gate/red fixture、test-consumer、`npm run verify:ci`、
  AppSDK 0.1.3 admission 全绿；
- DSH Review 使用 `opencode-go/deepseek-v4-flash`，最终语义 PASS 且无 P0/P1。

## 范围与边界

允许：

- `v4/crates/routecodex-v4-plugin-manager/**`
- `v4/crates/routecodex-v4-runtime-inspector/**`
- `v4/crates/routecodex-v4-admin/**`
- 三模块专属的 `.appsdk/project.json`、resource/function/mainline/module/
  verification map 条目
- 三模块专属 contract、gate、red fixture、test-consumer、文档和 V4 构建矩阵

只读依赖：

- `routecodex-v4-plugin-contract`
- `routecodex-v4-plugin-plan`
- `routecodex-v4-plugin-catalog`
- `routecodex-v4-cordis-bridge`

禁止：

- 修改 `v4/cordis/routecodex-v4-cordis-host/**` 或
  `v4/crates/routecodex-v4-node-container/**`
- 修改 frozen BaseNode/Edge/Control/Error Active/Protected 或源码
- 修改既有 plugin-contract/plugin-plan/catalog/cordis-bridge 公共 API；需要时写
  handoff，不在本线抢 owner
- 实现 Cordis Context/Fiber/Effect、业务 NodePlugin 执行、Skeleton 跨节点编排
- Admin/UI 读取、保存或重建业务 payload/control/secret
- fallback、silent strip、candidate 失败后自动发布旧计划、已发布失败自动回滚

## 技术方案

### PluginManager

唯一状态机：

```text
draft -> compiled -> validated -> smoke_passed -> published
  \-> failed
  \-> discarded
```

`publish` 必须比较 expected active base hash，调用 typed
`NodeContainerLifecyclePort::mount_candidate`，通过后原子更新 active，再请求旧
container drain/dispose。该 port 是 Track A 的集成边界；本线用严格 fake 做测试，
不得仿制 Cordis 或复制 NodeContainer。

### RuntimeInspector

只读 snapshot 包含：

```text
active_plan_hash
candidate summaries
failed summaries
container lifecycle state
audit records
```

字段禁止出现 request/response/provider/client payload、MetadataCenter 内容、secret
或 native handle。

### Admin

提供 typed query/command structs，不先建 HTTP server：

```text
list_plugins / inspect_runtime / create_candidate / compile / validate
dry_run / publish / discard / audit
```

所有 mutation 委托 PluginManager；所有查询委托 RuntimeInspector。

## 风险与规避

- 第二 active truth：Manager 是 active pointer 唯一 owner；Inspector 只读投影。
- 自动回滚伪 fallback：published execution failure 只记录 typed failure，不切旧 hash。
- UI/Admin 越界：管理 DTO 静态 gate 禁 payload/control/secret/native handle 字段。
- 双实现 Cordis：lifecycle port 只有 trait + strict fake；实际 adapter 等 Track A 合入。
- 构建越界：新模块走 V4 source/active-link 登记和 test-consumer，禁止引用 V3/root。

## 测试

- 正：candidate compile -> validate -> smoke -> publish；active hash 更新一次。
- 反：未验证 publish、stale base、并发 publish、mount failure、dispose failure。
- 正：candidate failure 保持旧 active；反：不得发生隐式 fallback event。
- 正：published execution failure 进入 failed/audit；反：active hash 不自动回旧值。
- 正：Inspector/Admin 仅含管理 projection；反：payload/control/secret 字段 red。
- gate 检查 owner/path/edge/resource/test 映射以及 build/test matrix 接线。

## 实施顺序

1. 建立 `.agent-collab` run/claim 和从 `d6ea7ee42` 创建的独立 clean worktree。
2. 先登记三模块 owner、资源、function/mainline/verification maps 和 contract。
3. 先写 red fixture，确认缺模块/缺 gate/越界 DTO/自动回滚/并发 publish 当前为红。
4. 实现 Manager -> Inspector -> Admin 最小 typed surface。
5. 跑定向测试、test-consumer、V4 `verify:ci`、AppSDK 0.1.3 admission。
6. 按 DSH skill 做只读 review；FAIL 则修复并重跑受影响验证与 review。
7. 只提交本线 allowlist，写 evidence/handoff；不要合并主 tree或修改 Track A。

## 完成定义

三模块由机器注册表唯一拥有；candidate transaction、原子 publish、无自动回滚、
只读 inspector/admin 均有正反证据；完整 V4 admission 绿；DSH 语义 PASS 无 P0/P1；
handoff 给集成 owner，列明 commit、base、验证和未绑定的 Track A lifecycle adapter。

# V4 Phase 0：V3 复用审计矩阵

状态：`in_progress`

本文件是 V4 第一阶段的审计真源。它回答“V3 哪些语义、合同、证据可以进入 V4”，不授权直接复制 V3 实现。

## 审计边界

- V3 是行为和兼容基线；本阶段不修改、不重命名、不移动 V3 文件。
- 审计顺序是 `resource map → function map → mainline call map → verification map → source`。
- 复用单位可以是合同、测试证据、协议样本或实现；“复用合同”不等于“复用运行时代码”。
- V4 的正式 owner 必须落在 `v4/`；V3 只能作为只读输入和对照样本。
- 所有控制语义继续走 typed side-channel / control resource / Error chain，禁止进入业务 payload。

## 决策定义

| 决策 | 含义 |
| --- | --- |
| `reuse-as-is` | 仅在合同稳定、owner 唯一、边界已满足 V4 时复用；当前只允许用于只读证据或不带 V3 runtime 依赖的合同资产。 |
| `extract-and-tighten` | 保留已验证语义，V4 重新建立更窄的 owner、类型和 gate；禁止把 V3 runtime 整体搬入。 |
| `rewrite-in-v4` | V3 的职责、控制/数据边界、性能模型或 provider 耦合不满足 V4，需要新实现。 |
| `legacy-only` | V3 继续作为兼容基线；V4 初期不直接依赖，待后续专项迁移。 |

## 矩阵

| 审计 ID | V3 范围 | V3 owner / 主线证据 | V4 决策 | V4 目标职责 | 禁止复用 | 证据状态 / 下一步 |
| --- | --- | --- | --- | --- | --- | --- |
| `AUDIT-CONFIG-01` | `v3.config_interpreter_contract`、配置读取→解析→校验→registry→manifest | Function map `v3-function-map.yml:119-192`；mainline chain `v3.config.compile`，`v3-mainline-call-map.yml:315-`；verification map `v3-verification-map.yml:905-969` | `extract-and-tighten` | V4 编译器：authoring → validate → deterministic manifest → load；manifest 是 runtime 唯一输入 | 不复制 `V3ConfigStore`、V3 默认值兼容分支、V3 server wiring | owner、链和 gates 已绑定；下一步建立 V4 schema/manifest contract |
| `AUDIT-HUB-02` | Hub typed stage skeleton：request/response 相邻节点和唯一 builder/parser | Function map `v3-function-map.yml:878-1068`；verification map `v3-verification-map.yml:298-376`；V3 主线 map 的 Hub chain 条目 | `extract-and-tighten` | V4 独立 stage types、相邻转换、编译期不可接、运行时 fail-fast | 不复制 V3 `hub_v1` runtime，不复活跨节点 shortcut、散落 `From` 或旧 TS 语义壳 | 节点 owner 与 builder 已有证据；下一步写 V4 pipeline topology 和 red tests |
| `AUDIT-CONTROL-03` | `v3.direct_stopless_metadata_center` 与 runtime control resource 关系 | Verification map `v3-verification-map.yml:2761-2828`；resource map 中 MetadataCenter/Stopless resource 定义；V3 约束为 side-channel-only | `extract-and-tighten` | V4 独立 MetadataCenter/data-center：按 request/pipeline/port/session scope 注册、消费、释放 | 不复制 Direct-specific 状态、不把客户端协议 metadata 当内部控制信号、不跨闭环缓存 | 控制/数据边界已明确；下一步建立资源 registry、scope key、生命周期 gate |
| `AUDIT-ROUTE-04` | `v3.virtual_router_target_interpreter`：路由选择、Target 展开、availability 读取 | Function map `v3-function-map.yml:583-708`；verification map `v3-verification-map.yml:1296-1357`；mainline `v3.target.session_global_selection`，`v3-mainline-call-map.yml:60-` | `extract-and-tighten` | V4 通用 route classifier + opaque target selection；provider availability 通过声明资源读取 | Router 不得写 health；Target 不得改 health；不复制 provider 特例、payload 修补或 fallback | session-first 选择和资源边已验证；下一步定义 V4 route/resource contracts |
| `AUDIT-ERROR-05` | `v3.debug_error_foundation` 的六段 Error chain、provider failure policy、availability projection | Function map `v3-function-map.yml:268-412`；verification map `v3-verification-map.yml:1208-1295`；resource map error resources | `extract-and-tighten` | V4 typed Error chain + policy decision + client projection；错误状态与业务 payload 分离 | 不复制 message-only 分叉、provider runtime 本地 retry/reroute、错误吞掉或 fallback 成功 | owner 和链条已绑定；下一步建立 V4 error contract 与正反红测 |
| `AUDIT-PROTOCOL-06` | OpenAI Chat / Gemini / Anthropic 等协议 codec characterization 与字段 parity | Function map `v3-function-map.yml:1467-1636`；verification map `v3-verification-map.yml:688-852`、`1923-2064` | `reuse-as-is`（仅证据） + `rewrite-in-v4`（实现） | V4 protocol adapters 只做解析、投影和语义保留；治理留在 Chat Process | 不复制 V3 codec 内部耦合，不在 normalize/compat 节点做工具治理或 payload cleanup | 协议样本/字段 parity 可作为只读基线；V4 codec owner 尚未建立，标记为下一阶段实现 |
| `AUDIT-PROVIDER-07` | `v3.responses_provider_runtime` 与 provider wire/transport/auth/capability | Function map `v3-function-map.yml:508-582`；verification map `v3-verification-map.yml:1127-1207`；Hub chain 的 provider compat/wire/transport 节点 | `rewrite-in-v4` | Provider 仅声明配置、能力、认证句柄、transport codec 和注册 action operator | 不把 provider runtime 代码直接接入 V4 core；不把 route/tool/error/continuation 通用语义写进 provider 分支 | V3 provider shape 有明确 owner，但与 V4 operator model 不同；需要先建立 V4 provider contract |
| `AUDIT-DEBUG-08` | debug trace/raw capture/event ledger/dry-run/snapshot 与 sample retention | Function map `v3-function-map.yml:268-412`、`4229-4266`；verification map `v3-verification-map.yml:1208-1295`、`3408-3438` | `legacy-only`（初期） | V4 后续建立独立 diagnostic side-channel 和受控 playground evidence | 不让 V3 debug store、snapshot 或样本路径成为 V4 runtime 输入；不裁剪真实 payload 语义 | V3 证据可用于对照，但生命周期和目录合同未迁移；后续单独设计 |
| `AUDIT-CONTINUATION-09` | remote/local continuation store、Responses continuation、servertool/stopless followup | Function map `v3-function-map.yml:1707-2210`、`3158-3428`；verification map `v3-verification-map.yml:1454-1845`、`2538-2828` | `legacy-only`（初期） | 后续以 V4 scope、ownership、immutable interval 合同为前提专项迁移 | 不直接复用 V3 continuation store、桥层恢复、SSE/handler 补偿或 session-only 命中 | 这是高耦合高风险域；先冻结 V4 foundation，完成 data/control contract 后再审计 |
| `AUDIT-TRANSPORT-10` | SSE transport、HTTP keepalive、websocket proxy、client projection | Function map `v3-function-map.yml:2147-2210`、`2962-3046`、`3639-3689`；verification map `v3-verification-map.yml:1846-1883`、`2421-2486`、`2903-2943` | `legacy-only`（初期） | V4 只在主线合同稳定后建立 transport projection；transport 不拥有治理语义 | 不复制 SSE/handler 对 continuation、tool、error 或 metadata 的语义补偿 | V3 有独立边界和 gates；当前不进入 V4 foundation |
| `AUDIT-LIFECYCLE-11` | V3 managed lifecycle、CLI、安装、restart/control plane | Function map `v3-function-map.yml:4-75`、`4327-4373`；verification map `v3-verification-map.yml:40-117`；mainline `v3.server.managed_lifecycle` | `legacy-only`（V4 bootstrap） | V4 由 AppSDK project lifecycle 和编译 artifact 管理；RouteCodex runtime lifecycle 后置 | 不让 V4 依赖 V3 CLI、全局安装路径、restart 状态或 V3 live config | V3 lifecycle 已验证但属于兼容运行面；V4 先使用 AppSDK contract，不迁移实现 |

## 当前结论

### 可直接固化为 V4 的内容

目前可以固化的是“语义和边界”，不是 V3 runtime 源代码：

- 配置必须经过编译，runtime 只消费 deterministic manifest。
- pipeline 节点必须有唯一 owner，只允许相邻转换。
- route、error、health、continuation、debug、scope 和 MetadataCenter 都是控制面资源。
- provider 只实现配置声明、能力、transport/codec 和注册 action operators。
- V3 已验证的协议 characterization、字段 parity、正反测试可作为只读对照证据。

### 首批 V4 实现顺序

1. V4 resource registry：先锁 data plane、control plane、MetadataCenter、artifact 和 scope resource。
2. V4 module/function/mainline registry：绑定 Rust owner、相邻边、禁止边和 required gates。
3. V4 data/control plane boundary contract：先写 fail-fast red tests。
4. V4 pipeline type topology：实现 request/response/error 的最小 typed skeleton。
5. V4 config compiler contract：生成 deterministic manifest/index。
6. V4 MetadataCenter/data-center lifecycle：注册、消费、scope 校验、释放。
7. 重新评估 `AUDIT-PROVIDER-07`、`AUDIT-CONTINUATION-09` 和 `AUDIT-TRANSPORT-10`，再决定进入模块迁移。

## Phase 0 退出门槛

审计完成前，每个候选域必须具备：

- `feature_id` / `resource_id`；
- 唯一 V3 owner 和实际 source path；
- mainline 相邻 caller/callee；
- required verification gates；
- 四选一复用决策；
- V4 target owner、禁止复用边界和下一步；
- 明确区分 confirmed evidence 与 audit-pending；
- V3 工作树未被本阶段修改。

本矩阵完成的是第一版领域分流，不代表 V4 已完成实现。下一件实际架构工作是建立 V4 resource registry 和 data/control boundary contract。

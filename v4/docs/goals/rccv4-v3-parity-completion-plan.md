# RCCV4 V3 parity completion plan

## 目标与验收标准

把 RCCV4 从当前独立 runtime admission / flat config 状态推进到可替代 V3
7777 的生产路径：配置、路由、provider、协议、错误策略、continuation、工具治理、
生命周期和发布证据全部对齐。V4 必须使用自己的 typed manifest 与 Rust owner，
不读取 V3 runtime、不调用 V3 runtime、不保留双真源。

验收必须同时满足：

- V3 7777 与 V4 5520 的选定功能清单 normalized differential 为零未解释差异。
- 配置、route pool、provider model、auth handle、error policy、protocol projection
  都由 V4 manifest/runtime 真正消费，不只是声明在 fixture 中。
- 正向与反向测试成对通过；workspace build/test 通过。
- 使用全局安装版本完成安装、聚合 restart、全部 listener health 检查。
- 同 requestId 旧样本完成 V3/V4 在线 replay，保留 raw request、provider-bound request、
  raw response、client projection 证据。
- architecture gate、active-link gate、differential gate、AGY review 全部通过后，
  才能提交整包 V4。

## 范围与边界

In scope：V4 config compiler、router、provider runtime、protocol adapters、error
chain、continuation、tool/servertool governance、runtime lifecycle、CLI/build/install
和 parity evidence。

Out of scope：V3/main tree 改动、V3 fallback/旁路、请求侧 cleanup、payload 注入控制面
字段、恢复已移除 provider、无证据的兼容层。

## 设计原则

- typed manifest 是 V4 唯一运行时配置真源；authoring 只经 compile/validate/load。
- 每项语义只有一个 owner；只允许相邻 pipeline 节点转换。
- routing、switching、health、retry、error、scope、debug 只走 typed side-channel/Error 链。
- 禁止 fallback、silent strip、handler/SSE/outbound 补偿和 provider 特例进入 Hub。
- 先红测锁边界，再最小实现；先模块边界自检，再功能验证，再安装/重启/live replay，
  最后 review。

## 技术方案与文件面

1. `routecodex-v4-config`：完成 V3 7777 typed import、manifest 编译、secret-free
   auth handles、route/error policy schema、normalized differential gate。
2. `routecodex-v4-router`：消费 product route groups/pools，覆盖 precedence、entry
   protocol、capability、threshold、priority/weight、unknown target fail-fast。
3. `routecodex-v4-runtime-bin` 与 provider owner：将 manifest target 解析为 provider
   wire request；禁止回读 raw payload 重建控制状态。
4. protocol / response / continuation owners：分别接入 Chat、Responses、Anthropic 等
   V3 选定入口，锁定 continuation owner、scope、save/restore 不可变区。
5. error / health / lifecycle owners：接入统一 ErrorErr01-06、provider failure policy、
   in-flight epoch drain/dispose、restart identity 稳定性。
6. maps、contracts、wiki、verification/evidence：每个功能同步 owner、edge、gate 和
   live replay 证据。

## 风险与规避

- 配置声明已存在但 runtime 未消费：每个字段必须有 consumer symbol 和 differential test。
- V3/V4 结果形状漂移：固定同 requestId 的四段证据链，禁止普通 smoke 代替。
- provider secret 泄漏：只允许 env/token_file handle，manifest 和 payload 均不得含 secret。
- 旧 runtime 旁路或 fallback：加入 red architecture tests，失败即停止接线。
- review 早于 live：未安装、未重启、未在线 replay 禁止启动 review。

## 测试计划

- config：正向 deterministic compile、完整 fixture count/ID、secret/unknown/duplicate
  red tests。
- router/provider：pool selection、priority/weight/capability/threshold、wire model、
  auth handle、provider error path 正反测试。
- protocol/lifecycle：Chat/Responses/stream/continuation、scope isolation、epoch
  publish/drain/dispose、restart identity 正反测试。
- project：workspace cargo test/build、architecture gates、active-link、normalized
  V3/V4 differential、安装/restart/health、在线旧样本 replay。

## 实施步骤

1. 读取 MemoryPalace、resource/function/mainline/verification maps，声明唯一 owner 和
   clean V4 worktree；冻结 V3 7777 baseline fixture 与差异 ledger。
2. 完成 config consumer：从 manifest 读取 product route/error declarations；通过 config
   differential gate。
3. 完成 router/provider 接线；通过 target/wire/auth/error 正反测试。
4. 完成 protocol、continuation、tool governance 与 lifecycle 接线；通过对应 red/green
   gates。
5. 在主 V4 tree build、安装、聚合 restart，验证 5520 与配置内全部 listener health。
6. 用相同 requestId/旧样本执行 V3 7777 ↔ V4 5520 differential replay，修复所有未解释
   差异并更新 evidence bundle。
7. 运行 AGY review；若 FAIL，修复后重跑受影响验证、安装、restart、replay，再新建 review。
8. 仅在所有 gate/review PASS 后，检查 staged change set，提交完整 V4，并验证 HEAD 与
   目标分支一致。

## 完成定义（DoD）

没有“配置已声明但未消费”、没有 source-only/lived-pending 条目；V3/V4 differential
ledger 全部关闭；live 版本与提交一致；所有 required gate、在线证据和 AGY PASS 已落盘；
整包 V4 一次性提交。

## 当前执行状态与硬退出条件（2026-08-24）

已完成的独立 source-green 层：

- config product compiler/import：V3 profile fixture 已编译为 typed product manifest；
  config L2 7/7。
- typed product route/error selection：route/product L2 7/7，包含 unavailable-provider
  排除和错误策略匹配。
- provider profile/auth/protocol/wire/response/SSE normalizer：provider L2 10/10。
- ErrorErr01-06 policy projection：runtime L2 35/35。
- runtime-bin product dispatch 与一次 policy-driven reselect：runtime-bin L2 11/11。

尚未闭环的层：

1. availability/cooldown 必须由 session-scoped typed owner 真正接入执行器；不能只在
   单次调用中排除当前 provider。
2. product fixture 必须由 live V4 authoring/config 入口加载，不能停在测试资源消费。
3. Chat/Responses/Anthropic 的同 requestId 四段 differential replay 尚未完成；需保留
   raw request、provider-bound request、raw response、client projection。
4. 全局安装、`routecodex restart` 聚合重启、5520 与配置内全部 listener `/health`、
   在线旧样本尚未完成。
5. active-link、architecture/red、differential、AGY review 尚未完成；在此之前禁止
   final commit/push/完成声明。

执行顺序锁：先完成同一层所有独立 source-green 任务，再由单一 integration owner 接线；
review 不阻塞无依赖开发，但 review FAIL 只回唯一 owner 修复并重跑受影响闭环。禁止 V3
修改、fallback、双真源、payload 控制字段、silent strip、handler/SSE/outbound 补偿。

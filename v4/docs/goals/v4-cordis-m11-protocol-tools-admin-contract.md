# V4 Cordis M11 协议、工具与管理面前置合同

状态：`contract_bound`（前置合同已锁定，M11 runtime implementation 仍为 `planned`）。

本文件是 M11-T01 的人读拆分面；机器真源是
`v4/contracts/m11-protocol-tools-admin.contract.json` 与
`v4/contracts/m11-protocol-tools-admin.manifest.json`。本任务只建立前置合同、依赖、owner、边界和 gate，不接入运行时。

## 目标与边界

M11 必须把 Chat、Anthropic、Gemini、WebSocket、function/custom/web-search/servertool/stopless 与 Admin 接入既有 Cordis graph、typed pipeline 和 PluginManager/RuntimeInspector owner。协议数据面与控制面必须分离：正常 payload 仅保留协议业务语义，route、epoch、scope、tool lifecycle、health、debug、snapshot、secret 与 publish control 只能走 typed side-channel 或 Error 链。

本次允许变更：V4 contract、machine manifest、任务拆分、测试设计和 verification map。禁止变更 `runtime-bin`、ExecutionEngine、D0、M08 async data-plane、Active artifact、V3、全局安装/重启/运行时和父进度文件。

## 唯一 owner 与依赖

- Protocol operator 复用 `routecodex-v4-standard-plugins` 的既有 standard-library owner；新协议变体必须先完成 typed entry/shape contract，再进入同一 library，不在 Hub/Virtual Router 增加 provider 特例。
- Tool governance 复用 standard plugins；servertool 的 CLI projection/control 继续由 `routecodex-v4-servertool` 持有，不把 control 投影回 client/provider payload。
- Admin query 只消费 `routecodex-v4-runtime-inspector` projection；Admin mutation 只委托 `routecodex-v4-plugin-manager`。Admin 不直连 Cordis Host 或 NodeContainer，不拥有排序、权限、graph、epoch 或 rollback policy。
- Cordis host daemon、PluginCatalog、candidate store、Admin projection 是已登记的依赖资源；本任务不重建第二套 graph、catalog、state store 或 lifecycle owner。

## 任务拆分

| 任务 | owner | 依赖 | 交付边界 |
| --- | --- | --- | --- |
| M11-T01-P | `routecodex-v4-standard-plugins` | Cordis daemon、PluginCatalog | 协议入口/shape/字段保真合同；Chat、Anthropic、Gemini、WebSocket 变体的后续实现入口；不得降级为文本 |
| M11-T01-T | `routecodex-v4-standard-plugins` | M11-T01-P、candidate store | function/custom/web-search/tool/servertool/stopless 的 typed identity、顺序、结果和多轮边界；控制状态不进 payload |
| M11-T01-AQ | `routecodex-v4-runtime-inspector` | Admin projection | catalog/epoch/candidate/lifecycle/audit 的只读 projection；不含 payload、metadata、secret、native handle |
| M11-T01-AM | `routecodex-v4-admin` | M11-T01-AQ、candidate store | typed query/command 边界与委托合同；不实现 lifecycle、排序、权限或 rollback |
| M11-T01-AP | `routecodex-v4-plugin-manager` | M11-T01-AM、Cordis daemon | candidate compile/validate/smoke/publish/drain/explicit rollback 合同；stale base、hash drift、并发和失败必须显式拒绝 |

所有 task 当前为 `planned`，没有把目标态伪报成 active。每个 task 必须先通过 M11 contract 正反 gate，再进入各自 owner 的既有模块 gates；实现 worker 必须新建自己的 feature/resource claim，不能复用本任务 claim。

## 不变量与禁止路径

1. 工具 identity/schema/order/result 必须保真；禁止 `tool_call`、`tool_result`、servertool 或 stopless 语义转成普通文本。
2. Admin 查询是 projection，Admin 写入是 typed command；两者都不得携带业务 payload、协议 metadata、MetadataCenter 内容、secret 或 native handle。
3. Publish 必须比较 candidate hash 与 expected active base hash，并由 PluginManager 通过既有 lifecycle port 改变唯一 active pointer；失败不自动发布旧计划、不自动 rollback。
4. Protocol、tool、admin lanes 只能使用声明的相邻依赖；禁止 Admin 直连 Cordis Host/NodeContainer，禁止 Hub/Virtual Router 读取 payload 重建控制状态。
5. 未知协议、工具、命令、epoch、candidate 或 lane 必须显式错误；不使用 fallback、silent strip、请求侧 cleanup 或 handler/SSE/outbound 补偿。

## 完成信号

本 T01 仅在合同、manifest、测试设计、verification-map 引用一致，canonical V4 test glob 能运行正反测试，定向 maps/边界检查通过，并将 evidence 与 merge queue 交给 checker 后完成。M11 产品实现、安装、重启、在线样本和 Active artifact 仍属于后续 owner，不在本任务完成声明内。

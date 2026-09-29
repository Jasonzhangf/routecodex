# V3 DAGPipe 接入入口

业务目标与首轮差异审计见 [v3-proxy-pipeline-target.md](v3-proxy-pipeline-target.md)。该图描述应有的代理语义，不以现有 Rust 接线反推目标。现有资源、owner、调用边和验证仍分别以 `../v3-resource-operation-map.yml`、`../v3-function-map.yml`、`../v3-mainline-call-map.yml`、`../v3-verification-map.yml` 为真源；锁定骨架遵守 `../wiki/v3-mainline-skeleton-sop.md`。

## 逐模块登记

`modules.json` 只记录 DAGPipe **静态图登记状态**，不复制节点或 owner 真相。请求、响应、错误是三个独立业务对象源，各自必须有单一输入 ARC 和单一输出 ARC。生命周期由 Runtime/Server 持有，重试启动新尝试，不在静态图中回边。三个 `v3.operation_runner.*.graph.json` 已登记；当前仅请求图的 `capture_client_json` Node01 切片完成 SDK 编译和真实入口接线，其余节点仍须逐一接入。静态图登记不代表整条请求、响应或错误图已运行。

每次只推进一个模块，按以下顺序留下证据：

1. 从目标业务图和真实入口核对该模块的对象源、成功/失败出口、节点责任、ARC、Direct/Relay 分支与透明代理边界；缺口先修图，独立审查通过后再变更锁定骨架或产品代码。
2. 建立该模块项目图 JSON，填入 Operator 名称/版本、ARC schema、依赖边和唯一出口；把 `modules.json` 的该模块改为 `graph` 并填图路径。运行 `npm run verify:v3-dagpipe-governance`，再用 `dagpipe graph inspect <graph.json>` 审阅拓扑。CLI 仅证明静态图格式、SESE 与声明绑定。
3. 在该模块原 owner 下实现并注册 Operator，借 SDK `compile()` 验证合同、ARC 权限及 effect；再核对真实入口和旧样本的成功、错误、取消或流终结证据。只有这些证据齐备，才能报告 SDK 编译或 runtime 接入。状态登记为 `graph` 也不表示后两项完成。

`pending` 模块不会被静态图校验冒充为 PASS；命令会逐项打印 PENDING。图文件出现后必须在 `modules.json` 登记，否则治理命令失败。模块先后由请求、响应、错误的依赖及真实证据决定，不对所有模块一次性改造。额外校验不能拒绝原本可兼容传递的请求或拦截可兼容响应。Node01 的实现与证据见 `../../design/v3-unified-operation-runner-design.md` 和 `npm run verify:v3-operation-runner-dagpipe`。

执行 V3 DAGPipe 治理 CI 的环境须安装 `dagpipe` CLI；缺少 CLI 时治理命令显式失败。CLI 安装本身不代表图通过，更不代表 SDK 或 runtime 接线。

# 请求身份搬运：作者验收缺口与下一修订条件

这是父编排的作者自检，不是独立架构review。当前identity候选未导入父、未接共享runtime。

输入：/Volumes/Intel/playground/routecodex/req02-identity-plumbing-20261003 的活动候选；源码引用来自2026-10-03本轮读取，最终产物变化后只复查受影响位置。现有8项公开control/guard测试、execution_control22PASS与runner回归仅作为开发证据；`cargo check | rg | head; echo DONE_SERVER`被后续命令掩盖退出码，不得作为cargo check成功证据。

## 已确认源码缺口

1. `hub_v1/responses_relay_runtime_inner.rs`在Req02、Req04及Req05之后才创建新control；`relay_runtime_core.rs`同样晚于Req02/Req04/Req05。需要把首次有真实requestId的factory边界移到首次归一化/规划前，且handoff传入control不重建scope。不能以公开test提前手工建control代替真实caller早创建。
2. `server/responses_direct_server_outcome.rs`的`relay_finalizer_owner.take_request_finalizer().ok()`吞掉typed内部失败；缺guard时两个attach helper静默return。必须显式暴露内部错误并让既有Runtime/Error owner决定，不往成功数据流塞错误、不增加对passable payload的业务拒绝。
3. 纯Responses Relay、共享Relay core与Anthropic Relay缺将同一guard搬运到真实输出/stream的实现。仅Direct→Relay server分支补guard不能覆盖这些入口；不得让guard在返回SSE前随着最后control Drop提前释放。
4. `V3RequestFinalizerLiveSseStream::poll_next`只转发，未在EOF释放guard，仅在Drop释放；读取至EOF但保留stream对象时资源不会抵达已声明终点。
5. 取消/future Drop目前依赖最后control clone被销毁。`cancelled_future...`仅drop唯一control，不覆盖metadata/handoff保留clone的实际情况；生命周期guard必须由实际Runtime future/output独占搬运，普通control clone不是终止owner。

以上2/4为源读已确认；真实入口资源副作用的因果红绿由独立实施中的公开consumer测试补证，不将源读当运行复现。

## 修订与验收边界

复用已审R2的唯一Runtime factory/非Clone guard/Server只搬运opaque的合同。实际Runtime根生命周期取得guard并保持到typed终点，handoff沿同scope搬运；不新增跨请求registry、第二MetadataCenter、default identity、另一个guard或不同协议各自释放政策。协议差异应仅为既有typed输出carrier，不复制清理决策。不改投影、field/profile/REQ06或provider管理。

新增输出struct/terminal carrier变化先落盘确切路径与原因，并核对owner/map；不能用口头声称允许扩大范围。普通handles/controls可Clone，但不决定request结束。

测试worker只负责`server/tests/req02_scope_runtime_consumer.rs`与自己的结果，产品worker不得同时改其用例。取得能编译的真实公开Runtime消费者红证据后修唯一owner，分别验证纯Relay SSE EOF/Drop、cancel时保留control clone、真实Direct JSON/error终点及可达handoff。成功JSON/error用手动drop guard自证、SSE用测试自造observer自证不作为真实caller准入。

最终必须分别执行合同的公开用例、execution_control与operation_runner测试，单独保存退出码；真实consumer全部绿及上述调用链闭合后，父才组合并继续REQ02完整候选验收。未达到这些条件可回传可用factory切片，但不能报告整个identity plumbing完成。

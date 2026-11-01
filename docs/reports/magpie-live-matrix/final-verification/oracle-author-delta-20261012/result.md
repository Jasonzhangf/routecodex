**本轮 oracle 作者修正已完成。** 受影响 Node 测试 **99 pass / 0 fail / 0 skipped**。7 个真实入口 delta replay 中，**6 个通过，1 个保留失败**。初始 48-case 报告仍为 **12 passed / 36 failed**，未改写。

交付记录：[result.md](/Volumes/Intel/playground/routecodex/.worker-runs/magpie-live-matrix-20261012-0435/oracle-author/result.md)。机器回执含 source hashes、installed identity、逐 case 结果和 cleanup：[receipt.json](/Volumes/Intel/playground/routecodex/.worker-runs/magpie-live-matrix-20261012-0435/oracle-author/receipt.json)。

本轮只修改了 6 个 owned helper/test 文件和 7 个相关 fixture：

- [protocol-semantics.mjs](/Volumes/Intel/playground/routecodex/magpie-live-matrix-20261012/v3/scripts/tests/protocol-live-mock/protocol-semantics.mjs)：从 Responses `output_item.done` 和完整 output 快照读取文本。保留 content metadata 和 message status。重复快照与前序 delta 不再重复计入文本。
- [assertions.mjs](/Volumes/Intel/playground/routecodex/magpie-live-matrix-20261012/v3/scripts/tests/protocol-live-mock/assertions.mjs)：只允许受限的纯文本表示等价。Anthropic 的角色、顺序、media、signature、tool arguments 和 call ID 仍严格匹配。Responses instructions 等价只覆盖单个前置 plain system message，且排除其他优先级消息和 `previous_response_id`。
- [corpus.mjs](/Volumes/Intel/playground/routecodex/magpie-live-matrix-20261012/v3/scripts/tests/protocol-live-mock/corpus.mjs)：`assert_tool_executed_once` 必须绑定实际 echo consumer。静态 namespace history 不能声称执行过工具。
- Responses SSE fixtures 改用 `status` 和 message/output_text 字段。Chat usage fixture 显式加入 `stream_options.include_usage=true`，保留原 usage golden。

反例证明：丢文本、丢 annotations/signature/media、改角色或顺序、改参数或配对 ID、缺失 usage，仍会失败。无效 flat Responses `output_text` item 没有被当成合法 message。

真实重放使用 installed `rccv3 0.90.4887`，SHA256 为 `5c1672a5…47a563`。6 个修正后的 case 通过。`responses-to-gemini-sse` 修正错误终态键后仍失败：**0 provider attempts，客户端只有 keepalive 后中断**。7 个 replay 的 cleanup 均为 complete；原始 captures 和控制回执保存在新建 [delta 目录](/Volumes/Intel/playground/routecodex/.worker-runs/magpie-live-matrix-20261012-0435/oracle-author/delta)。

保留的分类与限制：

- **namespace 不是“仅索引差异”。** mock callee 在 advertised wire tools 中，完整参数符合原声明；但客户端实际为零字节。该 fixture 还存在 `stream=false` 请求配 SSE mock 的差异。未放宽 alias/type 权限，未据此宣称产品根因。
- older-turn image case 不能只凭图片字节保留就证明完整角色、顺序和工具结果语义。未照实际输出移动 golden 索引。
- tool-followup 的真实 echo-once 和第二次请求证据保留。严格 wire mismatch 与 flat Responses JSON projection 缺口仍未关闭。
- Responses replay 的通过只证明已声明的语义断言；不证明全部 SDK 必需字段都有效。
- empty-body diagnostic 留给 active close-observation owner。本轮未修改 closed-transport assertions。

未修改 case-runner、package、CI、runtime 或生产状态。未进行 delegation、Review、commit 或 merge。编排 owner 可据这些回执组合其他 peer 的交付，再进入一次正式 whole Review。
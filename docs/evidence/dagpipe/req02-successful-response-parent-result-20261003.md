# REQ02 成功attempt响应consumer父组合结果

状态：typed view、既有Anthropic工具投影与provider SSE公开consumer已组合到父候选；公开consumer开发验证通过。Runtime实际caller尚未替换，本结果不证明REQ02交付、HTTP/WS或真实工具回合。

## 源码归属与消融

- 原请求pair与真实成功attempt由唯一 `ResponseProjectionView::from_successful_attempt` 结合；不以失败attempt或模型名称猜测身份。
- `anthropic_codec/projection_context.rs` 只构建成功attempt实际emitted name到原声明kind/name/namespace的一个map，关联依据原 `declaration_record_id`，不要求provider与客户端kind/namespace相等。
- `anthropic_codec_tool_projection.rs` 复用既有工具投影owner，按上述map恢复所有有映射的function/custom。完整参数、custom自由文本、call_id、namespace缺省/null/string保留。
- 新constructor冗余legacy三map回填已删除。旧factory仅保留给尚未迁移的真实caller，实际接线时须删除被替代的猜测路径。
- 删除无consumer的Responses-only with_context包装；通用protocol with_context只委托既有唯一provider SSE materializer，不新增reducer。
- metadata/reasoning业务值通过显式数据面参数保留，不复制进typed控制slots。

## 作者与父组合证据

作者原始结果：`req02-successful-response-correction-author-result-20261003.md`，SHA256 `a1860b762346fb57bcfc6a52eb680eabaeaea45461e44d132570cd2b8433b327`。定点消融作者结果：`req02-successful-response-ablation-author-result-20261003.md`。

父逐文件读取diff并核对两侧基线相同，使用apply_patch组合四个产品文件；typed store只加view与最小export，不覆盖已有runner。两份公开测试逐字导入。最终7个源码/测试输入与作者消融结果一致，见 `.execution/response-view-parent-combined-r2-inputs.sha256`。

| 父验证 | 绑定输入 | 真实结果 | 日志 |
| --- | --- | --- | --- |
| operation_runner开发回归 | HEAD75b1927f + typed view/export | exit0，51PASS | response-view-parent-runner-r1.log |
| 两项cross_kind公开consumer | HEAD75b1927f + 消融后响应候选 | exit0，2PASS | response-view-parent-public-r2.log |
| 六项view公开consumer，含真实provider SSE | 同上 | exit0，6PASS | 同上 |
| 全runtime lib | 同上 | exit0，1135PASS/0FAIL/1既有ignored | response-view-parent-runtime-lib-r2.log |
| operation runner gate | 同上及当前maps | exit0 | response-view-parent-operation-gate-r2.log |
| resource map gate | 同上及当前maps | exit0 | response-view-parent-resource-gate-r2.log |
| cross_kind与view公开consumer | HEADa9952cc748f417caa675025f20ae1e51323d0c79，已组合main688f7a1c6 + 上述dirty候选 | exit0，2+6PASS | response-view-parent-public-main-r3.log |
| 全runtime lib | 同上，包含上游main终态修复 | exit0，1139PASS/0FAIL/1既有ignored | response-view-parent-runtime-lib-main-r3.log |

所有日志均在父 `.execution/`；r2日志hash见 `response-view-parent-r2-logs.sha256`。r3公开日志SHA256为 `b3cac3bfa9a34d1f4d3a78f2161508489a5e873114a69af4a2f37d33e702e6b3`，r3源码与日志输入分别见 `response-view-parent-main-r3-inputs.sha256` 和 `response-view-parent-main-r3-logs.sha256`。完整architecture gate仍在运行，结果待收；开发测试绿不等于实现架构review或REQ02节点交付。

## 当前边界与下一步

父候选已经组合origin/main688f7a1c6的Responses incomplete/Chat codec修复，保留其他worker成果。identity候选仍在独占树修订，尚未导入；REQ06公共helper尚未交付，实际attempt producer及response caller仍待接通。HTTP/WS、gpt-5.5/5.6 exec/apply_patch/MCP真实回合、候选安装/restart、实现review、main/remote交付及资源清理均未证明。4444未变更。

收最新main输入的开发回归与architecture结果，identity真实生命周期五项全绿后逐文件组合；取得REQ06 helper并按序替换实际caller、消融旧实现，再完成真实入口与全工具黑盒及完整交付。

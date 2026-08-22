/goal
目标：实现 V4 Relay + Continuation 最小垂直切片：Relay 与 Direct 共用同一
Hub 链、只按 typed facts 选 operator；continuation 只在 resp_chatprocess
save、下一轮 req_chatprocess restore，不可变区零语义转换；六面兼容证据
unexplained_diff=0。

说明：本任务不需要再写新的提示词，直接按实现文档执行。

实现文档：
v4/docs/goals/v4-relay-continuation-slice-plan.md

执行规范：
- 先红后绿：不可变区转换、direct/relay 串续、仅 session 续接、chat/messages
  命中 responses continuation、控制字段进 body 全部先落红测。
- 控制面只走 typed carrier / MetadataCenter / Error 链，payload 不得重建控制
  状态；禁 fallback、禁请求侧 cleanup、禁 handler/SSE/outbound 补偿。
- Rust 真源：chat process / continuation / relay operator 语义只在 Rust；
  只动 v4/ + verify 脚本 + package.json + CI，不碰 V3；commit 显式列路径。

验证：
- 定向测试（白盒 + 红测）-> cargo test --workspace -> test-consumer
  （runtime/config/control/error）-> verify:v4-foundation（10 gates）->
  verify:v4-foundation-red（3 gates）-> appsdk verify --admission v4 ->
  DSH review（opencode-go/deepseek-v4-flash）语义 PASS。

完成标准：
- Relay/Continuation 六面 compat unexplained_diff=0；本 slice 资源 anchored
  且双源一致；所有红测全绿且先红证据在案；verify/workspace/appsdk 全绿；
  DSH review 无 P0/P1 的语义 PASS。

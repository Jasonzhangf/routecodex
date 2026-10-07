# REQ02 资源与 runner 作者纠正

父编排已停止本任务旧resource child（精确PID44489），现有文件完整保留。不是因静默或超时重启：实际代码已经违反锁定合同，不能继续按错误实现推进。你是全新GCM child，不resume旧会话；不是独自工作，gate/carrier/media各有独立owner，不覆盖或回滚他们的变更。

工作树 `/Volumes/Intel/playground/routecodex/dagpipe-req02-resources-20261003`。只写 `operation_runner/mod.rs`、`request_context_store.rs`、`operators/normalize_request_losslessly.rs`、`operators/mod.rs`，及本树 `docs/goals/req02-resource-runner-correction-result-20261003.md`。绝对目录为本树 `v3/crates/routecodex-v3-runtime/src/operation_runner`。其他field模块、graph/profile/maps只读。每个命令显式本workdir，apply_patch绝对路径。

已有独立设计：consumer R2已PASS，公共API沿用已有类型名。直接纠正实现并完成，不重审整链、不重新发明接口。先看这份合同和已写代码；红测已有实际exit101回执，父树 `.execution/resources-r1.jsonl`；不把baseline16项当REQ02红绿。

已证实必须移除的错误：

1. mod.rs 的 `request_normalize_graph_slice_from_sources` 递归包含capture ancestor，违反只消费已capture client-json的REQ02单节点slice。删掉ancestor收集及第二capture路径，直接从主graph取normalize节点，输入ARC为client-json，输出为canonical-request；保留原节点schema/effects并通过SDK compile/Runtime::run。无需重新遍历整张图或造新graph真源。
2. mod.rs 的AlreadyCanonical提前 `execute_with_already_canonical` 直接返回，绕过SDK和同一节点。移除该shortcut/helper；RawEntry与AlreadyCanonical都走同一个真实SDK slice，Operator根据typed invocation origin处理。retry/followup不重新归一且原pair不覆盖；内部不一致组合显式内部错误，不做业务请求语义拒绝。
3. AttemptProjectionContext.contents:Value 与 AttemptDeclarationMap.declarations:Value 是任意payload容器，不是typed声明关联。改为有明确字段的projection/path/provenance与actual tool declaration关联结构；只记录身份、来源/目标路径、编码和实际发出的工具映射引用，不存业务参数、结果、schema或完整provider request。业务值在canonical，控制资源不得镜像payload。类型要可供既有projection/response owner使用，不只为测试造Value。
4. release_request_scope在Mutex poison时直接return造成静默不释放。确保终态始终清理attempt再request并使slots失效；真实内部错误可观测，不能吞错/伪造成功。唯一take_finalizer不可Clone机制保留，handle clone本身不finalize。
5. `rebind_opaque_record_ids` 无必要且只找旧extension，移除事后payload重绑与重复client归一补偿。opaque record ID在同一request handle作用域解释，两请求天然隔离，不要求全局唯一或用requestId重写业务carrier。原pair首次成功成对发布；不把不同RawEntry归一结果与旧pair强行配成一对。修正为测试真实隔离而非额外全局ID格式。
6. 删不用的raw_entry_protocol/helper、重复类型alias及被替代路径。保留真正必须的API；不扩大到Server/kernel/REQ03—09或全局资源中心。

完成实际公开runner测试：RawEntry从已capture值进入SDK获得canonical，retry/followup同SDK得到完整原canonical且pair保持；真实requestId/invocationId/attemptId分离，两请求资源隔离，clone不finalize，guard终态attempt→request，成功attempt不借用失败attempt。测试必须覆盖上述shortcut/recapture修复；源码结构或private事件只能辅助，不能代替公开runner的真实输出/生命周期行为。字段profile缺口可原样报告，但REQ02 runner测试必须选已有可运行Responses请求，不因配置缺口跳过新测试，不改field代码猜测修复。

验证命令单独运行并收真实exit_code：`CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-runtime --lib operation_runner -- --nocapture`；`git diff --check`。如全field suite存在已知配置失败，另以实际新增REQ02测试的精确filter运行且必须PASS，保存完整原错误，不声称全suitePASS。结果文档绑定tree/profile哈希、实际用例数/结果和剩余caller/真实Server依赖。

完成 iff：真实单节点REQ02 SDK入口实现且新增公开runner/typed生命周期用例通过，上述已证实违规物理移除，控制/数据隔离，产物可供父候选组合。不commit/merge/push/install/restart；本子任务不是REQ02生产交付。

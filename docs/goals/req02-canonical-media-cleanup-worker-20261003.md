# REQ02 canonical media 历史图片唯一owner修复

目标：修复已复现的Gemini canonical图片在Chat Process历史清理中未被识别的问题，不改变Inbound输出或扩大图片清理政策。

独占worktree：/Volumes/Intel/playground/routecodex/req02-canonical-media-cleanup-20261003，从本次fetch的origin/main建立。你不是独自工作；另worker负责真实身份资源搬运，另树保留canonical consumer候选，不能覆盖其修改。使用全新codex exec --profile gcm，无resume/fork/父transcript/Collab。

已有依据：父consumer R2设计合同明确清理从Inbound迁至唯一Chat Process点；v3-function-map登记history_image_cleanup.rs为唯一图片清理owner。真实失败见父提供的req02_chat_history_images公开用例和behavior-red日志：SDK发出{"type":"media","media":{"inline_data":"aGVsbG8=","mime_type":"image/png"}}，当前history helper未替换它。这是已证实表示缺口，不是新清理政策。已有canonical consumer/Req04调用候选只读，不改第二调用点。

允许写入：v3/crates/routecodex-v3-runtime/src/hub_v1/history_image_cleanup.rs（只补现有canonical图片表示识别与该文件定向单测）；新增v3/crates/routecodex-v3-server/tests/req02_canonical_media_images.rs；docs/goals/req02-canonical-media-cleanup-result-20261003.md及本任务日志。禁止改operation_runner、field/profile、req_inbound_02、req_chat_process_04、任何runtime factory/caller、Server、Provider、其他共享maps及REQ06。提供的依赖和req02_chat_history_images.rs只读。

实现：先运行公开四协议用例保留真实行为红，再在唯一helper识别明确type=media且media.mime_type为image/*及真实inline_data/file_uri图片carrier。先读SDK实际fileData→canonical输出和既有media契约，按真实表示支持；不得仅因存在mime_type/inline_data就把音频/视频或无类型未知media当图片。当前轮图片、历史音频/视频/未知类型media、工具参数自由文本完整保留。复用现有固定[Image]替换和历史轮选择，不改归一化、不增加协议/model分支、拒绝或fallback。不解析工具参数来判断工具身份。修复必要识别处共享唯一谓词，避免同一语义多套实现。

测试条件：分别执行CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_chat_history_images -- --nocapture（红→绿）；同入口新增req02_canonical_media_images用例覆盖历史inline/file图片、当前图片、历史音频/视频/缺省未知MIME、不相关字段与完整工具输出保持；同命令--test req02_canonical_media_images应exit0；runtime --lib history_image -- --nocapture应exit0；git diff --check exit0。日志独立保存原始退出码，编译红不称行为红，不让后续命令掩盖失败。

完成iff：公开行为红绿闭合，四协议原公开用例和新增负向保留用例均绿，唯一helper最小diff、精确source/test/profile哈希及原始回执写入结果文档，然后退出。无commit/merge/push/install/restart；不动4444。公开harness绿只证明本切片，不能称完整HTTP/WS或真实工具回合PASS。遇必需接口未知先落盘确切缺口继续独立工作，不用宽松断言造绿。

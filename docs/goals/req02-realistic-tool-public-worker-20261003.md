# REQ02 真实工具形状公开consumer补齐

工作树：/Volumes/Intel/playground/routecodex/req02-tool-public-cases-20261003，fresh origin/main 75cab8267，父提供组合候选依赖。你不是独自工作，namespace记录由另一worker修。只能写新server/tests/req02_tool_shapes.rs及本树docs/goals/req02-tool-shapes-result-20261003.md；原测试、所有产品/profile/maps/graph只读。全新GCM，无resume/fork或父transcript。

目标：从外部crate公开capture→SDK normalize→公开typed inverse/history断言真实工具数据与配对；不要调私有helper、mock或源码字符串断言。

用例独立涵盖：1 Responses custom apply_patch的input是完整多行字符串（不是包在对象的free_text），使用真实patch语法及尾部sentinel，custom输出call_id配对；2 单独exec_command的function声明、完整长cmd/workdir字符串，原arguments逐字等价、result与call_id配对；3 单独MCP声明与嵌套业务参数/result值，namespace/name/type与history引用；4 Responses真实namespace声明对象内tools同时含function与custom，至少两个namespace可含同名工具和不同schema；断言原声明及嵌套声明可由公开typed身份/opaque引用定位，历史能对应，不按模型名或参数内容猜身份；5 对应gpt-5.5平面与gpt-5.6 namespace形式分别作为输入数据覆盖，协议结构可参考现有~/code/codex真源（从HOME或实际工具输出派生路径），不跑模型真实调用冒充此测试目的。

测试命令：CARGO_NET_OFFLINE=true node v3/scripts/run-v3-cargo-test.mjs +stable -p routecodex-v3-server --test req02_tool_shapes -- --nocapture。单独git diff --check。原始日志留.execution，准确报告exit与通过/失败；公开行为有缺陷就记录输入、期望、实际、最早偏差，不弱化断言或改产品。不等待其他worker，不重复验证未变输入。

完成iff：有意义的公开测试源码、一次实际回执、source/profile/input hashes与结果文档；行为验收PASS必须真实全部绿，失败如实返父。该测试只证明公开归一化，不能宣称真实HTTP/WS、工具实际执行或节点交付。不commit/merge/push/install/restart；窄任务结束退出。

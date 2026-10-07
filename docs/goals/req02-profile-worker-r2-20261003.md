# REQ02 显式请求字段配置补齐

独占worktree：`/Volumes/Intel/playground/routecodex/dagpipe-req02-profile-20261002`，base3a72ad813，已有38行typed schema候选修改，保留并核实。你不是独自工作，不覆盖别人的修改。仅写field_profiles.v1.yml及本树docs/goals/req02-profile-result-20261003.md；不写主设计、产品Rust、gate代码或其他worktree。每条命令显式workdir/先cd本树；apply_patch绝对路径。Desktop child不执行Collab。禁止resume。

已确认的缺口无需再审计：字段库需要request方向direction_bindings.transform_id；缺配置造成32项中11失败。gate当前错误地将optional(string)当必填，还把某个direction的profile套到所有bindings，且要求一旦出现bindings就四方向全有。这些由父编排修订设计后另派唯一gate owner解决。你不要为这些gate问题反复调试、给leaf伪造transform、添加其他方向绑定或改测试断言。

直接按已读不可变768a9565c的对应row和现有字段库消费接口，逐rowapply_patch补client_request_to_chat显式绑定：OpenAI messages/tools；Anthropic messages/tools/tool_choice；Gemini contents/systemInstruction/tools/toolConfig/generationConfig及role/media实际消费路径。raw source必须在当前inventory存在，destination使用既有chat.messages等以及chat.routecodex_chat_extension，不新设chat.extension。完整字段源值保留，声明operator@version、shape、semantics、transform_id、failure_class；维持唯一consumer与structure_only/parent_owned契约。无需把所有leaf变成容器。

最多只按变更后的本次配置跑一次 `npm run verify:v3-operation-runner-dagpipe` 和一次 `npm run test:v3-operation-runner-red-fixtures`，保留其实际通过/失败；已知schema gate失败允许作为明确待实现依赖落盘，不声称PASS。完成 `git diff --check`，结果文档列出实际增补绑定、来源、尚缺的gate合同以及diff路径。完成iff是显式请求绑定和结果文档都存在，不是再写一份方案。不得commit/install/restart/merge/push。

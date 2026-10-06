# REQ02 最小consumer及配置gate设计准入

- 独立Codex Review：`req02-consumer-design-20261003-r2`，oauth profile，显式gpt-6.1-sol，只读。
- controller：completed/pass，failureClass=null；exit0；findings=[]。
- 候选锚点：b436b68bcad0a809e9722e6fa179ee8ccc414e3c上的设计差异，精确10个设计/map/生成面文件hash见`.execution/consumer-design-r2-inputs.sha256`，收结果时逐项校验全部OK。
- 永久review原文：`req02-consumer-design-review-20261003-r2.json`。
- 已解决R1的P1：Direct factory与kernel.rs实际caller绑定到本feature，错误feature下的本次新增路径移除，入口/Direct worker独占最小参数/handle改动。
- 作者证据：request graph、resource-map、caller-map、正式admission/render、生成面同步、diff-check通过。原effects-only设计PASS不替代本次新增接口准入。

本PASS只准入REQ02增量consumer、request-local typed资源/生命周期、Direct注册hook边界、既有Outbound/response消费及请求方向配置compile合同。profile实际diff、可执行operator/资源实现、真实caller替换、工具回合、候选build/install/restart、实现架构review、merge/push/live与cleanup均未完成，不能继承此PASS为产品交付。

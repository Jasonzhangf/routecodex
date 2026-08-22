# 总纲与闭环合同

## 目标

把所有可影响运行时的变更，统一收口为一个默认完成合同。路由、细节、实现顺序都可以后置，但“什么算做完”必须先定。

## 默认原则

1. 先定总纲，再进路由。先确认目标、边界、验证证据，再决定落点。
2. 先看 function map / mainline call map / verification map / mainline source / wiki，再改实现。必须先定位模块边界、允许路径、禁止路径、主线调用边、required gates 和 review surface。
3. 先找唯一 owner，再改实现。允许路径和禁止路径必须先锁定。
4. 先红后绿。必须先证明当前问题存在，再改唯一真源。
5. 先 build/install，再 live verify。能影响运行时的改动，不能只停在局部测试。
6. 先样本复测，再宣布完成。若存在真实失败样本，必须在线重放同一入口/同一语义样本。
7. 验证结束后必须做架构 review。要判断：
   - 结果是否正确
   - 架构是否正确
   - 是否存在 fallback / 临时绕路 / 补丁式修复 / 错层修复
   - 是否出现“结果对了但实现层错了”的情况
8. 先完整闭环，再扩展细节。完成合同优先，补充优化后置。
9. 数据与控制必须分流。能从原始请求/响应负载直接获得的数据字段，优先且只认原始 payload，不允许从中间上下文、零散传递语义、日志侧写或多次派生中重复获取；`MetadataCenter` 只承载控制语义，不替代原始 payload 的数据真源。

## 默认闭环顺序

```text
问题/需求
  -> 根因与唯一 owner
  -> red test / failing sample
  -> 修改唯一真源
  -> build / necessary compile
  -> global install / managed restart
  -> live health / smoke
  -> exact old-sample replay or same-entry real replay
  -> full gate / broader regression
  -> 记录结论
```

## 证据门槛

- 只做局部测试，不可宣称闭环完成。
- 只做 build/install，不可宣称线上可用。
- 只做 `/health`，不可宣称问题已修复。
- 只做泛化 smoke，不可替代失败样本复测。
- 没有真实证据，必须明确写剩余风险。
- 验证结束但架构 review 不过，也不能宣称完成。

## 路由职责边界

- 总纲文档只定义完成合同，不定义具体模块实现。
- 路由文档只决定去哪里看、去哪里改，不决定什么叫完成。
- Skill 只定义可复用动作序列，不替代总纲证据门槛。

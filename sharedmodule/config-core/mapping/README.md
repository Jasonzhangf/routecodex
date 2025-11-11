# 映射规范（Mapping Spec）

作用：定义从 module.json（系统蓝图）与 config.json（用户声明）到 CanonicalConfig（解释体）的字段级映射、校验与后处理规则。

要点
- 禁止推测与回退：未匹配的字段不处理；缺失必填直接报错。
- 仅允许字段别名规范化（如 baseURL→baseUrl）与结构性默认（数组缺省→[]）。
- perKey 模式下，支持 routing 的“无 key 表示 all-keys”确定性展开。

文件
- mapping-spec.json：规则清单（source→target、策略、约束）


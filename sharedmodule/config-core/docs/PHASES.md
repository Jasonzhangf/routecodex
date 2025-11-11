# 阶段说明与产物

所有阶段产物写入 `config/` 目录（与 merged-config.json 同级），不做脱敏，完整保存字段。

- stage-1.system.parsed.json
  - 内容：module.json 解析+Schema 校验后的对象
- stage-2.user.parsed.json
  - 内容：config.json 解析+Schema 校验后的对象
- stage-3.canonical.json
  - 内容：解释体（providers/keyVault/pipelines/routing/routeMeta/_metadata）
- stage-4.assembler.config.json
  - 内容：pipeline_assembler.config（pipelines/routePools/routeMeta 投影）
- merged-config.json
  - 内容：解释体镜像 + _metadata

错误策略（Fail Fast）
- 缺失必填字段、引用不存在、ID 不规范、类型未注册 → 直接报错
- 禁止任何隐式继承/推测/回退

# config-core 架构总览

## 目标
- 单一路径（V2-only），无推测/无回退。
- 将 module.json（系统蓝图）+ config.json（用户声明）映射为 Canonical 解释体。
- 导出：pipeline_assembler.config 与 merged-config.json。

## 核心产物
- CanonicalConfig（解释体）：
  - providers：规范化 provider 实例
  - keyVault：多 Key 与 OAuth 的统一密钥仓库
  - pipelines[]：显式包含 provider/llmSwitch/compatibility/workflow 与 authRef
  - routing：分类→pipelineId[]
  - routeMeta：id→{ providerId, modelId, keyId? }
- 装配输入：pipeline_assembler.config（pipelines/routePools/routeMeta）

## 阶段
1) 解析+校验 System（Ajv/JSON Schema）
2) 解析+校验 User（Ajv/JSON Schema）
3) 解释体构建（MappingSpec 驱动，User 覆盖 System）
4) perKey 扩展 & routing 展开
5) 导出装配输入与镜像
6) 分阶段产物落盘（默认脱敏）

## 关键规则
- Fail Fast：缺失/冲突→直接报错
- 无家族推测、无 legacy 合成、无密钥继承
- perKey：`<pid>.<mid>` 在 routing 中表示“all keys”；流水线 id 使用 `<pid>.<mid>__<keyId>`


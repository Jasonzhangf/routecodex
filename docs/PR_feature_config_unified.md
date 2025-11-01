# PR: 配置模块统一化（feature/config-unified）

## 概述
将配置能力统一迁移到 sharedmodule 独立编译/发布的“统一配置模块”，彻底消除重复实现与分散解析；对齐 CCR 的“预算/路由”思路，落地配置驱动的上下文载荷预算（含安全预留）。

## 变更摘要（本批次）
- 配置驱动的上下文预算（contextBudget）：
  - 模型级：`config/config.json -> virtualrouter.providers.*.models[modelId].maxContext`
  - 模块默认：`config/modules.json -> modules.virtualrouter.config.contextBudget.{defaultMaxContextBytes,safetyRatio}`
  - 环境覆盖：`ROUTECODEX_CONTEXT_BUDGET_BYTES` / `RCC_CONTEXT_BUDGET_BYTES`；`RCC_CONTEXT_BUDGET_SAFETY`
- llmswitch-core 唯一入口执行预算约束：
  - 对 role='tool' 做“分层裁剪”（最近 3 条/历史/最小），统一标注截断
  - 保留历史与角色，不回灌到 assistant 文本；assistant+tool_calls 的空字符串 → null
- 新增文档：`docs/chat-glm-500-analysis.md`（记录 500 根因、CCR 对齐方案与 curl 验证）
- 版本：root 0.74.13（已构建并全局安装）

## 分阶段计划
1) Phase 0（已完成）
   - 建分支 feature/config-unified；打 tag：`ccr-tooling-align`
   - 配置驱动预算 & 唯一入口执行；curl 回放验证
2) Phase 1（进行中）
   - sharedmodule/config-unified 门面：load/get/watch/validate/sourceOf
   - enhanced-path-resolver：统一路径解析（家目录/项目根/包根）
   - 将 llmswitch-core 的 payload 预算解析切换为门面（暂时保留兼容）
3) Phase 2
   - server/pipeline/provider 等模块仅通过门面拿配置；移除直接读文件/解析 env
   - /config 输出脱敏（apiKey/token/password/Authorization 遮蔽）
4) Phase 3
   - 将 llmswitch-conversion-router 的 baseDir/profilesPath 解析改为 enhanced-path-resolver；删除重复扫描逻辑
5) Phase 4（可选增强）
   - 引入 token 级预算（tiktoken）；配置化的“长上下文/背景/think 模型”选择策略（CCR 同源）
6) Phase 5
   - 清理旧配置工具与重复代码；补测与迁移指南

## 验证与度量
- curl 回放最近 10 条样本（Chat/Responses）：
  - provider-request 不再出现巨量工具文本；截断标识出现；assistant+tool_calls content 为 null
  - 无上游 500；SSE 正常闭合
- /config 与 /health 输出配置与状态（敏感字段脱敏）
- 预算来源可审计（source: env|merged|config.json|modules.json|default）

## 风险与回滚
- 风险：
  - 双入口/多缓存造成行为漂移 → 通过门面唯一入口与 grep 校验规避
  - 热更引发竞态 → watch 回调幂等与可取消
- 回滚：
  - 保留兼容层开关（短期），容许关停统一预算执行；必要时快速回退到上一标签 `ccr-tooling-align`

## 构建顺序与要求
- 涉及 sharedmodule 改动必须：先编译共享模块，再编译根包并全局安装
- CI 中按上述顺序执行；安装完成用 `routecodex --version` 校验

## 关联
- Tag: `ccr-tooling-align`
- 文档：`docs/chat-glm-500-analysis.md`

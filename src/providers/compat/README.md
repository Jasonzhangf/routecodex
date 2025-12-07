# Compatibility 层

## 职责
- 只做 Provider 最小字段映射、黑名单处理；reasoning/tool 清理由 Hub Pipeline 统一完成。
- 配置驱动：字段映射、shape filter、response blacklist 均来自 JSON 配置。
- 工具治理、arguments 修复、文本收割全部由 Hub Pipeline 负责。

## 结构
```
src/providers/compat/
├── base-compatibility.ts            # 抽象基类
├── compat-directory-loader.ts       # 根据 providerType 加载兼容目录
├── glm/、iflow/、qwen/、lmstudio/…   # provider 专属 hook + 配置
├── filters/                         # blacklist / shape filter
├── config/                          # 兼容层配置加载
└── utils/                           # snapshot writer 等工具
```

## Hook/Filter
- `hooks/*.ts`：请求/响应验证、工具清洗（仅最小字段层面）。
- `filters/*.ts`：基于 JSON 的字段黑名单。
- `field-mapping/*.ts`：字段映射器，处理 usage/input_tokens 等差异。

## Do / Don't
**Do**
- 按配置删除不被 provider 接受的字段。
- 统一字段名称与结构（如 GLM usage.input_tokens ↔ prompt_tokens）。
- 在响应侧补齐 provider 要求的缺省值（role、finish_reason）。

**Don't**
- 不解析/修复 tool_calls arguments。
- 不注入兜底文本或工具。
- 不进行路由或 provider 选择。

## 调试
- 快照节点 `compatibility.request.post` / `compatibility.response.post` 可查看兼容层产物。
- 可以通过 `src/debug/harnesses/provider-harness.ts` 调 dry-run。

## 贡献
- 新增 provider 兼容层时需提供 JSON 配置 + Hook，并在 `compatibility-manager.ts` 注册。
- 所有兼容逻辑需遵守最小原则，避免与 Hub Pipeline 重复。

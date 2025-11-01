# ⚠️ Provider V1 - 已弃用 (DEPRECATED)

> **重要提示**: 此Provider V1实现已正式弃用，仅作为备份保存。
>
> 📅 **弃用日期**: 2025-11-01
> 🔄 **推荐替代**: Provider V2 (`../v2/`)

## 🚨 弃用原因

Provider V1存在以下问题，已被新的Provider V2架构替代：

1. **架构复杂性**: 文件数量多，结构不够模块化
2. **维护困难**: 缺乏统一的接口和标准化的实现
3. **功能重复**: 多个provider实现存在大量重复代码
4. **扩展性差**: 难以添加新的provider支持
5. **类型安全不足**: 缺乏完整的TypeScript类型定义

## 📁 文件结构

```
legacy/
├── README.md                       # 本文件 - 弃用说明
├── README-V1-ARCHIVE.md            # V1完整文档（存档）
├── generic-http-provider.ts        # 通用HTTP Provider (已弃用)
├── generic-openai-provider.ts      # 通用OpenAI Provider (已弃用)
├── generic-responses.ts            # 通用响应处理 (已弃用)
├── GLM_COMPATIBILITY.md            # GLM兼容性文档 (已弃用)
├── glm-http-provider.ts            # GLM HTTP Provider (已弃用)
├── iflow-oauth.ts                  # iFlow OAuth (已弃用)
├── iflow-provider.ts               # iFlow Provider (已弃用)
├── lmstudio-provider-simple.ts     # LM Studio Provider (已弃用)
├── openai-provider.ts              # OpenAI Provider (已弃用)
├── qwen-oauth.ts                   # Qwen OAuth (已弃用)
├── qwen-provider.ts                # Qwen Provider (已弃用)
└── shared/                          # 共享组件 (已弃用)
    ├── http-client.ts
    ├── oauth-utils.ts
    └── provider-base.ts
```

## 🔄 迁移指南

### 如何从V1迁移到V2

1. **更新导入路径**:
   ```typescript
   // 旧方式 (已弃用)
   import { OpenAIProvider } from '../provider/openai-provider.js';
   import { LMStudioProviderSimple } from '../provider/lmstudio-provider-simple.js';

   // 新方式 (推荐)
   import { OpenAIStandard } from '../provider/v2/core/openai-standard.js';
   import { LMStudioProvider } from '../provider/v2/core/lmstudio-provider.js';
   ```

2. **配置更新**:
   ```typescript
   // V1配置 (已弃用)
   const providerConfig = {
     type: 'openai-provider',
     config: {
       auth: {
         type: 'apikey',
         apiKey: 'xxx'
       },
       baseUrl: 'https://api.openai.com'
     }
   };

   // V2配置 (推荐)
   const providerConfig = {
     type: 'openai-standard',
     config: {
       auth: {
         type: 'apikey',
         apiKey: 'xxx'
       },
       overrides: {
         baseUrl: 'https://api.openai.com'
       }
     }
   };
   ```

3. **初始化方式**:
   ```typescript
   // V1方式 (已弃用)
   const provider = new OpenAIProvider(config, dependencies);

   // V2方式 (推荐)
   const provider = new OpenAIStandard(config, dependencies);
   ```

## ⚡ Provider V2优势

Provider V2相比V1具有以下优势：

- ✅ **统一架构**: 所有provider使用统一的基础架构
- ✅ **模块化设计**: 按功能模块组织，易于维护和扩展
- ✅ **类型安全**: 完整的TypeScript类型定义
- ✅ **配置驱动**: 灵活的配置系统
- ✅ **Hook系统**: 集成的Hook调试和扩展系统
- ✅ **更好的错误处理**: 统一的错误处理机制
- ✅ **性能优化**: 优化的HTTP客户端和连接管理

## 📋 迁移对照表

| V1 Provider | V2 Provider | 状态 |
|------------|-------------|------|
| `openai-provider.ts` | `v2/core/openai-standard.ts` | ✅ 完全兼容 |
| `lmstudio-provider-simple.ts` | `v2/core/lmstudio-provider.ts` | ✅ 完全兼容 |
| `qwen-provider.ts` | `v2/core/qwen-provider.ts` | ✅ 完全兼容 |
| `glm-http-provider.ts` | `v2/core/glm-provider.ts` | ✅ 完全兼容 |
| `iflow-provider.ts` | `v2/core/iflow-provider.ts` | ✅ 完全兼容 |
| `generic-responses.ts` | `v2/responses-provider.ts` | ✅ 完全兼容 |

## 📋 迁移检查清单

在迁移到Provider V2时，请确认以下项目：

- [ ] 更新provider导入路径
- [ ] 调整配置格式（config → config.config + config.overrides）
- [ ] 更新初始化代码
- [ ] 测试所有API调用
- [ ] 验证错误处理
- [ ] 检查性能表现
- [ ] 更新相关文档

## 🔗 相关链接

- **Provider V2文档**: `../v2/README.md`
- **V1完整文档**: `README-V1-ARCHIVE.md` (历史参考)
- **迁移指南**: `../../docs/provider-migration.md`
- **架构设计**: `../../docs/provider-architecture.md`

## ⚠️ 重要提醒

- **不要**在新项目中使用Provider V1
- **建议**现有项目尽快迁移到Provider V2
- **备份**: 此代码仅作为历史备份保存，不建议修改
- **支持**: Provider V1不再接收功能更新和bug修复
- **兼容性**: V1配置可能与V2不完全兼容，需要调整

## 📖 历史文档

如需查看Provider V1的完整技术文档，请参考：**[README-V1-ARCHIVE.md](./README-V1-ARCHIVE.md)**

该文档包含了V1版本的：
- 完整的API文档
- 配置说明
- 使用示例
- 架构设计
- 调试指南

---

*最后更新: 2025-11-01*
*状态: ⚠️ 已弃用 - 仅作备份用途*
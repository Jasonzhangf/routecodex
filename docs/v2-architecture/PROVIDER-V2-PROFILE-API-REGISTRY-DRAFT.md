# Provider V2 Profile API 与 Registry 机制（Draft）

- Status: Draft
- Date: 2026-02-09
- Owner: routecodex-113.3
- Strategy: 先实现各层模块，不连线；按 Wave 批次接线

## 1. 目标与输入约束

本草案定义 Provider 分层中 `Profile` 的抽象契约与注册解析机制，遵循已确认决策：

- 配置显式字段 `providerProtocol + providerId + compatibilityProfile` 决定协议、品牌分支与 compat。
- `providerId / providerFamily` 单一事实来源来自“配置文件 + provider 目录映射”。
- Gemini CLI 长期作为 Gemini 协议变体。

## 2. 当前代码的结构约束（作为设计边界）

- 已存在声明式 profile 输入：`src/providers/profile/provider-profile.ts`。
- 已存在配置装载器：`src/providers/profile/provider-profile-loader.ts`。
- 已存在 runtime metadata 承载 `providerProtocol/providerFamily/compatibilityProfile`：`src/providers/core/runtime/provider-runtime-metadata.ts`。
- 当前 transport 内仍有大量品牌分支（iflow/antigravity 等），需要迁移到 family profile：`src/providers/core/runtime/http-transport-provider.ts`、`src/providers/core/runtime/http-request-executor.ts`。

## 3. 抽象契约（API 草案）

> 下列接口为目标 API；本阶段只定义，不替换现网调用。

### 3.1 标识与解析结果

```ts
type ProtocolId =
  | 'openai-chat'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'gemini-chat';

interface ProviderDirectoryEntry {
  providerId: string;
  providerFamily: string;
  allowedProtocols: ProtocolId[];
  defaultModuleType?: string;
  defaultProfileId: string;
}

interface ResolvedProviderBinding {
  providerId: string;
  providerFamily: string;
  providerProtocol: ProtocolId;
  profileId: string;
  compatibilityProfile: string;
  moduleType?: string;
}
```

### 3.2 Profile 能力接口

```ts
interface RequestPolicyInput {
  endpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  runtime: ProviderRuntimeMetadata;
}

interface ResponsePolicyInput {
  response: unknown;
  runtime: ProviderRuntimeMetadata;
}

interface ErrorPolicyInput {
  error: unknown;
  runtime: ProviderRuntimeMetadata;
}

interface ProviderFamilyProfile {
  id: string;            // e.g. 'iflow/default'
  providerFamily: string;

  applyRequestPolicy?(input: RequestPolicyInput): RequestPolicyInput;
  applyResponsePolicy?(input: ResponsePolicyInput): ResponsePolicyInput;
  mapError?(input: ErrorPolicyInput): ProviderErrorAugmented;
}
```

### 3.3 Registry 契约

```ts
interface ProviderProfileRegistry {
  register(entry: ProviderDirectoryEntry, profile: ProviderFamilyProfile): void;
  resolve(binding: {
    providerProtocol: string;
    providerId: string;
    compatibilityProfile: string;
    moduleType?: string;
  }): ResolvedProviderBinding;
  getProfile(profileId: string): ProviderFamilyProfile;
}
```

## 4. 解析顺序（已定稿）

解析顺序必须固定并可审计：

1. 读取配置中的 `providerProtocol`，映射到唯一 `ProtocolId`。
2. 读取配置中的 `providerId`，通过 provider-directory 映射得到 `providerFamily` 与 `defaultProfileId`。
3. 读取配置中的 `compatibilityProfile`，写入 `ResolvedProviderBinding`（供 llmswitch-core compat 阶段使用）。
4. 若任一字段缺失/非法/冲突，直接 fail-fast。

### 4.1 重要边界

- Provider 层只“解析并透传” `compatibilityProfile`，不在 transport 内执行 compat 语义。
- compat 的实际转换仍由 llmswitch-core 负责（保持 AGENTS 既有边界）。

## 5. Protocol 与 Profile 的交互边界

### 5.1 Protocol 层负责

- wire shape（endpoint/body/stream）
- 协议级 response parse
- 协议字段合法性

### 5.2 Family Profile 层负责

- 品牌级 header 策略（UA、签名、清理）
- 品牌级 request 微调（字段注入/裁剪）
- 品牌级 error envelope 映射

### 5.3 明确禁止

- Profile 禁止发 HTTP、禁止路由决策、禁止工具语义改写。
- Protocol 禁止品牌识别分支。

## 6. 向后兼容策略（迁移期间）

### 6.1 Legacy 兼容输入

现有配置仍可能仅给 `providerType/type`（无显式 `providerProtocol`）。迁移期策略：

1. 在配置加载阶段做一次性 legacy 归一（alias -> protocol/providerId）。
2. 归一后输出“显式三元组”：`providerProtocol + providerId + compatibilityProfile`。
3. 运行时仅消费归一结果，不再做二次猜测。

### 6.2 兼容期约束

- 兼容归一逻辑只存在于配置加载层（single source of truth）。
- Provider runtime / transport 中不得新增 legacy 推断。

## 7. 最小可行目录结构（MVP）

```text
src/providers/
  profile/
    provider-directory.ts            # providerId -> providerFamily/protocol constraints
    profile-contracts.ts             # ProviderFamilyProfile interfaces
    profile-registry.ts              # register/resolve/getProfile
    families/
      iflow/default-profile.ts
      antigravity/default-profile.ts
      qwen/default-profile.ts
      gemini/default-profile.ts
  core/
    protocols/
      openai-chat/adapter.ts
      openai-responses/adapter.ts
      anthropic-messages/adapter.ts
      gemini-chat/adapter.ts
```

## 8. 先实现不连线：可执行落地清单

### Step A（仅实现）

- 新增 `provider-directory.ts` + `profile-registry.ts`。
- 新增 `profile-contracts.ts`。
- 为 iflow/antigravity 提供最小 default profile（空实现 + 单测）。

### Step B（仅验证）

- 增加 registry 解析测试：字段缺失/冲突/非法协议 fail-fast。
- 增加 profile policy 单测：请求头策略和错误映射逻辑纯函数测试。

### Step C（仍不连线）

- 在 factory/transport 增加“旁路可调用”探针（仅日志/快照，不接入主执行流）。

## 9. 风险与防护

1. **风险：Registry 成为第二个 factory**
   - 防护：registry 只做解析，不做实例化。
2. **风险：compat 再次下沉到 provider**
   - 防护：compatibilityProfile 仅透传，不在 profile 中执行。
3. **风险：legacy 兼容逻辑散落**
   - 防护：只允许配置加载层存在 alias 归一。

## 10. 113.3 验收对应关系

- Profile 接口：见第 3 节。
- Protocol/Profile 边界：见第 5 节。
- 向后兼容：见第 6 节。
- 最小目录结构：见第 7 节。


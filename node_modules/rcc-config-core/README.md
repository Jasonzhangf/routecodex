# config-core（V2 配置解释体引擎）

目标：提供单一路径、无推测与无回退的配置解析引擎。把系统蓝图（module.json）与用户配置（config.json）映射为唯一“解释体”（CanonicalConfig），并导出装配输入（pipeline_assembler.config）与最终镜像（merged-config.json）。

要点
- 单一路径：仅支持 V2 新格式，不兼容 legacy 自动合成与家族推断。
- Fail Fast：缺失/冲突即报错；仅允许结构性默认（如 routing.* 缺省→[]），不做语义猜测。
- 多 Key 与 OAuth：统一 keyVault + authRef 绑定；支持 apikey 与 oauth。
- perKey 路由规则：在 perKey 模式下，routing 中不带 key 的 `<pid>.<mid>` 表示“该 provider 的所有启用 key”。
- 全阶段落盘：所有阶段产物写入 `config/`，与 `merged-config.json` 同级（不做脱敏，完整保留字段）。

阶段产物（均写入 `config/`）
- stage-1.system.parsed.json：系统蓝图解析+校验
- stage-2.user.parsed.json：用户配置解析+校验
- stage-3.canonical.json：解释体（providers/keyVault/pipelines/routing/routeMeta）
- stage-4.assembler.config.json：装配输入（pipelines/routePools/routeMeta）
- merged-config.json：解释体镜像 + `_metadata`

接口（规划）
- loadSystemConfig(path): 解析+校验 module.json（JSON Schema/Ajv）
- loadUserConfig(path): 解析+校验 config.json（JSON Schema/Ajv）
- buildCanonical({ system, user, options }): 生成解释体（含 perKey 扩展与 routing 展开）
- exportAssemblerConfig(canonical): 产出 pipeline_assembler.config
- writeArtifacts(): 将各阶段产物落盘（不做脱敏）

非目标
- 不进行 provider 家族/模型名推测（如 glm→openai）。
- 不进行密钥隐式继承/猜测（仅用户显式配置）。
- 不从 legacy 结构自动合成 pipelines。

目录
- schema/：User/System/Canonical JSON Schema 草案
- mapping/：映射规范（source→target 规则与校验约束）
- docs/：阶段说明、perKey 路由规则等
- interpreter/、exporters/：实现落点（后续补充，不在本次提交中实现）

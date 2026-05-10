# Goal: deepseek-web provider 工具调用能力对齐（基于 ds2api）

## 索引概要
- L1-L8 `scope`: 目标范围与验收标准
- L10-L30 `implemented`: 已实现修改点
- L32-L48 `verification`: 验证方法
- L50-L63 `remaining`: 当前剩余缺口

## 目标
参考 `../ds2api`，补齐 `deepseek-web` provider 的完整工具调用能力：
- 工具引导注入
- 响应收割
- 文件上传 ready 等待
- `web_search` / `multimodal` live 路由闭环

## 验收标准
1. `docs/design/deepseek-web-ds2api-toolcalling-alignment.md` 存在且内容完整
2. 本文件存在，描述真源修改点、测试方法、验收标准
3. `web_search` live smoke 命中：
   - `web_search/... -> deepseek-web.*.deepseek-v4-flash-search`
4. `multimodal` live smoke 命中：
   - `multimodal/... -> deepseek-web.*.deepseek-v4-vision`
5. 图片请求不再报：
   - `invalid ref file id`
   - `view_image requires input.path`
6. 不引入 fallback / 静默失败

## 已实现修改点

### Rust 真源
- `features/tools.rs`
  - `detect_web_search_tool_declared()` 已识别：
    - `type=web_search_preview`
    - `type=websearch_preview`
    - `type=web_search`
    - `type=websearch`
- `routing/config.rs`
  - `build_route_queue()` 在 `has_web_search_tool_declared=true` 时前置 `web_search`
- `engine/selection.rs`
  - `web_search_route_requested` 改为同时接受 `features.has_web_search_tool_declared`
- `provider_bootstrap.rs`
  - `normalize_model_capabilities()` 把父 model capability 传播到 aliases

### TypeScript provider runtime
- `src/providers/core/runtime/deepseek-http-provider.ts`
  - `uploadContextArtifactsIfNeeded()` 统一处理 context file + inline image
- `src/providers/core/runtime/deepseek-file-upload.ts`
  - inline image 上传后追加 `fetch_files` ready 检查

## 验证方法
- 本地独立端口：`5555`
- health:
  - `curl http://127.0.0.1:5555/health`
- web_search smoke:
  - `tools=[{type:\"web_search_preview\"}]`
- multimodal smoke:
  - `input_image=data:image/png;base64,...`
- 日志文件：
  - `~/.rcc/logs/server-5555.log`

## 当前剩余缺口
1. `web_search` 仍落到 `thinking -> deepseek-v4-pro`
2. 说明 `request.tools` 在进入 Rust VR 前仍有 shape 丢失或未落到 `build_routing_features()`
3. `multimodal` 还没在 5555 完成最终 live 复测

## 真源唯一性声明
- `web_search` 首轮失效的唯一真源仍在 Rust VR 请求特征链，不在 compat 结果面
- `invalid ref file id` 的唯一真源在 provider upload ready 链，不在 router / compat

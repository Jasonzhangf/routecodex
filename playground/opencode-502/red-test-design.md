# 保真红测设计（正式修复前先红后绿）

目标不变量：请求链、continuation save/restore、provider-bound payload
不得把图片替换为 `[Image]`、不得删除图片载体、不得把含图片的工具输出
改写为占位文本；只允许真实协议转换。

## 正向红测（当前应红）

1. `responses_history_image_preserved_through_req_inbound`
   - Responses `input[]` 含历史 `input_image` / `function_call_output` 图片，
     过 `build_v3_hub_req_inbound_02_from_v3_hub_req_inbound_01` 后图片
     part 类型、URL/data/file_id 与原请求逐字节等价。
2. `chat_history_image_preserved_through_direct_standardized`
   - chat direct `build_v3_chat_req_04_standardized_from_v3_server_03`
     后历史 `image_url` part 保持不变。
3. `relay_restored_context_preserves_images`
   - Req04 恢复 local context 后，历史图片仍保留，不做占位/清理。
4. `resp04_continuation_context_preserves_images`
   - Resp04 local continuation save 保留工具输出/历史图片。
5. `route_facts_read_images_without_mutating_payload`
   - `build_v3_router_request_facts_for_entry` 输入 JSON 不被 clone 后
     cleanup；当前轮图片仍贡献 multimodal，历史图片不贡献 multimodal。

## 反向红测（防止复活）

1. 任意请求/continuation 路径重新出现
   `normalize_v3_history_image_placeholders` /
   `normalize_v3_all_images_to_placeholder` 调用必须编译/静态 gate 红。
2. 删除/截断/替换图片载体后仍通过保真测试必须红。
3. 路由事实为路由判定修改 payload 必须红。
4. 不可变区间重新出现图片清理/历史语义操作必须红。

## 验证栈

- `cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-runtime --lib history_image_preserved_`
- `npm run verify:responses-continuation-immutable-boundary`
- `npm run test:responses-continuation-immutable-boundary-red-fixtures`
- 相关 `test:v3-*` 和 `verify:v3-architecture-ci`
- 全局安装后同入口真实样本 replay

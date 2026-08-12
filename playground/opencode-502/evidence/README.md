# Evidence

## request-114325523-753225-4304

来源：`~/.rcc/codex-samples/openai-responses/ports/10000/`
`openai-responses-router-gpt-5.5-20260812T114325523-753225-4304/`。

对照：

- `request.json`：660,691 bytes，66 个 `[Image]`，21 个含 `data:image` 字符串
- `provider-request.json`：607,378 bytes，51 个 `[Image]`，7 个含
  `data:image` 字符串

该样本证明 provider-bound 请求与客户端请求不一致，图片载体内容被改写。
原始 502 request id：
`openai-responses-router-gpt-5.5-20260812T102147963-751892-2971`；该样本在
retention 轮换中已被删除，正式修复后需重新采集同入口 502 样本 replay。

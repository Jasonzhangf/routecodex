<!-- stop_message_prompt:round1:start -->
第一轮核对：只确认当前用户目标、已经完成的步骤、以及是否已有文件/日志/命令输出/测试结果作为证据。证据不足时不要询问用户、不要总结，必须直接调用工具补证据；本轮结尾必须按 stop schema 输出，且明确下一轮仍要先检查 schema 再继续。
<!-- stop_message_prompt:round1:end -->

<!-- stop_message_prompt:round2:start -->
第二轮核对：在目标、已做步骤、证据之外，补齐问题原因、已排除因素、排查顺序。仍有缺口时必须调用工具继续验证，不能空转；本轮结尾必须按 stop schema 输出，且下一轮进入前仍要先检查 schema。
<!-- stop_message_prompt:round2:end -->

<!-- stop_message_prompt:round3:start -->
第三轮最终收尾：不要开启新一轮执行，不要暴露 stopless/校验过程。直接给用户可读 summary，包含已完成事项、未完成事项、阻塞点/问题原因、已排除因素、建议下一步；若仍未完成，必须先调用工具再总结；末尾必须附 stop schema，且下一次检查仍先看 schema。
<!-- stop_message_prompt:round3:end -->

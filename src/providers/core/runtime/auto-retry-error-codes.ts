/**
 * Auto-Retry Error Codes
 *
 * 全局统一的 provider 自动重试错误码方案。
 * 所有错误码使用 XXXX.YYYY 格式：
 *   XXXX = HTTP 状态码（或 0 = 非 HTTP 层错误）
 *   YYYY = 子编号，按错误语义细分
 *
 * 命名风格：AUTO_RETRY_<CATEGORY>_<NAME>
 */

// ===== HTTP 4xx =====
export const AUTO_RETRY_429_SHORT_LIVED = '429.1000';    // 短期 Rate Limit（可重试）
export const AUTO_RETRY_429_DAILY_LIMIT = '429.2000';    // 日额度耗尽（不可重试）
export const AUTO_RETRY_429_SATURATED = '429.3000';      // 流量饱和（PROVIDER_TRAFFIC_SATURATED）
export const AUTO_RETRY_408_TIMEOUT = '408.1000';        // 请求超时
export const AUTO_RETRY_425_TOO_EARLY = '425.1000';      // Too Early

// ===== HTTP 5xx =====
export const AUTO_RETRY_500_INTERNAL = '500.1000';       // Internal Server Error
export const AUTO_RETRY_502_BAD_GATEWAY = '502.1000';    // Bad Gateway
export const AUTO_RETRY_503_UNAVAILABLE = '503.1000';    // Service Unavailable
export const AUTO_RETRY_504_GATEWAY_TIMEOUT = '504.1000';// Gateway Timeout
export const AUTO_RETRY_520_UNKNOWN = '520.1000';        // Cloudflare / upstream unknown error

// ===== 网络层错误 (0.xxxx) =====
export const AUTO_RETRY_NET_CONNECT = '0.1000';           // 连接失败 ECONNRESET / ECONNREFUSED / EHOSTUNREACH / ENOTFOUND
export const AUTO_RETRY_NET_TIMEOUT = '0.2000';           // 网络超时 ETIMEDOUT
export const AUTO_RETRY_NET_PIPE = '0.3000';              // 管道断开 EPIPE
export const AUTO_RETRY_NET_DNS = '0.4000';               // DNS 解析失败 EAI_AGAIN
export const AUTO_RETRY_NET_ABORT = '0.5000';             // AbortError（非客户端主动取消）
export const AUTO_RETRY_NET_CANCEL = '0.6000';            // HTTP2 流取消 ERR_HTTP2_STREAM_CANCEL

// ===== 协议层错误 (0.7xxx) =====
export const AUTO_RETRY_PROTO_SSE_DECODE = '0.7100';      // SSE 解码失败
export const AUTO_RETRY_PROTO_EMPTY_RESPONSE = '0.7200';  // 上游返回空响应
export const AUTO_RETRY_PROTO_SSE_TO_JSON = '0.7300';     // SSE → JSON 转换失败

// ===== 上游业务错误 (upstream.xxxx) =====
export const AUTO_RETRY_UPSTREAM_GLM_514 = '0.8000';      // GLM 业务错误 514（可重试）
export const AUTO_RETRY_UPSTREAM_STATUS_1000 = '0.8100';  // 上游状态码 1000
export const AUTO_RETRY_UPSTREAM_STATUS_2056 = '0.8200';  // 上游状态码 2056（用量超限）

/**
 * 所有错误码的归一路径集合，用于验证配置合法性
 */
export const ALL_AUTO_RETRY_CODES = new Set<string>([
  AUTO_RETRY_429_SHORT_LIVED,
  AUTO_RETRY_429_DAILY_LIMIT,
  AUTO_RETRY_429_SATURATED,
  AUTO_RETRY_408_TIMEOUT,
  AUTO_RETRY_425_TOO_EARLY,
  AUTO_RETRY_500_INTERNAL,
  AUTO_RETRY_502_BAD_GATEWAY,
  AUTO_RETRY_503_UNAVAILABLE,
  AUTO_RETRY_504_GATEWAY_TIMEOUT,
  AUTO_RETRY_520_UNKNOWN,
  AUTO_RETRY_NET_CONNECT,
  AUTO_RETRY_NET_TIMEOUT,
  AUTO_RETRY_NET_PIPE,
  AUTO_RETRY_NET_DNS,
  AUTO_RETRY_NET_ABORT,
  AUTO_RETRY_NET_CANCEL,
  AUTO_RETRY_PROTO_SSE_DECODE,
  AUTO_RETRY_PROTO_EMPTY_RESPONSE,
  AUTO_RETRY_PROTO_SSE_TO_JSON,
  AUTO_RETRY_UPSTREAM_GLM_514,
  AUTO_RETRY_UPSTREAM_STATUS_1000,
  AUTO_RETRY_UPSTREAM_STATUS_2056,
]);

/**
 * 根据 error 对象解析出对应的统一自动重试错误码
 *
 * 匹配优先级：
 *   1. upstreamCode / error.code 精确匹配已知错误码
 *   2. statusCode + message 特征匹配
 *   3. 网络/协议层模式匹配
 *   4. 无匹配 → undefined（不参与自动重试）
 */
export function resolveAutoRetryErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  const err = error as Record<string, unknown>;
  const statusCode = typeof err.statusCode === 'number' ? err.statusCode : undefined;
  const code = typeof err.code === 'string' ? err.code.trim().toUpperCase() : undefined;
  const upstreamCode = typeof err.upstreamCode === 'string' ? err.upstreamCode.trim().toUpperCase() : undefined;
  const message = typeof err.message === 'string' ? err.message.trim().toLowerCase() : '';
  const name = typeof err.name === 'string' ? err.name.trim() : '';

  // --- 1. 精确错误码匹配 ---

  // ERR_HTTP2_STREAM_CANCEL
  if (code === 'ERR_HTTP2_STREAM_CANCEL' || upstreamCode === 'ERR_HTTP2_STREAM_CANCEL') {
    return AUTO_RETRY_NET_CANCEL;
  }

  // PROVIDER_TRAFFIC_SATURATED
  if (code === 'PROVIDER_TRAFFIC_SATURATED' || upstreamCode === 'PROVIDER_TRAFFIC_SATURATED') {
    return AUTO_RETRY_429_SATURATED;
  }

  // GLM 514
  if (
    code === '514'
    || upstreamCode === '514'
    || message.includes('glm business error (514)')
  ) {
    return AUTO_RETRY_UPSTREAM_GLM_514;
  }

  // 上游状态码 1000 / 2056（泛化匹配 PROVIDER_STATUS_NNNN）
  if (upstreamCode === 'PROVIDER_STATUS_1000' || code === 'PROVIDER_STATUS_1000') {
    return AUTO_RETRY_UPSTREAM_STATUS_1000;
  }
  if (upstreamCode === 'PROVIDER_STATUS_2056' || code === 'PROVIDER_STATUS_2056') {
    return AUTO_RETRY_UPSTREAM_STATUS_2056;
  }

  // SSE decode error
  if (
    code === 'SSE_DECODE_ERROR'
    || upstreamCode === 'SSE_DECODE_ERROR'
    || message.includes('sse decode error')
  ) {
    return AUTO_RETRY_PROTO_SSE_DECODE;
  }

  // SSE → JSON error
  if (
    code === 'SSE_TO_JSON_ERROR'
    || upstreamCode === 'SSE_TO_JSON_ERROR'
  ) {
    return AUTO_RETRY_PROTO_SSE_TO_JSON;
  }

  // Upstream empty output
  if (
    code === 'UPSTREAM_EMPTY_OUTPUT'
    || upstreamCode === 'UPSTREAM_EMPTY_OUTPUT'
  ) {
    return AUTO_RETRY_PROTO_EMPTY_RESPONSE;
  }

  // HTTP 429 variants
  if (
    code === 'HTTP_429'
    || upstreamCode === 'HTTP_429'
    || statusCode === 429
  ) {
    // 根据 message 区分日额度 vs 短期
    if (
      message.includes('daily') ||
      message.includes('insufficient_quota') ||
      message.includes('quota exceeded')
    ) {
      return AUTO_RETRY_429_DAILY_LIMIT;
    }
    return AUTO_RETRY_429_SHORT_LIVED;
  }

  // HTTP 408
  if (code === 'HTTP_408' || upstreamCode === 'HTTP_408' || statusCode === 408) {
    return AUTO_RETRY_408_TIMEOUT;
  }

  // HTTP 425
  if (code === 'HTTP_425' || upstreamCode === 'HTTP_425' || statusCode === 425) {
    return AUTO_RETRY_425_TOO_EARLY;
  }

  // HTTP 5xx
  if (statusCode === 500 || code === 'HTTP_500' || upstreamCode === 'HTTP_500') {
    return AUTO_RETRY_500_INTERNAL;
  }
  if (statusCode === 502 || code === 'HTTP_502' || upstreamCode === 'HTTP_502') {
    return AUTO_RETRY_502_BAD_GATEWAY;
  }
  if (statusCode === 503 || code === 'HTTP_503' || upstreamCode === 'HTTP_503') {
    return AUTO_RETRY_503_UNAVAILABLE;
  }
  if (statusCode === 504 || code === 'HTTP_504' || upstreamCode === 'HTTP_504') {
    return AUTO_RETRY_504_GATEWAY_TIMEOUT;
  }
  if (statusCode === 520 || code === 'HTTP_520' || upstreamCode === 'HTTP_520') {
    return AUTO_RETRY_520_UNKNOWN;
  }

  // --- 2. 网络层特征匹配 ---

  // AbortError (非客户端主动取消)
  if (name === 'AbortError' || message.includes('operation was aborted')) {
    if (
      message.includes('client_request_aborted') ||
      message.includes('client_response_closed') ||
      message.includes('client_timeout_hint_expired')
    ) {
      // 这些是客户端主动取消，不可自动重试
      return undefined;
    }
    return AUTO_RETRY_NET_ABORT;
  }

  // 连接错误
  if (
    code &&
    ['ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED'].includes(code)
  ) {
    if (code === 'ETIMEDOUT' || code === 'EAI_AGAIN') {
      return code === 'ETIMEDOUT' ? AUTO_RETRY_NET_TIMEOUT : AUTO_RETRY_NET_DNS;
    }
    if (code === 'EPIPE') {
      return AUTO_RETRY_NET_PIPE;
    }
    return AUTO_RETRY_NET_CONNECT;
  }

  // 网络超时
  if (
    message.includes('network timeout') ||
    message.includes('fetch failed') ||
    message.includes('socket hang up') ||
    message.includes('client network socket disconnected') ||
    message.includes('tls handshake timeout') ||
    message.includes('unable to verify the first certificate') ||
    message.includes('network error') ||
    message.includes('temporarily unreachable')
  ) {
    if (
      message.includes('timeout') ||
      message.includes('timed out')
    ) {
      return AUTO_RETRY_NET_TIMEOUT;
    }
    return AUTO_RETRY_NET_CONNECT;
  }

  // --- 3. 无匹配 ---
  return undefined;
}

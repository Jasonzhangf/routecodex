import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { boundedDuration, errorDetails } from './lifecycle-common.mjs';

export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;
const DEFAULT_HTTP_MAX_BYTES = 16 * 1024 * 1024;

export async function sendHttp(url, options = {}) {
  const started = Date.now();
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported URL protocol: ${parsed.protocol}`);
  }
  const transport = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
  const method = String(options.method ?? 'GET').toUpperCase();
  const headers = lowerHeaders(options.headers ?? {});
  const timeoutMs = boundedDuration(options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS, 1);
  const maxBytes = boundedDuration(options.maxBytes ?? DEFAULT_HTTP_MAX_BYTES, 1);
  const body = options.body;

  return new Promise((resolveResponse) => {
    const result = {
      url,
      method,
      request_headers: headers,
      status: null,
      status_text: null,
      headers: {},
      raw_headers: [],
      body: null,
      bodyText: '',
      bodyBytes: Buffer.alloc(0),
      bodyBytesBase64: '',
      response_ended: false,
      complete: null,
      closed: false,
      aborted: false,
      truncated: false,
      elapsed_ms: 0,
      error: null,
      error_detail: null,
    };
    let settled = false;
    let timer = null;
    const chunks = [];
    let receivedBytes = 0;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const bodyBuffer = Buffer.concat(chunks);
      result.bodyBytes = bodyBuffer;
      result.bodyBytesBase64 = bodyBuffer.toString('base64');
      result.bodyText = bodyBuffer.toString('utf8');
      try {
        result.body = result.bodyText ? JSON.parse(result.bodyText) : null;
      } catch {
        result.body = null;
      }
      result.elapsed_ms = Date.now() - started;
      request?.destroy();
      resolveResponse(result);
    };

    const fail = (error, closed = true) => {
      result.error = error?.message ?? String(error);
      result.error_detail = errorDetails(error);
      result.closed = closed;
      finish();
    };

    let request;
    try {
      request = transport(parsed, { method, headers, agent: false }, (response) => {
        result.status = response.statusCode ?? null;
        result.status_text = response.statusMessage ?? null;
        result.headers = lowerHeaders(response.headers);
        result.raw_headers = [...response.rawHeaders];
        response.on('data', (chunk) => {
          const buffer = Buffer.from(chunk);
          receivedBytes += buffer.length;
          if (receivedBytes > maxBytes) {
            result.truncated = true;
            const error = new Error(`response exceeded maxBytes=${maxBytes}`);
            error.code = 'RESPONSE_TOO_LARGE';
            fail(error);
            response.destroy(error);
            return;
          }
          chunks.push(buffer);
        });
        response.on('aborted', () => {
          result.aborted = true;
          result.closed = true;
          result.complete = false;
        });
        response.on('error', (error) => {
          result.aborted = true;
          fail(error);
        });
        response.on('end', () => {
          result.response_ended = true;
          result.complete = response.complete === true;
          result.closed = result.complete === false;
          finish();
        });
        response.on('close', () => {
          result.closed = result.closed || response.complete === false || !result.response_ended;
          if (!result.response_ended) result.complete = false;
          if (!result.response_ended) finish();
        });
      });
    } catch (error) {
      fail(error);
      return;
    }

    timer = setTimeout(() => {
      const error = new Error(`request timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEDOUT';
      fail(error);
      request.destroy(error);
    }, timeoutMs);

    request.on('error', (error) => fail(error));
    if (body !== undefined && body !== null) request.write(body);
    request.end();
  });
}

function lowerHeaders(headers) {
  const output = {};
  if (!headers) return output;
  if (typeof headers.forEach === 'function') {
    headers.forEach((value, key) => {
      output[String(key).toLowerCase()] = String(value);
    });
    return output;
  }
  for (const [key, value] of Object.entries(headers)) {
    output[String(key).toLowerCase()] = String(value);
  }
  return output;
}

import type { ProviderContext } from '../../api/provider-types.js';
import type { PreparedHttpRequest } from '../http-request-executor.js';
import {
  buildRemoteImageInlineError,
  hasRemoteAnthropicImageUrls,
  inlineRemoteAnthropicImageUrls,
  resolveAnthropicRemoteImagePolicy,
  shouldRetryWithInlineRemoteImage,
  type InlineRemoteAnthropicImageOptions,
  type RemoteImagePolicy
} from './anthropic-sdk-remote-image.js';
import { executeAnthropicRequestWithBody } from './anthropic-sdk-request-exec.js';
import { pickString } from './anthropic-sdk-transport-shared.js';

export {
  hasRemoteAnthropicImageUrls,
  inlineRemoteAnthropicImageUrls,
  resolveAnthropicRemoteImagePolicy,
  shouldRetryWithInlineRemoteImage,
  type InlineRemoteAnthropicImageOptions,
  type RemoteImagePolicy
};

export class VercelAiSdkAnthropicTransport {
  async executePreparedRequest(
    requestInfo: PreparedHttpRequest,
    context: ProviderContext
  ): Promise<unknown> {
    const providerWireBody = (requestInfo.body ?? {}) as Record<string, unknown>;
    if (!hasRemoteAnthropicImageUrls(providerWireBody)) {
      return executeAnthropicRequestWithBody(providerWireBody, requestInfo);
    }

    const policy = resolveAnthropicRemoteImagePolicy(context, providerWireBody);
    if (policy === 'direct') {
      return executeAnthropicRequestWithBody(providerWireBody, requestInfo);
    }
    if (policy === 'inline') {
      const { body: inlinedProviderWireBody, rewrites } = await inlineRemoteAnthropicImageUrls(providerWireBody);
      if (rewrites > 0) {
        console.warn(
          `[multimodal][remote-image] mode=inline provider=${context.providerKey ?? context.providerId ?? '-'} rewrites=${rewrites}`
        );
      }
      return executeAnthropicRequestWithBody(inlinedProviderWireBody, requestInfo);
    }

    let directError: unknown;
    try {
      return await executeAnthropicRequestWithBody(providerWireBody, requestInfo);
    } catch (error) {
      directError = error;
      if (!shouldRetryWithInlineRemoteImage(error)) {
        throw error;
      }
    }

    const { body: inlinedProviderWireBody, rewrites } = await inlineRemoteAnthropicImageUrls(providerWireBody);
    console.warn(
      `[multimodal][remote-image] mode=direct_then_inline provider=${context.providerKey ?? context.providerId ?? '-'} rewrites=${rewrites} reason=${pickString((directError as { code?: unknown })?.code) ?? 'upstream_error'}`
    );
    try {
      return await executeAnthropicRequestWithBody(inlinedProviderWireBody, requestInfo);
    } catch (inlineError) {
      throw buildRemoteImageInlineError(
        'REMOTE_IMAGE_FALLBACK_FAILED',
        'direct remote URL request failed and inline retry failed',
        502,
        {
          directError: pickString((directError as { message?: unknown })?.message) ?? String(directError ?? ''),
          inlineError: pickString((inlineError as { message?: unknown })?.message) ?? String(inlineError ?? '')
        }
      );
    }
  }
}

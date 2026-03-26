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
  buildAnthropicSdkCallOptions
} from './anthropic-sdk-call-options.js';
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
    const incomingBody = (requestInfo.body ?? {}) as Record<string, unknown>;
    if (!hasRemoteAnthropicImageUrls(incomingBody)) {
      return executeAnthropicRequestWithBody(incomingBody, requestInfo);
    }

    const policy = resolveAnthropicRemoteImagePolicy(context, incomingBody);
    if (policy === 'direct') {
      return executeAnthropicRequestWithBody(incomingBody, requestInfo);
    }
    if (policy === 'inline') {
      const { body: inlinedBody, rewrites } = await inlineRemoteAnthropicImageUrls(incomingBody);
      if (rewrites > 0) {
        console.warn(
          `[multimodal][remote-image] mode=inline provider=${context.providerKey ?? context.providerId ?? '-'} rewrites=${rewrites}`
        );
      }
      return executeAnthropicRequestWithBody(inlinedBody, requestInfo);
    }

    let directError: unknown;
    try {
      return await executeAnthropicRequestWithBody(incomingBody, requestInfo);
    } catch (error) {
      directError = error;
      if (!shouldRetryWithInlineRemoteImage(error)) {
        throw error;
      }
    }

    const { body: inlinedBody, rewrites } = await inlineRemoteAnthropicImageUrls(incomingBody);
    console.warn(
      `[multimodal][remote-image] mode=direct_then_inline provider=${context.providerKey ?? context.providerId ?? '-'} rewrites=${rewrites} reason=${pickString((directError as { code?: unknown })?.code) ?? 'upstream_error'}`
    );
    try {
      return await executeAnthropicRequestWithBody(inlinedBody, requestInfo);
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

import type { ProcessedRequest, StandardizedRequest } from '../../hub/types/standardized.js';
import type { ChatCompletionLike } from '../../hub/response/response-mappers.js';

/**
 * Canonical request payload used by the Chat Process. The structure already
 * exists inside the hub pipeline (`StandardizedRequest`), so v2 codecs can
 * simply reuse it to avoid redefining similar shapes.
 */
export type CanonicalChatRequest = StandardizedRequest;

/**
 * Processed requests (after tool governance/reranking) are also exposed so the
 * outbound side can make decisions that depend on process metadata.
 */
export type CanonicalProcessedRequest = ProcessedRequest;

/**
 * Canonical response payloads follow the OpenAI ChatCompletion-like structure
 * that the existing format adapters emit.
 */
export type CanonicalChatResponse = ChatCompletionLike;

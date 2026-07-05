// feature_id: conversion.shared.anthropic
// Thin wrapper: Anthropic tool schema mapping is owned by Rust anthropic_openai_codec.rs.
import { mapChatToolsToAnthropicToolsWithNative } from '../../native/router-hotpath/native-shared-conversion-semantics.js';

export function mapChatToolsToAnthropicTools(rawTools: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(rawTools) || rawTools.length === 0) {
    return undefined;
  }
  const mapped = mapChatToolsToAnthropicToolsWithNative(rawTools);
  return mapped.length ? mapped : undefined;
}

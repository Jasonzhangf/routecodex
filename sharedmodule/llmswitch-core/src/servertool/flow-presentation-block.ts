import {
  resolveServertoolProgressToolNameWithNative,
  shouldUseServertoolGoldProgressHighlightWithNative
} from '../native/router-hotpath/native-chat-process-servertool-orchestration-semantics.js';

export const SERVERTOOL_FLOW_PRESENTATION_FEATURE_ID = 'feature_id: hub.servertool_flow_presentation';
export const SERVERTOOL_FLOW_PRESENTATION_CANONICAL_BUILDERS = [
  'resolve_servertool_progress_tool_name_json',
  'should_use_servertool_gold_progress_highlight_json'
] as const;

export function resolveProgressToolName(flowId: unknown): string {
  return resolveServertoolProgressToolNameWithNative({ flowId });
}

export function shouldUseGoldProgressHighlight(flowId: unknown): boolean {
  return shouldUseServertoolGoldProgressHighlightWithNative({ flowId });
}

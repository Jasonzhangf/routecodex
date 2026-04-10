import type { ApplyPatchNormalizeAction } from './types.js';

export const DEFAULT_APPLY_PATCH_NORMALIZE_ACTIONS: ApplyPatchNormalizeAction[] = [
  { action: 'raw_non_json_patch' },
  { action: 'json_container_patch_fallback' },
  { action: 'record_text_fields', fields: ['patch'] },
  { action: 'record_conflict_patch', patchField: 'patch', fileFields: ['file', 'path', 'filepath', 'filename'] },
  { action: 'record_text_fields', fields: ['diff', 'patchText', 'body', 'input', 'instructions', 'command'] },
  { action: 'record_raw_envelope', field: '_raw', parseJson: true, maxDepth: 3 },
  {
    action: 'record_object_envelope',
    fields: ['result', 'payload', 'data', 'tool_input', 'toolInput', 'arguments'],
    parseJsonString: true,
    maxDepth: 3
  },
  { action: 'record_structured_payload' },
  { action: 'array_structured_payload' },
  { action: 'raw_string_patch' },
  { action: 'invalid_json_guard' }
];

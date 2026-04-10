import type { UnknownRecord } from '../validation/shared.js';

export type ApplyPatchExtraction = {
  patchText?: string;
  failureReason?: string;
};

export type ApplyPatchNormalizeResult =
  | {
      ok: true;
      patchText: string;
    }
  | {
      ok: false;
      reason: string;
    };

export type ApplyPatchNormalizeAction =
  | {
      action: 'raw_non_json_patch';
    }
  | {
      action: 'json_container_patch_fallback';
    }
  | {
      action: 'record_text_fields';
      fields: string[];
    }
  | {
      action: 'record_conflict_patch';
      patchField: string;
      fileFields: string[];
    }
  | {
      action: 'record_raw_envelope';
      field: string;
      parseJson?: boolean;
      maxDepth?: number;
    }
  | {
      action: 'record_object_envelope';
      fields: string[];
      parseJsonString?: boolean;
      maxDepth?: number;
    }
  | {
      action: 'record_structured_payload';
    }
  | {
      action: 'array_structured_payload';
    }
  | {
      action: 'raw_string_patch';
    }
  | {
      action: 'invalid_json_guard';
    };

export type ApplyPatchNormalizeOptions = {
  actions?: ApplyPatchNormalizeAction[];
};

export type ApplyPatchNormalizeState = {
  argsString: string;
  rawArgs: unknown;
  rawTrimmed: string;
  looksJsonContainer: boolean;
  depth: number;
};

export type ApplyPatchActionContext = {
  state: ApplyPatchNormalizeState;
  runNested: (argsString: string, rawArgs: unknown, depth: number) => ApplyPatchExtraction;
};

export type ApplyPatchRecordActionContext = ApplyPatchActionContext & {
  record: UnknownRecord;
};

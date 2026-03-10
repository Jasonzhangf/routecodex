import { resolveStopMessageText } from './stop-message-file-resolver.js';

export type StopMessageStageTemplateName = 'status_probe' | 'active_continue' | 'loop_self_check';

export interface StopMessageStageTemplateLoadResult {
  stage: StopMessageStageTemplateName;
  ref: string;
  text?: string;
  error?: string;
}

const DEFAULT_STAGE_TEMPLATE_REFS: Record<StopMessageStageTemplateName, string> = {
  status_probe: '<file://stopMessage/stage-status-check.md>',
  active_continue: '<file://stopMessage/stage-active-continue.md>',
  loop_self_check: '<file://stopMessage/stage-loop-self-check.md>'
};

const STAGE_ENV_KEYS: Record<StopMessageStageTemplateName, string> = {
  status_probe: 'ROUTECODEX_STOPMESSAGE_STAGE_STATUS_REF',
  active_continue: 'ROUTECODEX_STOPMESSAGE_STAGE_ACTIVE_REF',
  loop_self_check: 'ROUTECODEX_STOPMESSAGE_STAGE_LOOP_REF'
};

export function loadStopMessageStageTemplate(stage: StopMessageStageTemplateName): StopMessageStageTemplateLoadResult {
  const ref = resolveStopMessageStageTemplateRef(stage);
  if (!ref) {
    return {
      stage,
      ref: '',
      error: `missing template reference for ${stage}`
    };
  }
  try {
    const text = resolveStopMessageText(ref);
    const normalized = typeof text === 'string' ? text.trim() : '';
    if (!normalized) {
      return {
        stage,
        ref,
        error: `template is empty for ${stage}`
      };
    }
    return {
      stage,
      ref,
      text: normalized
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
    return {
      stage,
      ref,
      error: message
    };
  }
}

export function validateStopMessageStageTemplatesCompleteness(): {
  ok: boolean;
  missing: StopMessageStageTemplateLoadResult[];
} {
  const requiredStages: StopMessageStageTemplateName[] = ['status_probe', 'active_continue', 'loop_self_check'];
  const missing: StopMessageStageTemplateLoadResult[] = [];

  for (const stage of requiredStages) {
    const loaded = loadStopMessageStageTemplate(stage);
    if (!loaded.text) {
      missing.push(loaded);
    }
  }

  return {
    ok: missing.length === 0,
    missing
  };
}

function resolveStopMessageStageTemplateRef(stage: StopMessageStageTemplateName): string {
  const envKey = STAGE_ENV_KEYS[stage];
  const envRef = normalizeText(process.env[envKey]);
  return envRef || DEFAULT_STAGE_TEMPLATE_REFS[stage];
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

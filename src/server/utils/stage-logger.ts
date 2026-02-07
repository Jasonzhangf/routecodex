const truthy = new Set(['1', 'true', 'yes']);
const falsy = new Set(['0', 'false', 'no']);
let cachedStageLoggingFlag: boolean | null = null;
let cachedStageVerboseFlag: boolean | null = null;

const COLOR_RESET = '\x1b[0m';
const COLOR_INFO = '\x1b[90m';
const COLOR_START = '\x1b[36m';
const COLOR_SUCCESS = '\x1b[32m';
const COLOR_ERROR = '\x1b[31m';

type StageLevel = 'info' | 'start' | 'success' | 'error';

function resolveBoolFromEnv(value: string | undefined, fallback: boolean): boolean {
  if (!value) {return fallback;}
  const normalized = value.trim().toLowerCase();
  if (truthy.has(normalized)) {return true;}
  if (falsy.has(normalized)) {return false;}
  return fallback;
}

function computeStageLoggingEnabled(): boolean {
  const raw = String(process.env.ROUTECODEX_STAGE_LOG || '').trim().toLowerCase();
  if (truthy.has(raw)) {
    return true;
  }
  if (falsy.has(raw)) {
    return false;
  }
  const nodeEnv = String(process.env.NODE_ENV || '').trim().toLowerCase();
  return nodeEnv === 'development';
}

function computeStageVerboseEnabled(): boolean {
  return resolveBoolFromEnv(
    process.env.ROUTECODEX_STAGE_LOG_VERBOSE
      ?? process.env.RCC_STAGE_LOG_VERBOSE
      ?? process.env.ROUTECODEX_PIPELINE_LOG_VERBOSE
      ?? process.env.RCC_PIPELINE_LOG_VERBOSE,
    false
  );
}

function isStageVerboseEnabled(): boolean {
  if (cachedStageVerboseFlag === null) {
    cachedStageVerboseFlag = computeStageVerboseEnabled();
  }
  return cachedStageVerboseFlag;
}

export function isStageLoggingEnabled(): boolean {
  if (cachedStageLoggingFlag === null) {
    cachedStageLoggingFlag = computeStageLoggingEnabled();
  }
  return cachedStageLoggingFlag;
}

export function logPipelineStage(stage: string, requestId: string, details?: Record<string, unknown>): void {
  if (!isStageLoggingEnabled()) {
    return;
  }

  const { scope, action } = parseStage(stage);
  const level = detectStageLevel(stage);
  const verbose = isStageVerboseEnabled();

  if (!shouldLogStage(scope, level, verbose)) {
    return;
  }

  const showDetail = verbose || level === 'error';
  const providerLabel = showDetail && typeof details?.providerLabel === 'string' ? details?.providerLabel : undefined;
  const detailPayload = showDetail
    ? (providerLabel
      ? (() => {
          const clone = { ...details } as Record<string, unknown>;
          delete clone.providerLabel;
          return clone;
        })()
      : details)
    : undefined;

  const suffix = detailPayload && Object.keys(detailPayload).length ? ` ${JSON.stringify(detailPayload)}` : '';
  const label = `[${scope}][${requestId}] ${action}`;
  const providerTag = providerLabel ? ` ${colorizeProviderLabel(level, providerLabel)}` : '';
  console.log(`${colorize(level, label)}${providerTag}${suffix}`);
}

function shouldLogStage(scope: string, level: StageLevel, verbose: boolean): boolean {
  if (level === 'error') {
    return true;
  }
  if (verbose) {
    return true;
  }
  if (scope.startsWith('response.sse')) {
    return false;
  }
  return scope.startsWith('request') || scope.startsWith('servertool');
}

function parseStage(stage: string): { scope: string; action: string } {
  const segments = stage.split('.').filter(Boolean);
  if (segments.length <= 1) {
    return { scope: 'pipeline', action: segments[0] || stage };
  }
  return {
    scope: segments.slice(0, -1).join('.'),
    action: segments[segments.length - 1]
  };
}

function detectStageLevel(stage: string): StageLevel {
  const normalized = stage.toLowerCase();
  if (normalized.includes('error') || normalized.includes('fail')) {
    return 'error';
  }
  if (normalized.includes('completed') || normalized.includes('end')) {
    return 'success';
  }
  if (normalized.includes('start') || normalized.includes('prepare')) {
    return 'start';
  }
  return 'info';
}

function colorize(level: StageLevel, text: string): string {
  switch (level) {
    case 'start':
      return `${COLOR_START}${text}${COLOR_RESET}`;
    case 'success':
      return `${COLOR_SUCCESS}${text}${COLOR_RESET}`;
    case 'error':
      return `${COLOR_ERROR}${text}${COLOR_RESET}`;
    default:
      return `${COLOR_INFO}${text}${COLOR_RESET}`;
  }
}

function colorizeProviderLabel(level: StageLevel, label: string): string {
  const color = level === 'error' ? COLOR_ERROR : COLOR_SUCCESS;
  return `${color}[${label}]${COLOR_RESET}`;
}

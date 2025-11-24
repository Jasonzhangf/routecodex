import path from 'path';

const DEFAULT_FILENAME = 'pipeline-config.generated.json';

function sanitizePortLabel(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const sanitized = trimmed.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  return sanitized || undefined;
}

export function getPortLabel(explicit?: number | string): string | undefined {
  const source =
    explicit ?? process.env.ROUTECODEX_PIPELINE_PORT ?? process.env.ROUTECODEX_PORT ?? process.env.RCC_PORT;
  if (source === undefined || source === null) return undefined;
  const str = typeof source === 'number' ? String(source) : String(source);
  return sanitizePortLabel(str);
}

export function getPipelineConfigFilename(portLabel?: string): string {
  return portLabel ? `pipeline-config.${portLabel}.generated.json` : DEFAULT_FILENAME;
}

export function resolvePipelineConfigCandidates(baseDir: string, override?: string): string[] {
  const candidates: string[] = [];
  const overridePath = override && override.trim() ? path.resolve(override.trim()) : undefined;
  const envPathRaw =
    process.env.ROUTECODEX_PIPELINE_CONFIG_PATH ||
    process.env.ROUTECODEX_PIPELINE_CONFIG ||
    process.env.RCC_PIPELINE_CONFIG_PATH;
  const envPath = envPathRaw && envPathRaw.trim() ? path.resolve(envPathRaw.trim()) : undefined;
  const portLabel = getPortLabel();
  const portFile = portLabel ? path.join(baseDir, 'config', getPipelineConfigFilename(portLabel)) : undefined;
  const defaultPath = path.join(baseDir, 'config', DEFAULT_FILENAME);

  if (overridePath) candidates.push(overridePath);
  if (envPath) candidates.push(envPath);
  if (portFile) candidates.push(portFile);
  candidates.push(defaultPath);

  return Array.from(new Set(candidates));
}

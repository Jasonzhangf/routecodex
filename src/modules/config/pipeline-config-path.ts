import path from 'path';
import os from 'os';

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

// 新路径规范：仅消费由 config-core 生成的标准位置
// ~/.routecodex/config/generated/pipeline-config.<port>.generated.json
export function resolvePipelineConfigCandidates(_baseDir: string, override?: string): string[] {
  const overridePath = override && override.trim() ? path.resolve(override.trim()) : undefined;
  const envPathRaw =
    process.env.ROUTECODEX_PIPELINE_CONFIG_PATH ||
    process.env.ROUTECODEX_PIPELINE_CONFIG ||
    process.env.RCC_PIPELINE_CONFIG_PATH;
  const envPath = envPathRaw && envPathRaw.trim() ? path.resolve(envPathRaw.trim()) : undefined;
  const portLabel = getPortLabel();
  const home = os.homedir();
  const generatedDir = path.join(home, '.routecodex', 'config', 'generated');
  const standard = path.join(generatedDir, getPipelineConfigFilename(portLabel));

  const candidates: string[] = [];
  if (overridePath) candidates.push(overridePath);
  if (envPath) candidates.push(envPath);
  candidates.push(standard);
  return Array.from(new Set(candidates));
}

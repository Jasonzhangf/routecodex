import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

/**
 * InlineAuthResolver
 *
 * Resolves provider API keys from environment variables or the default
 * user configuration file (~/.routecodex/config.json). This is used to
 * rehydrate credentials when compatibility/merged-config output has
 * redacted secrets.
 */
function normalizeFamilyId(providerId: string): string {
  const pid = String(providerId || '').toLowerCase();
  // Normalize known families and common aliases
  if (pid.includes('qwen') || pid.includes('dashscope') || pid.includes('aliyun')) {return 'qwen';}
  if (pid.includes('openai')) {return 'openai';}
  if (pid.includes('zhipu') || pid === 'glm' || pid.includes('bigmodel')) {return 'glm';}
  if (pid.includes('modelscope')) {return 'modelscope';}
  if (pid.includes('lmstudio') || pid.includes('lm-studio')) {return 'lmstudio';}
  if (pid.includes('iflow')) {return 'iflow';}
  return pid;
}

export async function resolveInlineApiKey(providerId: string): Promise<string | undefined> {
  // Deprecated: not used in strict assembly. Kept for potential tooling or diagnostics.
  const pid = String(providerId || '').toLowerCase();
  const family = normalizeFamilyId(pid);

  // 1) Environment variables by provider family
  const envMap: Record<string, string[]> = {
    glm: ['GLM_API_KEY', 'ZHIPU_API_KEY', 'BIGMODEL_API_KEY'],
    openai: ['OPENAI_API_KEY'],
    qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY', 'ALIYUN_QWEN_API_KEY'],
    iflow: ['IFLOW_API_KEY'],
    modelscope: ['MODELSCOPE_API_KEY'],
    lmstudio: ['LMSTUDIO_API_KEY'],
  };

  const envCandidates = envMap[family] || envMap[pid] || [];
  for (const name of envCandidates) {
    const v = process.env[name];
    if (typeof v === 'string' && v.trim()) {
      return v.trim();
    }
  }

  // 2) Read from default user config (~/.routecodex/config.json)
  try {
    const userCfgPath = path.join(homedir(), '.routecodex', 'config.json');
    const raw = await fs.readFile(userCfgPath, 'utf-8');
    const j = JSON.parse(raw);
    const providers = j?.virtualrouter?.providers || {};
    const prov = providers[providerId] || providers[pid] || providers[family];
    const key = (prov?.apiKey && Array.isArray(prov.apiKey) ? prov.apiKey[0] : undefined)
      || (Array.isArray(prov?.apiKeys) ? (prov as any).apiKeys[0] : undefined);
    if (typeof key === 'string' && key && key !== '***REDACTED***') {
      return key;
    }
  } catch {
    // ignore
  }

  return undefined;
}

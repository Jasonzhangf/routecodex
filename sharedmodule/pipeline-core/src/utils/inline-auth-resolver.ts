import fs from 'fs/promises';
import path from 'path';
import { homedir } from 'os';

export async function resolveInlineApiKey(providerId: string): Promise<string | undefined> {
  const pid = String(providerId || '').toLowerCase();

  const envMap: Record<string, string[]> = {
    glm: ['GLM_API_KEY', 'ZHIPU_API_KEY', 'BIGMODEL_API_KEY'],
    openai: ['OPENAI_API_KEY'],
    qwen: ['QWEN_API_KEY', 'DASHSCOPE_API_KEY', 'ALIYUN_QWEN_API_KEY'],
    iflow: ['IFLOW_API_KEY'],
    modelscope: ['MODELSCOPE_API_KEY'],
    lmstudio: ['LMSTUDIO_API_KEY'],
  };

  const envCandidates = envMap[pid] || [];
  for (const name of envCandidates) {
    const v = process.env[name];
    if (typeof v === 'string' && v.trim()) {
      return v.trim();
    }
  }

  try {
    const userCfgPath = path.join(homedir(), '.routecodex', 'config.json');
    const raw = await fs.readFile(userCfgPath, 'utf-8');
    const j = JSON.parse(raw);
    const providers = j?.virtualrouter?.providers || {};
    const prov = providers[providerId] || providers[pid];
    const key = prov?.apiKey?.[0];
    if (typeof key === 'string' && key && key !== '***REDACTED***') {
      return key;
    }
  } catch {
    // ignore
  }

  return undefined;
}


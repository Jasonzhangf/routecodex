import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getCamoufoxProfileDir } from '../providers/core/config/camoufox-launcher.js';
import { inferAntigravityUaSuffixFromFingerprint } from '../providers/auth/antigravity-fingerprint.js';

export type TokenPortalFingerprintSummary = {
  profileId: string;
  os?: string;
  arch?: string;
  suffix?: string;
  navigatorPlatform?: string;
  navigatorOscpu?: string;
};

function getFingerprintRoot(): string {
  const home = (process.env.HOME || '').trim() || os.homedir();
  return path.join(home, '.routecodex', 'camoufox-fp');
}

function getFingerprintPath(profileId: string): string {
  return path.join(getFingerprintRoot(), `${profileId}.json`);
}

export async function loadTokenPortalFingerprintSummary(provider: string, alias: string): Promise<TokenPortalFingerprintSummary | null> {
  const normalizedProvider = typeof provider === 'string' ? provider.trim() : '';
  const normalizedAlias = typeof alias === 'string' ? alias.trim().toLowerCase() : '';
  if (!normalizedProvider || !normalizedAlias) {
    return null;
  }

  let profileId = '';
  try {
    const dir = getCamoufoxProfileDir(normalizedProvider, normalizedAlias);
    profileId = path.basename(dir);
  } catch {
    return null;
  }
  if (!profileId) {
    return null;
  }

  const fpPath = getFingerprintPath(profileId);
  let payload: unknown;
  try {
    const raw = await fs.readFile(fpPath, 'utf8');
    payload = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return { profileId };
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { profileId };
  }
  const env = (payload as { env?: unknown }).env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return { profileId };
  }
  const camouConfigRaw = (env as Record<string, unknown>).CAMOU_CONFIG_1;
  if (typeof camouConfigRaw !== 'string' || !camouConfigRaw.trim()) {
    return { profileId };
  }

  let camouConfig: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(camouConfigRaw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      camouConfig = parsed as Record<string, unknown>;
    }
  } catch {
    camouConfig = null;
  }

  const navigatorPlatform = camouConfig && typeof camouConfig['navigator.platform'] === 'string'
    ? String(camouConfig['navigator.platform'])
    : undefined;
  const navigatorOscpu = camouConfig && typeof camouConfig['navigator.oscpu'] === 'string'
    ? String(camouConfig['navigator.oscpu'])
    : undefined;
  const navigatorUserAgent = camouConfig && typeof camouConfig['navigator.userAgent'] === 'string'
    ? String(camouConfig['navigator.userAgent'])
    : undefined;

  const suffix = inferAntigravityUaSuffixFromFingerprint({
    navigatorPlatform,
    navigatorOscpu,
    navigatorUserAgent
  });

  const [osPart, archPart] = (suffix || '').split('/');

  return {
    profileId,
    suffix: suffix || undefined,
    os: osPart || undefined,
    arch: archPart || undefined,
    navigatorPlatform,
    navigatorOscpu
  };
}


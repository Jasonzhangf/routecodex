import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveRccCamoufoxFingerprintDir } from '../config/user-data-paths.js';
import { getCamoufoxProfileDir } from '../providers/core/config/camoufox-launcher.js';

export type TokenPortalFingerprintSummary = {
  profileId: string;
  os?: string;
  arch?: string;
  suffix?: string;
  navigatorPlatform?: string;
  navigatorOscpu?: string;
};

function getFingerprintRoot(): string {
  return resolveRccCamoufoxFingerprintDir();
}

function getFingerprintPath(profileId: string): string {
  return path.join(getFingerprintRoot(), `${profileId}.json`);
}

function inferUaSuffixFromFingerprint(input: {
  navigatorPlatform?: string;
  navigatorOscpu?: string;
  navigatorUserAgent?: string;
}): string | undefined {
  const platform = String(input.navigatorPlatform || '').trim().toLowerCase();
  const oscpu = String(input.navigatorOscpu || '').trim().toLowerCase();
  const ua = String(input.navigatorUserAgent || '').trim().toLowerCase();
  const haystack = `${platform} ${oscpu} ${ua}`;

  let os = '';
  if (haystack.includes('win')) {
    os = 'windows';
  } else if (haystack.includes('mac') || haystack.includes('darwin')) {
    os = 'macos';
  } else if (haystack.includes('linux')) {
    os = 'linux';
  }

  let arch = '';
  if (haystack.includes('aarch64') || haystack.includes('arm64')) {
    arch = 'arm64';
  } else if (haystack.includes('x86_64') || haystack.includes('win64') || haystack.includes('x64') || haystack.includes('amd64')) {
    arch = 'x64';
  } else if (haystack.includes('x86') || haystack.includes('i686') || haystack.includes('i386')) {
    arch = 'x86';
  }

  if (!os && !arch) {
    return undefined;
  }
  return [os || 'unknown', arch || 'unknown'].join('/');
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

  const suffix = inferUaSuffixFromFingerprint({
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

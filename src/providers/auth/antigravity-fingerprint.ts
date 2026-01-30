import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getCamoufoxProfileDir } from '../core/config/camoufox-launcher.js';

export type AntigravityCamoufoxFingerprint = {
  navigatorPlatform?: string;
  navigatorUserAgent?: string;
  navigatorOscpu?: string;
};

function getFingerprintRoot(): string {
  const home = process.env.HOME || os.homedir();
  return path.join(home, '.routecodex', 'camoufox-fp');
}

function getFingerprintPath(profileId: string): string {
  return path.join(getFingerprintRoot(), `${profileId}.json`);
}

function parseCamouConfig1(envValue: unknown): Record<string, unknown> | null {
  if (typeof envValue !== 'string' || !envValue.trim()) {
    return null;
  }
  try {
    const parsed = JSON.parse(envValue);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function inferAntigravityUaSuffixFromFingerprint(fp: AntigravityCamoufoxFingerprint): string | undefined {
  const platform = String(fp.navigatorPlatform || '').trim();
  const ua = String(fp.navigatorUserAgent || '').trim();
  const oscpu = String(fp.navigatorOscpu || '').trim();

  const combined = `${platform} ${oscpu} ${ua}`.toLowerCase();

  let osPart: string | undefined;
  if (combined.includes('win')) {
    osPart = 'windows';
  } else if (combined.includes('mac')) {
    // Antigravity-Manager UA uses `macos` (Rust std::env::consts::OS).
    osPart = 'macos';
  } else if (combined.includes('linux') || combined.includes('x11')) {
    osPart = 'linux';
  }

  let archPart: string | undefined;
  if (/(aarch64|arm64)/i.test(combined)) {
    archPart = 'aarch64';
  } else if (/(x86_64|amd64|x64|win64)/i.test(combined)) {
    archPart = 'amd64';
  }

  // Conservative defaults: most existing OAuth fingerprints here are x86_64-like.
  if (osPart && !archPart) {
    archPart = 'amd64';
  }

  if (!osPart || !archPart) {
    return undefined;
  }
  return `${osPart}/${archPart}`;
}

export async function loadAntigravityCamoufoxFingerprint(alias: string): Promise<AntigravityCamoufoxFingerprint | null> {
  const rawAlias = typeof alias === 'string' ? alias.trim() : '';
  if (!rawAlias) {
    return null;
  }

  // IMPORTANT: antigravity/gemini-cli share the same camoufox profile family ("gemini").
  // getCamoufoxProfileDir handles this mapping.
  const profileDir = getCamoufoxProfileDir('antigravity', rawAlias);
  const profileId = path.basename(profileDir);
  const fpPath = getFingerprintPath(profileId);

  let payload: unknown;
  try {
    const raw = await fs.readFile(fpPath, 'utf8');
    payload = raw.trim() ? JSON.parse(raw) : null;
  } catch {
    return null;
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null;
  }
  const env = (payload as { env?: unknown }).env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return null;
  }
  const camouConfig1 = (env as Record<string, unknown>).CAMOU_CONFIG_1;
  const config = parseCamouConfig1(camouConfig1);
  if (!config) {
    return null;
  }

  const navigatorPlatform = config['navigator.platform'];
  const navigatorUserAgent = config['navigator.userAgent'];
  const navigatorOscpu = config['navigator.oscpu'];

  return {
    navigatorPlatform: typeof navigatorPlatform === 'string' ? navigatorPlatform : undefined,
    navigatorUserAgent: typeof navigatorUserAgent === 'string' ? navigatorUserAgent : undefined,
    navigatorOscpu: typeof navigatorOscpu === 'string' ? navigatorOscpu : undefined
  };
}


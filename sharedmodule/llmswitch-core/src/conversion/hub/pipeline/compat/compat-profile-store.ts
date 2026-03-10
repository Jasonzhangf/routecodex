import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { CompatProfileConfig } from './compat-types.js';
import { normalizeProviderProtocolTokenWithNative } from '../../../../router/virtual-router/engine-selection/native-hub-pipeline-req-inbound-semantics.js';

const builtinDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../compat/profiles'
);

const USER_COMPAT_DIR =
  (process.env.ROUTECODEX_COMPAT_DIR && process.env.ROUTECODEX_COMPAT_DIR.trim()) ||
  path.join(os.homedir(), '.routecodex', 'compat');

let profileMap: Map<string, CompatProfileConfig> | null = null;

function normalizeProfiles(profiles: CompatProfileConfig[]): Map<string, CompatProfileConfig> {
  const map = new Map<string, CompatProfileConfig>();
  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object') {
      continue;
    }
    const id = typeof profile.id === 'string' ? profile.id.trim() : '';
    if (!id) {
      continue;
    }
    const normalized: CompatProfileConfig = {
      ...profile,
      id
    };
    // Treat profile IDs as case-insensitive for lookup purposes.
    // Many configs are hand-authored and may use different casing (e.g. "Chat:Claude-Code"),
    // while built-in profiles are lower-case.
    map.set(id, normalized);
    const lower = id.toLowerCase();
    if (lower !== id) {
      map.set(lower, normalized);
    }
  }
  return map;
}

function loadProfilesFromDir(dir: string): CompatProfileConfig[] {
  try {
    if (!fs.existsSync(dir)) {
      return [];
    }
    const entries = fs.readdirSync(dir);
    const configs: CompatProfileConfig[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) {
        continue;
      }
      const file = path.join(dir, entry);
      try {
        const text = fs.readFileSync(file, 'utf8');
        const json = JSON.parse(text) as CompatProfileConfig;
        if (!json.id) {
          json.id = entry.replace(/\.json$/i, '');
        }
        configs.push(json);
      } catch (error) {
        console.warn(`[compat] Failed to load ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return configs;
  } catch {
    return [];
  }
}

function buildProfileMap(): Map<string, CompatProfileConfig> {
  const merged = new Map<string, CompatProfileConfig>();
  const builtinProfiles = normalizeProfiles(loadProfilesFromDir(builtinDir));
  for (const [key, value] of builtinProfiles.entries()) {
    merged.set(key, value);
  }
  const userProfiles = normalizeProfiles(loadProfilesFromDir(USER_COMPAT_DIR));
  for (const [key, value] of userProfiles.entries()) {
    merged.set(key, value);
  }
  return merged;
}

export function getCompatProfile(profileId?: string): CompatProfileConfig | null {
  normalizeProviderProtocolTokenWithNative('openai-responses');
  if (!profileId || !profileId.trim()) {
    return null;
  }
  if (!profileMap) {
    profileMap = buildProfileMap();
  }
  const key = profileId.trim();
  return profileMap.get(key) ?? profileMap.get(key.toLowerCase()) ?? null;
}

/**
 * Compat Profile Registry — loader and lookup.
 *
 * Parallel implementation (Step A). Loads all profile JSON files from disk,
 * applies extended fields (headerPolicies, policyOverrides), and exposes
 * a typed registry for downstream consumers.
 *
 * This is the THIN SHELL layer. The heavy validation (schema enforcement,
 * action registration checks) will move to Rust per Guard #8.
 * For now, we do minimal structural validation and fail-fast on missing data.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CompatProfileEntry, CompatProfileRegistry, HeaderPolicyRule, PolicyOverrideConfig } from './types.js';

// Re-export types for consumers
export type { CompatProfileEntry, CompatProfileRegistry, HeaderPolicyRule, PolicyOverrideConfig };

function getProfilesDir(): string {
  try {
    const selfDir = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(selfDir, '..', 'profiles');
  } catch {
    return path.resolve(process.cwd(), 'src', 'conversion', 'compat', 'profiles');
  }
}

/**
 * Load all compat profile JSON files from the profiles directory.
 * Returns a registry with profiles keyed by id.
 *
 * Fails fast on:
 * - Missing or unreadable profiles directory
 * - Invalid JSON in any profile file
 * - Profile missing 'id' or 'protocol' fields
 */
export function loadCompatProfileRegistry(profilesDir?: string): CompatProfileRegistry {
  const dir = profilesDir ?? getProfilesDir();

  if (!fs.existsSync(dir)) {
    throw new Error(
      `[CompatProfileRegistry] profiles directory not found: ${dir}`
    );
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  const profiles = new Map<string, CompatProfileEntry>();

  for (const file of files) {
    const filePath = path.join(dir, file);
    const raw = fs.readFileSync(filePath, 'utf-8');
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(raw) as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `[CompatProfileRegistry] invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (typeof entry.id !== 'string' || !entry.id.trim()) {
      throw new Error(
        `[CompatProfileRegistry] profile in ${filePath} is missing required field 'id'`
      );
    }
    if (typeof entry.protocol !== 'string') {
      throw new Error(
        `[CompatProfileRegistry] profile "${entry.id}" in ${filePath} has invalid field 'protocol' (must be a string)`
      );
    }

    const profile = entry as unknown as CompatProfileEntry;
    if (profiles.has(profile.id)) {
      throw new Error(
        `[CompatProfileRegistry] duplicate profile id "${profile.id}" in ${filePath} (already loaded from another file)`
      );
    }
    profiles.set(profile.id, profile);
  }

  return { profiles, providerBlocks: [] };
}

/**
 * Look up a profile by id. Throws if not found (fail-fast, no fallback).
 */
export function getProfile(
  registry: CompatProfileRegistry,
  profileId: string
): CompatProfileEntry {
  const entry = registry.profiles.get(profileId);
  if (!entry) {
    throw new Error(
      `[CompatProfileRegistry] profile not found: "${profileId}". ` +
      `Available: ${[...registry.profiles.keys()].join(', ')}`
    );
  }
  return entry;
}

/**
 * Get header policy rules for a profile (empty array if none).
 */
export function getHeaderPolicies(
  registry: CompatProfileRegistry,
  profileId: string
): HeaderPolicyRule[] {
  const entry = getProfile(registry, profileId);
  return entry.headerPolicies ?? [];
}

/**
 * Get policy overrides for a profile (undefined if none).
 */
export function getPolicyOverrides(
  registry: CompatProfileRegistry,
  profileId: string
): PolicyOverrideConfig | undefined {
  const entry = getProfile(registry, profileId);
  return entry.policyOverrides;
}

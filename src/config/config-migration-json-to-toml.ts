import fs from 'node:fs';
import path from 'node:path';
import { parseUserConfigText, detectUserConfigFormat } from './user-config-codec.js';
import { parseProviderConfigText, detectProviderConfigFormat } from './provider-config-codec.js';
import { serializeTomlRecord } from './toml-basic.js';
import { resolveRccUserDir, resolveRccProviderDir } from './user-data-paths.js';
import { isRecord } from '../utils/common-utils.js';

export interface ConfigMigrationReport {
  migrated: string[];
  skipped: string[];
  errors: { path: string; message: string }[];
  summary: string;
}

/**
 * Migrate user config.json → config.toml
 * Reads config.json, writes config.toml with comments preserved template approach.
 */
export function migrateUserConfigJsonToToml(homeDir?: string): ConfigMigrationReport {
  const report: ConfigMigrationReport = { migrated: [], skipped: [], errors: [], summary: '' };
  const userDir = resolveRccUserDir(homeDir);
  const jsonPath = path.join(userDir, 'config.json');
  const tomlPath = path.join(userDir, 'config.toml');

  if (!fs.existsSync(jsonPath)) {
    report.skipped.push(jsonPath);
    report.summary = 'No config.json found; nothing to migrate.';
    return report;
  }

  if (fs.existsSync(tomlPath)) {
    report.skipped.push(jsonPath);
    report.summary = `config.toml already exists at ${tomlPath}; refusing to overwrite.`;
    return report;
  }

  try {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const parsed = parseUserConfigText(raw, 'json');
    if (!isRecord(parsed)) {
      report.errors.push({ path: jsonPath, message: 'Parsed config is not a valid record' });
      return report;
    }

    const tomlContent = serializeTomlRecord(parsed as Record<string, unknown>);
    fs.writeFileSync(tomlPath, tomlContent, 'utf8');
    report.migrated.push(tomlPath);
    report.summary = `Migrated ${jsonPath} → ${tomlPath}`;
  } catch (err) {
    report.errors.push({ path: jsonPath, message: err instanceof Error ? err.message : String(err) });
  }

  return report;
}

/**
 * Migrate a single provider's config.v2.json → config.v2.toml
 */
export function migrateProviderConfigJsonToToml(providerId: string, providerRoot?: string): ConfigMigrationReport {
  const report: ConfigMigrationReport = { migrated: [], skipped: [], errors: [], summary: '' };
  const root = providerRoot || resolveRccProviderDir();
  const providerDir = path.join(root, providerId);
  const jsonPath = path.join(providerDir, 'config.v2.json');
  const tomlPath = path.join(providerDir, 'config.v2.toml');

  if (!fs.existsSync(jsonPath)) {
    report.skipped.push(jsonPath);
    report.summary = `No config.v2.json found for provider "${providerId}" at ${jsonPath}`;
    return report;
  }

  if (fs.existsSync(tomlPath)) {
    report.skipped.push(jsonPath);
    report.summary = `config.v2.toml already exists at ${tomlPath}; refusing to overwrite.`;
    return report;
  }

  try {
    const raw = fs.readFileSync(jsonPath, 'utf8');
    const parsed = parseProviderConfigText(raw, 'json');
    if (!isRecord(parsed)) {
      report.errors.push({ path: jsonPath, message: 'Parsed provider config is not a valid record' });
      return report;
    }

    const tomlContent = serializeTomlRecord(parsed as Record<string, unknown>);
    fs.mkdirSync(providerDir, { recursive: true });
    fs.writeFileSync(tomlPath, tomlContent, 'utf8');
    report.migrated.push(tomlPath);
    report.summary = `Migrated ${jsonPath} → ${tomlPath}`;
  } catch (err) {
    report.errors.push({ path: jsonPath, message: err instanceof Error ? err.message : String(err) });
  }

  return report;
}

/**
 * Migrate all provider configs from config.v2.json to config.v2.toml
 */
export function migrateAllProviderConfigs(homeDir?: string): ConfigMigrationReport {
  const report: ConfigMigrationReport = { migrated: [], skipped: [], errors: [], summary: '' };
  const providerRoot = resolveRccProviderDir(homeDir);

  if (!fs.existsSync(providerRoot)) {
    report.summary = 'Provider root directory does not exist.';
    return report;
  }

  const entries = fs.readdirSync(providerRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const providerId = entry.name;
    const result = migrateProviderConfigJsonToToml(providerId, providerRoot);
    report.migrated.push(...result.migrated);
    report.skipped.push(...result.skipped);
    report.errors.push(...result.errors);
  }

  report.summary = `Migrated ${report.migrated.length}, skipped ${report.skipped.length}, errors ${report.errors.length}`;
  return report;
}

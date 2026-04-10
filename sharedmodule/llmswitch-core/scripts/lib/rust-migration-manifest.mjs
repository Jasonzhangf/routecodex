#!/usr/bin/env node
import fs from 'node:fs';

function normalizeModule(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }
  const id = String(item.id || '').trim();
  const paths = Array.isArray(item.paths) ? item.paths.map((value) => String(value)) : [];
  if (!id || paths.length === 0) {
    return null;
  }
  return {
    id,
    preparedForShadow: item.preparedForShadow === true,
    paths,
    lineThreshold:
      typeof item.lineThreshold === 'number' && Number.isFinite(item.lineThreshold) ? item.lineThreshold : 95,
    branchThreshold:
      typeof item.branchThreshold === 'number' && Number.isFinite(item.branchThreshold) ? item.branchThreshold : 95
  };
}

export function loadRustMigrationManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`migration manifest not found: ${manifestPath}`);
  }
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const modulesRaw = Array.isArray(raw?.modules) ? raw.modules : [];
  const modules = modulesRaw.map(normalizeModule).filter((item) => item !== null);
  return { raw, modules };
}

export function setModulePreparedForShadow(manifestObject, moduleId, prepared) {
  const modules = Array.isArray(manifestObject?.modules) ? manifestObject.modules : [];
  for (let i = 0; i < modules.length; i += 1) {
    const item = modules[i];
    if (!item || typeof item !== 'object') {
      continue;
    }
    const id = String(item.id || '').trim();
    if (id !== moduleId) {
      continue;
    }
    modules[i] = {
      ...item,
      preparedForShadow: Boolean(prepared)
    };
    return true;
  }
  return false;
}

export function writeRustMigrationManifest(manifestPath, manifestObject) {
  const content = `${JSON.stringify(manifestObject, null, 2)}\n`;
  fs.writeFileSync(manifestPath, content, 'utf8');
}

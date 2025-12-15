const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const LEGACY_PROFILE_ALIASES: Record<string, string> = {
  'responses-c4m': 'responses:c4m',
  'responses-c4m-compatibility': 'responses:c4m',
  'responses-fc': 'responses:fc',
  'responses-fai': 'responses:fai'
};

export function resolveCompatibilityModuleTypes(config: unknown): string[] {
  if (!isRecord(config)) {
    return ['compat:passthrough'];
  }
  const cc = config;
  const profileSources: unknown[] = [];
  if (Array.isArray(cc.profiles)) {
    profileSources.push(cc.profiles);
  }
  const compatibility = isRecord(cc.compatibility) ? cc.compatibility : undefined;
  if (compatibility?.profiles) {
    profileSources.push(compatibility.profiles);
  }
  if (Array.isArray(cc.compatibilityProfiles)) {
    profileSources.push(cc.compatibilityProfiles);
  }
  for (const source of profileSources) {
    const arr = normalizeProfileArray(source);
    if (arr.length > 0) {
      return arr;
    }
  }
  const moduleType =
    typeof cc.moduleType === 'string' && cc.moduleType.trim()
      ? normalizeProfileIdentifier(cc.moduleType.trim())
      : undefined;
  return [moduleType || 'compat:passthrough'];
}

function normalizeProfileArray(value: unknown): string[] {
  if (!value) {
    return [];
  }
  const values: string[] = [];
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string' && entry.trim()) {
        const normalized = normalizeProfileIdentifier(entry);
        if (normalized) {
          values.push(normalized);
        }
      }
    }
  } else if (typeof value === 'string' && value.trim()) {
    for (const entry of value.split(/[,\s]+/)) {
      if (!entry.trim()) {
        continue;
      }
      const normalized = normalizeProfileIdentifier(entry);
      if (normalized) {
        values.push(normalized);
      }
    }
  }
  return Array.from(new Set(values));
}

function normalizeProfileIdentifier(value: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.includes(':')) {
    return trimmed;
  }
  const alias = LEGACY_PROFILE_ALIASES[trimmed.toLowerCase()];
  return alias || undefined;
}

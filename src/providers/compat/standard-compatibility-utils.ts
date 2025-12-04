export function resolveCompatibilityModuleTypes(config: unknown): string[] {
  if (!config || typeof config !== 'object') {
    return ['passthrough-compatibility'];
  }
  const cc = config as Record<string, unknown>;
  const profileSources: unknown[] = [];
  if (Array.isArray(cc.profiles)) profileSources.push(cc.profiles);
  if (Array.isArray((cc.compatibility as any)?.profiles)) profileSources.push((cc.compatibility as any).profiles);
  if (Array.isArray(cc.compatibilityProfiles)) profileSources.push(cc.compatibilityProfiles);
  for (const source of profileSources) {
    const arr = normalizeProfileArray(source);
    if (arr.length > 0) {
      return arr;
    }
  }
  const moduleType =
    typeof cc.moduleType === 'string' && cc.moduleType.trim()
      ? cc.moduleType.trim()
      : undefined;
  return [moduleType || 'passthrough-compatibility'];
}

function normalizeProfileArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    const names = value
      .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
      .filter(Boolean);
    return Array.from(new Set(names));
  }
  if (typeof value === 'string' && value.trim()) {
    return value
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

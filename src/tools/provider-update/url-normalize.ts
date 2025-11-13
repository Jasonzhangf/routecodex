export function normalizeBaseUrlForModels(baseUrlRaw: string): string {
  let base = String(baseUrlRaw || '').trim();
  if (!base) return '';
  // Remove trailing slashes
  base = base.replace(/\/$/, '');
  // Avoid duplicating /v1 if already included in path when we append /models
  // For OpenAI style, both with or without /v1 are acceptable; /models should follow the existing prefix
  return base + '/models';
}


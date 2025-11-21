import type { UnknownObject } from '../../../../../../types/common-types.js';
import type { CompatibilityContext } from '../../compatibility-interface.js';
import { UniversalShapeFilter } from '../../filters/universal-shape-filter.js';
import { BlacklistSanitizer } from '../../filters/blacklist-sanitizer.js';
import { sanitizeAndValidateOpenAIChat } from '../../../../utils/preflight-validator.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export async function glmRequestTransform(
  manager: { processRequest: (moduleId: string, data: UnknownObject, ctx: CompatibilityContext) => Promise<UnknownObject> },
  moduleId: string,
  input: UnknownObject,
  context: CompatibilityContext
): Promise<UnknownObject> {
  // 1) 形状修剪 + 黑名单清理（最小兼容）
  let preFiltered = input;
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const shapePath = join(__dirname, '..', 'glm', 'config', 'shape-filters.json');
    const filter = new UniversalShapeFilter({ configPath: shapePath });
    await filter.initialize();
    preFiltered = await filter.applyRequestFilter(preFiltered);
    try {
      const blacklistPath = join(__dirname, '..', 'glm', 'config', 'blacklist-rules.json');
      const bl = new BlacklistSanitizer({ configPath: blacklistPath });
      await bl.initialize();
      preFiltered = await bl.apply(preFiltered);
    } catch { /* ignore blacklist errors */ }
  } catch { /* best-effort */ }

  // 2) 兼容管理器处理（字段映射/校验/hooks）
  let processed = await manager.processRequest(moduleId, preFiltered, context);

  // 3) 最后预检（防 1210/1214）
  const preflight = sanitizeAndValidateOpenAIChat(processed as any, { target: 'glm', enableTools: true, glmPolicy: 'compat' });
  if (Array.isArray(preflight.issues) && preflight.issues.length) {
    const errs = preflight.issues.filter((i: any) => i.level === 'error');
    if (errs.length) {
      const detail = errs.map(e => e.code).join(',');
      throw new Error(`compat-validation-failed: ${detail}`);
    }
  }
  processed = preflight.payload as UnknownObject;
  return processed;
}

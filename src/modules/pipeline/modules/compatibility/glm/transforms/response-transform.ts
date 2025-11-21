import type { UnknownObject } from '../../../../../../types/common-types.js';
import type { CompatibilityContext } from '../../compatibility-interface.js';

export async function glmResponseTransform(
  manager: { processResponse: (moduleId: string, data: UnknownObject, ctx: CompatibilityContext) => Promise<UnknownObject> },
  moduleId: string,
  response: UnknownObject,
  context: CompatibilityContext
): Promise<UnknownObject> {
  return await manager.processResponse(moduleId, response, context);
}


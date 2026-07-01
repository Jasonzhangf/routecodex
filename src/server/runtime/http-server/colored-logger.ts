import { ColoredLogger } from '../../../modules/pipeline/utils/colored-logger.js';

// Local colored logger wrapper that stays aligned with the bundled pipeline utils
// implementation.

export function createServerColoredLogger(): ColoredLogger {
  return new ColoredLogger({ isDev: true });
}

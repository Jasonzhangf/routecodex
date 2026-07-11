/**
 * Session log color bridge surface.
 *
 * Virtual Router hit-log color selection stays Rust-owned; this host file
 * exposes only the narrow color helpers needed by server logging.
 */

import { getRouterHotpathJsonBindingSync } from './native-exports.js';

type SessionLogColorBinding = {
  resolveSessionColorStr?: (sessionId?: string | null) => string;
  resolveSessionLogColorKeyJson?: (inputJson: string) => string;
};

export function getSessionLogColorBinding(): SessionLogColorBinding {
  return getRouterHotpathJsonBindingSync() as SessionLogColorBinding;
}

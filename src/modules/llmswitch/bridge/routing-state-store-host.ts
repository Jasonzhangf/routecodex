/**
 * Routing-state store bridge surface.
 *
 * Routing instruction persistence stays Rust-owned; this host file only
 * exposes the native binding needed by the manager routing-state shell.
 */

import { getRouterHotpathJsonBindingSync } from './native-exports.js';

export { getRouterHotpathJsonBindingSync };

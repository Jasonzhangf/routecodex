/**
 * Traffic-governor bridge surface.
 *
 * Cross-process traffic governance stays Rust-owned; this host file only
 * exposes the native binding needed by the TS traffic-governor shell.
 */

import { getRouterHotpathJsonBindingSync } from './native-exports.js';

export { getRouterHotpathJsonBindingSync };

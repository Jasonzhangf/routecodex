import type { RouterMetadataInput } from '../../types.js';
import { resolveVirtualRouterStickyKeyWithNative } from '../../engine-selection/native-virtual-router-sticky-semantics.js';

export function resolveStickyKey(metadata: RouterMetadataInput): string {
  const stickyKey = resolveVirtualRouterStickyKeyWithNative(metadata as unknown as Record<string, unknown>);
  if (typeof stickyKey === 'string' && stickyKey.trim()) {
    return stickyKey;
  }
  throw new Error('native virtual-router sticky key resolver returned empty result');
}

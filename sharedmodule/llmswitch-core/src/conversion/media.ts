import { isImagePathWithNative } from '../native/router-hotpath/native-shared-conversion-semantics.js';

export function isImagePath(p: unknown): boolean {
  return isImagePathWithNative(p);
}

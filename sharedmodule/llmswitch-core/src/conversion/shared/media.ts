export function isImagePath(p: unknown): boolean {
  try { const s = String(p || '').toLowerCase(); return /\.(png|jpg|jpeg|gif|webp|bmp|svg|tiff?|ico|heic|jxl)$/.test(s); } catch { return false; }
}


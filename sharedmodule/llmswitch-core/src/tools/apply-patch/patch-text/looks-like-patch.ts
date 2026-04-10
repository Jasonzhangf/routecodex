export const looksLikePatch = (text?: string): boolean => {
  if (!text) return false;
  const t = text.trim();
  if (!t) return false;
  return (
    /^(?:\s*)\*\*\*\s*Begin Patch\b/m.test(t) ||
    /^(?:\s*)\*\*\*\s*(?:Update|Add|Create|Delete)\s+File:/m.test(t) ||
    /^diff --git\s/m.test(t) ||
    /^(?:@@|\+\+\+\s|---\s)/m.test(t)
  );
};

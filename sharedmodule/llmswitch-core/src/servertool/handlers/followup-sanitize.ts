const TIME_TAG_BLOCK_RE = /\[Time\/Date\]:.*?(?=(?:\\n|\n|$))/g;
const STOPMESSAGE_MARKER_RE = /<\*\*[\s\S]*?\*\*>/g;
const IMAGE_OMITTED_RE = /\[Image omitted\]/g;

function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

export function sanitizeFollowupText(raw: unknown): string {
  const text = typeof raw === 'string' ? raw : '';
  if (!text.trim()) {
    return '';
  }
  const cleaned = text
    .replace(STOPMESSAGE_MARKER_RE, ' ')
    .replace(TIME_TAG_BLOCK_RE, ' ')
    .replace(IMAGE_OMITTED_RE, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n');
  return collapseBlankLines(cleaned);
}

export function sanitizeFollowupSnapshotText(raw: unknown): string {
  return sanitizeFollowupText(raw);
}

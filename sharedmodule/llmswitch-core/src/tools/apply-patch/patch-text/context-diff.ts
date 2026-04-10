type ContextDiffHunk = {
  oldStart?: number;
  oldCount?: number;
  newStart?: number;
  newCount?: number;
  oldLines: string[];
  newLines: string[];
};

const normalizeHeaderPath = (raw: string): string => {
  const value = String(raw || '').split('\t')[0]?.trim() || '';
  if (!value) return '';
  if (value === '/dev/null') return value;
  const matched = value.match(/^(?:a\/|b\/)?(.+)$/);
  return (matched && matched[1] ? matched[1] : value).trim();
};

export const convertContextDiffToApplyPatch = (text: string): string | null => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const patchLines: string[] = ['*** Begin Patch'];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.startsWith('*** ')) {
      i += 1;
      continue;
    }
    const oldHeader = line.slice(4).trim();
    const newHeaderLine = lines[i + 1] ?? '';
    if (!newHeaderLine.startsWith('--- ')) {
      i += 1;
      continue;
    }
    const newHeader = newHeaderLine.slice(4).trim();
    const filePathRaw = (newHeader && newHeader !== '/dev/null' ? newHeader : oldHeader) || '';
    const filePath = normalizeHeaderPath(filePathRaw);
    if (!filePath) {
      i += 2;
      continue;
    }
    i += 2;

    const hunks: ContextDiffHunk[] = [];
    while (i < lines.length) {
      const marker = lines[i] ?? '';
      if (marker.startsWith('*** ') && (lines[i + 1] ?? '').startsWith('--- ')) {
        break; // next file header
      }
      if (marker.startsWith('***************')) {
        i += 1;
        const oldRangeHeader = lines[i] ?? '';
        if (!oldRangeHeader.startsWith('*** ')) {
          continue;
        }
        const oldRangeMatch = oldRangeHeader.match(/^\*\*\*\s+(\d+)(?:,(\d+))?\s+\*{4}\s*$/);
        i += 1;
        const oldLines: string[] = [];
        while (i < lines.length && !(lines[i] ?? '').startsWith('--- ')) {
          const l = lines[i] ?? '';
          if (l.startsWith('***************')) break;
          if (l.startsWith('*** ') && (lines[i + 1] ?? '').startsWith('--- ')) break;
          oldLines.push(l);
          i += 1;
        }
        const newRangeHeader = lines[i] ?? '';
        if (!newRangeHeader.startsWith('--- ')) {
          continue;
        }
        const newRangeMatch = newRangeHeader.match(/^---\s+(\d+)(?:,(\d+))?\s+-{4}\s*$/);
        i += 1;
        const newLines: string[] = [];
        while (i < lines.length) {
          const l = lines[i] ?? '';
          if (l.startsWith('***************')) break;
          if (l.startsWith('*** ') && (lines[i + 1] ?? '').startsWith('--- ')) break;
          newLines.push(l);
          i += 1;
        }

        const oldStart = oldRangeMatch ? Number.parseInt(oldRangeMatch[1], 10) : undefined;
        const oldEnd = oldRangeMatch && oldRangeMatch[2] ? Number.parseInt(oldRangeMatch[2], 10) : oldStart;
        const newStart = newRangeMatch ? Number.parseInt(newRangeMatch[1], 10) : undefined;
        const newEnd = newRangeMatch && newRangeMatch[2] ? Number.parseInt(newRangeMatch[2], 10) : newStart;
        const oldCount =
          oldStart && oldEnd && Number.isFinite(oldStart) && Number.isFinite(oldEnd)
            ? Math.max(0, oldEnd - oldStart + 1)
            : undefined;
        const newCount =
          newStart && newEnd && Number.isFinite(newStart) && Number.isFinite(newEnd)
            ? Math.max(0, newEnd - newStart + 1)
            : undefined;

        hunks.push({
          oldStart,
          oldCount,
          newStart,
          newCount,
          oldLines,
          newLines
        });
        continue;
      }
      i += 1;
    }

    if (!hunks.length) {
      continue;
    }

    patchLines.push(`*** Update File: ${filePath}`);

    const decodeContextLine = (raw: string): { kind: 'context' | 'delete' | 'add'; text: string } | null => {
      if (raw === undefined || raw === null) return null;
      const lineText = String(raw);
      const lead = lineText[0] ?? '';
      const candidateKinds: Record<string, 'context' | 'delete' | 'add'> = {
        ' ': 'context',
        '!': 'delete',
        '-': 'delete',
        '+': 'add'
      };
      const kind = candidateKinds[lead];
      const content = kind
        ? (() => {
            let rest = lineText.slice(1);
            if (rest.startsWith(' ')) rest = rest.slice(1);
            return rest;
          })()
        : lineText;
      return { kind: kind ?? 'context', text: content };
    };

    for (const hunk of hunks) {
      patchLines.push('@@');
      const oldOps = hunk.oldLines.map(decodeContextLine).filter(Boolean) as Array<ReturnType<typeof decodeContextLine>>;
      const newOpsRaw = hunk.newLines.map(decodeContextLine).filter(Boolean) as Array<ReturnType<typeof decodeContextLine>>;
      // In new-half, "!" denotes replacement (add side) rather than delete.
      const newOps = newOpsRaw.map((op) => {
        if (!op) return op;
        if ((op as any).kind === 'delete') {
          // Interpret '!' (mapped to delete) as add for new-half.
          return { kind: 'add' as const, text: (op as any).text };
        }
        return op as any;
      });

      let oi = 0;
      let ni = 0;
      while (oi < oldOps.length || ni < newOps.length) {
        const o = oi < oldOps.length ? (oldOps[oi] as any) : null;
        const n = ni < newOps.length ? (newOps[ni] as any) : null;

        if (o && n && o.kind === 'context' && n.kind === 'context' && o.text === n.text) {
          patchLines.push(` ${o.text}`);
          oi += 1;
          ni += 1;
          continue;
        }

        if (o && o.kind === 'delete') {
          patchLines.push(`-${o.text}`);
          oi += 1;
          if (n && n.kind === 'add') {
            patchLines.push(`+${n.text}`);
            ni += 1;
          }
          continue;
        }

        if (n && n.kind === 'add') {
          patchLines.push(`+${n.text}`);
          ni += 1;
          continue;
        }

        if (o && o.kind === 'context') {
          patchLines.push(` ${o.text}`);
          oi += 1;
          continue;
        }
        if (n && n.kind === 'context') {
          patchLines.push(` ${n.text}`);
          ni += 1;
          continue;
        }

        // Fallback: advance to avoid infinite loops.
        if (o) oi += 1;
        if (n) ni += 1;
      }
    }
  }

  patchLines.push('*** End Patch');
  const out = patchLines.join('\n').trim();
  return out.includes('*** Update File:') ? out : null;
};

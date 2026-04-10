type GitDiffFile = {
  path: string;
  kind: 'add' | 'delete' | 'update';
  lines: string[];
  oldPath?: string;
  newPath?: string;
  moveTo?: string;
  binary?: boolean;
};

export const convertGitDiffToApplyPatch = (text: string): string | null => {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const files: GitDiffFile[] = [];
  let current: GitDiffFile | null = null;
  let sawDiff = false;

  const flush = (): void => {
    if (!current) return;
    if (current.path && current.kind === 'delete') {
      files.push(current);
      current = null;
      return;
    }
    // Include rename-only diffs (no hunks) when we have a move target.
    if (current.path && (current.lines.length || current.moveTo)) {
      files.push(current);
    }
    current = null;
  };

  const extractPath = (value: string): string => {
    const v = String(value || '').trim();
    if (!v) return '';
    const head = v.split('\t')[0] ?? v;
    const m = String(head).trim().match(/^(?:a\/|b\/)?(.+)$/);
    return (m && m[1] ? m[1] : String(head)).trim();
  };

  for (const line of lines) {
    const diffMatch = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/);
    if (diffMatch) {
      sawDiff = true;
      flush();
      current = {
        path: extractPath(diffMatch[2]),
        kind: 'update',
        lines: [],
        oldPath: extractPath(diffMatch[1]),
        newPath: extractPath(diffMatch[2])
      };
      continue;
    }
    if (!current) continue;

    if (line.startsWith('GIT binary patch') || line.startsWith('Binary files ')) {
      current.binary = true;
      continue;
    }

    const delMatch = line.match(/^deleted file mode\s+/);
    const newMatch = line.match(/^new file mode\s+/);
    if (delMatch) {
      current.kind = 'delete';
      continue;
    }
    if (newMatch) {
      current.kind = 'add';
      continue;
    }

    if (line.startsWith('rename from ')) {
      const p = extractPath(line.slice('rename from '.length));
      if (p) current.oldPath = p;
      continue;
    }
    if (line.startsWith('rename to ')) {
      const p = extractPath(line.slice('rename to '.length));
      if (p) {
        current.newPath = p;
        current.moveTo = p;
      }
      continue;
    }

    if (line.startsWith('--- ')) {
      const p = extractPath(line.slice(4));
      if (p) {
        current.oldPath = p;
        if (p === '/dev/null') current.kind = 'add';
      }
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = extractPath(line.slice(4));
      if (p) {
        current.newPath = p;
        if (p === '/dev/null') current.kind = 'delete';
      }
      continue;
    }

    if (line.startsWith('index ') || line.startsWith('similarity index ') || line.startsWith('dissimilarity index ')) {
      continue;
    }
    if (line.startsWith('@@')) {
      current.lines.push(line);
      continue;
    }
    if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')) {
      current.lines.push(line);
      continue;
    }
  }
  flush();
  if (!sawDiff || files.length === 0) return null;
  if (files.some((f) => f.binary)) return null;

  const out: string[] = ['*** Begin Patch'];
  for (const file of files) {
    const oldPath = typeof file.oldPath === 'string' ? file.oldPath : '';
    const newPath = typeof file.newPath === 'string' ? file.newPath : '';
    const resolvedPath =
      file.kind === 'add'
        ? (newPath && newPath !== '/dev/null' ? newPath : file.path)
        : file.kind === 'delete'
          ? (oldPath && oldPath !== '/dev/null' ? oldPath : file.path)
          : (file.moveTo && oldPath && oldPath !== '/dev/null'
              ? oldPath
              : (newPath && newPath !== '/dev/null' ? newPath : file.path));
    if (file.kind === 'delete') {
      out.push(`*** Delete File: ${resolvedPath}`);
      continue;
    }
    if (file.kind === 'add') {
      out.push(`*** Add File: ${resolvedPath}`);
      for (const l of file.lines) {
        if (l.startsWith('+')) out.push(l);
      }
      continue;
    }
    out.push(`*** Update File: ${resolvedPath}`);
    if (file.moveTo && file.moveTo !== resolvedPath) {
      out.push(`*** Move to: ${file.moveTo}`);
    }
    out.push(...file.lines);
  }
  out.push('*** End Patch');
  return out.join('\n');
};


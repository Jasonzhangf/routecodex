function parseTablePath(rawHeader: string): string[] {
  return rawHeader
    .split('.')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => {
      if (segment.startsWith('"') && segment.endsWith('"')) {
        return JSON.parse(segment) as string;
      }
      return segment;
    });
}

function tablePathEquals(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((item, index) => item === right[index]);
}

function escapeTomlString(value: string): string {
  return JSON.stringify(value);
}

function replaceTomlScalarLine(line: string, key: string, serializedValue: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^(\\s*${escapedKey}\\s*=\\s*)([^#\\r\\n]*?)(\\s*(?:#.*)?)$`);
  const match = line.match(pattern);
  if (!match) {
    return null;
  }
  return `${match[1]}${serializedValue}${match[3] ?? ''}`;
}

export function updateTomlStringScalarInTable(raw: string, tablePath: string[], key: string, value: string): string {
  const lines = raw.split(/\r?\n/);
  const serializedValue = escapeTomlString(value);

  // Root-level key (no table header): update before first [section] or [[array]]
  if (tablePath.length === 0) {
    let rootEnd = lines.length;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        rootEnd = i;
        break;
      }
    }
    for (let i = 0; i < rootEnd; i++) {
      const replaced = replaceTomlScalarLine(lines[i], key, serializedValue);
      if (replaced !== null) {
        lines[i] = replaced;
        return lines.join('\n');
      }
    }
    // Insert before first [section] or at end if no sections
    let insertAt = 0;
    while (insertAt < rootEnd && lines[insertAt].trim() === '') {
      insertAt++;
    }
    lines.splice(insertAt, 0, `${key} = ${serializedValue}`);
    return lines.join('\n');
  }

  let currentTable: string[] = [];
  let targetTableFound = false;
  let targetTableStart = -1;
  let targetTableEnd = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!(trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      continue;
    }
    const isArrayTable = trimmed.startsWith('[[') && trimmed.endsWith(']]');
    if (isArrayTable) {
      continue;
    }
    const parsedPath = parseTablePath(trimmed.slice(1, -1).trim());
    if (targetTableFound) {
      targetTableEnd = i;
      break;
    }
    currentTable = parsedPath;
    if (tablePathEquals(currentTable, tablePath)) {
      targetTableFound = true;
      targetTableStart = i;
    }
  }

  if (!targetTableFound) {
    const suffix = lines.length && lines[lines.length - 1] === '' ? '' : '\n';
    const header = `[${tablePath.join('.')}]`;
    return `${raw}${suffix}\n${header}\n${key} = ${serializedValue}\n`;
  }

  for (let i = targetTableStart + 1; i < targetTableEnd; i++) {
    const replaced = replaceTomlScalarLine(lines[i], key, serializedValue);
    if (replaced !== null) {
      lines[i] = replaced;
      return `${lines.join('\n')}${raw.endsWith('\n') ? '' : '\n'}`.replace(/\n\n$/, '\n\n');
    }
  }

  const insertAt = targetTableEnd;
  lines.splice(insertAt, 0, `${key} = ${serializedValue}`);
  return `${lines.join('\n')}${raw.endsWith('\n') ? '' : '\n'}`;
}

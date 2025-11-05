export function normalizeShellArgsJSON(args: string): string | null {
  try {
    if (typeof args !== 'string' || !args.trim().startsWith('{')) return null;
    const obj = JSON.parse(args);
    if (!obj || typeof obj !== 'object') return null;
    const cmd = (obj as any).command;
    const hasMetaInArray = (arr: any[]): boolean => {
      try {
        const metas = ['|', '&&', '||', ';', '>>', '<<', '>', '<'];
        if (!Array.isArray(arr)) return false;
        const sArr = arr.map((x) => String(x));
        return sArr.some((t) => metas.some((m) => t.includes(m)));
      } catch { return false; }
    };
    if (typeof cmd === 'string' && cmd.trim().length > 0) {
      (obj as any).command = ['bash', '-lc', cmd as string];
      return JSON.stringify(obj);
    }
    if (Array.isArray(cmd) && hasMetaInArray(cmd)) {
      const script = cmd.map((x) => String(x)).join(' ');
      (obj as any).command = ['bash', '-lc', script];
      return JSON.stringify(obj);
    }
    return null;
  } catch { return null; }
}


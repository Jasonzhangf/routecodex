export function parseNetstatListeningPids(stdout: string, port: number): number[] {
  const results = new Set<number>();
  const targetSuffix = `:${port}`;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    // Typical output:
    // TCP    0.0.0.0:5520     0.0.0.0:0     LISTENING       1234
    // TCP    [::]:5520        [::]:0        LISTENING       1234
    const parts = line.split(/\s+/);
    if (parts.length < 5) {
      continue;
    }
    if (parts[0].toUpperCase() !== 'TCP') {
      continue;
    }
    const localAddr = parts[1];
    const state = parts[3]?.toUpperCase();
    if (state !== 'LISTENING' && state !== 'LISTEN') {
      continue;
    }
    if (!localAddr.endsWith(targetSuffix)) {
      continue;
    }
    const pid = Number(parts[4]);
    if (Number.isFinite(pid) && pid > 0) {
      results.add(pid);
    }
  }

  return Array.from(results).sort((a, b) => a - b);
}


const SNAPSHOT_LOCAL_DISK_GATE_TTL_MS = 15 * 60_000;

const snapshotLocalDiskAllowedRoots = new Map<string, number>();

function normalizeSnapshotGateKey(value?: string): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const root = trimmed.split(':')[0]?.trim() || trimmed;
  return root || undefined;
}

function pruneSnapshotLocalDiskGate(now = Date.now()): void {
  for (const [key, updatedAtMs] of snapshotLocalDiskAllowedRoots.entries()) {
    if (now - updatedAtMs >= SNAPSHOT_LOCAL_DISK_GATE_TTL_MS) {
      snapshotLocalDiskAllowedRoots.delete(key);
    }
  }
}

export function allowSnapshotLocalDiskWrite(...candidates: Array<string | undefined>): void {
  const now = Date.now();
  pruneSnapshotLocalDiskGate(now);
  for (const candidate of candidates) {
    const key = normalizeSnapshotGateKey(candidate);
    if (!key) {
      continue;
    }
    snapshotLocalDiskAllowedRoots.set(key, now);
  }
}

export function canWriteSnapshotToLocalDisk(...candidates: Array<string | undefined>): boolean {
  const now = Date.now();
  pruneSnapshotLocalDiskGate(now);
  for (const candidate of candidates) {
    const key = normalizeSnapshotGateKey(candidate);
    if (!key) {
      continue;
    }
    if (snapshotLocalDiskAllowedRoots.has(key)) {
      snapshotLocalDiskAllowedRoots.set(key, now);
      return true;
    }
  }
  return false;
}

export function __resetSnapshotLocalDiskGateForTests(): void {
  snapshotLocalDiskAllowedRoots.clear();
}

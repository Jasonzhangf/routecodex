function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function extractWorkdirHintFromReservationTasks(
  tasks: unknown[],
  reservationTaskIds: Set<string>
): string | undefined {
  if (!Array.isArray(tasks) || reservationTaskIds.size < 1) {
    return undefined;
  }

  const candidates = new Set<string>();
  for (const task of tasks) {
    if (!task || typeof task !== 'object') {
      continue;
    }
    const taskId = readString((task as { taskId?: unknown }).taskId);
    if (!taskId || !reservationTaskIds.has(taskId)) {
      continue;
    }
    const args = (task as { arguments?: unknown }).arguments;
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      continue;
    }
    const workdir =
      readString((args as { workdir?: unknown }).workdir)
      ?? readString((args as { cwd?: unknown }).cwd)
      ?? readString((args as { workingDirectory?: unknown }).workingDirectory);
    if (workdir) {
      candidates.add(workdir);
    }
  }

  if (candidates.size !== 1) {
    return undefined;
  }
  return Array.from(candidates)[0];
}

export function stopSessionDaemonInjectLoop(server: any): void {
  if (server.sessionDaemonInjectTimer) {
    clearInterval(server.sessionDaemonInjectTimer);
    server.sessionDaemonInjectTimer = null;
  }
}

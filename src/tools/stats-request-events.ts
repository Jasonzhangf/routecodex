import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { ProviderUsageEvent } from '@jsonstudio/llms';

const STATS_DIR = path.join(os.homedir(), '.routecodex', 'stats');
const REQUEST_EVENTS_FILE = path.join(STATS_DIR, 'request-events.log');

export async function appendRequestEvent(event: ProviderUsageEvent): Promise<void> {
  try {
    await fs.mkdir(STATS_DIR, { recursive: true });
    const payload = JSON.stringify(event);
    await fs.appendFile(REQUEST_EVENTS_FILE, `${payload}\n`, 'utf8');
  } catch {
    // best-effort only; never block main path
  }
}


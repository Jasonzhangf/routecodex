import { buildTimeTagLine, getClockTimeSnapshot } from '../../../servertool/clock/ntp.js';
import { resolveClockTimeTagFallbackLineWithNative } from '../../../router/virtual-router/engine-selection/native-chat-process-clock-reminder-time-tag-semantics.js';

export const CLOCK_TIME_TAG_FALLBACK_LINE =
  '[Time/Date]: utc=`1970-01-01T00:00:00.000Z` local=`1970-01-01 00:00:00.000 +00:00` tz=`unknown` nowMs=`0` ntpOffsetMs=`0`';

type ClockReminderTimeTagDeps = {
  getClockTimeSnapshotFn?: typeof getClockTimeSnapshot;
  buildTimeTagLineFn?: typeof buildTimeTagLine;
  fallbackLine?: string;
};

export async function resolveClockReminderTimeTagLine(deps: ClockReminderTimeTagDeps = {}): Promise<string> {
  const getClockTimeSnapshotFn = deps.getClockTimeSnapshotFn ?? getClockTimeSnapshot;
  const buildTimeTagLineFn = deps.buildTimeTagLineFn ?? buildTimeTagLine;
  const fallbackLine = resolveClockTimeTagFallbackLineWithNative(
    deps.fallbackLine,
    CLOCK_TIME_TAG_FALLBACK_LINE
  );
  try {
    const snapshot = await getClockTimeSnapshotFn();
    if (snapshot) {
      return buildTimeTagLineFn(snapshot);
    }
  } catch {
    // best-effort
  }
  return fallbackLine;
}

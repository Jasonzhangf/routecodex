import { getClockClientRegistry } from './clock-client-registry.js';
import { isTmuxSessionAlive } from './tmux-session-probe.js';
import { logProcessLifecycle } from '../../../utils/process-lifecycle-logger.js';

const DEFAULT_REAPER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_GRACE_PERIOD_MS = 30 * 1000; // 30 seconds grace before killing

export interface ClockReaperConfig {
  intervalMs?: number;
  gracePeriodMs?: number;
  enableManagedTermination?: boolean;
}

function readReaperIntervalFromEnv(): number {
  const raw = String(
    process.env.ROUTECODEX_CLOCK_REAPER_INTERVAL_MS
      ?? process.env.RCC_CLOCK_REAPER_INTERVAL_MS
      ?? ''
  ).trim();
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 1000) {
    return Math.floor(parsed);
  }
  return DEFAULT_REAPER_INTERVAL_MS;
}

function readGracePeriodFromEnv(): number {
  const raw = String(
    process.env.ROUTECODEX_CLOCK_REAPER_GRACE_MS
      ?? process.env.RCC_CLOCK_REAPER_GRACE_MS
      ?? ''
  ).trim();
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return Math.floor(parsed);
  }
  return DEFAULT_GRACE_PERIOD_MS;
}

function shouldLogStaleOnlyCleanup(): boolean {
  const raw = String(
    process.env.ROUTECODEX_CLOCK_REAPER_LOG_STALE_ONLY
      ?? process.env.RCC_CLOCK_REAPER_LOG_STALE_ONLY
      ?? ''
  ).trim().toLowerCase();
  if (!raw) {
    return false;
  }
  if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on') {
    return true;
  }
  if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'off') {
    return false;
  }
  return false;
}

export class ClockReaper {
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly gracePeriodMs: number;
  private readonly enableManagedTermination: boolean;
  private readonly logStaleOnlyCleanup: boolean;

  constructor(config?: ClockReaperConfig) {
    this.intervalMs = config?.intervalMs ?? readReaperIntervalFromEnv();
    this.gracePeriodMs = config?.gracePeriodMs ?? readGracePeriodFromEnv();
    this.enableManagedTermination = false;
    this.logStaleOnlyCleanup = shouldLogStaleOnlyCleanup();
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.runCleanup().catch((err) => {
        logProcessLifecycle({
          event: 'clock_reaper_error',
          source: 'clock-client-reaper',
          details: { error: err instanceof Error ? err.message : String(err) }
        });
      });
    }, this.intervalMs);

    // 确保 timer 不会阻止进程退出
    if (this.timer.unref) {
      this.timer.unref();
    }

    logProcessLifecycle({
      event: 'clock_reaper_started',
      source: 'clock-client-reaper',
      details: {
        intervalMs: this.intervalMs,
        gracePeriodMs: this.gracePeriodMs,
        enableManagedTermination: this.enableManagedTermination
      }
    });

    // 立即执行一次清理
    void this.runCleanup().catch(() => {});
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logProcessLifecycle({
        event: 'clock_reaper_stopped',
        source: 'clock-client-reaper',
        details: {}
      });
    }
  }

  async runCleanup(): Promise<void> {
    const registry = getClockClientRegistry();
    const now = Date.now();

    // 先清理僵死 tmux 会话
    const deadTmuxResult = registry.cleanupDeadTmuxSessions({
      isTmuxSessionAlive
    });

    // 再清理心跳过期的客户端（但不终止进程，仅移除记录）
    const staleResult = registry.cleanupStaleHeartbeats({
      nowMs: now,
      staleAfterMs: this.gracePeriodMs
    });

    const totalRemovedSessions =
      deadTmuxResult.removedTmuxSessionIds.length +
      staleResult.removedTmuxSessionIds.length;
    const totalKilledSessions = deadTmuxResult.killedTmuxSessionIds.length;
    const totalKilledProcesses = deadTmuxResult.killedManagedClientPids.length;
    const totalFailedKills =
      deadTmuxResult.failedKillTmuxSessionIds.length +
      deadTmuxResult.failedKillManagedClientPids.length;
    const hasDeadTmuxCleanup = deadTmuxResult.removedTmuxSessionIds.length > 0;
    const hasStaleOnlyCleanup =
      staleResult.removedTmuxSessionIds.length > 0 &&
      !hasDeadTmuxCleanup &&
      totalKilledSessions === 0 &&
      totalKilledProcesses === 0 &&
      totalFailedKills === 0;

    if (totalRemovedSessions > 0 || totalKilledSessions > 0 || totalKilledProcesses > 0 || totalFailedKills > 0) {
      if (hasStaleOnlyCleanup && !this.logStaleOnlyCleanup) {
        return;
      }
      logProcessLifecycle({
        event: 'clock_reaper_cleanup',
        source: 'clock-client-reaper',
        details: {
          result: hasStaleOnlyCleanup ? 'stale_only_cleanup' : 'cleanup_performed',
          deadTmuxRemoved: deadTmuxResult.removedTmuxSessionIds.length,
          deadTmuxKilled: deadTmuxResult.killedTmuxSessionIds.length,
          deadTmuxFailedKill: deadTmuxResult.failedKillTmuxSessionIds.length,
          deadTmuxSkippedKill: deadTmuxResult.skippedKillTmuxSessionIds.length,
          staleRemoved: staleResult.removedTmuxSessionIds.length,
          killedProcesses: deadTmuxResult.killedManagedClientPids.length,
          failedKillProcesses: deadTmuxResult.failedKillManagedClientPids.length,
          gracePeriodMs: this.gracePeriodMs,
          enableManagedTermination: this.enableManagedTermination
        }
      });
    }
  }

  getConfig(): { intervalMs: number; gracePeriodMs: number; enableManagedTermination: boolean } {
    return {
      intervalMs: this.intervalMs,
      gracePeriodMs: this.gracePeriodMs,
      enableManagedTermination: this.enableManagedTermination
    };
  }
}

// 单例
let globalReaper: ClockReaper | null = null;

export function getClockReaper(config?: ClockReaperConfig): ClockReaper {
  if (!globalReaper) {
    globalReaper = new ClockReaper(config);
  }
  return globalReaper;
}

export function startClockReaper(config?: ClockReaperConfig): void {
  const reaper = getClockReaper(config);
  reaper.start();
}

export function stopClockReaper(): void {
  if (globalReaper) {
    globalReaper.stop();
    globalReaper = null;
  }
}

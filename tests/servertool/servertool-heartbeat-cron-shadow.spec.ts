import * as fs from "node:fs";
import * as path from "node:path";
import { jest } from "@jest/globals";

import {
  listHeartbeatHistory,
  loadHeartbeatState,
  runHeartbeatDaemonTickForTests,
  saveHeartbeatState,
  setHeartbeatEnabled,
  setHeartbeatRuntimeHooks,
  stopHeartbeatDaemonForTests,
  resetHeartbeatRuntimeHooksForTests,
} from "../../sharedmodule/llmswitch-core/src/servertool/heartbeat/task-store.js";

const SESSION_DIR = path.join(
  process.cwd(),
  "tmp",
  "jest-heartbeat-cron-shadow-sessions",
);

function resetSessionDir(): void {
  fs.rmSync(SESSION_DIR, { recursive: true, force: true });
  fs.mkdirSync(SESSION_DIR, { recursive: true });
}

describe("servertool:heartbeat cron shadow diagnostics", () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
  });

  beforeEach(async () => {
    resetSessionDir();
    resetHeartbeatRuntimeHooksForTests();
    await stopHeartbeatDaemonForTests();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    resetHeartbeatRuntimeHooksForTests();
    await stopHeartbeatDaemonForTests();
  });

  test("daemon tick persists cron-shadow diagnostic for minute-aligned heartbeat intervals", async () => {
    const tmuxSessionId = "hb-cron-shadow-10m";
    const lastTriggeredAtMs = Date.parse("2026-03-18T04:00:00.000Z");
    const observedAtMs = lastTriggeredAtMs + 10 * 60_000 + 42_000;

    const state = await setHeartbeatEnabled(tmuxSessionId, true, {
      intervalMs: 10 * 60_000,
      source: "test",
    });
    await saveHeartbeatState({
      ...state,
      updatedAtMs: lastTriggeredAtMs,
      lastTriggeredAtMs,
      triggerCount: 1,
    });

    const dispatchHeartbeat = jest.fn(async () => ({ ok: true }));
    setHeartbeatRuntimeHooks({
      isTmuxSessionAlive: () => true,
      dispatchHeartbeat,
    });
    jest.spyOn(Date, "now").mockReturnValue(observedAtMs);

    await runHeartbeatDaemonTickForTests();

    expect(dispatchHeartbeat).toHaveBeenCalledTimes(1);
    const next = await loadHeartbeatState(tmuxSessionId);
    expect(next.lastScheduleDiagnostic).toEqual(
      expect.objectContaining({
        phase: "triggered",
        observedAtMs,
        effectiveIntervalMs: 10 * 60_000,
        dueAtMs: lastTriggeredAtMs + 10 * 60_000,
        latenessMs: 42_000,
        cronShadow: expect.objectContaining({
          supported: true,
          expression: "*/10 * * * *",
          previousBoundaryAtMs: lastTriggeredAtMs + 10 * 60_000,
          nextBoundaryAtMs: lastTriggeredAtMs + 20 * 60_000,
          offsetFromPreviousBoundaryMs: 42_000,
        }),
      }),
    );

    const history = await listHeartbeatHistory({ tmuxSessionId, limit: 10 });
    const triggerEvent = history.find(
      (event) => event.action === "trigger" && event.outcome === "triggered",
    );
    expect(triggerEvent?.details).toEqual(
      expect.objectContaining({
        scheduleDiagnostic: expect.objectContaining({
          phase: "triggered",
          observedAtMs,
          latenessMs: 42_000,
        }),
      }),
    );
  });

  test("daemon tick marks cron shadow unsupported for sub-minute heartbeat intervals", async () => {
    const tmuxSessionId = "hb-cron-shadow-30s";
    const lastTriggeredAtMs = Date.parse("2026-03-18T04:00:00.000Z");
    const observedAtMs = lastTriggeredAtMs + 31_000;

    const state = await setHeartbeatEnabled(tmuxSessionId, true, {
      intervalMs: 30_000,
      source: "test",
    });
    await saveHeartbeatState({
      ...state,
      updatedAtMs: lastTriggeredAtMs,
      lastTriggeredAtMs,
      triggerCount: 1,
    });

    setHeartbeatRuntimeHooks({
      isTmuxSessionAlive: () => true,
      dispatchHeartbeat: async () => ({ ok: false, skipped: true, reason: "session_execution_active" }),
    });
    jest.spyOn(Date, "now").mockReturnValue(observedAtMs);

    await runHeartbeatDaemonTickForTests();

    const next = await loadHeartbeatState(tmuxSessionId);
    expect(next.lastScheduleDiagnostic).toEqual(
      expect.objectContaining({
        phase: "skipped",
        observedAtMs,
        effectiveIntervalMs: 30_000,
        latenessMs: 1_000,
        reason: "session_execution_active",
        cronShadow: {
          supported: false,
          reason: "interval_lt_one_minute",
        },
      }),
    );
  });
});

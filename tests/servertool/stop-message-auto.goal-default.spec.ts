import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test, beforeEach, afterEach } from "@jest/globals";
import { runServerToolOrchestration } from "../../sharedmodule/llmswitch-core/src/servertool/engine.js";
import {
  serializeRoutingInstructionState,
  type RoutingInstructionState,
} from "../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.js";
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync,
} from "../../sharedmodule/llmswitch-core/src/native/router-hotpath/native-virtual-router-routing-state.js";
import type { JsonObject } from "../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js";
import type { AdapterContext } from "../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js";
import { resetStopMessageRuntimeConfigCacheForTests } from "../../sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/config.js";
import { MetadataCenter } from "../../src/server/runtime/http-server/metadata-center/metadata-center.js";

const SESSION_DIR = path.join(
  process.cwd(),
  "tmp",
  "jest-stopmessage-goal-default",
);
const STOPMESSAGE_CONFIG_PATH = path.join(SESSION_DIR, "stop-message.json");
const PREV_SESSION_DIR = process.env.ROUTECODEX_SESSION_DIR;
const PREV_DEFAULT_ENABLED = process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED;
const PREV_DEFAULT_MAX = process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS;
const PREV_CONFIG_PATH = process.env.ROUTECODEX_STOPMESSAGE_CONFIG_PATH;

function writeRoutingStateForSession(
  sessionId: string,
  state: RoutingInstructionState,
): void {
  saveRoutingInstructionStateSync(`session:${sessionId}`, state);
}

function readState(sessionId: string): Record<string, unknown> | undefined {
  const state = loadRoutingInstructionStateSync(`session:${sessionId}`);
  return state ? serializeRoutingInstructionState(state) : undefined;
}

function buildStopChatResponse(): JsonObject {
  return {
    id: "chatcmpl-stop-goal-default",
    object: "chat.completion",
    model: "gpt-test",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "ok",
        },
        finish_reason: "stop",
      },
    ],
  };
}

function buildToolCallChatResponse(): JsonObject {
  return {
    id: "chatcmpl-stop-goal-default-tool-call",
    object: "chat.completion",
    model: "gpt-test",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_reset_budget",
              type: "function",
              function: {
                name: "client_tool",
                arguments: "{}",
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function buildLengthChatResponse(): JsonObject {
  return {
    id: "chatcmpl-stop-goal-default-length",
    object: "chat.completion",
    model: "gpt-test",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: "partial",
        },
        finish_reason: "length",
      },
    ],
  };
}

function buildAdapterContext(sessionId: string): AdapterContext {
  const adapterContext = {
    requestId: `req-${sessionId}`,
    entryEndpoint: "/v1/chat/completions",
    providerProtocol: "openai-chat",
    sessionId,
    capturedChatRequest: {
      model: "gpt-test",
      messages: [{ role: "user", content: "继续处理" }],
    },
  } as any;
  MetadataCenter.attach(adapterContext);
  return adapterContext;
}

function runStopOrchestration(args: {
  sessionId: string;
  requestId: string;
  adapterContext?: AdapterContext;
  clientInjectDispatch?: (options: {
    entryEndpoint: string;
    requestId: string;
    body?: JsonObject;
    metadata?: JsonObject;
  }) => Promise<{ ok: boolean; reason?: string }>;
}) {
  return runServerToolOrchestration({
    chat: buildStopChatResponse(),
    adapterContext: args.adapterContext ?? buildAdapterContext(args.sessionId),
    entryEndpoint: "/v1/chat/completions",
    requestId: args.requestId,
    providerProtocol: "openai-chat",
    clientInjectDispatch:
      args.clientInjectDispatch ?? (async () => ({ ok: true })),
    reenterPipeline: async () => {
      throw new Error("stop_message_flow must not reenter pipeline");
    },
  });
}

function buildGoalOnlyStickyState(
  status: "active" | "completed",
): RoutingInstructionState {
  return {
    stoplessGoalState: {
      status,
      objective: `${status}-goal`,
      createdAt: 100,
      updatedAt: 100,
    },
    forcedTarget: undefined,
    preferTarget: undefined,
    allowedProviders: new Set<string>(),
    disabledProviders: new Set<string>(),
    disabledKeys: new Map<string, Set<string | number>>(),
    disabledModels: new Map<string, Set<string>>(),
    stopMessageSource: undefined,
    stopMessageText: undefined,
    stopMessageMaxRepeats: undefined,
    stopMessageUsed: undefined,
    stopMessageUpdatedAt: undefined,
    stopMessageLastUsedAt: undefined,
    stopMessageStageMode: undefined,
    stopMessageAiMode: undefined,
    stopMessageAiSeedPrompt: undefined,
    stopMessageAiHistory: undefined,
    preCommandSource: undefined,
    preCommandScriptPath: undefined,
    preCommandUpdatedAt: undefined,
  };
}

function buildStopMessageState(overrides: Partial<RoutingInstructionState> = {}): RoutingInstructionState {
  return {
    forcedTarget: undefined,
    preferTarget: undefined,
    allowedProviders: new Set<string>(),
    disabledProviders: new Set<string>(),
    disabledKeys: new Map<string, Set<string | number>>(),
    disabledModels: new Map<string, Set<string>>(),
    stopMessageSource: "default",
    stopMessageText: "继续执行",
    stopMessageMaxRepeats: 3,
    stopMessageUsed: 1,
    stopMessageUpdatedAt: Date.now(),
    stopMessageLastUsedAt: Date.now(),
    stopMessageStageMode: "on",
    stopMessageAiMode: undefined,
    stopMessageAiSeedPrompt: undefined,
    stopMessageAiHistory: undefined,
    preCommandSource: undefined,
    preCommandScriptPath: undefined,
    preCommandUpdatedAt: undefined,
    ...overrides,
  };
}

describe("stop_message_auto current goal/default contract", () => {
  beforeEach(() => {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    resetStopMessageRuntimeConfigCacheForTests();
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
    process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED = "1";
    process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS = "3";
    process.env.ROUTECODEX_STOPMESSAGE_CONFIG_PATH = STOPMESSAGE_CONFIG_PATH;
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    fs.writeFileSync(
      STOPMESSAGE_CONFIG_PATH,
      JSON.stringify({
        default: {
          enabled: true,
          text: "继续执行",
          maxRepeats: 3,
        },
      }),
      "utf8",
    );
  });

  afterEach(() => {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    resetStopMessageRuntimeConfigCacheForTests();
    if (PREV_SESSION_DIR === undefined) {
      delete process.env.ROUTECODEX_SESSION_DIR;
    } else {
      process.env.ROUTECODEX_SESSION_DIR = PREV_SESSION_DIR;
    }
    if (PREV_DEFAULT_ENABLED === undefined) {
      delete process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED;
    } else {
      process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED = PREV_DEFAULT_ENABLED;
    }
    if (PREV_DEFAULT_MAX === undefined) {
      delete process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS;
    } else {
      process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_MAX_REPEATS = PREV_DEFAULT_MAX;
    }
    if (PREV_CONFIG_PATH === undefined) {
      delete process.env.ROUTECODEX_STOPMESSAGE_CONFIG_PATH;
    } else {
      process.env.ROUTECODEX_STOPMESSAGE_CONFIG_PATH = PREV_CONFIG_PATH;
    }
  });

  test("/goal active 缺少 hook 结果时显式 fail-fast", async () => {
    const sessionId = "goal-active-skip";
    const now = Date.now();
    const adapterContext = {
      ...buildAdapterContext(sessionId),
      stoplessGoalState: {
        status: "active",
        objective: "live goal",
        createdAt: now,
        updatedAt: now,
      },
    } as any;
    await expect(
      runStopOrchestration({
        sessionId,
        adapterContext,
        requestId: "req-goal-active-skip",
      }),
    ).rejects.toMatchObject({
      code: "SERVERTOOL_REQUIRED_RESPONSE_HOOK_EMPTY",
    });
    expect(adapterContext.stoplessGoalState).toMatchObject({
      status: "active",
    });
    expect(readState(sessionId)).toBeUndefined();
  });

  test("非 /goal 缺 schema 时继续投影 stopless flow，但不再持久化旧 stopMessage 计数", async () => {
    const sessionId = "non-goal-default-repeat-3";
    const runOnce = (requestId: string) =>
      runServerToolOrchestration({
        chat: buildStopChatResponse(),
        adapterContext: buildAdapterContext(sessionId),
        entryEndpoint: "/v1/chat/completions",
        requestId,
        providerProtocol: "openai-chat",
        clientInjectDispatch: async () => ({ ok: true }),
        reenterPipeline: async () => {
          throw new Error("stop_message_flow must not reenter pipeline");
        },
      });
    const first = await runOnce("req-non-goal-default-repeat-1");
    expect(first.executed).toBe(true);
    expect(first.flowId).toBe("stop_message_flow");
    expect(readState(sessionId)).toMatchObject({
      stopMessageSource: "default",
      stopMessageStageMode: "on",
      stopMessageMaxRepeats: 3,
      stopMessageUsed: 3,
    });

    const second = await runOnce("req-non-goal-default-repeat-2");
    expect(second.executed).toBe(true);
    expect(second.flowId).toBe("stop_message_flow");
    expect(readState(sessionId)?.stopMessageUsed).toBe(3);

    const third = await runOnce("req-non-goal-default-repeat-3");
    expect(third.executed).toBe(true);
    expect(third.flowId).toBe("stop_message_flow");
    expect(readState(sessionId)?.stopMessageUsed).toBe(3);

    const fourth = await runOnce("req-non-goal-default-repeat-4");
    expect(fourth.executed).toBe(true);
    expect(fourth.flowId).toBe("stop_message_flow");
    expect(readState(sessionId)?.stopMessageUsed).toBe(3);
  });

  test("非 /goal 场景出现 tool call 时不进入 stopless，也不推进既有 stopMessage 计数", async () => {
    const sessionId = "non-goal-default-reset-after-tool-call";
    writeRoutingStateForSession(sessionId, buildStopMessageState());
    const toolCall = await runServerToolOrchestration({
      chat: buildToolCallChatResponse(),
      adapterContext: buildAdapterContext(sessionId),
      entryEndpoint: "/v1/chat/completions",
      requestId: "req-reset-after-tool-call",
      providerProtocol: "openai-chat",
    });
    expect(toolCall.executed).toBe(false);
    expect(readState(sessionId)).toMatchObject({
      stopMessageSource: "default",
      stopMessageUsed: 1,
      stopMessageMaxRepeats: 3,
    });
  });

  test("非 /goal 场景出现非 stop finish_reason 不触发 stopless，也不推进既有 stopMessage 计数", async () => {
    const sessionId = "non-goal-default-reset-after-non-stop";
    writeRoutingStateForSession(sessionId, buildStopMessageState());
    const nonStop = await runServerToolOrchestration({
      chat: buildLengthChatResponse(),
      adapterContext: buildAdapterContext(sessionId),
      entryEndpoint: "/v1/chat/completions",
      requestId: "req-reset-after-length",
      providerProtocol: "openai-chat",
    });
    expect(nonStop.executed).toBe(false);
    expect(readState(sessionId)).toMatchObject({
      stopMessageSource: "default",
      stopMessageUsed: 1,
      stopMessageMaxRepeats: 3,
    });
  });

  test("非 /goal 场景即使 sticky 里有 completed goal 也继续 stopless，但不补写旧 stopMessage 计数", async () => {
    const sessionId = "non-goal-sticky-completed-repeat";
    writeRoutingStateForSession(
      sessionId,
      buildGoalOnlyStickyState("completed"),
    );

    const result = await runStopOrchestration({
      sessionId,
      requestId: "req-non-goal-sticky-completed-skip",
    });

    expect(result.executed).toBe(true);
    expect(result.flowId).toBe("stop_message_flow");
    expect(readState(sessionId)?.stoplessGoalState).toMatchObject({
      status: "completed",
    });
    expect(readState(sessionId)?.stopMessageUsed).toBeUndefined();
  });

  test("sticky 里有 active goal 但当前请求非显式 /goal 时仍继续 stopless，并保留 goal sticky state", async () => {
    const sessionId = "sticky-active-goal-skip";
    writeRoutingStateForSession(sessionId, buildGoalOnlyStickyState("active"));

    const result = await runStopOrchestration({
      sessionId,
      requestId: "req-non-goal-sticky-active-skip",
    });

    expect(result.executed).toBe(true);
    expect(result.flowId).toBe("stop_message_flow");
    expect(readState(sessionId)?.stoplessGoalState).toMatchObject({
      status: "active",
    });
    expect(readState(sessionId)?.stopMessageUsed).toBeUndefined();
  });

  test("/goal completed 当前仍走 stopless projection，并写入默认 stopMessage state", async () => {
    const sessionId = "goal-completed-default-repeat-1";
    const now = Date.now();
    const adapterContext = {
      ...buildAdapterContext(sessionId),
      stoplessGoalState: {
        status: "completed",
        objective: "finished goal",
        createdAt: now,
        updatedAt: now,
      },
    } as any;

    const first = await runStopOrchestration({
      sessionId,
      adapterContext,
      requestId: "req-goal-completed-repeat-1",
    });
    expect(first.executed).toBe(true);
    expect(first.flowId).toBe("stop_message_flow");
    expect(readState(sessionId)).toMatchObject({
      stopMessageSource: "default",
      stopMessageStageMode: "on",
      stopMessageMaxRepeats: 3,
      stopMessageUsed: 3,
    });
  });
});

import * as fs from "node:fs";
import * as path from "node:path";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "@jest/globals";

import type { AdapterContext } from "../../sharedmodule/llmswitch-core/src/conversion/hub/types/chat-envelope.js";
import type { JsonObject } from "../../sharedmodule/llmswitch-core/src/conversion/hub/types/json.js";
import { runServerToolOrchestration } from "../../sharedmodule/llmswitch-core/src/servertool/engine.js";
import { runServertoolResponseStageOrchestrationShell } from "../../sharedmodule/llmswitch-core/src/servertool/response-stage-orchestration-shell.js";
import {
  loadRoutingInstructionStateSync,
  saveRoutingInstructionStateSync,
} from "../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-state-store.js";
import type { RoutingInstructionState } from "../../sharedmodule/llmswitch-core/src/router/virtual-router/routing-instructions.js";
import { resetStopMessageRuntimeConfigCacheForTests } from "../../sharedmodule/llmswitch-core/src/servertool/handlers/stop-message-auto/config.js";

const SESSION_DIR = path.join(
  process.cwd(),
  "tmp",
  "jest-stop-message-flow-followup-sessions",
);
const STOPMESSAGE_CONFIG_PATH = path.join(SESSION_DIR, "stop-message.json");
const PREV_SESSION_DIR = process.env.ROUTECODEX_SESSION_DIR;
const PREV_CONFIG_PATH = process.env.ROUTECODEX_STOPMESSAGE_CONFIG_PATH;
const PREV_DEFAULT_ENABLED = process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED;

function buildStopResponse(content = "done"): JsonObject {
  return {
    id: "chatcmpl_stop_message_flow_followup",
    object: "chat.completion",
    model: "gpt-test",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: {
          role: "assistant",
          content,
        },
      },
    ],
  };
}

function buildToolCallsResponse(): JsonObject {
  return {
    id: "chatcmpl_stop_message_flow_tool_calls",
    object: "chat.completion",
    model: "gpt-test",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: {
                name: "apply_patch",
                arguments: '{"filePath":"tmp/a.txt","patch":"+ hello"}',
              },
            },
          ],
        },
      },
    ],
  };
}

function createEmptyRoutingInstructionState(): RoutingInstructionState {
  return {
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
    reasoningStopMode: undefined,
    reasoningStopArmed: undefined,
    reasoningStopSummary: undefined,
    reasoningStopUpdatedAt: undefined,
    preCommandSource: undefined,
    preCommandScriptPath: undefined,
    preCommandUpdatedAt: undefined,
  };
}

describe("stop_message_flow reentry", () => {
  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
    process.env.ROUTECODEX_STOPMESSAGE_CONFIG_PATH = STOPMESSAGE_CONFIG_PATH;
    process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED = "1";
  });

  afterAll(() => {
    if (PREV_SESSION_DIR === undefined) {
      delete process.env.ROUTECODEX_SESSION_DIR;
    } else {
      process.env.ROUTECODEX_SESSION_DIR = PREV_SESSION_DIR;
    }
    if (PREV_CONFIG_PATH === undefined) {
      delete process.env.ROUTECODEX_STOPMESSAGE_CONFIG_PATH;
    } else {
      process.env.ROUTECODEX_STOPMESSAGE_CONFIG_PATH = PREV_CONFIG_PATH;
    }
    if (PREV_DEFAULT_ENABLED === undefined) {
      delete process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED;
    } else {
      process.env.ROUTECODEX_STOPMESSAGE_DEFAULT_ENABLED = PREV_DEFAULT_ENABLED;
    }
    resetStopMessageRuntimeConfigCacheForTests();
  });

  beforeEach(() => {
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    resetStopMessageRuntimeConfigCacheForTests();
    fs.writeFileSync(
      STOPMESSAGE_CONFIG_PATH,
      JSON.stringify({
        default: { enabled: true, text: "继续执行", maxRepeats: 3 },
        aiFollowup: { enabled: false },
      }),
      "utf8",
    );
  });

  test("skips stop_message_flow when the hop is already followup", async () => {
    const sessionId = "stop-message-flow-followup-hop";
    const stateKey = `session:${sessionId}`;
    const state = createEmptyRoutingInstructionState();
    state.stopMessageText = "继续执行";
    state.stopMessageMaxRepeats = 3;
    state.stopMessageUsed = 0;
    state.stopMessageUpdatedAt = Date.now();
    saveRoutingInstructionStateSync(stateKey, state);

    const clientInjectDispatch = jest.fn(async () => ({ ok: true }) as const);
    const reenterPipeline = jest.fn(async () => ({ body: buildStopResponse("reentered") }));

    const result = await runServerToolOrchestration({
      chat: buildStopResponse("再次停止"),
      adapterContext: {
        sessionId,
        capturedChatRequest: {
          model: "gpt-test",
          messages: [{ role: "user", content: "start" }],
        },
        __rt: { serverToolFollowup: true },
      } as unknown as AdapterContext,
      requestId: "req_stop_message_flow_followup_hop",
      entryEndpoint: "/v1/chat/completions",
      providerProtocol: "openai-chat",
      clientInjectDispatch,
      reenterPipeline,
    });

    expect(result.executed).toBe(false);
    expect(clientInjectDispatch).not.toHaveBeenCalled();
    expect(reenterPipeline).not.toHaveBeenCalled();
    expect(loadRoutingInstructionStateSync(stateKey)?.stopMessageUsed).toBe(0);
  });

  test("non-goal stopless default uses reenter for three consecutive stop turns then stops", async () => {
    const sessionId = "stopless-default-three-turns";
    const stateKey = `session:${sessionId}`;
    const clientInjectDispatch = jest.fn(async () => ({ ok: true }) as const);
    const reenterPipeline = jest.fn(async () => ({ body: buildStopResponse("reentered") }));

    for (let index = 0; index < 3; index += 1) {
      const result = await runServerToolOrchestration({
        chat: buildStopResponse(`stop-${index + 1}`),
        adapterContext: {
          sessionId,
          capturedChatRequest: {
            model: "gpt-test",
            messages: [{ role: "user", content: "start" }],
          },
        } as unknown as AdapterContext,
        requestId: `req_stopless_default_${index + 1}`,
        entryEndpoint: "/v1/chat/completions",
        providerProtocol: "openai-chat",
        clientInjectDispatch,
        reenterPipeline,
      });

      expect(result.executed).toBe(true);
      expect(result.flowId).toBe("stop_message_flow");
      expect(loadRoutingInstructionStateSync(stateKey)?.stopMessageUsed).toBe(
        index + 1,
      );
    }

    const exhausted = await runServerToolOrchestration({
      chat: buildStopResponse("stop-4"),
      adapterContext: {
        sessionId,
        stopMessageClientInjectSessionScope: `session:${sessionId}`,
        capturedChatRequest: {
          model: "gpt-test",
          messages: [{ role: "user", content: "start" }],
        },
      } as unknown as AdapterContext,
      requestId: "req_stopless_default_4",
      entryEndpoint: "/v1/chat/completions",
      providerProtocol: "openai-chat",
      clientInjectDispatch,
      reenterPipeline,
    });

    expect(exhausted.executed).toBe(false);
    expect(clientInjectDispatch).not.toHaveBeenCalled();
    expect(reenterPipeline).toHaveBeenCalledTimes(3);
  });

  test("servertool followup hop stop does not trigger stopless client injection", async () => {
    const sessionId = "stopless-after-apply-patch-followup-stop";
    const stateKey = `session:${sessionId}`;
    const clientInjectDispatch = jest.fn(async () => ({ ok: true }) as const);
    const reenterPipeline = jest.fn(async () => ({ body: buildStopResponse("reentered") }));

    const result = await runServerToolOrchestration({
      chat: buildStopResponse("apply_patch followup stopped"),
      adapterContext: {
        sessionId,
        capturedChatRequest: {
          model: "gpt-test",
          messages: [{ role: "user", content: "start" }],
        },
        __rt: {
          serverToolFollowup: true,
          serverToolFollowupFlowId: "apply_patch_flow",
        },
      } as unknown as AdapterContext,
      requestId: "req_stopless_after_apply_patch_followup_stop",
      entryEndpoint: "/v1/chat/completions",
      providerProtocol: "openai-chat",
      clientInjectDispatch,
      reenterPipeline,
    });

    expect(result.executed).toBe(false);
    expect(result.flowId).toBeUndefined();
    expect(clientInjectDispatch).not.toHaveBeenCalled();
    expect(reenterPipeline).not.toHaveBeenCalled();
    expect(loadRoutingInstructionStateSync(stateKey)?.stopMessageUsed).toBeUndefined();
  });

  test("servertool loop-state followup stop does not become a second stopless trigger", async () => {
    const sessionId = "stopless-after-loop-state-followup-stop";
    const clientInjectDispatch = jest.fn(async () => ({ ok: true }) as const);
    const reenterPipeline = jest.fn(async () => {
      throw new Error("stop_message_flow must not reenter pipeline");
    });

    const result = await runServerToolOrchestration({
      chat: buildStopResponse("loop-state followup stopped"),
      adapterContext: {
        sessionId,
        capturedChatRequest: {
          model: "gpt-test",
          messages: [{ role: "user", content: "start" }],
        },
        __rt: {
          serverToolFollowup: true,
          serverToolLoopState: {
            flowId: "apply_patch_flow",
          },
        },
      } as unknown as AdapterContext,
      requestId: "req_stopless_after_loop_state_followup_stop",
      entryEndpoint: "/v1/responses",
      providerProtocol: "openai-responses",
      clientInjectDispatch,
      reenterPipeline,
    });

    expect(result.executed).toBe(false);
    expect(clientInjectDispatch).not.toHaveBeenCalled();
    expect(reenterPipeline).not.toHaveBeenCalled();
  });

  test("response-stage followup hop does not trigger stopless when apply_patch followup returns stop", async () => {
    const sessionId = "response-stage-apply-patch-followup-stopless";
    const clientInjectDispatch = jest.fn(async () => ({ ok: true }) as const);
    const reenterPipeline = jest.fn(async () => {
      throw new Error("stop_message_flow must not reenter pipeline");
    });

    const result = await runServertoolResponseStageOrchestrationShell({
      payload: buildStopResponse("apply_patch followup stopped") as any,
      adapterContext: {
        sessionId,
        capturedChatRequest: {
          model: "gpt-test",
          messages: [{ role: "user", content: "start" }],
        },
        __rt: {
          serverToolFollowup: true,
        },
      } as unknown as AdapterContext,
      requestId: "req_response_stage_apply_patch_followup_stopless",
      entryEndpoint: "/v1/chat/completions",
      providerProtocol: "openai-chat",
      clientInjectDispatch,
      reenterPipeline,
    });

    expect(result.executed).toBe(false);
    expect(result.flowId).toBeUndefined();
    expect(clientInjectDispatch).not.toHaveBeenCalled();
    expect(reenterPipeline).not.toHaveBeenCalled();
  });

  test("openai-responses relay chat.completion stop is not a second stopless trigger", async () => {
    const sessionId = "responses-relay-chat-completion-stopless";
    const clientInjectDispatch = jest.fn(async () => ({ ok: true }) as const);
    const reenterPipeline = jest.fn(async () => {
      throw new Error("stop_message_flow must not reenter pipeline");
    });

    const result = await runServertoolResponseStageOrchestrationShell({
      payload: buildStopResponse("responses relay stopped") as any,
      adapterContext: {
        sessionId,
        entryEndpoint: "/v1/responses",
        providerProtocol: "openai-responses",
        stopMessageClientInjectSessionScope: `session:${sessionId}`,
        metadata: {
          stopMessageClientInjectSessionScope: `session:${sessionId}`,
        },
        capturedChatRequest: {
          model: "gpt-test",
          messages: [{ role: "user", content: "start" }],
        },
      } as unknown as AdapterContext,
      requestId: "req_responses_relay_chat_completion_stopless",
      entryEndpoint: "/v1/responses",
      providerProtocol: "openai-responses",
      clientInjectDispatch,
      reenterPipeline,
    });

    expect(result.executed).toBe(false);
    expect(clientInjectDispatch).not.toHaveBeenCalled();
    expect(reenterPipeline).not.toHaveBeenCalled();
  });
});

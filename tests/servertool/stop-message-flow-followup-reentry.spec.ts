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

  test("continues stop_message_flow when followup hop stops again", async () => {
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
          tools: [
            {
              type: "function",
              function: { name: "exec_command", parameters: { type: "object" } },
            },
          ],
        },
        __rt: {
          serverToolFollowup: true,
          serverToolLoopState: { flowId: "stop_message_flow", maxRepeats: 3 },
        },
      } as unknown as AdapterContext,
      requestId: "req_stop_message_flow_followup_hop",
      entryEndpoint: "/v1/chat/completions",
      providerProtocol: "openai-chat",
      clientInjectDispatch,
      reenterPipeline,
    });

    expect(result.executed).toBe(true);
    expect(result.flowId).toBe("stop_message_flow");
    expect(clientInjectDispatch).not.toHaveBeenCalled();
    expect(reenterPipeline).toHaveBeenCalledTimes(1);
    const followupBody = reenterPipeline.mock.calls[0]?.[0]?.body as Record<string, unknown>;
    expect((followupBody.tools as any[])?.[0]?.function?.name).toBe("exec_command");
    const messages = followupBody.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "user", content: "start" });
    expect(messages.at(-1)?.role).toBe("user");
    expect(String(messages.at(-1)?.content)).toContain("Stop schema 校验未通过");
    expect(String(messages.at(-1)?.content)).toContain("必须在本轮直接发出工具调用");
    expect(loadRoutingInstructionStateSync(stateKey)?.stopMessageUsed).toBe(1);
  });

  test("tool call response resets consecutive stop_message_flow count", async () => {
    const sessionId = "stop-message-flow-tool-call-reset";
    const stateKey = `session:${sessionId}`;
    const state = createEmptyRoutingInstructionState();
    state.stopMessageText = "继续执行";
    state.stopMessageMaxRepeats = 3;
    state.stopMessageUsed = 1;
    state.stopMessageUpdatedAt = Date.now();
    saveRoutingInstructionStateSync(stateKey, state);

    const clientInjectDispatch = jest.fn(async () => ({ ok: true }) as const);
    const reenterPipeline = jest.fn(async () => ({ body: buildStopResponse("reentered") }));

    const result = await runServerToolOrchestration({
      chat: buildToolCallsResponse(),
      adapterContext: {
        sessionId,
        capturedChatRequest: {
          model: "gpt-test",
          messages: [{ role: "user", content: "start" }],
        },
        __rt: {
          serverToolFollowup: true,
          serverToolLoopState: { flowId: "stop_message_flow", maxRepeats: 3 },
        },
      } as unknown as AdapterContext,
      requestId: "req_stop_message_flow_tool_call_reset",
      entryEndpoint: "/v1/chat/completions",
      providerProtocol: "openai-chat",
      clientInjectDispatch,
      reenterPipeline,
    });

    expect(result.executed).toBe(false);
    expect(clientInjectDispatch).not.toHaveBeenCalled();
    expect(reenterPipeline).not.toHaveBeenCalled();
    expect(loadRoutingInstructionStateSync(stateKey)?.stopMessageUsed).toBeUndefined();
  });

  test("non-goal stopless default counts missing schema stops", async () => {
    const sessionId = "stopless-default-missing-schema";
    const stateKey = `session:${sessionId}`;
    const clientInjectDispatch = jest.fn(async () => ({ ok: true }) as const);
    const reenterPipeline = jest.fn(async () => ({ body: buildStopResponse("reentered") }));

    for (let index = 0; index < 2; index += 1) {
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
      expect(loadRoutingInstructionStateSync(stateKey)?.stopMessageUsed).toBe(index + 1);
    }
    const exhausted = await runServerToolOrchestration({
      chat: buildStopResponse("stop-3"),
      adapterContext: {
        sessionId,
        capturedChatRequest: {
          model: "gpt-test",
          messages: [{ role: "user", content: "start" }],
        },
      } as unknown as AdapterContext,
      requestId: "req_stopless_default_3",
      entryEndpoint: "/v1/chat/completions",
      providerProtocol: "openai-chat",
      clientInjectDispatch,
      reenterPipeline,
    });

    expect(exhausted.executed).toBe(true);
    expect(JSON.stringify(exhausted.chat)).toContain("Stopless 校验结果");
    expect(loadRoutingInstructionStateSync(stateKey)?.stopMessageUsed).toBeUndefined();
    expect(reenterPipeline).toHaveBeenCalledTimes(2);
  });

  test("non-goal stopless default counts invalid schema stops then returns final summary", async () => {
    const sessionId = "stopless-default-invalid-schema-three-turns";
    const stateKey = `session:${sessionId}`;
    const clientInjectDispatch = jest.fn(async () => ({ ok: true }) as const);
    const reenterPipeline = jest.fn(async () => ({ body: buildStopResponse("reentered") }));
    const invalidSchema = '{"stopreason":2,"reason":"未完成","has_evidence":0,"next_step":"继续测试"}';

    for (let index = 0; index < 2; index += 1) {
      const result = await runServerToolOrchestration({
        chat: buildStopResponse(invalidSchema),
        adapterContext: {
          sessionId,
          capturedChatRequest: {
            model: "gpt-test",
            messages: [{ role: "user", content: "start" }],
          },
        } as unknown as AdapterContext,
        requestId: `req_stopless_invalid_schema_${index + 1}`,
        entryEndpoint: "/v1/chat/completions",
        providerProtocol: "openai-chat",
        clientInjectDispatch,
        reenterPipeline,
      });

      expect(result.executed).toBe(true);
      expect(result.flowId).toBe("stop_message_flow");
      expect(loadRoutingInstructionStateSync(stateKey)?.stopMessageUsed).toBe(index + 1);
    }

    const exhausted = await runServerToolOrchestration({
      chat: buildStopResponse(invalidSchema),
      adapterContext: {
        sessionId,
        stopMessageClientInjectSessionScope: `session:${sessionId}`,
        capturedChatRequest: {
          model: "gpt-test",
          messages: [
            { role: "user", content: "start" },
            { role: "user", content: "继续完成当前用户目标。Stop schema 校验未通过：缺 schema。" },
            { role: "assistant", content: "第一次停止：未完成，只总结。" },
            { role: "user", content: "你已经提供 next_step，所以本轮不允许停止。立即执行这个下一步：继续测试 A" },
            { role: "assistant", content: "第二次停止：仍未执行 A。" },
            { role: "user", content: "按当前目标继续执行；需要操作/验证时调用工具；不要只总结/复述" },
          ],
        },
      } as unknown as AdapterContext,
      requestId: "req_stopless_default_3",
      entryEndpoint: "/v1/chat/completions",
      providerProtocol: "openai-chat",
      clientInjectDispatch,
      reenterPipeline,
    });

    expect(exhausted.executed).toBe(true);
    const finalText = JSON.stringify(exhausted.chat);
    expect(finalText).toContain("Stopless 校验结果");
    expect(finalText).toContain("第 1 次续杯询问");
    expect(finalText).toContain("第一次停止：未完成，只总结。");
    expect(finalText).toContain("第 2 次续杯询问");
    expect(finalText).toContain("第二次停止：仍未执行 A。");
    expect(finalText).toContain('\\"stopreason\\":2');
    expect(finalText).toContain('\\"next_step\\":\\"继续测试\\"');
    expect(finalText).toContain("最后原始 summary");
    expect(clientInjectDispatch).not.toHaveBeenCalled();
    expect(reenterPipeline).toHaveBeenCalledTimes(2);
  });

  test("stopless writes learned note only when schema allows final stop", async () => {
    const sessionId = "stopless-learned-final-stop";
    const tempWorkdir = path.join(SESSION_DIR, "workdir-learned-final-stop");
    fs.mkdirSync(tempWorkdir, { recursive: true });
    const clientInjectDispatch = jest.fn(async () => ({ ok: true }) as const);
    const reenterPipeline = jest.fn(async () => ({ body: buildStopResponse("reentered") }));

    const invalidSchemaWithLearned = '{"stopreason":2,"reason":"未完成","has_evidence":0,"next_step":"继续验证","learned":"不应写入"}';
    const invalid = await runServerToolOrchestration({
      chat: buildStopResponse(invalidSchemaWithLearned),
      adapterContext: {
        sessionId,
        workingDirectory: tempWorkdir,
        capturedChatRequest: {
          model: "gpt-test",
          messages: [{ role: "user", content: "start" }],
        },
      } as unknown as AdapterContext,
      requestId: "req_stopless_learned_invalid",
      entryEndpoint: "/v1/chat/completions",
      providerProtocol: "openai-chat",
      clientInjectDispatch,
      reenterPipeline,
    });
    expect(invalid.executed).toBe(true);
    expect(fs.existsSync(path.join(tempWorkdir, "note.md"))).toBe(false);

    const validSchemaWithLearned = '{"stopreason":0,"reason":"目标完成","has_evidence":1,"evidence":"测试通过","next_step":"","learned":"只在真正停止时写 note.md"}';
    const valid = await runServerToolOrchestration({
      chat: buildStopResponse(validSchemaWithLearned),
      adapterContext: {
        sessionId,
        workingDirectory: tempWorkdir,
        capturedChatRequest: {
          model: "gpt-test",
          messages: [{ role: "user", content: "start" }],
        },
      } as unknown as AdapterContext,
      requestId: "req_stopless_learned_valid",
      entryEndpoint: "/v1/chat/completions",
      providerProtocol: "openai-chat",
      clientInjectDispatch,
      reenterPipeline,
    });

    expect(valid.executed).toBe(true);
    const note = fs.readFileSync(path.join(tempWorkdir, "note.md"), "utf8");
    expect(note).toContain("requestId: req_stopless_learned_valid");
    expect(note).toContain("只在真正停止时写 note.md");
    expect(note).not.toContain("不应写入");
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
        __rt: {
          serverToolFollowup: true,
          serverToolLoopState: { flowId: "apply_patch_flow", maxRepeats: 1 },
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

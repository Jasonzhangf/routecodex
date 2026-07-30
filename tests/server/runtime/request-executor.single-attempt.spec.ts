import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { createRequire } from "node:module";
import { jest } from "@jest/globals";
import type {
  PipelineExecutionInput,
  PipelineExecutionResult,
} from "../../../src/server/runtime/handlers/types.js";
import type { HubPipeline } from "../../../src/server/runtime/http-server/types.js";
import type { ProviderRuntimeManager } from "../../../src/server/runtime/http-server/runtime-manager.js";
import type { ProviderHandle } from "../../../src/server/runtime/http-server/types.js";
import type { ModuleDependencies } from "../../../src/modules/pipeline/interfaces/pipeline-interfaces.js";
import {
  __resetSnapshotLocalDiskGateForTests,
  canWriteSnapshotToLocalDisk,
} from "../../../src/utils/snapshot-local-disk-gate.js";
import {
  setRuntimeFlag,
  runtimeFlags,
} from "../../../src/runtime/runtime-flags.js";
import {
  readRuntimeProviderObservationProjection,
  readRuntimeRequestTruthSessionId,
  writeRuntimeControlSlot,
} from "../../../src/server/runtime/http-server/metadata-center/request-truth-readers.js";
import { writeMetadataCenterSlot } from "../../../src/server/runtime/http-server/metadata-center/dualwrite-api.js";
import {
  captureResponsesRequestContext,
  clearAllResponsesConversationState,
} from "../../../src/modules/llmswitch/bridge/responses-conversation-store-host.js";

const nodeRequire = createRequire(import.meta.url);

jest.setTimeout(15_000);

let requestExecutorLocalHubPipelineExecute:
  | ((input: unknown) => unknown)
  | undefined;
let requestExecutorLocalCurrentTargetProviderProtocol: string | undefined;
let requestExecutorLocalLastHubPipelineResult: unknown;

function createRequestExecutorLocalRuntimeIntegrationsMock() {
  return {
    captureResponsesRequestContextForRequest: async (args: Parameters<
      typeof captureResponsesRequestContext
    >[0]) => {
      captureResponsesRequestContext(args);
    },
    clearResponsesConversationByRequestId: async () => undefined,
    reportProviderErrorToRouterPolicy: async (event: unknown) => event,
    reportProviderSuccessToRouterPolicy: async (event: unknown) => event,
    rebindResponsesConversationRequestId: async () => undefined,
  };
}

function normalizeLocalHubPipelineInput(input: unknown): unknown {
  const record =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  if (!record) {
    return input;
  }
  const metadata =
    record.metadata &&
    typeof record.metadata === "object" &&
    !Array.isArray(record.metadata)
      ? (record.metadata as Record<string, unknown>)
      : {};
  if (record.retryExclusionSet === undefined) {
    return input;
  }
  return {
    ...record,
    metadata: {
      ...metadata,
      excludedProviderKeys: record.retryExclusionSet,
    },
  };
}

function normalizeLocalHubPipelineResult(
  result: unknown,
  input: unknown,
): unknown {
  const record =
    result && typeof result === "object" && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : undefined;
  const target =
    record?.target &&
    typeof record.target === "object" &&
    !Array.isArray(record.target)
      ? (record.target as Record<string, unknown>)
      : undefined;
  if (!record?.providerPayload || !target?.providerKey) {
    return result;
  }
  const routingDecision =
    record.routingDecision &&
    typeof record.routingDecision === "object" &&
    !Array.isArray(record.routingDecision)
      ? (record.routingDecision as Record<string, unknown>)
      : {};
  const routePool = Array.isArray(routingDecision.routePool)
    ? routingDecision.routePool
    : Array.isArray(routingDecision.pool)
      ? routingDecision.pool
      : [target.providerKey];
  if (typeof routingDecision.providerProtocol === "string") {
    requestExecutorLocalCurrentTargetProviderProtocol =
      routingDecision.providerProtocol;
    return {
      ...record,
      routingDecision: {
        ...routingDecision,
        routeName:
          typeof routingDecision.routeName === "string"
            ? routingDecision.routeName
            : "test-route",
        routePool,
      },
    };
  }
  const inputRecord =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const providerProtocol =
    typeof target.providerProtocol === "string"
      ? target.providerProtocol
      : typeof target.outboundProfile === "string"
        ? target.outboundProfile
        : typeof inputRecord.providerProtocol === "string"
          ? inputRecord.providerProtocol
          : "openai-chat";
  requestExecutorLocalCurrentTargetProviderProtocol = providerProtocol;
  return {
    ...record,
    routingDecision: {
      ...routingDecision,
      routeName:
        typeof routingDecision.routeName === "string"
          ? routingDecision.routeName
          : "test-route",
      providerProtocol,
      routePool,
    },
  };
}

jest.unstable_mockModule(
  "../../../src/modules/llmswitch/bridge/routing-integrations.js",
  () => ({
    buildRequestStageRuntimeControlWritePlanNative: () => ({
      runtimeControl: undefined,
    }),
    executeHubPipelineNative: (_handle: string, input: unknown) => {
      if (!requestExecutorLocalHubPipelineExecute) {
        throw new Error(
          "request-executor local Hub pipeline fixture is not installed",
        );
      }
      const legacyInput = normalizeLocalHubPipelineInput(input);
      const result = requestExecutorLocalHubPipelineExecute(legacyInput);
      const normalized = normalizeLocalHubPipelineResult(
        result ?? requestExecutorLocalLastHubPipelineResult,
        legacyInput,
      );
      if (
        normalized &&
        typeof normalized === "object" &&
        !Array.isArray(normalized)
      ) {
        requestExecutorLocalLastHubPipelineResult = normalized;
      }
      return normalized;
    },
    markHubPipelineVirtualRouterConcurrencyScopeBusyNative: () => undefined,
    markHubPipelineVirtualRouterConcurrencyScopeIdleNative: () => undefined,
    resolveEntryProtocolFromEndpointNative: (entryEndpoint: string) => {
      if (entryEndpoint === "/v1/responses") return "openai-responses";
      if (entryEndpoint === "/v1/messages") return "anthropic-messages";
      return "openai-chat";
    },
  }),
);
jest.unstable_mockModule(
  "../../../src/modules/llmswitch/bridge/runtime-integrations.js",
  createRequestExecutorLocalRuntimeIntegrationsMock,
);
jest.unstable_mockModule(
  "../../../src/server/runtime/http-server/hub-pipeline-handle.js",
  () => ({
    readHubPipelineNativeHandle: (pipeline: unknown) => {
      if (typeof pipeline === "string" && pipeline.trim()) {
        return pipeline;
      }
      const execute = (
        pipeline as { execute?: (input: unknown) => unknown } | null
      )?.execute;
      if (typeof execute !== "function") {
        return null;
      }
      requestExecutorLocalHubPipelineExecute = (input: unknown) =>
        execute.call(pipeline, input);
      return "request-executor-single-attempt-native-handle";
    },
  }),
);

const {
  HubRequestExecutor: HubRequestExecutorRaw,
  __requestExecutorTestables,
} =
  await import("../../../src/server/runtime/http-server/request-executor.js");

class HubRequestExecutor extends HubRequestExecutorRaw {
  constructor(
    deps: ConstructorParameters<typeof HubRequestExecutorRaw>[0],
  ) {
    const onRequestStart = deps.onRequestStart;
    super({
      ...deps,
      onRequestStart: async (args) => {
        await onRequestStart?.(args);
        if (
          typeof args.metadata.routecodexRoutingPolicyGroup !== "string" ||
          !args.metadata.routecodexRoutingPolicyGroup.trim()
        ) {
          args.metadata.routecodexRoutingPolicyGroup = "test-group";
        }
      },
    });
  }
}

function writeStopMessageState(sessionId: string, used: number): void {
  fs.mkdirSync(SESSION_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(SESSION_DIR, `session-${sessionId}.json`),
    JSON.stringify({
      version: 1,
      state: {
        stopMessageSource: "default",
        stopMessageText: "继续执行",
        stopMessageMaxRepeats: 3,
        stopMessageUsed: used,
        stopMessageStageMode: "on",
        stopMessageAiMode: "off",
      },
    }),
    "utf8",
  );
}

function readStopMessageUsed(sessionId: string): number | undefined {
  const filepath = path.join(SESSION_DIR, `session-${sessionId}.json`);
  if (!fs.existsSync(filepath)) {
    return undefined;
  }
  const payload = JSON.parse(fs.readFileSync(filepath, "utf8")) as {
    state?: { stopMessageUsed?: number };
  };
  return payload.state?.stopMessageUsed;
}

function normalizeMinimalSuccessResponse(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  const record = result as Record<string, unknown>;
  if (
    typeof record.status === "number" ||
    Object.prototype.hasOwnProperty.call(record, "data")
  ) {
    return result;
  }
  return {
    status: 200,
    data: result,
  };
}

function buildMinimalResponsesSuccessBody(
  id: string,
  text = "ok",
): Record<string, unknown> {
  return {
    id,
    object: "response",
    status: "completed",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
    ],
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
    },
  };
}

function seedStoplessRequestTruth(
  metadata: Record<string, unknown>,
  sessionId: string,
): void {
  const writer = {
    module: "tests/server/runtime/request-executor.single-attempt.spec.ts",
    symbol: "seedStoplessRequestTruth",
    stage: "test_request_start",
  };
  metadata.sessionId = sessionId;
  const existingSessionId = readRuntimeRequestTruthSessionId(metadata);
  if (existingSessionId && existingSessionId !== sessionId) {
    throw new Error(
      `stopless fixture session truth conflict: ${existingSessionId} != ${sessionId}`,
    );
  }
  if (!existingSessionId) {
    writeMetadataCenterSlot({
      target: metadata,
      family: "request_truth",
      key: "sessionId",
      value: sessionId,
      writer,
      reason: "fixture binds current request session truth",
    });
  }
  writeRuntimeControlSlot({
    target: metadata,
    key: "stopless",
    value: {
      active: true,
      flowId: "stop_message_flow",
      sessionId,
      repeatCount: 0,
      maxRepeats: 3,
      triggerHint: "test_request_start",
    },
    writer,
    reason: "fixture binds Rust-owned stopless runtime control",
  });
}

const SESSION_DIR = path.join(
  process.cwd(),
  "tmp",
  "jest-request-executor-single-attempt-sessions",
);
const LEGACY_ROUTE_CODEX_PREFIX = "__routecodex";
const LEGACY_ROUTE_CODEX_FINISH_REASON_KEY = `${LEGACY_ROUTE_CODEX_PREFIX}_finish_reason`;
const LEGACY_ROUTE_CODEX_STREAM_PROBE_KEY = `${LEGACY_ROUTE_CODEX_PREFIX}_stream_contract_probe_body`;

function createRuntimeHandle(
  processImpl: () => Promise<unknown>,
): ProviderHandle {
  return {
    providerType: "gemini",
    providerFamily: "gemini",
    providerId: "gemini",
    get providerProtocol() {
      return requestExecutorLocalCurrentTargetProviderProtocol ?? "gemini-chat";
    },
    runtime: {
      runtimeKey: "runtime:key",
      providerId: "gemini",
      keyAlias: "gemini",
      providerType: "gemini",
      endpoint: "https://example.invalid",
      auth: { type: "oauth" },
      get outboundProfile() {
        return requestExecutorLocalCurrentTargetProviderProtocol ?? "gemini-chat";
      },
    },
    instance: {
      processIncoming: jest.fn().mockImplementation(async () =>
        normalizeMinimalSuccessResponse(await processImpl())
      ),
      cleanup: jest.fn(),
    },
  } as unknown as ProviderHandle;
}

function createRuntimeHandleWithProtocol(
  processImpl: () => Promise<unknown>,
  providerProtocol: string,
): ProviderHandle {
  return {
    providerType: "openai",
    providerFamily: "openai",
    providerId: "mini27",
    providerProtocol,
    runtime: {
      runtimeKey: "runtime:key",
      providerId: "mini27",
      keyAlias: "mini27.key1-MiniMax-M2.7",
      providerType: "openai",
      endpoint: "https://example.invalid",
      auth: { type: "oauth" },
      outboundProfile: providerProtocol,
    },
    instance: {
      processIncoming: jest.fn().mockImplementation(async () =>
        normalizeMinimalSuccessResponse(await processImpl())
      ),
      cleanup: jest.fn(),
    },
  } as unknown as ProviderHandle;
}

function createExecutor(
  pipelineResult: PipelineExecutionResult,
  handle: ProviderHandle,
  options?: {
    fallback?: {
      pipelineResult: PipelineExecutionResult;
      handle: ProviderHandle;
    };
    onRequestStart?: (args: {
      requestId: string;
      metadata: Record<string, unknown>;
    }) => void | Promise<void>;
  },
) {
  const fakePipeline: HubPipeline = {
    execute: jest.fn((input: PipelineExecutionInput) => {
      const excluded = Array.isArray(input.metadata?.excludedProviderKeys)
        ? input.metadata.excludedProviderKeys
        : [];
      const providerKey = pipelineResult.target?.providerKey;
      if (providerKey && excluded.includes(providerKey)) {
        if (options?.fallback) {
          return options.fallback.pipelineResult;
        }
        const routingDecision = pipelineResult.routingDecision as
          | Record<string, unknown>
          | undefined;
        const routeName =
          typeof routingDecision?.routeName === "string"
            ? routingDecision.routeName
            : "test-route";
        throw Object.assign(
          new Error("No available providers after applying routing instructions"),
          {
            code: "PROVIDER_NOT_AVAILABLE",
            details: {
              route: routeName,
              routeName,
              exhaustedTargets: [...excluded],
            },
          },
        );
      }
      return pipelineResult;
    }),
  };

  const targetProtocol =
    typeof pipelineResult.target?.outboundProfile === "string"
      ? pipelineResult.target.outboundProfile
      : undefined;
  const runtimeHandle = targetProtocol
    ? ({
        ...(handle as Record<string, unknown>),
        providerProtocol: targetProtocol,
        runtime: {
          ...(((handle as { runtime?: Record<string, unknown> }).runtime ?? {}) as Record<
            string,
            unknown
          >),
          outboundProfile: targetProtocol,
        },
      } as unknown as ProviderHandle)
    : handle;

  const runtimeManager: ProviderRuntimeManager = {
    resolveRuntimeKey: jest.fn((providerKey?: string) => {
      if (
        options?.fallback?.pipelineResult.target?.providerKey === providerKey
      ) {
        return options.fallback.pipelineResult.target.runtimeKey;
      }
      if (pipelineResult.target?.providerKey === providerKey) {
        return pipelineResult.target.runtimeKey ?? "runtime:key";
      }
      return undefined;
    }),
    getHandleByRuntimeKey: jest.fn((runtimeKey: string) => {
      const fallbackRuntimeKey = options?.fallback?.pipelineResult.target?.runtimeKey;
      if (fallbackRuntimeKey && runtimeKey === fallbackRuntimeKey) {
        return options.fallback?.handle;
      }
      return runtimeHandle;
    }),
    getHandleByProviderKey: jest.fn(),
    disposeAll: jest.fn(),
    initialize: jest.fn(),
  } as unknown as ProviderRuntimeManager;

  const stats = {
    recordRequestStart: jest.fn(),
    recordCompletion: jest.fn(),
    bindProvider: jest.fn(),
    recordToolUsage: jest.fn(),
  };

  const errorHandlingCenter = {
    handleError: jest.fn().mockReturnValue({ success: true }),
  };

  const deps = {
    runtimeManager,
    getHubPipeline: () => fakePipeline,
    getModuleDependencies: (): ModuleDependencies =>
      ({
        errorHandlingCenter,
      }) as ModuleDependencies,
    logStage: jest.fn(),
    stats,
    onRequestStart: options?.onRequestStart,
  };

  const executor = new HubRequestExecutor(deps);

  const request: PipelineExecutionInput = {
    requestId: "req_test",
    entryEndpoint: "/v1/responses",
    headers: {},
    body: {
      input: [
        {
          role: "user",
          type: "message",
          content: [{ type: "input_text", text: "ping" }],
        },
      ],
    },
    metadata: { stream: false, inboundStream: false },
  };

  return {
    executor,
    request,
    handle,
    runtimeManager,
    logStage: deps.logStage,
    stats,
  };
}

describe("HubRequestExecutor single attempt behaviour", () => {
  const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  let convertProviderResponseSpy: ReturnType<typeof jest.spyOn> | null = null;
  const originalSnapshotDir = process.env.ROUTECODEX_SNAPSHOT_DIR;
  const originalCompatSnapshotDir = process.env.RCC_SNAPSHOT_DIR;
  const originalSnapshotsEnabled = runtimeFlags.snapshotsEnabled;

  beforeAll(() => {
    process.env.ROUTECODEX_SESSION_DIR = SESSION_DIR;
  });

  beforeEach(() => {
    warnSpy.mockClear();
    requestExecutorLocalCurrentTargetProviderProtocol = undefined;
    requestExecutorLocalLastHubPipelineResult = undefined;
    convertProviderResponseSpy?.mockRestore();
    convertProviderResponseSpy = null;
    clearAllResponsesConversationState();
    __requestExecutorTestables.resetRequestExecutorInternalStateForTests();
    __resetSnapshotLocalDiskGateForTests();
    fs.rmSync(SESSION_DIR, { recursive: true, force: true });
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  });

  afterAll(() => {
    convertProviderResponseSpy?.mockRestore();
    convertProviderResponseSpy = null;
    if (originalSnapshotDir === undefined) {
      delete process.env.ROUTECODEX_SNAPSHOT_DIR;
    } else {
      process.env.ROUTECODEX_SNAPSHOT_DIR = originalSnapshotDir;
    }
    if (originalCompatSnapshotDir === undefined) {
      delete process.env.RCC_SNAPSHOT_DIR;
    } else {
      process.env.RCC_SNAPSHOT_DIR = originalCompatSnapshotDir;
    }
    setRuntimeFlag("snapshotsEnabled", originalSnapshotsEnabled);
    warnSpy.mockRestore();
  });

  const pipelineResult: PipelineExecutionResult = {
    providerPayload: { data: { messages: [] } },
    target: {
      providerKey: "gemini.primary",
      providerType: "gemini",
      outboundProfile: "gemini-chat",
      runtimeKey: "runtime:key",
      processMode: "standard",
    },
    processMode: "standard",
    metadata: {},
  };

  function stubConvertProviderResponse(
    converted: PipelineExecutionResult = {
      status: 200,
      body: {
        id: "chatcmpl-test",
        object: "chat.completion",
        model: "test-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
      },
    },
  ) {
    convertProviderResponseSpy?.mockRestore();
    convertProviderResponseSpy = jest
      .spyOn(
        HubRequestExecutor.prototype as any,
        "convertProviderResponseIfNeeded",
      )
      .mockReturnValue(converted);
    return convertProviderResponseSpy;
  }

  it("invokes provider only once on success", async () => {
    const handle = createRuntimeHandle(async () => ({ ok: true }));
    const { executor, request } = createExecutor(pipelineResult, handle);
    stubConvertProviderResponse();

    const response = await executor.execute(request);

    expect(response).toBeDefined();
    expect(handle.instance.processIncoming).toHaveBeenCalledTimes(1);
  });

  it("projects stopless as visible exec_command CLI call for openai-responses relay provider stop response", async () => {
    const providerResponse = {
      status: 200,
      data: {
        id: "chatcmpl-minimax-stopless-red",
        object: "chat.completion",
        model: "MiniMax-M2.7",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "stopped",
            },
          },
        ],
      },
    };
    const handle = createRuntimeHandleWithProtocol(
      async () => providerResponse,
      "openai-responses",
    );
    const relayPipelineResult: PipelineExecutionResult = {
      providerPayload: { model: "MiniMax-M2.7", messages: [] },
      target: {
        providerKey: "mini27.key1-MiniMax-M2.7",
        providerType: "openai",
        outboundProfile: "openai-responses",
        runtimeKey: "runtime:key",
        processMode: "standard",
      },
      processMode: "standard",
      metadata: {
        routeName: "coding",
        routecodexLocalPort: 10000,
        routecodexPortMode: "router",
        routecodexRoutingPolicyGroup: "gateway_coding_10000",
      },
    } as PipelineExecutionResult;
    const nested = jest.fn(async () => ({
      status: 200,
      body: {
        id: "resp-stopless-reentered",
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "continued" }],
          },
        ],
      },
    }));
    const { executor, request } = createExecutor(relayPipelineResult, handle, {
      onRequestStart: ({ metadata }) => {
        seedStoplessRequestTruth(
          metadata,
          "executor-minimax-relay-stopless",
        );
      },
    });
    (executor as any).deps.executeNestedInput = nested;

    const response = await executor.execute({
      ...request,
      requestId: "req_executor_minimax_relay_stopless_red",
      entryEndpoint: "/v1/responses",
      body: { model: "gpt-5.4", input: "continue", stream: true },
      metadata: {
        stream: true,
        inboundStream: true,
        routecodexLocalPort: 10000,
        routecodexPortMode: "router",
        routecodexRoutingPolicyGroup: "gateway_coding_10000",
      },
    });

    expect(nested).toHaveBeenCalledTimes(0);
    expect(response.status).toBe(200);
    const responseBody = response.body as Record<string, unknown>;
    expect(responseBody[LEGACY_ROUTE_CODEX_FINISH_REASON_KEY]).toBeUndefined();
    expect(responseBody[LEGACY_ROUTE_CODEX_STREAM_PROBE_KEY]).toBeUndefined();
    const output = (responseBody.output ?? []) as Array<
      Record<string, unknown>
    >;
    const toolCall = output.find((item) => item.type === "function_call") as
      | Record<string, unknown>
      | undefined;
    expect(toolCall?.name).toBe("exec_command");
    expect(String(toolCall?.arguments)).toContain(
      "routecodex hook run reasoningStop",
    );
    expect(String(toolCall?.arguments)).not.toContain("当前用户目标");
  });

  it("does not bypass stopless for openai-responses prebuilt SSE stop response", async () => {
    const responseId = "resp_prebuilt_sse_stopless_red";
    const providerResponse = {
      status: 200,
      sseStream: Readable.from([
          "event: response.created\n",
          `data: ${JSON.stringify({
            type: "response.created",
            response: {
              id: responseId,
              object: "response",
              status: "in_progress",
              model: "gpt-5.5",
              output: [],
            },
          })}\n\n`,
          "event: response.output_item.done\n",
          `data: ${JSON.stringify({
            type: "response.output_item.done",
            output_index: 0,
            item: {
              id: "msg_prebuilt_sse_stopless_red",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "stopped" }],
            },
          })}\n\n`,
          "event: response.completed\n",
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: responseId,
              object: "response",
              status: "completed",
              model: "gpt-5.5",
              output: [
                {
                  id: "msg_prebuilt_sse_stopless_red",
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "stopped" }],
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          })}\n\n`,
          "event: response.done\n",
          `data: ${JSON.stringify({
            type: "response.done",
            response: {
              id: responseId,
              object: "response",
              status: "completed",
              output: [
                {
                  id: "msg_prebuilt_sse_stopless_red",
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text: "stopped" }],
                },
              ],
            },
          })}\n\n`,
          "data: [DONE]\n\n",
      ]),
    };
    const handle = createRuntimeHandleWithProtocol(
      async () => providerResponse,
      "openai-responses",
    );
    const relayPipelineResult: PipelineExecutionResult = {
      providerPayload: { model: "MiniMax-M2.7", messages: [] },
      target: {
        providerKey: "mini27.key1-MiniMax-M2.7",
        providerType: "openai",
        outboundProfile: "openai-responses",
        runtimeKey: "runtime:key",
        processMode: "standard",
      },
      processMode: "standard",
      metadata: {
        routeName: "longcontext",
        routecodexLocalPort: 5555,
        routecodexPortMode: "router",
        routecodexRoutingPolicyGroup:
          "gateway-priority-5555-weighted-longcontext",
      },
    } as PipelineExecutionResult;
    const { executor, request } = createExecutor(relayPipelineResult, handle, {
      onRequestStart: ({ metadata }) => {
        seedStoplessRequestTruth(
          metadata,
          "executor-prebuilt-sse-stopless",
        );
      },
    });

    const response = await executor.execute({
      ...request,
      requestId: "req_executor_prebuilt_sse_stopless_red",
      entryEndpoint: "/v1/responses",
      body: { model: "gpt-5.5", input: "continue", stream: true },
      metadata: {
        stream: true,
        inboundStream: true,
        routecodexLocalPort: 5555,
        routecodexPortMode: "router",
        routecodexRoutingPolicyGroup:
          "gateway-priority-5555-weighted-longcontext",
      },
    });

    expect(response.status).toBe(200);
    const responseBody = response.body as Record<string, unknown>;
    expect(responseBody[LEGACY_ROUTE_CODEX_FINISH_REASON_KEY]).toBeUndefined();
    expect(responseBody[LEGACY_ROUTE_CODEX_STREAM_PROBE_KEY]).toBeUndefined();
    const output = (responseBody.output ?? []) as Array<
      Record<string, unknown>
    >;
    const toolCall = output.find((item) => item.type === "function_call") as
      | Record<string, unknown>
      | undefined;
    expect(toolCall?.name).toBe("exec_command");
    expect(String(toolCall?.arguments)).toContain(
      "routecodex hook run reasoningStop",
    );
  });

  it("does not mutate legacy session-file stopless budget after relay tool_calls", async () => {
    const sessionId = "executor-relay-tool-calls-reset";
    writeStopMessageState(sessionId, 3);
    const providerResponse = {
      status: 200,
      data: {
        id: "chatcmpl-minimax-tool-calls-reset",
        object: "chat.completion",
        model: "MiniMax-M2.7",
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              tool_calls: [
                {
                  id: "call_reset_budget",
                  type: "function",
                  function: {
                    name: "exec_command",
                    arguments: '{"cmd":"pwd"}',
                  },
                },
              ],
            },
          },
        ],
      },
    };
    const handle = createRuntimeHandleWithProtocol(
      async () => providerResponse,
      "openai-responses",
    );
    const relayPipelineResult: PipelineExecutionResult = {
      providerPayload: { model: "MiniMax-M2.7", messages: [] },
      target: {
        providerKey: "mini27.key1-MiniMax-M2.7",
        providerType: "openai",
        outboundProfile: "openai-responses",
        runtimeKey: "runtime:key",
        processMode: "standard",
      },
      processMode: "standard",
      metadata: {
        sessionId,
        routeName: "coding",
        routecodexLocalPort: 10000,
        routecodexPortMode: "router",
        routecodexRoutingPolicyGroup: "gateway_coding_10000",
      },
    } as PipelineExecutionResult;
    const { executor, request } = createExecutor(relayPipelineResult, handle, {
      onRequestStart: ({ metadata }) => {
        seedStoplessRequestTruth(metadata, sessionId);
      },
    });

    const response = await executor.execute({
      ...request,
      requestId: "req_executor_minimax_relay_tool_calls_reset",
      entryEndpoint: "/v1/responses",
      body: { model: "gpt-5.4", input: "continue", stream: true },
      metadata: {
        stream: true,
        inboundStream: true,
        sessionId,
        routecodexLocalPort: 10000,
        routecodexPortMode: "router",
        routecodexRoutingPolicyGroup: "gateway_coding_10000",
      },
    });

    expect(response.status).toBe(200);
    expect(readStopMessageUsed(sessionId)).toBe(3);
  });

  it("writes payload-contract-error errorsample for empty provider request payload by default", async () => {
    const errorsDir = fs.mkdtempSync(
      path.join(
        process.cwd(),
        "tmp",
        "jest-request-executor-errorsamples-empty-request-",
      ),
    );
    process.env.ROUTECODEX_ERRORSAMPLES_DIR = errorsDir;
    const { __resetErrorsampleQueueForTests, __flushErrorsampleQueueForTests } =
      await import("../../../src/utils/errorsamples.js");
    __resetErrorsampleQueueForTests();
    try {
      const handle = createRuntimeHandle(async () => ({ ok: true }));
      const { executor, request } = createExecutor(pipelineResult, handle);
      stubConvertProviderResponse();

      await executor.execute(request);
      await __flushErrorsampleQueueForTests();

      const groupDir = path.join(errorsDir, "payload-contract-error");
      const files = fs.readdirSync(groupDir);
      expect(files.length).toBeGreaterThan(0);
      const payload = JSON.parse(
        fs.readFileSync(path.join(groupDir, files[0]), "utf8"),
      );
      expect(payload.phase).toBe("provider-request");
      expect(payload.marker).toBe("provider_request_empty_messages");
    } finally {
      __resetErrorsampleQueueForTests();
      delete process.env.ROUTECODEX_ERRORSAMPLES_DIR;
      fs.rmSync(errorsDir, { recursive: true, force: true });
    }
  });

  it("unlocks local snapshot gate before provider runtime starts writing snapshots", async () => {
    const handle = createRuntimeHandle(async () => {
      expect(canWriteSnapshotToLocalDisk("req_test")).toBe(true);
      return { ok: true };
    });
    const { executor, request } = createExecutor(pipelineResult, handle);
    stubConvertProviderResponse();

    await executor.execute(request);

    expect(handle.instance.processIncoming).toHaveBeenCalledTimes(1);
  });

  it("falls back to derive finish_reason when stream finish marker is absent", async () => {
    const handle = createRuntimeHandle(async () => ({ ok: true }));
    const { executor, request } = createExecutor(pipelineResult, handle);
    jest
      .spyOn(executor as any, "convertProviderResponseIfNeeded")
      .mockReturnValue({
        status: 200,
        body: {
          status: "completed",
          output_text: "done",
        },
      });

    const response = await executor.execute(request);
    expect(response.usageLogInfo?.finishReason).toBe("stop");
  });

  it("derives finish_reason from nested data payload when stream marker is absent", async () => {
    const handle = createRuntimeHandle(async () => ({ ok: true }));
    const { executor, request } = createExecutor(pipelineResult, handle);
    jest
      .spyOn(executor as any, "convertProviderResponseIfNeeded")
      .mockReturnValue({
        status: 200,
        body: {
          data: {
            choices: [
              {
                finish_reason: "tool_calls",
              },
            ],
          },
        },
      });

    const response = await executor.execute(request);
    expect(response.usageLogInfo?.finishReason).toBe("tool_calls");
  });

  it("falls back to provider normalized body for finish_reason when converted body lacks markers", async () => {
    const handle = createRuntimeHandle(async () => ({
      status: 200,
      data: {
        choices: [
          {
            finish_reason: "stop",
          },
        ],
      },
    }));
    const { executor, request } = createExecutor(pipelineResult, handle);
    jest
      .spyOn(executor as any, "convertProviderResponseIfNeeded")
      .mockReturnValue({
        status: 200,
        body: {
          id: "converted_without_finish_reason",
        },
      });

    const response = await executor.execute(request);
    expect(response.usageLogInfo?.finishReason).toBe("stop");
  });

  it("keeps usage from provider response when converted payload has no usage", async () => {
    const handle = createRuntimeHandle(async () => ({
      status: 200,
      data: {
        id: "raw_provider_payload",
        usage: {
          prompt_tokens: 12,
          completion_tokens: 5,
          total_tokens: 17,
        },
      },
    }));
    const { executor, request, stats } = createExecutor(pipelineResult, handle);
    jest
      .spyOn(executor as any, "convertProviderResponseIfNeeded")
      .mockReturnValue({
        status: 200,
        body: { id: "converted_payload_without_usage" },
      });

    await executor.execute(request);

    const completionCalls = stats.recordCompletion.mock.calls;
    const successCall = completionCalls.find(
      (call) => call[1] && call[1].error === false,
    );
    expect(successCall).toBeDefined();
    expect(successCall?.[1]?.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 5,
      total_tokens: 17,
    });
  });

  it("retries retryable provider errors and re-runs pipeline", async () => {
    const retryable = Object.assign(new Error("HTTP 429"), {
      statusCode: 429,
      retryable: true,
    });
    const successHandle = createRuntimeHandle(async () => ({ ok: true }));
    const failingHandle = createRuntimeHandle(async () => {
      throw retryable;
    });
    const pipelineResultOne: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: "gemini.primary",
        providerType: "gemini",
        outboundProfile: "gemini-chat",
        runtimeKey: "runtime:one",
        processMode: "standard",
      },
      processMode: "standard",
      metadata: {},
    };
    const pipelineResultTwo: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: "provider-a.aliasB",
        providerType: "responses",
        outboundProfile: "openai-responses",
        runtimeKey: "runtime:two",
        processMode: "standard",
      },
      processMode: "standard",
      metadata: {},
    };
    const fakePipeline: HubPipeline = {
      execute: jest
        .fn()
        .mockReturnValueOnce(pipelineResultOne)
        .mockReturnValueOnce(pipelineResultTwo),
    };
    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn(),
      getHandleByRuntimeKey: jest.fn((runtimeKey: string) =>
        runtimeKey === "runtime:one" ? failingHandle : successHandle,
      ),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn(),
    } as unknown as ProviderRuntimeManager;
    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn(),
    };
    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies =>
        ({
          errorHandlingCenter: {
            handleError: jest.fn().mockReturnValue({ success: true }),
          },
        }) as ModuleDependencies,
      logStage: jest.fn(),
      stats,
    };
    const executor = new HubRequestExecutor(deps);
    const request: PipelineExecutionInput = {
      requestId: "req_retry",
      entryEndpoint: "/v1/chat/completions",
      headers: {},
      body: { messages: [{ role: "user", content: "retry me" }] },
      metadata: { stream: false, inboundStream: false },
    };
    jest
      .spyOn(executor as any, "convertProviderResponseIfNeeded")
      .mockReturnValue({
        status: 200,
        body: buildMinimalResponsesSuccessBody("resp_retry_ok"),
      });

    const response = await executor.execute(request);

    expect(response).toBeDefined();
    expect(fakePipeline.execute).toHaveBeenCalledTimes(2);
    expect(failingHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(successHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    const secondCallMetadata = fakePipeline.execute.mock.calls[1][0]
      .metadata as Record<string, unknown>;
    expect(secondCallMetadata.retryAttempt).toBe(2);
  });

  it("waits and reroutes when converted response is finish_reason=stop with empty assistant payload", async () => {
    const firstHandle = createRuntimeHandle(async () => ({
      status: 200,
      data: { ok: true },
    }));
    const secondHandle = createRuntimeHandle(async () => ({
      status: 200,
      data: { ok: true },
    }));
    const pipelineResultOne: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: "provider-a.aliasA",
        providerType: "openai",
        outboundProfile: "openai-chat",
        runtimeKey: "runtime:one",
        processMode: "standard",
      },
      routingDecision: {
        routeName: "test-route",
        routePool: ["provider-a.aliasA", "tab.aliasB"],
      },
      processMode: "standard",
      metadata: {},
    };
    const pipelineResultTwo: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: "tab.aliasB",
        providerType: "openai",
        outboundProfile: "openai-chat",
        runtimeKey: "runtime:two",
        processMode: "standard",
      },
      routingDecision: {
        routeName: "test-route",
        routePool: ["provider-a.aliasA", "tab.aliasB"],
      },
      processMode: "standard",
      metadata: {},
    };
    const fakePipeline: HubPipeline = {
      execute: jest
        .fn()
        .mockReturnValueOnce(pipelineResultOne)
        .mockReturnValueOnce(pipelineResultTwo),
    };
    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn(),
      getHandleByRuntimeKey: jest.fn((runtimeKey: string) =>
        runtimeKey === "runtime:one" ? firstHandle : secondHandle,
      ),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn(),
    } as unknown as ProviderRuntimeManager;
    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn(),
    };
    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies =>
        ({
          errorHandlingCenter: {
            handleError: jest.fn().mockReturnValue({ success: true }),
          },
        }) as ModuleDependencies,
      logStage: jest.fn(),
      stats,
    };
    const executor = new HubRequestExecutor(deps);
    jest
      .spyOn(executor as any, "convertProviderResponseIfNeeded")
      .mockReturnValueOnce({
        status: 200,
        body: {
          choices: [{ finish_reason: "stop", message: { content: "" } }],
        },
      })
      .mockReturnValueOnce({
        status: 200,
        body: {
          choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        },
      });
    const request: PipelineExecutionInput = {
      requestId: "req_empty_assistant_reroute",
      entryEndpoint: "/v1/chat/completions",
      headers: {},
      body: { messages: [{ role: "user", content: "retry me" }] },
      metadata: { stream: false, inboundStream: false },
    };

    const startedAt = Date.now();
    const response = await executor.execute(request);

    expect(response).toMatchObject({
      status: 200,
      body: {
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
      },
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(fakePipeline.execute).toHaveBeenCalledTimes(2);
    expect(firstHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(secondHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
  });

  it("writes payload-contract-error errorsample for empty assistant response by default", async () => {
    const errorsDir = fs.mkdtempSync(
      path.join(
        process.cwd(),
        "tmp",
        "jest-request-executor-errorsamples-empty-response-",
      ),
    );
    process.env.ROUTECODEX_ERRORSAMPLES_DIR = errorsDir;
    const { __resetErrorsampleQueueForTests, __flushErrorsampleQueueForTests } =
      await import("../../../src/utils/errorsamples.js");
    __resetErrorsampleQueueForTests();
    try {
      const handle = createRuntimeHandle(async () => ({
        status: 200,
        data: { ok: true },
      }));
      const pipelineResult: PipelineExecutionResult = {
        providerPayload: {
          data: { messages: [{ role: "user", content: "retry me" }] },
        },
        target: {
          providerKey: "provider-a.aliasA",
          providerType: "openai",
          outboundProfile: "openai-chat",
          runtimeKey: "runtime:one",
          processMode: "standard",
        },
        routingDecision: {
          routeName: "test-route",
          routePool: ["provider-a.aliasA", "provider-b.aliasB"],
        },
        processMode: "standard",
        metadata: {},
      };
      const fallbackHandle = createRuntimeHandle(async () => ({
        status: 200,
        data: { ok: true },
      }));
      const fallbackResult: PipelineExecutionResult = {
        ...pipelineResult,
        target: {
          providerKey: "provider-b.aliasB",
          providerType: "openai",
          outboundProfile: "openai-chat",
          runtimeKey: "runtime:two",
          processMode: "standard",
        },
      };
      const { executor } = createExecutor(pipelineResult, handle, {
        fallback: {
          pipelineResult: fallbackResult,
          handle: fallbackHandle,
        },
      });
      jest
        .spyOn(executor as any, "convertProviderResponseIfNeeded")
        .mockReturnValueOnce({
          status: 200,
          body: {
            choices: [{ finish_reason: "stop", message: { content: "" } }],
          },
        })
        .mockReturnValueOnce({
          status: 200,
          body: {
            choices: [
              { finish_reason: "stop", message: { content: "recovered" } },
            ],
          },
        });

      const response = await executor.execute({
        requestId: "req_empty_assistant_errorsample",
        entryEndpoint: "/v1/chat/completions",
        headers: {},
        body: { messages: [{ role: "user", content: "retry me" }] },
        metadata: { stream: false, inboundStream: false },
      });
      expect(response.status).toBe(200);
      expect(handle.instance.processIncoming).toHaveBeenCalledTimes(1);
      expect(fallbackHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
      await __flushErrorsampleQueueForTests();

      const groupDir = path.join(errorsDir, "payload-contract-error");
      const files = fs.readdirSync(groupDir);
      const payloads = files.map((file) =>
        JSON.parse(fs.readFileSync(path.join(groupDir, file), "utf8")),
      );
      expect(
        payloads.some(
          (payload) =>
            payload.phase === "provider-response" &&
            payload.marker === "chat_empty_assistant",
        ),
      ).toBe(true);
    } finally {
      __resetErrorsampleQueueForTests();
      delete process.env.ROUTECODEX_ERRORSAMPLES_DIR;
      fs.rmSync(errorsDir, { recursive: true, force: true });
    }
  });

  it("writes payload-contract-error errorsample when assistant response was repaired by sanitize placeholder", async () => {
    const errorsDir = fs.mkdtempSync(
      path.join(
        process.cwd(),
        "tmp",
        "jest-request-executor-errorsamples-sanitized-placeholder-",
      ),
    );
    const snapshotDir = fs.mkdtempSync(
      path.join(
        process.cwd(),
        "tmp",
        "jest-request-executor-snapshots-sanitized-placeholder-",
      ),
    );
    process.env.ROUTECODEX_ERRORSAMPLES_DIR = errorsDir;
    process.env.ROUTECODEX_SNAPSHOT_DIR = snapshotDir;
    process.env.RCC_SNAPSHOT_DIR = snapshotDir;
    setRuntimeFlag("snapshotsEnabled", false);
    const { __resetErrorsampleQueueForTests, __flushErrorsampleQueueForTests } =
      await import("../../../src/utils/errorsamples.js");
    __resetErrorsampleQueueForTests();
    const { __flushProviderSnapshotQueueForTests } =
      await import("../../../src/providers/core/utils/snapshot-writer.js");
    try {
      const handle = createRuntimeHandle(async () => ({
        status: 200,
        data: { ok: true },
      }));
      const pipelineResult: PipelineExecutionResult = {
        providerPayload: {
          data: { messages: [{ role: "user", content: "retry me" }] },
        },
        target: {
          providerKey: "provider-a.aliasA",
          providerType: "openai",
          outboundProfile: "openai-chat",
          runtimeKey: "runtime:one",
          processMode: "standard",
        },
        routingDecision: {
          routeName: "test-route",
          routePool: ["provider-a.aliasA", "provider-b.aliasB"],
        },
        processMode: "standard",
        metadata: {},
      };
      const fallbackHandle = createRuntimeHandle(async () => ({
        status: 200,
        data: { ok: true },
      }));
      const fallbackResult: PipelineExecutionResult = {
        ...pipelineResult,
        target: {
          providerKey: "provider-b.aliasB",
          providerType: "openai",
          outboundProfile: "openai-chat",
          runtimeKey: "runtime:two",
          processMode: "standard",
        },
      };
      const { executor } = createExecutor(pipelineResult, handle, {
        fallback: {
          pipelineResult: fallbackResult,
          handle: fallbackHandle,
        },
      });
      jest
        .spyOn(executor as any, "convertProviderResponseIfNeeded")
        .mockReturnValueOnce({
          status: 200,
          body: {
            choices: [
              {
                finish_reason: "stop",
                message: {
                  content:
                    "[RouteCodex] assistant response became empty after response sanitization.",
                },
              },
            ],
          },
        })
        .mockReturnValueOnce({
          status: 200,
          body: {
            choices: [
              { finish_reason: "stop", message: { content: "recovered" } },
            ],
          },
        });

      const response = await executor.execute({
        requestId: "req_sanitized_placeholder_errorsample",
        entryEndpoint: "/v1/chat/completions",
        headers: {},
        body: { messages: [{ role: "user", content: "retry me" }] },
        metadata: { stream: false, inboundStream: false, entryPort: 5555 },
      });
      expect(response.status).toBe(200);
      expect(handle.instance.processIncoming).toHaveBeenCalledTimes(1);
      expect(fallbackHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
      await __flushErrorsampleQueueForTests();
      await __flushProviderSnapshotQueueForTests();

      const groupDir = path.join(errorsDir, "payload-contract-error");
      const files = fs.readdirSync(groupDir);
      const payloads = files.map((file) =>
        JSON.parse(fs.readFileSync(path.join(groupDir, file), "utf8")),
      );
      expect(
        payloads.some(
          (payload) =>
            payload.phase === "provider-response" &&
            payload.marker === "assistant_sanitized_empty_placeholder",
        ),
      ).toBe(true);
      const snapshotRequestDir = path.join(
        snapshotDir,
        "openai-chat",
        "ports",
        "5555",
        "req_sanitized_placeholder_errorsample",
      );
      expect(
        fs.existsSync(
          path.join(snapshotRequestDir, "provider-request-contract.json"),
        ),
      ).toBe(true);
      expect(
        fs.existsSync(
          path.join(snapshotRequestDir, "provider-response-contract.json"),
        ),
      ).toBe(true);
      const providerResponsePayload = JSON.parse(
        fs.readFileSync(
          path.join(snapshotRequestDir, "provider-response-contract.json"),
          "utf8",
        ),
      ) as { body?: Record<string, unknown> };
      expect(providerResponsePayload.body).toMatchObject({
        payloadContractSignal: {
          marker: "assistant_sanitized_empty_placeholder",
        },
      });
    } finally {
      __resetErrorsampleQueueForTests();
      delete process.env.ROUTECODEX_ERRORSAMPLES_DIR;
      delete process.env.ROUTECODEX_SNAPSHOT_DIR;
      delete process.env.RCC_SNAPSHOT_DIR;
      setRuntimeFlag("snapshotsEnabled", originalSnapshotsEnabled);
      fs.rmSync(errorsDir, { recursive: true, force: true });
      fs.rmSync(snapshotDir, { recursive: true, force: true });
    }
  });

  it("allows non-empty reasoning-only payload without forcing missing required tool call", async () => {
    const handle = createRuntimeHandle(async () => ({
      status: 200,
      data: { ok: true },
    }));
    const declaredTools = [
      {
        type: "function",
        function: {
          name: "exec_command",
          parameters: {
            type: "object",
            properties: { cmd: { type: "string" } },
            required: ["cmd"],
          },
        },
      },
    ];
    const pipelineResult: PipelineExecutionResult = {
      providerPayload: {
        data: { messages: [{ role: "user", content: "retry me" }] },
      },
      processedRequest: {
        model: "test-model",
        messages: [{ role: "user", content: "继续执行" }],
        tools: declaredTools,
        metadata: {},
      } as any,
      target: {
        providerKey: "provider-a.aliasA",
        providerType: "openai",
        outboundProfile: "openai-chat",
        runtimeKey: "runtime:one",
        processMode: "standard",
      },
      processMode: "standard",
      metadata: {},
    };
    const { executor } = createExecutor(pipelineResult, handle);
    jest
      .spyOn(executor as any, "convertProviderResponseIfNeeded")
      .mockReturnValue({
        status: 200,
        body: {
          status: "completed",
          output_text: "",
          output: [
            {
              type: "reasoning",
              summary: [
                {
                  type: "summary_text",
                  text: "I have all the information I need. Let me create the hook file now.",
                },
              ],
            },
          ],
        },
      });

    const response = await executor.execute({
      requestId: "req_reasoning_only_missing_tool_call",
      entryEndpoint: "/v1/responses",
      headers: {},
      body: {
        input: [
          { role: "user", content: [{ type: "input_text", text: "继续执行" }] },
        ],
        tools: declaredTools,
      },
      metadata: { stream: false, inboundStream: false },
    });
    expect(response).toMatchObject({
      status: 200,
      body: {
        status: "completed",
      },
    });
  });

  it("logs provider-switch status/code/upstreamCode parsed from raw error text", async () => {
    const retryable = Object.assign(
      new Error(
        'HTTP 429: {"error":{"code":"SSE_TO_JSON_ERROR","message":"decoder crashed","upstream_code":"EPIPE"}}',
      ),
      { statusCode: 429 },
    );
    const successHandle = createRuntimeHandle(async () => ({ ok: true }));
    const failingHandle = createRuntimeHandle(async () => {
      throw retryable;
    });

    const pipelineResultOne: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: "tab.key1",
        providerType: "responses",
        outboundProfile: "openai-responses",
        runtimeKey: "runtime:one",
        processMode: "standard",
      },
      processMode: "standard",
      metadata: {},
    };
    const pipelineResultTwo: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: "tab.key2",
        providerType: "responses",
        outboundProfile: "openai-responses",
        runtimeKey: "runtime:two",
        processMode: "standard",
      },
      processMode: "standard",
      metadata: {},
    };
    const fakePipeline: HubPipeline = {
      execute: jest
        .fn()
        .mockReturnValueOnce(pipelineResultOne)
        .mockReturnValueOnce(pipelineResultTwo),
    };
    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn(),
      getHandleByRuntimeKey: jest.fn((runtimeKey: string) =>
        runtimeKey === "runtime:one" ? failingHandle : successHandle,
      ),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn(),
    } as unknown as ProviderRuntimeManager;
    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn(),
    };
    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies =>
        ({
          errorHandlingCenter: {
            handleError: jest.fn().mockReturnValue({ success: true }),
          },
        }) as ModuleDependencies,
      logStage: jest.fn(),
      stats,
    };
    const executor = new HubRequestExecutor(deps);
    const request: PipelineExecutionInput = {
      requestId: "req_retry_log_fields",
      entryEndpoint: "/v1/chat/completions",
      headers: {},
      body: { messages: [{ role: "user", content: "retry me" }] },
      metadata: { stream: false, inboundStream: false },
    };
    jest
      .spyOn(executor as any, "convertProviderResponseIfNeeded")
      .mockReturnValue({
        status: 200,
        body: buildMinimalResponsesSuccessBody("resp_retry_log_ok"),
      });

    const response = await executor.execute({
      ...request,
      entryEndpoint: "/v1/chat/completions",
      body: { messages: [{ role: "user", content: "retry me" }] },
    });
    expect(response).toBeDefined();

    const warnLines = warnSpy.mock.calls.map((call) => String(call[0] ?? ""));
    const switchLine = warnLines.find((line) =>
      line.includes("[provider-switch]"),
    );
    expect(switchLine).toBeDefined();
    expect(switchLine).toContain("status=429");
    expect(switchLine).toContain("code=SSE_TO_JSON_ERROR");
    expect(switchLine).toContain("upstreamCode=EPIPE");
    expect(switchLine).toContain('reason="decoder crashed"');
  });

  it("does not same-provider retry streaming pre-response failures when provider payload omits stream flag", async () => {
    const retryable = Object.assign(
      new Error("HTTP 525: upstream ssl handshake failed"),
      {
        statusCode: 525,
        code: "HTTP_525",
        upstreamCode: "HTTP_525",
        retryable: true,
      },
    );
    const failingHandle = createRuntimeHandleWithProtocol(async () => {
      throw retryable;
    }, "openai-responses");
    const successHandle = createRuntimeHandleWithProtocol(
      async () => ({ ok: true }),
      "openai-responses",
    );

    const pipelineResultOne: PipelineExecutionResult = {
      providerPayload: { model: "gpt-5.5", input: "tool request" },
      target: {
        providerKey: "asxs.crsa.gpt-5.5",
        providerType: "openai",
        outboundProfile: "openai-responses",
        runtimeKey: "runtime:one",
        processMode: "standard",
      },
      routingDecision: {
        routeName: "longcontext",
        pool: ["asxs.crsa.gpt-5.5"],
      } as unknown as { routeName?: string },
      processMode: "standard",
      metadata: {},
    };
    const pipelineResultTwo: PipelineExecutionResult = {
      providerPayload: { model: "gpt-5.5", input: "tool request" },
      target: {
        providerKey: "backup.crsa.gpt-5.5",
        providerType: "openai",
        outboundProfile: "openai-responses",
        runtimeKey: "runtime:two",
        processMode: "standard",
      },
      routingDecision: {
        routeName: "longcontext",
        pool: ["backup.crsa.gpt-5.5"],
      } as unknown as { routeName?: string },
      processMode: "standard",
      metadata: {},
    };
    const fakePipeline: HubPipeline = {
      execute: jest
        .fn()
        .mockReturnValueOnce(pipelineResultOne)
        .mockReturnValueOnce(pipelineResultTwo),
    };
    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn(),
      getHandleByRuntimeKey: jest.fn((runtimeKey: string) =>
        runtimeKey === "runtime:one" ? failingHandle : successHandle,
      ),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn(),
    } as unknown as ProviderRuntimeManager;
    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn(),
    };
    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies =>
        ({
          errorHandlingCenter: {
            handleError: jest.fn().mockReturnValue({ success: true }),
          },
        }) as ModuleDependencies,
      logStage: jest.fn(),
      stats,
      onRequestStart: ({
        metadata,
      }: {
        metadata: Record<string, unknown>;
      }) => {
        writeRuntimeControlSlot({
          target: metadata,
          key: "streamIntent",
          value: "stream",
          writer: {
            module:
              "tests/server/runtime/request-executor.single-attempt.spec.ts",
            symbol:
              "does not same-provider retry streaming pre-response failures when provider payload omits stream flag",
            stage: "test_request_start",
          },
          reason: "fixture declares client stream intent",
        });
      },
    };
    const executor = new HubRequestExecutor(deps);
    jest
      .spyOn(executor as any, "convertProviderResponseIfNeeded")
      .mockReturnValue({
        status: 200,
        body: buildMinimalResponsesSuccessBody("resp_stream_retry_ok"),
      });

    const response = await executor.execute({
      requestId: "req_stream_metadata_payload_no_stream_reroute",
      entryEndpoint: "/v1/responses",
      headers: {},
      body: { model: "gpt-5.5", input: "tool request", stream: true },
      metadata: { stream: true, inboundStream: true },
    });

    expect(response.status).toBe(200);
    expect(fakePipeline.execute).toHaveBeenCalledTimes(2);
    expect(failingHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(successHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    const secondCallMetadata = fakePipeline.execute.mock.calls[1][0]
      .metadata as Record<string, unknown>;
    expect(secondCallMetadata.retryAttempt).toBe(2);
    const excluded = Array.isArray(secondCallMetadata.excludedProviderKeys)
      ? (secondCallMetadata.excludedProviderKeys as string[])
      : [];
    expect(excluded).toEqual(["asxs.crsa.gpt-5.5"]);
    expect(secondCallMetadata.retryProviderKey).toBeUndefined();
    expect(secondCallMetadata.__routecodexRetryProviderKey).toBeUndefined();
    const providerSendStart = (deps.logStage as jest.Mock).mock.calls.find(
      ([stage]) => stage === "provider.send.start",
    );
    expect(providerSendStart?.[2]).toMatchObject({
      providerRequestedStream: true,
      providerPayloadRequestedStream: undefined,
      metadataStreamIntent: "stream",
    });
    const warnLines = warnSpy.mock.calls.map((call) => String(call[0] ?? ""));
    const switchLine = warnLines.find(
      (line) =>
        line.includes("[provider-switch]") &&
        line.includes("req_stream_metadata_payload_no_stream_reroute"),
    );
    expect(switchLine).toContain("switch=exclude_and_reroute");
    expect(switchLine).toContain("policy=streaming_recoverable_pre_response");
    expect(switchLine).not.toContain("switch=retry_same_provider_once");
  });

  it("retries and reroutes when converted response returns status 429 without error envelope", async () => {
    const rateLimitedHandle = createRuntimeHandle(async () => ({
      data: { id: "resp_429" },
      status: 429,
    }));
    const successHandle = createRuntimeHandle(async () => ({
      data: { id: "resp_ok" },
      status: 200,
    }));

    const pipelineResultOne: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: "tab.key1",
        providerType: "responses",
        outboundProfile: "openai-responses",
        runtimeKey: "runtime:one",
        processMode: "standard",
      },
      processMode: "standard",
      metadata: {},
    };
    const pipelineResultTwo: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: "tab.key2",
        providerType: "responses",
        outboundProfile: "openai-responses",
        runtimeKey: "runtime:two",
        processMode: "standard",
      },
      processMode: "standard",
      metadata: {},
    };

    const fakePipeline: HubPipeline = {
      execute: jest
        .fn()
        .mockReturnValueOnce(pipelineResultOne)
        .mockReturnValueOnce(pipelineResultTwo),
    };

    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn(),
      getHandleByRuntimeKey: jest.fn((runtimeKey: string) =>
        runtimeKey === "runtime:one" ? rateLimitedHandle : successHandle,
      ),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn(),
    } as unknown as ProviderRuntimeManager;

    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn(),
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies =>
        ({
          errorHandlingCenter: {
            handleError: jest.fn().mockReturnValue({ success: true }),
          },
        }) as ModuleDependencies,
      logStage: jest.fn(),
      stats,
    };

    const executor = new HubRequestExecutor(deps);
    const convertSpy = jest
      .spyOn(executor as any, "convertProviderResponseIfNeeded")
      .mockReturnValueOnce({ status: 200, body: { id: "resp_ok" } });

    const request: PipelineExecutionInput = {
      requestId: "req_retry_429_wrapped",
      entryEndpoint: "/v1/chat/completions",
      headers: {},
      body: { messages: [{ role: "user", content: "retry me" }] },
      metadata: { stream: false, inboundStream: false },
    };

    const response = await executor.execute(request);

    expect(response).toEqual(expect.objectContaining({ status: 200 }));
    expect(convertSpy).toHaveBeenCalledTimes(1);
    expect(fakePipeline.execute).toHaveBeenCalledTimes(2);
    expect(rateLimitedHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(successHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    const secondCallMetadata = fakePipeline.execute.mock.calls[1][0]
      .metadata as Record<string, unknown>;
    expect(secondCallMetadata.retryAttempt).toBe(2);
  });

  it("reroutes when SSE wrapper carries Anthropic 1302 rate-limit error", async () => {
    const rateLimitedHandle = createRuntimeHandle(async () => ({
      status: 200,
      data: {
        mode: "sse",
        error:
          "Anthropic SSE error event [1302] 您的账户已达到速率限制，请您控制请求频率",
      },
    }));
    const successHandle = createRuntimeHandle(async () => ({
      status: 200,
      data: { ok: true },
    }));

    const pipelineResultOne: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: "tab.key1",
        providerType: "responses",
        outboundProfile: "openai-responses",
        runtimeKey: "runtime:one",
        processMode: "standard",
      },
      processMode: "standard",
      metadata: {},
    };
    const pipelineResultTwo: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: "tab.key2",
        providerType: "responses",
        outboundProfile: "openai-responses",
        runtimeKey: "runtime:two",
        processMode: "standard",
      },
      processMode: "standard",
      metadata: {},
    };

    const fakePipeline: HubPipeline = {
      execute: jest
        .fn()
        .mockReturnValueOnce(pipelineResultOne)
        .mockReturnValueOnce(pipelineResultTwo),
    };

    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn(),
      getHandleByRuntimeKey: jest.fn((runtimeKey: string) =>
        runtimeKey === "runtime:one" ? rateLimitedHandle : successHandle,
      ),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn(),
    } as unknown as ProviderRuntimeManager;

    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn(),
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies =>
        ({
          errorHandlingCenter: {
            handleError: jest.fn().mockReturnValue({ success: true }),
          },
        }) as ModuleDependencies,
      logStage: jest.fn(),
      stats,
    };

    const executor = new HubRequestExecutor(deps);
    const request: PipelineExecutionInput = {
      requestId: "req_retry_1302",
      entryEndpoint: "/internal/test",
      headers: {},
      body: { messages: [{ role: "user", content: "retry me" }] },
      metadata: { stream: false, inboundStream: false },
    };

    const startedAt = Date.now();
    const response = await executor.execute(request);

    expect(response.status).toBe(200);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(fakePipeline.execute).toHaveBeenCalledTimes(2);
    expect(rateLimitedHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(successHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
  });

  it("reroutes when SSE wrapper carries Anthropic 500 upstream failure", async () => {
    const failingHandle = createRuntimeHandle(async () => ({
      status: 200,
      data: {
        mode: "sse",
        error:
          "Anthropic SSE error event [500] Operation failed (request_id=req500)",
      },
    }));
    const successHandle = createRuntimeHandle(async () => ({
      status: 200,
      data: { ok: true },
    }));

    const firstResult: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: "tab.key1",
        providerType: "responses",
        outboundProfile: "openai-responses",
        runtimeKey: "runtime:one",
        processMode: "standard",
      },
      processMode: "standard",
      metadata: {},
    };
    const secondResult: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: "tab.key2",
        providerType: "responses",
        outboundProfile: "openai-responses",
        runtimeKey: "runtime:two",
        processMode: "standard",
      },
      processMode: "standard",
      metadata: {},
    };

    const fakePipeline: HubPipeline = {
      execute: jest
        .fn()
        .mockReturnValueOnce(firstResult)
        .mockReturnValueOnce(secondResult),
    };

    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn(),
      getHandleByRuntimeKey: jest.fn((runtimeKey: string) =>
        runtimeKey === "runtime:one" ? failingHandle : successHandle,
      ),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn(),
    } as unknown as ProviderRuntimeManager;

    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn(),
    };

    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies =>
        ({
          errorHandlingCenter: {
            handleError: jest.fn().mockReturnValue({ success: true }),
          },
        }) as ModuleDependencies,
      logStage: jest.fn(),
      stats,
    };

    const executor = new HubRequestExecutor(deps);
    const request: PipelineExecutionInput = {
      requestId: "req_retry_sse_500",
      entryEndpoint: "/internal/test",
      headers: {},
      body: { messages: [{ role: "user", content: "retry me" }] },
      metadata: { stream: false, inboundStream: false },
    };

    const startedAt = Date.now();
    const response = await executor.execute(request);

    expect(response.status).toBe(200);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(fakePipeline.execute).toHaveBeenCalledTimes(2);
    expect(failingHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(successHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
  });

  it("prefers route-selected target compatibility profile for response conversion metadata", async () => {
    const handle = createRuntimeHandle(async () => ({
      data: { id: "resp_ok" },
      status: 200,
    }));
    const pipelineResultDeepSeek: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: "provider-a.3.model-a",
        providerType: "responses",
        outboundProfile: "openai-responses",
        runtimeKey: "runtime:deepseek",
        processMode: "standard",
        compatibilityProfile: "chat:provider-a",
      },
      processMode: "standard",
      metadata: {},
    };
    const fakePipeline: HubPipeline = {
      execute: jest.fn().mockReturnValueOnce(pipelineResultDeepSeek),
    };
    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn(),
      getHandleByRuntimeKey: jest.fn().mockReturnValue(handle),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn(),
    } as unknown as ProviderRuntimeManager;
    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn(),
    };
    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies =>
        ({
          errorHandlingCenter: {
            handleError: jest.fn().mockReturnValue({ success: true }),
          },
        }) as ModuleDependencies,
      logStage: jest.fn(),
      stats,
    };

    const executor = new HubRequestExecutor(deps);
    const convertSpy = jest
      .spyOn(executor as any, "convertProviderResponseIfNeeded")
      .mockImplementation(async (options: any) => options.response);

    const request: PipelineExecutionInput = {
      requestId: "req_profile_override",
      entryEndpoint: "/v1/responses",
      headers: {},
      body: { input: "ping" },
      metadata: {
        stream: false,
        inboundStream: false,
        compatibilityProfile: "compat:passthrough",
        target: {
          providerKey: "provider-b.1.coder-model",
          compatibilityProfile: "compat:passthrough",
        },
      } as Record<string, unknown>,
    };

    await executor.execute(request);

    expect(convertSpy).toHaveBeenCalledTimes(1);
    const convertOptions = convertSpy.mock.calls[0]?.[0] as {
      pipelineMetadata?: Record<string, unknown>;
    };
    const observation = readRuntimeProviderObservationProjection(
      convertOptions.pipelineMetadata,
    );
    expect(observation.compatibilityProfile).toBe("chat:provider-a");
    expect(observation.target?.providerKey).toBe("provider-a.3.model-a");
    expect(observation.target?.compatibilityProfile).toBe("chat:provider-a");
  });

  it("drops inherited compatibility profile when route target has no compatibility profile", async () => {
    const handle = createRuntimeHandle(async () => ({
      data: { id: "resp_ok" },
      status: 200,
    }));
    const pipelineResultNoCompat: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: "tabglm.key1.glm-5",
        providerType: "anthropic",
        outboundProfile: "anthropic-messages",
        runtimeKey: "runtime:tabglm",
        processMode: "standard",
      },
      processMode: "standard",
      metadata: {},
    };
    const fakePipeline: HubPipeline = {
      execute: jest.fn().mockReturnValueOnce(pipelineResultNoCompat),
    };
    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn(),
      getHandleByRuntimeKey: jest.fn().mockReturnValue(handle),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn(),
    } as unknown as ProviderRuntimeManager;
    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn(),
    };
    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies =>
        ({
          errorHandlingCenter: {
            handleError: jest.fn().mockReturnValue({ success: true }),
          },
        }) as ModuleDependencies,
      logStage: jest.fn(),
      stats,
    };

    const executor = new HubRequestExecutor(deps);
    const convertSpy = jest
      .spyOn(executor as any, "convertProviderResponseIfNeeded")
      .mockImplementation(async (options: any) => options.response);

    const request: PipelineExecutionInput = {
      requestId: "req_profile_drop",
      entryEndpoint: "/v1/messages",
      headers: {},
      body: { messages: [{ role: "user", content: "ping" }] },
      metadata: {
        stream: false,
        inboundStream: false,
        compatibilityProfile: "chat:glm",
        target: {
          providerKey: "glm.1.glm-4.6",
          compatibilityProfile: "chat:glm",
        },
      } as Record<string, unknown>,
    };

    await executor.execute(request);

    expect(convertSpy).toHaveBeenCalledTimes(1);
    const convertOptions = convertSpy.mock.calls[0]?.[0] as {
      pipelineMetadata?: Record<string, unknown>;
    };
    const observation = readRuntimeProviderObservationProjection(
      convertOptions.pipelineMetadata,
    );
    expect(observation.compatibilityProfile).toBeUndefined();
    expect(observation.target?.providerKey).toBe("tabglm.key1.glm-5");
    expect(observation.target?.compatibilityProfile).toBeUndefined();
  });

  it("preserves session scope metadata when pipeline metadata contains undefined fields", async () => {
    const handle = createRuntimeHandle(async () => ({
      data: { id: "resp_ok" },
      status: 200,
    }));
    const pipelineResultWithUndefinedMetadata: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: "glm.3-138.kimi-k2.5",
        providerType: "responses",
        outboundProfile: "openai-responses",
        runtimeKey: "runtime:glm",
        processMode: "standard",
      },
      processMode: "standard",
      metadata: {
        sessionId: undefined,
        tmuxSessionId: undefined,
        clientInjectReady: undefined,
      },
    };
    const fakePipeline: HubPipeline = {
      execute: jest
        .fn()
        .mockReturnValueOnce(pipelineResultWithUndefinedMetadata),
    };
    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn(),
      getHandleByRuntimeKey: jest.fn().mockReturnValue(handle),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn(),
    } as unknown as ProviderRuntimeManager;
    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn(),
    };
    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies =>
        ({
          errorHandlingCenter: {
            handleError: jest.fn().mockReturnValue({ success: true }),
          },
        }) as ModuleDependencies,
      logStage: jest.fn(),
      stats,
      onRequestStart: ({
        metadata,
      }: {
        metadata: Record<string, unknown>;
      }) => {
        metadata.sessionId = "session-abc";
        metadata.tmuxSessionId = "tmux-main-1";
        metadata.clientInjectReady = true;
      },
    };
    const executor = new HubRequestExecutor(deps);
    const convertSpy = jest
      .spyOn(executor as any, "convertProviderResponseIfNeeded")
      .mockImplementation(async (options: any) => options.response);

    const request: PipelineExecutionInput = {
      requestId: "req_preserve_session_scope",
      entryEndpoint: "/v1/responses",
      headers: {},
      body: { input: "ping" },
      metadata: {
        stream: false,
        inboundStream: false,
        sessionId: "session-abc",
        tmuxSessionId: "tmux-main-1",
        clientInjectReady: true,
      } as Record<string, unknown>,
    };

    await executor.execute(request);

    expect(convertSpy).toHaveBeenCalledTimes(1);
    const convertOptions = convertSpy.mock.calls[0]?.[0] as {
      pipelineMetadata?: Record<string, unknown>;
    };
    expect(convertOptions?.pipelineMetadata?.sessionId).toBe("session-abc");
    expect(convertOptions?.pipelineMetadata?.tmuxSessionId).toBe("tmux-main-1");
    expect(convertOptions?.pipelineMetadata?.clientInjectReady).toBe(true);
  });

  it("projects provider auth errors only after route and default pools are exhausted", async () => {
    const fatal = Object.assign(new Error("HTTP 401"), {
      statusCode: 401,
      code: "INVALID_API_KEY",
      retryable: false,
    });
    const excludedProviderKeys = new Set<string>();
    const plan =
      await __requestExecutorTestables.resolveProviderRetryExecutionPlan({
        error: fatal,
        retryError: {
          statusCode: 401,
          errorCode: "INVALID_API_KEY",
          reason: "HTTP 401",
        },
        attempt: 1,
        maxAttempts: 1,
        stage: "provider.send",
        providerKey: "gemini.primary",
        runtimeKey: "runtime:key",
        logicalRequestChainKey: "req_test",
        logicalChainRetryLimitStageRequestId: "req_test",
        routePool: [],
        routePoolIsAuthoritative: true,
        defaultTierAvailable: false,
        runtimeManager: {
          resolveRuntimeKey: jest.fn().mockReturnValue("runtime:key"),
        },
        excludedProviderKeys,
        recordAttempt: jest.fn(),
        logStage: jest.fn(),
        status: 401,
      });

    expect(plan).toMatchObject({
      shouldRetry: false,
      policyExhausted: true,
      mayProject: true,
    });
  });

  it("waits and reroutes DeepSeek file upload failures to another provider", async () => {
    const fatal = Object.assign(
      new Error("DeepSeek file upload returned non-JSON payload"),
      {
        statusCode: 502,
        code: "DEEPSEEK_FILE_UPLOAD_FAILED",
        upstreamCode: "DEEPSEEK_FILE_UPLOAD_FAILED",
        retryable: true,
      },
    );
    const handle = createRuntimeHandle(async () => {
      throw fatal;
    });
    const fallbackHandle = createRuntimeHandle(async () => ({ ok: true }));
    const pipelineResult: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: "provider-a.berg.model-c",
        providerType: "openai",
        outboundProfile: "openai-responses",
        runtimeKey: "provider-a.berg",
        processMode: "standard",
      },
      routingDecision: {
        routeName: "coding",
        routePool: ["provider-a.berg.model-c", "provider-b.key.model-c"],
      } as unknown as { routeName?: string },
      processMode: "standard",
      metadata: {},
    };
    const fallbackResult: PipelineExecutionResult = {
      ...pipelineResult,
      target: {
        providerKey: "provider-b.key.model-c",
        providerType: "openai",
        outboundProfile: "openai-responses",
        runtimeKey: "provider-b.key",
        processMode: "standard",
      },
    };
    const { executor, request, runtimeManager } = createExecutor(
      pipelineResult,
      handle,
      {
        fallback: {
          pipelineResult: fallbackResult,
          handle: fallbackHandle,
        },
      },
    );
    runtimeManager.resolveRuntimeKey = jest.fn((providerKey?: string) => {
      if (providerKey === "provider-a.berg.model-c") return "provider-a.berg";
      if (providerKey === "provider-b.key.model-c") return "provider-b.key";
      return undefined;
    }) as unknown as ProviderRuntimeManager["resolveRuntimeKey"];

    const startedAt = Date.now();
    const response = await executor.execute({
      ...request,
      entryEndpoint: "/v1/chat/completions",
      body: { messages: [{ role: "user", content: "retry me" }] },
    });

    expect(response.status).toBe(200);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(handle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(fallbackHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(runtimeManager.getHandleByRuntimeKey).toHaveBeenCalledTimes(2);
  });

  it("waits and reroutes HTTP 400 signature-invalid provider errors", async () => {
    const invalidSig = Object.assign(
      new Error("HTTP 400: thinking.signature invalid"),
      {
        statusCode: 400,
        retryable: false,
        upstreamMessage: "Bad Request: thinking.signature",
      },
    );

    const handle = createRuntimeHandle(async () => {
      throw invalidSig;
    });
    const successHandle = createRuntimeHandle(async () => ({ ok: true }));

    const pipelineResultA: PipelineExecutionResult = {
      providerPayload: {
        metadata: { requestTag: "sig-invalid" },
        data: { messages: [] },
      },
      target: {
        providerKey: "gemini.models/gemini-2.5-pro",
        providerType: "gemini",
        outboundProfile: "gemini-chat",
        runtimeKey: "runtime:ag",
        processMode: "standard",
      },
      routingDecision: {
        routeName: "coding",
        routePool: [
          "gemini.models/gemini-2.5-pro",
          "provider-b.models/coder",
        ],
      },
      processMode: "standard",
      metadata: {},
    };
    const pipelineResultB: PipelineExecutionResult = {
      ...pipelineResultA,
      target: {
        providerKey: "provider-b.models/coder",
        providerType: "openai",
        outboundProfile: "openai-chat",
        runtimeKey: "runtime:provider-b",
        processMode: "standard",
      },
    };

    const fakePipeline: HubPipeline = {
      execute: jest
        .fn()
        .mockReturnValueOnce(pipelineResultA)
        .mockReturnValueOnce(pipelineResultB),
    };

    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn(),
      getHandleByRuntimeKey: jest.fn((runtimeKey: string) =>
        runtimeKey === "runtime:ag" ? handle : successHandle,
      ),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn(),
    } as unknown as ProviderRuntimeManager;

    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn(),
    };
    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies =>
        ({
          errorHandlingCenter: {
            handleError: jest.fn().mockReturnValue({ success: true }),
          },
        }) as ModuleDependencies,
      logStage: jest.fn(),
      stats,
    };
    const executor = new HubRequestExecutor(deps);
    stubConvertProviderResponse();
    const request: PipelineExecutionInput = {
      requestId: "req_invalid_sig",
      entryEndpoint: "/v1/chat/completions",
      headers: {},
      body: { messages: [{ role: "user", content: "retry me" }] },
      metadata: { stream: false, inboundStream: false },
    };

    const startedAt = Date.now();
    const response = await executor.execute(request);

    expect(response.status).toBe(200);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(fakePipeline.execute).toHaveBeenCalledTimes(2);
    expect(handle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(successHandle.instance.processIncoming).toHaveBeenCalledTimes(1);
  });

  it("excludes only the current provider on PROVIDER_TRAFFIC_SATURATED retry", async () => {
    const saturatedError = Object.assign(
      new Error("provider traffic wait exceeded soft timeout"),
      {
        statusCode: 429,
        code: "PROVIDER_TRAFFIC_SATURATED",
        retryable: true,
      },
    );
    const failingHandle = createRuntimeHandle(async () => {
      throw saturatedError;
    });
    const successHandle = createRuntimeHandle(async () => ({ ok: true }));

    const firstResult: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: "tab.key1",
        providerType: "responses",
        outboundProfile: "openai-responses",
        runtimeKey: "runtime:one",
        processMode: "standard",
      },
      routingDecision: {
        routeName: "tools",
        pool: ["tab.key1", "tab.key1.alt", "tab.key2"],
      } as unknown as { routeName?: string },
      processMode: "standard",
      metadata: {},
    };
    const secondResult: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: "tab.key2",
        providerType: "responses",
        outboundProfile: "openai-responses",
        runtimeKey: "runtime:two",
        processMode: "standard",
      },
      processMode: "standard",
      metadata: {},
    };

    const fakePipeline: HubPipeline = {
      execute: jest
        .fn()
        .mockReturnValueOnce(firstResult)
        .mockReturnValueOnce(secondResult),
    };
    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn((providerKey?: string) => {
        if (providerKey === "tab.key1" || providerKey === "tab.key1.alt") {
          return "runtime:one";
        }
        if (providerKey === "tab.key2") {
          return "runtime:two";
        }
        return undefined;
      }),
      getHandleByRuntimeKey: jest.fn((runtimeKey: string) =>
        runtimeKey === "runtime:one" ? failingHandle : successHandle,
      ),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn(),
    } as unknown as ProviderRuntimeManager;

    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn(),
    };
    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies =>
        ({
          errorHandlingCenter: {
            handleError: jest.fn().mockReturnValue({ success: true }),
          },
        }) as ModuleDependencies,
      logStage: jest.fn(),
      stats,
    };
    const executor = new HubRequestExecutor(deps);
    stubConvertProviderResponse();
    const request: PipelineExecutionInput = {
      requestId: "req_runtime_scope_exclude",
      entryEndpoint: "/v1/chat/completions",
      headers: {},
      body: { messages: [{ role: "user", content: "retry me" }] },
      metadata: { stream: false, inboundStream: false },
    };

    const response = await executor.execute(request);
    expect(response).toBeDefined();
    expect(fakePipeline.execute).toHaveBeenCalledTimes(2);
    const secondCallMetadata = fakePipeline.execute.mock.calls[1][0]
      .metadata as Record<string, unknown>;
    const excluded = Array.isArray(secondCallMetadata.excludedProviderKeys)
      ? (secondCallMetadata.excludedProviderKeys as string[])
      : [];
    expect(excluded).toEqual(["tab.key1"]);
  });

  it("waits before switching to the alternative provider for a transport recoverable error", async () => {
    const transientError = Object.assign(new Error("socket reset"), {
      code: "ECONNRESET",
      retryable: true,
    });
    const providerACalls: number[] = [];
    const providerBCalls: number[] = [];
    const providerAHandle = createRuntimeHandle(async () => {
      providerACalls.push(providerACalls.length + 1);
      throw transientError;
    });
    const providerBHandle = createRuntimeHandle(async () => {
      providerBCalls.push(providerBCalls.length + 1);
      return { ok: true };
    });
    const providerAResult: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: "tab.key1",
        providerType: "responses",
        outboundProfile: "openai-responses",
        runtimeKey: "runtime:one",
        processMode: "standard",
      },
      routingDecision: {
        routeName: "tools",
        pool: ["tab.key1", "tab.key2"],
      } as unknown as { routeName?: string },
      processMode: "standard",
      metadata: {},
    };
    const providerBResult: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: "tab.key2",
        providerType: "responses",
        outboundProfile: "openai-responses",
        runtimeKey: "runtime:two",
        processMode: "standard",
      },
      routingDecision: {
        routeName: "tools",
        pool: ["tab.key1", "tab.key2"],
      } as unknown as { routeName?: string },
      processMode: "standard",
      metadata: {},
    };
    const fakePipeline: HubPipeline = {
      execute: jest.fn((input: PipelineExecutionInput) => {
        const metadata =
          input.metadata && typeof input.metadata === "object"
            ? (input.metadata as Record<string, unknown>)
            : {};
        if (metadata.__routecodexRetryProviderKey === "tab.key1") {
          return providerAResult;
        }
        const excluded = Array.isArray(metadata.excludedProviderKeys)
          ? metadata.excludedProviderKeys
          : [];
        return excluded.includes("tab.key1")
          ? providerBResult
          : providerAResult;
      }),
    };
    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn((providerKey?: string) => {
        if (providerKey === "tab.key1") return "runtime:one";
        if (providerKey === "tab.key2") return "runtime:two";
        return undefined;
      }),
      getHandleByRuntimeKey: jest.fn((runtimeKey: string) =>
        runtimeKey === "runtime:one" ? providerAHandle : providerBHandle,
      ),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn(),
    } as unknown as ProviderRuntimeManager;
    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn(),
    };
    const logStage = jest.fn();
    const deps = {
      runtimeManager,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies =>
        ({
          errorHandlingCenter: {
            handleError: jest.fn().mockReturnValue({ success: true }),
          },
        }) as ModuleDependencies,
      logStage,
      stats,
    };
    const executor = new HubRequestExecutor(deps);
    stubConvertProviderResponse();
    const request: PipelineExecutionInput = {
      requestId: "req_switch_immediately_on_alternative",
      entryEndpoint: "/v1/chat/completions",
      headers: {},
      body: { messages: [{ role: "user", content: "retry me" }] },
      metadata: { stream: false, inboundStream: false },
    };

    const startedAt = Date.now();
    const response = await executor.execute(request);

    expect(response).toBeDefined();
    expect(providerACalls).toHaveLength(1);
    expect(providerBCalls).toHaveLength(1);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
    expect(fakePipeline.execute).toHaveBeenCalledTimes(2);
    expect(
      (fakePipeline.execute as jest.Mock).mock.calls[1][0].metadata,
    ).toEqual(
      expect.objectContaining({
        excludedProviderKeys: ["tab.key1"],
      }),
    );
    const stages = logStage.mock.calls.map((call) => call[0]);
    expect(stages).toContain("provider.error_action_backoff_wait");
    expect(stages).toContain("provider.error_action_backoff_wait.completed");
    expect(stages).not.toContain("provider.transport_backoff_wait");
    expect(stages).not.toContain("server.global_error_backoff_wait");
  });

  it("does not pass legacy soft-wait options to provider traffic acquire", async () => {
    const acquireArgs: Array<Record<string, unknown>> = [];
    const trafficGovernor = {
      acquire: jest.fn(async (options: Record<string, unknown>) => {
        acquireArgs.push(options);
        return {
          permit: {
            runtimeKey: String(options.runtimeKey || ""),
            requestId: String(options.requestId || ""),
            leaseId: "lease-1",
            stateKey: "state-1",
          },
          policy: {
            concurrency: {
              maxInFlight: 2,
              acquireTimeoutMs: 60_000,
              staleLeaseMs: 300_000,
            },
            rpm: {
              requestsPerMinute: 120,
              acquireTimeoutMs: 60_000,
              windowMs: 60_000,
            },
          },
          waitedMs: 0,
          activeInFlight: 1,
          rpmInWindow: 1,
        };
      }),
      release: jest.fn(async () => ({ released: true, activeInFlight: 0 })),
    };

    const handle = createRuntimeHandle(async () => ({ ok: true }));
    const pipelineResult: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: "tab.key1",
        providerType: "responses",
        compatibilityProfile: "chat:provider-a",
        outboundProfile: "openai-responses",
        runtimeKey: "runtime:one",
        processMode: "standard",
      },
      routingDecision: {
        routeName: "tools",
        pool: ["tab.key1", "tab.key1.alt"],
      } as unknown as { routeName?: string },
      processMode: "standard",
      metadata: {},
    };
    const fakePipeline: HubPipeline = {
      execute: jest.fn().mockReturnValue(pipelineResult),
    };
    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn((providerKey?: string) => {
        if (providerKey === "tab.key1" || providerKey === "tab.key1.alt") {
          return "runtime:one";
        }
        if (providerKey === "tab.key2") {
          return "runtime:two";
        }
        return undefined;
      }),
      getHandleByRuntimeKey: jest.fn().mockReturnValue(handle),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn(),
    } as unknown as ProviderRuntimeManager;
    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn(),
    };
    const logStage = jest.fn();
    const deps = {
      runtimeManager,
      trafficGovernor,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies =>
        ({
          errorHandlingCenter: {
            handleError: jest.fn().mockReturnValue({ success: true }),
          },
        }) as ModuleDependencies,
      logStage,
      stats,
    };
    const executor = new HubRequestExecutor(deps);
    stubConvertProviderResponse();

    await executor.execute({
      requestId: "req_soft_wait_same_runtime",
      entryEndpoint: "/v1/chat/completions",
      headers: {},
      body: { messages: [{ role: "user", content: "same runtime pool" }] },
      metadata: { stream: false, inboundStream: false },
    });

    expect(acquireArgs[0]).not.toHaveProperty("softWaitTimeoutMs");

    (fakePipeline.execute as jest.Mock).mockReturnValueOnce({
      ...pipelineResult,
      routingDecision: {
        routeName: "tools",
        pool: ["tab.key1", "tab.key2"],
      },
    });

    await executor.execute({
      requestId: "req_soft_wait_cross_runtime",
      entryEndpoint: "/v1/chat/completions",
      headers: {},
      body: { messages: [{ role: "user", content: "cross runtime pool" }] },
      metadata: { stream: false, inboundStream: false },
    });

    expect(acquireArgs[1]).not.toHaveProperty("softWaitTimeoutMs");
  });

  it("runs servertool followup hops through the provider traffic governor", async () => {
    const trafficGovernor = {
      acquire: jest.fn(async () => ({
        permit: {
          runtimeKey: "runtime:one",
          requestId: "req_stopmessage_disabled_single_attempt",
          leaseId: "lease-followup",
          stateKey: "state-followup",
        },
        policy: {
          concurrency: {
            maxInFlight: 2,
            acquireTimeoutMs: 60_000,
            staleLeaseMs: 300_000,
          },
          rpm: {
            requestsPerMinute: 120,
            acquireTimeoutMs: 60_000,
            windowMs: 60_000,
          },
        },
        waitedMs: 0,
        activeInFlight: 1,
        rpmInWindow: 1,
      })),
      release: jest.fn(async () => ({ released: true, activeInFlight: 0 })),
      observeOutcome: jest.fn(async () => undefined),
    };

    const handle = createRuntimeHandle(async () => ({ ok: true }));
    const pipelineResult: PipelineExecutionResult = {
      providerPayload: { data: { messages: [] } },
      target: {
        providerKey: "tab.key1",
        providerType: "responses",
        outboundProfile: "openai-responses",
        runtimeKey: "runtime:one",
        processMode: "standard",
      },
      routingDecision: {
        routeName: "tools",
        pool: ["tab.key1"],
      } as unknown as { routeName?: string },
      processMode: "standard",
      metadata: {},
    };
    const fakePipeline: HubPipeline = {
      execute: jest.fn().mockReturnValue(pipelineResult),
    };
    const runtimeManager: ProviderRuntimeManager = {
      resolveRuntimeKey: jest.fn().mockReturnValue("runtime:one"),
      getHandleByRuntimeKey: jest.fn().mockReturnValue(handle),
      getHandleByProviderKey: jest.fn(),
      disposeAll: jest.fn(),
      initialize: jest.fn(),
    } as unknown as ProviderRuntimeManager;
    const stats = {
      recordRequestStart: jest.fn(),
      recordCompletion: jest.fn(),
      bindProvider: jest.fn(),
      recordToolUsage: jest.fn(),
    };
    const logStage = jest.fn();
    const deps = {
      runtimeManager,
      trafficGovernor,
      getHubPipeline: () => fakePipeline,
      getModuleDependencies: (): ModuleDependencies =>
        ({
          errorHandlingCenter: {
            handleError: jest.fn().mockReturnValue({ success: true }),
          },
        }) as ModuleDependencies,
      logStage,
      stats,
    };
    const executor = new HubRequestExecutor(deps);
    stubConvertProviderResponse();

    const response = await executor.execute({
      requestId: "req_stopmessage_disabled_single_attempt",
      entryEndpoint: "/v1/responses",
      headers: {},
      body: { input: "continue" },
      metadata: {
        stream: false,
        inboundStream: false,
        stopMessageEnabled: false,
      },
    });

    expect(response.status).toBe(200);
    expect(handle.instance.processIncoming).toHaveBeenCalledTimes(1);
    expect(trafficGovernor.acquire).toHaveBeenCalledTimes(1);
    expect(trafficGovernor.release).not.toHaveBeenCalled();
    expect(logStage.mock.calls.map((call) => call[0])).toContain(
      "provider.traffic.release.completed",
    );
  });
});

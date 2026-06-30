import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it, jest } from "@jest/globals";

jest.unstable_mockModule(
  "../../../src/modules/llmswitch/bridge.js",
  async () => {
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    return {
      createResponsesJsonToSseConverter: jest.fn(async () => ({
        convertResponseToJsonToSse: jest.fn(async () =>
          Readable.from(["event: response.completed\n", "data: {}\n\n"]),
        ),
      })),
      deriveFinishReasonNative: jest.fn((body: unknown) => {
        const record =
          body && typeof body === "object" && !Array.isArray(body)
            ? (body as Record<string, unknown>)
            : undefined;
        if (!record) {
          return undefined;
        }
        if (typeof record.finish_reason === "string" && record.finish_reason.trim()) {
          return record.finish_reason.trim();
        }
        const response =
          record.response && typeof record.response === "object" && !Array.isArray(record.response)
            ? (record.response as Record<string, unknown>)
            : undefined;
        if (typeof response?.finish_reason === "string" && response.finish_reason.trim()) {
          return response.finish_reason.trim();
        }
        const output = Array.isArray(record.output)
          ? record.output
          : Array.isArray(response?.output)
            ? response.output
            : [];
        if (
          output.some((item) =>
            item
            && typeof item === "object"
            && !Array.isArray(item)
            && (item as Record<string, unknown>).type === "function_call"
          )
        ) {
          return "tool_calls";
        }
        return undefined;
      }),
      isToolCallContinuationResponseNative: jest.fn((body: unknown) => {
        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return false;
        }
        const record = body as Record<string, unknown>;
        const requiredAction = record.required_action as Record<string, unknown> | undefined;
        const submit = requiredAction?.submit_tool_outputs as Record<string, unknown> | undefined;
        if (Array.isArray(submit?.tool_calls) && submit.tool_calls.length > 0) {
          return true;
        }
        const output = Array.isArray(record.output) ? record.output : [];
        return output.some((item) =>
          item
          && typeof item === "object"
          && !Array.isArray(item)
          && (item as Record<string, unknown>).type === "function_call"
        );
      }),
      updateResponsesContractProbeFromSseChunkNative: jest.fn((chunk: unknown, probe: unknown) => {
        const next = {
          ...((probe && typeof probe === "object" && !Array.isArray(probe)) ? probe as Record<string, unknown> : {}),
        };
        const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk ?? "");
        const upsertOutputItem = (item: unknown) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            return;
          }
          const outputItem = item as Record<string, unknown>;
          if (outputItem.type !== "function_call") {
            return;
          }
          const output = Array.isArray(next.output)
            ? [...next.output] as Record<string, unknown>[]
            : [];
          const id = typeof outputItem.id === "string" ? outputItem.id : undefined;
          const callId = typeof outputItem.call_id === "string" ? outputItem.call_id : undefined;
          const existingIndex = output.findIndex((row) => {
            if (!row || typeof row !== "object" || Array.isArray(row)) {
              return false;
            }
            return (id && row.id === id) || (callId && row.call_id === callId);
          });
          if (existingIndex >= 0) {
            output[existingIndex] = { ...output[existingIndex], ...outputItem };
          } else {
            output.push({ ...outputItem });
          }
          next.output = output;
        };
        const mergeArguments = (parsed: Record<string, unknown>, done: boolean) => {
          const callId = typeof parsed.call_id === "string" ? parsed.call_id : undefined;
          const itemId = typeof parsed.item_id === "string" ? parsed.item_id : undefined;
          const name = typeof parsed.name === "string" ? parsed.name : undefined;
          const delta = typeof parsed.delta === "string" ? parsed.delta : "";
          const finalArguments = typeof parsed.arguments === "string" ? parsed.arguments : undefined;
          const output = Array.isArray(next.output)
            ? [...next.output] as Record<string, unknown>[]
            : [];
          let index = output.findIndex((row) => {
            if (!row || typeof row !== "object" || Array.isArray(row)) {
              return false;
            }
            return (itemId && row.id === itemId) || (callId && row.call_id === callId);
          });
          if (index < 0) {
            output.push({
              id: itemId ?? (callId ? `fc_${callId}` : undefined),
              type: "function_call",
              call_id: callId,
              name: name ?? "function",
              arguments: "",
              status: "in_progress",
            });
            index = output.length - 1;
          }
          const current = output[index];
          const currentArgs = typeof current.arguments === "string" ? current.arguments : "";
          output[index] = {
            ...current,
            ...(callId ? { call_id: callId } : {}),
            ...(itemId ? { id: itemId } : {}),
            ...(name ? { name } : {}),
            arguments: finalArguments ?? `${currentArgs}${delta}`,
            ...(done ? { status: "completed" } : {}),
          };
          next.output = output;
        };
        for (const block of text.split(/\n\n/)) {
          const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice("data:".length).trimStart())
            .join("\n")
            .trim();
          if (!data || data === "[DONE]") {
            continue;
          }
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }
          if (parsed.type === "response.required_action" && parsed.required_action) {
            next.required_action = parsed.required_action;
            if (parsed.response && typeof parsed.response === "object" && !Array.isArray(parsed.response)) {
              Object.assign(next, parsed.response);
            }
          }
          if (parsed.type === "response.output_item.added" || parsed.type === "response.output_item.done") {
            upsertOutputItem(parsed.item);
          }
          if (parsed.type === "response.function_call_arguments.delta") {
            mergeArguments(parsed, false);
          }
          if (parsed.type === "response.function_call_arguments.done") {
            mergeArguments(parsed, true);
          }
          if (parsed.type === "response.completed" || parsed.type === "response.done") {
            next.__seen_response_done = parsed.type === "response.done" || next.__seen_response_done;
            const response = parsed.response;
            if (response && typeof response === "object" && !Array.isArray(response)) {
              const existingOutput = next.output;
              Object.assign(next, response);
              if (
                (!Array.isArray(next.output) || next.output.length === 0)
                && Array.isArray(existingOutput)
                && existingOutput.length > 0
              ) {
                next.output = existingOutput;
              }
            }
          }
        }
        return next;
      }),
      buildResponsesTerminalSseFramesFromProbeNative: jest.fn(() => []),
      importCoreDist: jest.fn(async (subpath?: string) => {
        if (subpath !== "native/router-hotpath/native-hub-pipeline-resp-semantics") {
          return {};
        }
        return {
          projectResponsesSseFrameForClientWithNative: (input: {
            frame: string;
            eventName?: string;
            data?: Record<string, unknown>;
            state: unknown;
          }) => {
            const requiredAction = input.data?.required_action as Record<string, unknown> | undefined;
            const submit = requiredAction?.submit_tool_outputs as Record<string, unknown> | undefined;
            const calls = Array.isArray(submit?.tool_calls)
              ? submit.tool_calls as Record<string, unknown>[]
              : [];
            if (input.eventName === "response.required_action" && calls.length > 0) {
              const frames = calls.map((call, index) => {
                const fn = call.function as Record<string, unknown> | undefined;
                const callId = String(call.id ?? call.call_id ?? `call_${index + 1}`);
                const name = String(fn?.name ?? call.name ?? "function");
                const args = String(fn?.arguments ?? call.arguments ?? "{}");
                const itemId = `fc_${callId}`;
                return [
                  `event: response.output_item.added\ndata: ${JSON.stringify({ type: "response.output_item.added", output_index: index, item: { id: itemId, type: "function_call", call_id: callId, name, arguments: "", status: "in_progress" } })}\n\n`,
                  `event: response.function_call_arguments.delta\ndata: ${JSON.stringify({ type: "response.function_call_arguments.delta", output_index: index, item_id: itemId, call_id: callId, delta: args })}\n\n`,
                  `event: response.function_call_arguments.done\ndata: ${JSON.stringify({ type: "response.function_call_arguments.done", output_index: index, item_id: itemId, call_id: callId, name, arguments: args })}\n\n`,
                  `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: index, item: { id: itemId, type: "function_call", call_id: callId, name, arguments: args, status: "completed" } })}\n\n`,
                ].join("");
              }).join("");
              return { emit: true, frame: frames, state: input.state };
            }
            return { emit: true, frame: input.frame, state: input.state };
          },
          projectResponsesClientPayloadForClientWithNative: (payload: unknown) => payload,
        };
      }),
      requireCoreDist: jest.fn(),
      captureResponsesRequestContextForRequest: jest.fn(
        async (args: {
          requestId: string;
          payload: Record<string, unknown>;
          context: Record<string, unknown>;
          sessionId?: string;
          routeHint?: string;
        }) => store.captureResponsesRequestContext(args),
      ),
      clearResponsesConversationByRequestId: jest.fn(
        async (requestId?: string) => {
          store.clearResponsesConversationByRequestId(requestId);
          return undefined;
        },
      ),
      finalizeResponsesConversationRequestRetention: jest.fn(
        async (
          requestId?: string,
          options?: { keepForSubmitToolOutputs?: boolean },
        ) => {
          store.finalizeResponsesConversationRequestRetention(
            requestId,
            options,
          );
          return undefined;
        },
      ),
      recordResponsesResponseForRequest: jest.fn(
        async (args: {
          requestId: string;
          response: Record<string, unknown>;
          routeHint?: string;
        }) => {
          store.recordResponsesResponse(args);
          return undefined;
        },
      ),
      rebindResponsesConversationRequestId: jest.fn(
        async (oldId?: string, newId?: string) => {
          store.rebindResponsesConversationRequestId(oldId, newId);
          return undefined;
        },
      ),
    };
  },
);

jest.unstable_mockModule("../../../src/utils/snapshot-writer.js", () => ({
  isSnapshotsEnabled: () => false,
  writeServerSnapshot: async () => undefined,
}));

class MockResponse extends PassThrough {
  public statusCode = 200;
  public headers = new Map<string, string>();

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(key: string, value: string): void {
    this.headers.set(key.toLowerCase(), value);
  }

  json(body: unknown): this {
    this.end(JSON.stringify(body));
    return this;
  }
}

async function waitForEnd(stream: PassThrough): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once("end", resolve);
    stream.once("error", reject);
    stream.resume();
  });
}

function responseFunctionCall(args: {
  callId: string;
  name: string;
  argumentsJson: string;
  id?: string;
}): Record<string, unknown> {
  return {
    id: args.id ?? `fc_${args.callId}`,
    type: "function_call",
    status: "completed",
    call_id: args.callId,
    name: args.name,
    arguments: args.argumentsJson,
  };
}

function requiredActionForFunctionCall(args: {
  callId: string;
  name: string;
  argumentsJson: string;
}): Record<string, unknown> {
  return {
    type: "submit_tool_outputs",
    submit_tool_outputs: {
      tool_calls: [
        {
          id: args.callId,
          type: "function_call",
          name: args.name,
          arguments: args.argumentsJson,
        },
      ],
    },
  };
}

function responsesToolCallBody(args: {
  responseId: string;
  callId: string;
  name: string;
  argumentsJson: string;
  status?: string;
  outputId?: string;
}): Record<string, unknown> {
  return {
    id: args.responseId,
    object: "response",
    status: args.status ?? "requires_action",
    output: [
      responseFunctionCall({
        callId: args.callId,
        name: args.name,
        argumentsJson: args.argumentsJson,
        id: args.outputId,
      }),
    ],
    required_action: requiredActionForFunctionCall({
      callId: args.callId,
      name: args.name,
      argumentsJson: args.argumentsJson,
    }),
  };
}

function requiredActionSseFrame(args: {
  responseId: string;
  callId: string;
  name: string;
  argumentsJson: string;
}): string {
  return [
    "event: response.required_action\n",
    `data: ${JSON.stringify({
      type: "response.required_action",
      response: {
        id: args.responseId,
        object: "response",
        status: "requires_action",
      },
      required_action: requiredActionForFunctionCall({
        callId: args.callId,
        name: args.name,
        argumentsJson: args.argumentsJson,
      }),
    })}\n\n`,
  ].join("");
}

describe("sendPipelineResponse responses store integration", () => {
  const requestIds = [
    "openai-responses-router-gpt-5.3-codex-native-sse-store",
    "openai-responses-router-gpt-5.3-codex-native-sse-premature-persist",
    "openai-responses-router-gpt-5.3-codex-native-sse-metadata-only-store",
    "openai-responses-router-gpt-5.3-codex-native-sse-no-final-delimiter",
    "openai-responses-router-gpt-5.3-codex-native-sse-tail-store",
    "openai-responses-sdfv.key1-gpt-5.4-live-shape-direct-sse",
    "openai-responses-openai.key1-gpt-5.4-none-20260523T102906604-222183-867",
    "openai-responses-router-gpt-5.3-codex-20260523T102906604-222183-867",
    "resp_native_sse_premature_persist_1",
    "resp_native_sse_metadata_only_store_1",
    "resp_native_sse_no_final_delimiter_1",
    "resp_native_sse_store_1",
    "resp_native_sse_tail_store_1",
    "resp_04c9be1feb153bec016a1539bb89a08196b1c2349ac465d6a3",
    "resp_1779503404150",
    "resp_provider_json_resume_1",
    "openai-responses-router-gpt-5.3-codex-orphan-cleanup",
    "openai-responses-openai.key1-gpt-5.4-none-orphan-cleanup",
    "resp_provider_orphan_cleanup_1",
    "req-provider-history-tool-next",
  ];

  afterEach(async () => {
    const bridge = await import("../../../src/modules/llmswitch/bridge.js");
    (bridge.captureResponsesRequestContextForRequest as jest.Mock).mockClear();
    (bridge.recordResponsesResponseForRequest as jest.Mock).mockClear();
    (bridge.clearResponsesConversationByRequestId as jest.Mock).mockClear();
    (
      bridge.finalizeResponsesConversationRequestRetention as jest.Mock
    ).mockClear();
    (bridge.rebindResponsesConversationRequestId as jest.Mock).mockClear();
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    for (const requestId of requestIds) {
      store.clearResponsesConversationByRequestId(requestId);
    }
  });

  it("RED: streamed provider tool_calls records provider context so history plus tools restore together", async () => {
    const { sendPipelineResponse } =
      await import("../../../src/server/handlers/handler-response-utils.js");
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    const providerRequestId =
      "openai-responses-openai.key1-gpt-5.4-none-20260523T102906604-222183-867";
    const routerRequestId =
      "openai-responses-router-gpt-5.3-codex-20260523T102906604-222183-867";
    const responseId = "resp_1779503404150";

    store.captureResponsesRequestContext({
      requestId: responseId,
      sessionId: "rcc-routecodex-2",
      payload: {
        model: "gpt-5.3-codex",
        store: true,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "first coding request" }],
          },
        ],
        tools: [{ type: "function", function: { name: "exec_command" } }],
      },
      context: {
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "first coding request" }],
          },
        ],
        toolsRaw: [{ type: "function", function: { name: "exec_command" } }],
      },
      routeHint: "tools/gateway-priority-5520-tools",
    });

    const res = new MockResponse();
    await sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: responsesToolCallBody({
          responseId,
          callId: "call_provider_history_tool",
          name: "exec_command",
          argumentsJson: '{"cmd":"pwd"}',
        }),
        usageLogInfo: {
          finishReason: "tool_calls",
          routeName: "tools/gateway-priority-5520-tools",
          sessionId: "rcc-routecodex-2",
          timingRequestIds: [providerRequestId, routerRequestId],
        },
      } as any,
      routerRequestId,
      {
        entryEndpoint: "/v1/responses",
        forceSSE: true,
        responsesRequestContext: {
          payload: {
            model: "gpt-5.3-codex",
            store: true,
            input: [
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "first coding request" }],
              },
            ],
            tools: [{ type: "function", function: { name: "exec_command" } }],
          },
          context: {
            input: [
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "first coding request" }],
              },
            ],
            toolsRaw: [{ type: "function", function: { name: "exec_command" } }],
          },
          sessionId: "rcc-routecodex-2",
        },
      },
    );
    await waitForEnd(res);

    const stats = store.responsesConversationStore.getDebugStats();
    expect(stats.responseIndexSize).toBe(1);
    expect(stats.scopeIndexSize).toBe(1);
    expect(stats.requestEntriesWithoutLastResponseId).toBe(0);

    const restored = store.resumeLatestResponsesContinuationByScope({
      requestId: "req-provider-history-tool-next",
      sessionId: "rcc-routecodex-2",
      payload: {
        model: "gpt-5.3-codex",
        store: true,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "first coding request" }],
          },
          {
            type: "function_call_output",
            call_id: "call_provider_history_tool",
            output: "/Users/fanzhang/Documents/github/routecodex",
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "continue coding" }],
          },
        ],
      },
    });

    expect(restored).not.toBeNull();
    expect(restored?.payload.previous_response_id).toBe("resp_1779503404150");
    expect(restored?.payload.tools).toEqual([
      { type: "function", name: "exec_command" },
    ]);
    expect(restored?.payload.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_provider_history_tool",
        output: "/Users/fanzhang/Documents/github/routecodex",
      },
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "continue coding" }],
      },
    ]);
  });

  it("RED: preset stream finish_reason must not persist native SSE conversation before terminal chunk arrives", async () => {
    const { sendPipelineResponse } =
      await import("../../../src/server/handlers/handler-response-utils.js");
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    const requestId =
      "openai-responses-router-gpt-5.3-codex-native-sse-premature-persist";
    const responseId = "resp_native_sse_premature_persist_1";
    const callId = "call_native_sse_premature_persist_1";

    async function* delayedTerminalStream(): AsyncGenerator<string> {
      yield "event: response.created\n";
      yield `data: ${JSON.stringify({
        type: "response.created",
        response: {
          id: responseId,
          object: "response",
          status: "in_progress",
        },
      })}\n\n`;
      await new Promise((resolve) => setTimeout(resolve, 40));
      yield "event: response.output_item.done\n";
      yield `data: ${JSON.stringify({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: `fc_${callId}`,
          type: "function_call",
          status: "completed",
          call_id: callId,
          name: "exec_command",
          arguments: '{"cmd":"pwd"}',
        },
      })}\n\n`;
      await new Promise((resolve) => setTimeout(resolve, 40));
      yield "event: response.completed\n";
      yield `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: responseId,
          object: "response",
          status: "completed",
        },
      })}\n\n`;
      yield "data: [DONE]\n\n";
    }

    const res = new MockResponse();
    await sendPipelineResponse(
      res as any,
      {
        status: 200,
        body: {
          id: responseId,
          object: "response",
          status: "in_progress",
        },
        sseStream: Readable.from(delayedTerminalStream()),
        usageLogInfo: {
          finishReason: "tool_calls",
          routeName: "thinking/gateway-priority-5555-thinking",
          sessionId: "rcc-native-sse-premature-persist",
        },
        metadata: {
          outboundStream: true,
        },
      } as any,
      requestId,
      {
        entryEndpoint: "/v1/responses",
        responsesRequestContext: {
          payload: {
            store: true,
            model: "gpt-5.3-codex",
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "call exec_command then continue",
                  },
                ],
              },
            ],
            tools: [{ type: "function", name: "exec_command" }],
          },
          context: {
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "call exec_command then continue",
                  },
                ],
              },
            ],
            toolsRaw: [{ type: "function", name: "exec_command" }],
          },
          sessionId: "rcc-native-sse-premature-persist",
        },
      },
    );
    await waitForEnd(res);

    const stats = store.responsesConversationStore.getDebugStats();
    expect(stats.responseIndexSize).toBe(1);
    expect(stats.requestEntriesWithoutLastResponseId).toBe(0);

    const resumed = store.resumeResponsesConversation(responseId, {
      tool_outputs: [
        {
          call_id: callId,
          output: "/Users/fanzhang/Documents/github/routecodex",
        },
      ],
    });
    expect(resumed.payload.previous_response_id).toBe(responseId);
  });

  it("RED: responses tool-call continuation must persist even when request store=false", async () => {
    const { sendPipelineResponse } =
      await import("../../../src/server/handlers/handler-response-utils.js");
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    const requestId = "openai-responses-router-gpt-5.3-codex-store-false-continuation";
    const responseId = "resp_store_false_continuation_1";
    const callId = "call_store_false_continuation_1";

    const res = new MockResponse();
    await sendPipelineResponse(
      res as any,
      {
        status: 200,
        sseStream: Readable.from([
            requiredActionSseFrame({
              responseId,
              callId,
              name: "echo",
              argumentsJson: '{"text":"PING_OK"}',
            }),
            "event: response.output_item.done\n",
            `data: ${JSON.stringify({
              type: "response.output_item.done",
              output_index: 0,
              item: {
                id: `fc_${callId}`,
                type: "function_call",
                status: "completed",
                arguments: '{"text":"PING_OK"}',
                call_id: callId,
                name: "echo",
              },
            })}\n\n`,
            "event: response.completed\n",
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                id: responseId,
                object: "response",
                status: "requires_action",
                output: [
                  responseFunctionCall({
                    callId,
                    name: "echo",
                    argumentsJson: '{"text":"PING_OK"}',
                  }),
                ],
                required_action: requiredActionForFunctionCall({
                  callId,
                  name: "echo",
                  argumentsJson: '{"text":"PING_OK"}',
                }),
              },
            })}\n\n`,
            "data: [DONE]\n\n",
          ]),
        usageLogInfo: {
          finishReason: "tool_calls",
          routeName: "tools/gateway-priority-5520-tools",
          sessionId: "store-false-session",
        },
        metadata: {
          outboundStream: true,
        },
      } as any,
      requestId,
      {
        entryEndpoint: "/v1/responses",
        responsesRequestContext: {
          payload: {
            model: "gpt-5.3-codex",
            store: false,
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "必须调用 echo 工具",
                  },
                ],
              },
            ],
            tools: [{ type: "function", name: "echo" }],
          },
          context: {
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "必须调用 echo 工具",
                  },
                ],
              },
            ],
            toolsRaw: [{ type: "function", name: "echo" }],
          },
          sessionId: "store-false-session",
        },
      },
    );
    await waitForEnd(res);

    const stats = store.responsesConversationStore.getDebugStats();
    expect(stats.responseIndexSize).toBeGreaterThanOrEqual(1);
    const resumed = store.resumeResponsesConversation(responseId, {
      tool_outputs: [
        {
          call_id: callId,
          output: "PING_OK",
        },
      ],
    });
    expect(resumed.payload.previous_response_id).toBe(responseId);
    expect(resumed.payload.providerKey).toBeUndefined();
    expect(resumed.meta.providerKey).toBeDefined();
  });


  it("RED: direct 5555 live-shape SSE tool_calls with completed status must still retain responseIndex for submit_tool_outputs", async () => {
    const { sendPipelineResponse } =
      await import("../../../src/server/handlers/handler-response-utils.js");
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    const requestId = "openai-responses-sdfv.key1-gpt-5.4-live-shape-direct-sse";
    const responseId = "resp_04c9be1feb153bec016a1539bb89a08196b1c2349ac465d6a3";
    const callId = "call_MxyUdrGqvHYTLLSUlXNp2FQu";

    const res = new MockResponse();
    await sendPipelineResponse(
      res as any,
      {
        status: 200,
        sseStream: Readable.from([
            "event: response.created\n",
            `data: ${JSON.stringify({
              type: "response.created",
              response: {
                id: responseId,
                object: "response",
                status: "in_progress",
              },
            })}\n\n`,
            requiredActionSseFrame({
              responseId,
              callId,
              name: "exec_command",
              argumentsJson: '{"cmd":"pwd"}',
            }),
            "event: response.output_item.done\n",
            `data: ${JSON.stringify({
              type: "response.output_item.done",
              output_index: 0,
              item: {
                id: "fc_04c9be1feb153bec016a1539bc954c8196a9fdff6c36397aea",
                type: "function_call",
                status: "completed",
                arguments: '{"cmd":"pwd"}',
                call_id: callId,
                name: "exec_command",
              },
            })}\n\n`,
            "event: response.completed\n",
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                id: responseId,
                object: "response",
                status: "requires_action",
                output: [
                  responseFunctionCall({
                    callId,
                    name: "exec_command",
                    argumentsJson: '{"cmd":"pwd"}',
                    id: "fc_04c9be1feb153bec016a1539bc954c8196a9fdff6c36397aea",
                  }),
                ],
                required_action: requiredActionForFunctionCall({
                  callId,
                  name: "exec_command",
                  argumentsJson: '{"cmd":"pwd"}',
                }),
              },
            })}\n\n`,
            "data: [DONE]\n\n",
          ]),
        usageLogInfo: {
          finishReason: "tool_calls",
          routeName: "thinking/gateway-priority-5555-thinking",
          sessionId: "live-5555-shape-session",
        },
        metadata: {
          outboundStream: true,
        },
      } as any,
      requestId,
      {
        entryEndpoint: "/v1/responses",
        responsesRequestContext: {
          payload: {
            model: "gpt-5.4",
            store: true,
            stream: true,
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "请调用 exec_command 工具执行 pwd，不要直接回答。",
                  },
                ],
              },
            ],
            tools: [
              {
                type: "function",
                name: "exec_command",
                description: "Run a shell command",
                parameters: {
                  type: "object",
                  properties: { cmd: { type: "string" } },
                  required: ["cmd"],
                },
              },
            ],
          },
          context: {
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "请调用 exec_command 工具执行 pwd，不要直接回答。",
                  },
                ],
              },
            ],
            toolsRaw: [
              {
                type: "function",
                name: "exec_command",
                description: "Run a shell command",
                parameters: {
                  type: "object",
                  properties: { cmd: { type: "string" } },
                  required: ["cmd"],
                },
              },
            ],
          },
          sessionId: "live-5555-shape-session",
        },
      },
    );
    await waitForEnd(res);

    const stats = store.responsesConversationStore.getDebugStats();
    expect(stats.responseIndexSize).toBe(1);
    expect(stats.requestEntriesWithoutLastResponseId).toBe(0);

    const resumed = store.resumeResponsesConversation(responseId, {
      tool_outputs: [
        { call_id: callId, output: "/Users/fanzhang/Documents/github/routecodex\n" },
      ],
    });
    expect(resumed.payload.previous_response_id).toBe(responseId);
  });

  it("RED: native SSE (sseStream) tool_calls must record responses continuation context", async () => {
    const { sendPipelineResponse } =
      await import("../../../src/server/handlers/handler-response-utils.js");
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    const requestId = "openai-responses-router-gpt-5.3-codex-native-sse-store";
    const responseId = "resp_native_sse_store_1";
    const callId = "call_native_sse_store_1";

    const res = new MockResponse();
    await sendPipelineResponse(
      res as any,
      {
        status: 200,
        sseStream: Readable.from([
            "event: response.required_action\n",
            `data: ${JSON.stringify({
              type: "response.required_action",
              response: {
                id: responseId,
                object: "response",
                status: "requires_action",
              },
              required_action: {
                type: "submit_tool_outputs",
                submit_tool_outputs: {
                  tool_calls: [
                    {
                      id: callId,
                      type: "function_call",
                      name: "update_plan",
                      arguments: '{"plan":[{"step":"native-sse-store"}]}',
                    },
                  ],
                },
              },
            })}\n\n`,
            "event: response.completed\n",
            `data: ${JSON.stringify({ type: "response.completed", response: { id: responseId, object: "response", status: "requires_action" } })}\n\n`,
          ]),
        usageLogInfo: {
          finishReason: "tool_calls",
          routeName: "thinking/gateway-priority-5555-thinking",
          sessionId: "rcc-native-sse-store",
        },
        metadata: {
          outboundStream: true,
        },
      } as any,
      requestId,
      {
        entryEndpoint: "/v1/responses",
        responsesRequestContext: {
          payload: {
            store: true,
            model: "gpt-5.3-codex",
            input: [
              {
                role: "user",
                content: [
                  { type: "input_text", text: "call update_plan and continue" },
                ],
              },
            ],
            tools: [{ type: "function", name: "update_plan" }],
          },
          context: {
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  { type: "input_text", text: "call update_plan and continue" },
                ],
              },
            ],
            toolsRaw: [{ type: "function", name: "update_plan" }],
          },
          sessionId: "rcc-native-sse-store",
        },
      },
    );
    await waitForEnd(res);

    const stats = store.responsesConversationStore.getDebugStats();
    expect(stats.responseIndexSize).toBe(1);
    expect(stats.requestMapSize).toBe(1);
  });

  it("RED: native SSE tool_calls must still persist responseIndex from result.metadata responsesRequestContext when dispatch options omit it", async () => {
    const { sendPipelineResponse } =
      await import("../../../src/server/handlers/handler-response-utils.js");
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    const requestId =
      "openai-responses-router-gpt-5.3-codex-native-sse-metadata-only-store";
    const responseId = "resp_native_sse_metadata_only_store_1";
    const callId = "call_native_sse_metadata_only_store_1";

    const res = new MockResponse();
    await sendPipelineResponse(
      res as any,
      {
        status: 200,
        sseStream: Readable.from([
            "event: response.required_action\n",
            `data: ${JSON.stringify({
              type: "response.required_action",
              response: {
                id: responseId,
                object: "response",
                status: "requires_action",
              },
              required_action: {
                type: "submit_tool_outputs",
                submit_tool_outputs: {
                  tool_calls: [
                    {
                      id: callId,
                      type: "function_call",
                      name: "update_plan",
                      arguments:
                        '{"plan":[{"step":"native-sse-metadata-only-store"}]}',
                    },
                  ],
                },
              },
            })}\n\n`,
            "event: response.completed\n",
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                id: responseId,
                object: "response",
                status: "requires_action",
              },
            })}\n\n`,
          ]),
        usageLogInfo: {
          finishReason: "tool_calls",
          routeName: "thinking/gateway-priority-5555-thinking",
        },
        metadata: {
          outboundStream: true,
          responsesRequestContext: {
            payload: {
              model: "gpt-5.3-codex",
              store: true,
              input: [
                {
                  role: "user",
                  content: [
                    {
                      type: "input_text",
                      text: "call update_plan and continue",
                    },
                  ],
                },
              ],
              tools: [{ type: "function", name: "update_plan" }],
            },
            context: {
              input: [
                {
                  type: "message",
                  role: "user",
                  content: [
                    {
                      type: "input_text",
                      text: "call update_plan and continue",
                    },
                  ],
                },
              ],
              toolsRaw: [{ type: "function", name: "update_plan" }],
            },
          },
        },
      } as any,
      requestId,
      {
        entryEndpoint: "/v1/responses",
        responsesRequestContext: {
          payload: {
            model: "gpt-5.3-codex",
            store: true,
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "call update_plan and continue from existing inbound store",
                  },
                ],
              },
            ],
            tools: [{ type: "function", name: "update_plan" }],
          },
          context: {
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "call update_plan and continue from existing inbound store",
                  },
                ],
              },
            ],
            toolsRaw: [{ type: "function", name: "update_plan" }],
          },
          sessionId: "rcc-native-sse-existing-inbound-store",
        },
      },
    );
    await waitForEnd(res);

    const stats = store.responsesConversationStore.getDebugStats();
    expect(stats.requestMapSize).toBe(1);
    expect(stats.responseIndexSize).toBe(1);
    expect(stats.requestEntriesWithoutLastResponseId).toBe(0);

    const resumed = store.resumeResponsesConversation(responseId, {
      tool_outputs: [
        {
          call_id: callId,
          output: "metadata-only-store-ok",
        },
      ],
    });
    expect(resumed.payload.previous_response_id).toBe(responseId);
  });

  it("RED: native SSE (sseStream) tool_calls with trailing tail must not leave continuation context half-closed", async () => {
    const { sendPipelineResponse } =
      await import("../../../src/server/handlers/handler-response-utils.js");
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    const requestId =
      "openai-responses-router-gpt-5.3-codex-native-sse-tail-store";
    const responseId = "resp_native_sse_tail_store_1";
    const callId = "call_native_sse_tail_store_1";

    const res = new MockResponse();
    await sendPipelineResponse(
      res as any,
      {
        status: 200,
        sseStream: Readable.from([
            "event: response.required_action\n",
            `data: ${JSON.stringify({
              type: "response.required_action",
              response: {
                id: responseId,
                object: "response",
                status: "requires_action",
              },
              required_action: {
                type: "submit_tool_outputs",
                submit_tool_outputs: {
                  tool_calls: [
                    {
                      id: callId,
                      type: "function_call",
                      name: "update_plan",
                      arguments: '{"plan":[{"step":"native-sse-tail-store"}]}',
                    },
                  ],
                },
              },
            })}\n\n`,
            "event: response.completed\n",
            `data: ${JSON.stringify({ type: "response.completed", response: { id: responseId, object: "response", status: "requires_action" } })}\n\n`,
            ": trailing-tail-after-terminal\n\n",
            "data: [DONE]\n\n",
          ]),
        usageLogInfo: {
          finishReason: "tool_calls",
          routeName: "thinking/gateway-priority-5555-thinking",
          sessionId: "rcc-native-sse-tail-store",
        },
        metadata: {
          outboundStream: true,
        },
      } as any,
      requestId,
      {
        entryEndpoint: "/v1/responses",
        responsesRequestContext: {
          payload: {
            store: true,
            model: "gpt-5.3-codex",
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "call update_plan and continue with tail",
                  },
                ],
              },
            ],
            tools: [{ type: "function", name: "update_plan" }],
          },
          context: {
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "call update_plan and continue with tail",
                  },
                ],
              },
            ],
            toolsRaw: [{ type: "function", name: "update_plan" }],
          },
          sessionId: "rcc-native-sse-tail-store",
        },
      },
    );
    await waitForEnd(res);

    const stats = store.responsesConversationStore.getDebugStats();
    expect(stats.responseIndexSize).toBe(1);
    expect(stats.requestMapSize).toBe(1);
    expect(stats.requestEntriesWithoutLastResponseId).toBe(0);

    const resumed = store.resumeResponsesConversation(responseId, {
      response_id: responseId,
      tool_outputs: [{ tool_call_id: callId, output: "tail-store-ok" }],
    });

    expect(resumed.payload.previous_response_id).toBe(responseId);
    expect(resumed.payload.providerKey).toBeUndefined();
    expect(resumed.meta.providerKey).toBeDefined();
    expect(resumed.payload.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function_call_output",
          call_id: callId,
          output: "tail-store-ok",
        }),
      ]),
    );
  });

  it("RED: native SSE tool_calls ending without final SSE delimiter must still persist responseIndex for submit_tool_outputs", async () => {
    const { sendPipelineResponse } =
      await import("../../../src/server/handlers/handler-response-utils.js");
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    const requestId =
      "openai-responses-router-gpt-5.3-codex-native-sse-no-final-delimiter";
    const responseId = "resp_native_sse_no_final_delimiter_1";
    const callId = "call_native_sse_no_final_delimiter_1";

    const res = new MockResponse();
    await sendPipelineResponse(
      res as any,
      {
        status: 200,
        sseStream: Readable.from([
            "event: response.required_action\n",
            `data: ${JSON.stringify({
              type: "response.required_action",
              response: {
                id: responseId,
                object: "response",
                status: "requires_action",
              },
              required_action: {
                type: "submit_tool_outputs",
                submit_tool_outputs: {
                  tool_calls: [
                    {
                      id: callId,
                      type: "function_call",
                      name: "update_plan",
                      arguments:
                        '{"plan":[{"step":"native-sse-no-final-delimiter"}]}',
                    },
                  ],
                },
              },
            })}\n\n`,
            "event: response.completed\n",
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                id: responseId,
                object: "response",
                status: "requires_action",
                output: [
                  {
                    type: "function_call",
                    call_id: callId,
                    id: `fc_${callId}`,
                    name: "update_plan",
                    arguments:
                      '{"plan":[{"step":"native-sse-no-final-delimiter"}]}',
                  },
                ],
              },
            })}`,
          ]),
        usageLogInfo: {
          finishReason: "tool_calls",
          routeName: "thinking/gateway-priority-5555-thinking",
          sessionId: "rcc-native-sse-no-final-delimiter",
        },
        metadata: {
          outboundStream: true,
        },
      } as any,
      requestId,
      {
        entryEndpoint: "/v1/responses",
        responsesRequestContext: {
          payload: {
            store: true,
            model: "gpt-5.3-codex",
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "call update_plan and continue without final delimiter",
                  },
                ],
              },
            ],
            tools: [{ type: "function", name: "update_plan" }],
          },
          context: {
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "call update_plan and continue without final delimiter",
                  },
                ],
              },
            ],
            toolsRaw: [{ type: "function", name: "update_plan" }],
          },
          sessionId: "rcc-native-sse-no-final-delimiter",
        },
      },
    );
    await waitForEnd(res);

    const stats = store.responsesConversationStore.getDebugStats();
    expect(stats.responseIndexSize).toBe(1);
    expect(stats.requestEntriesWithoutLastResponseId).toBe(0);

    const resumed = store.resumeResponsesConversation(responseId, {
      tool_outputs: [{ call_id: callId, output: "no-final-delimiter-ok" }],
    });
    expect(resumed.payload.previous_response_id).toBe(responseId);
  });

  it("RED: native SSE tool_calls must still index responseId from existing inbound request context when response-context payload is absent", async () => {
    const { sendPipelineResponse } =
      await import("../../../src/server/handlers/handler-response-utils.js");
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    const requestId =
      "openai-responses-router-gpt-5.3-codex-native-sse-existing-inbound-store";
    const providerRequestId =
      "openai-responses-sdfv.key1-gpt-5.4-native-sse-existing-inbound-store";
    const responseId = "resp_native_sse_existing_inbound_store_1";
    const callId = "call_native_sse_existing_inbound_store_1";

    store.captureResponsesRequestContext({
      requestId,
      payload: {
        model: "gpt-5.3-codex",
        store: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "call update_plan and continue from existing inbound store",
              },
            ],
          },
        ],
        tools: [{ type: "function", name: "update_plan" }],
      },
      context: {
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "call update_plan and continue from existing inbound store",
              },
            ],
          },
        ],
        toolsRaw: [{ type: "function", name: "update_plan" }],
      },
      sessionId: "rcc-native-sse-existing-inbound-store",
      routeHint: "thinking/gateway-priority-5555-thinking",
    });
    store.captureResponsesRequestContext({
      requestId: providerRequestId,
      payload: {
        model: "gpt-5.3-codex",
        store: true,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: "call update_plan and continue from existing inbound store",
              },
            ],
          },
        ],
        tools: [{ type: "function", name: "update_plan" }],
      },
      context: {
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "call update_plan and continue from existing inbound store",
              },
            ],
          },
        ],
        toolsRaw: [{ type: "function", name: "update_plan" }],
      },
      sessionId: "rcc-native-sse-existing-inbound-store",
      routeHint: "thinking/gateway-priority-5555-thinking",
    });

    const res = new MockResponse();
    await sendPipelineResponse(
      res as any,
      {
        status: 200,
        sseStream: Readable.from([
            "event: response.required_action\n",
            `data: ${JSON.stringify({
              type: "response.required_action",
              response: {
                id: responseId,
                object: "response",
                status: "requires_action",
              },
              required_action: {
                type: "submit_tool_outputs",
                submit_tool_outputs: {
                  tool_calls: [
                    {
                      id: callId,
                      type: "function_call",
                      name: "update_plan",
                      arguments:
                        '{"plan":[{"step":"native-sse-existing-inbound-store"}]}',
                    },
                  ],
                },
              },
            })}\n\n`,
            "event: response.completed\n",
            `data: ${JSON.stringify({
              type: "response.completed",
              response: {
                id: responseId,
                object: "response",
                status: "requires_action",
              },
            })}\n\n`,
          ]),
        usageLogInfo: {
          finishReason: "tool_calls",
          routeName: "thinking/gateway-priority-5555-thinking",
          timingRequestIds: [providerRequestId, requestId],
          sessionId: "rcc-native-sse-existing-inbound-store",
        },
        metadata: {
          outboundStream: true,
        },
      } as any,
      requestId,
      {
        entryEndpoint: "/v1/responses",
        responsesRequestContext: {
          payload: {
            model: "gpt-5.3-codex",
            store: true,
            input: [
              {
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "call update_plan and continue from existing inbound store",
                  },
                ],
              },
            ],
            tools: [{ type: "function", name: "update_plan" }],
          },
          context: {
            input: [
              {
                type: "message",
                role: "user",
                content: [
                  {
                    type: "input_text",
                    text: "call update_plan and continue from existing inbound store",
                  },
                ],
              },
            ],
            toolsRaw: [{ type: "function", name: "update_plan" }],
          },
          sessionId: "rcc-native-sse-existing-inbound-store",
        },
      },
    );
    await waitForEnd(res);

    const stats = store.responsesConversationStore.getDebugStats();
    expect(stats.responseIndexSize).toBe(1);
    expect(stats.requestEntriesWithoutLastResponseId).toBe(0);

    const resumed = store.resumeResponsesConversation(responseId, {
      tool_outputs: [{ call_id: callId, output: "existing-inbound-store-ok" }],
    });
    expect(resumed.payload.previous_response_id).toBe(responseId);
  });


  it("RED: store=false /v1/responses tool_calls must still retain same-response submit_tool_outputs continuation state", async () => {
    const { sendPipelineResponse } =
      await import("../../../src/server/handlers/handler-response-utils.js");
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    const routerRequestId = "openai-responses-router-gpt-5.3-codex-store-false-no-retain";
    const responseId = "resp_store_false_no_retain_1";
    const callId = "call_store_false_no_retain_1";

    try {
      const res = new MockResponse();
      await sendPipelineResponse(
        res as any,
        {
          status: 200,
          body: responsesToolCallBody({
            responseId,
            callId,
            name: "exec_command",
            argumentsJson: '{"cmd":"pwd"}',
          }),
          usageLogInfo: {
            finishReason: "tool_calls",
            routeName: "thinking/gateway-priority-5555-thinking",
            sessionId: "rcc-store-false-no-retain",
          },
        } as any,
        routerRequestId,
        {
          entryEndpoint: "/v1/responses",
          responsesRequestContext: {
            payload: {
              model: "gpt-5.3-codex",
              store: false,
              input: [
                {
                  role: "user",
                  content: [{ type: "input_text", text: "store false should not persist continuation" }],
                },
              ],
              tools: [{ type: "function", name: "exec_command" }],
            },
            context: {
              input: [
                {
                  role: "user",
                  content: [{ type: "input_text", text: "store false should not persist continuation" }],
                },
              ],
              toolsRaw: [{ type: "function", name: "exec_command" }],
            },
            sessionId: "rcc-store-false-no-retain",
          },
        },
      );

      const stats = store.responsesConversationStore.getDebugStats();
      expect(stats.responseIndexSize).toBeGreaterThanOrEqual(1);
      const resumed = store.resumeResponsesConversation(responseId, {
        response_id: responseId,
        tool_outputs: [{ tool_call_id: callId, output: "ok" }],
      });
      expect(resumed.payload.previous_response_id).toBe(responseId);
      expect(resumed.payload.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "function_call_output",
            call_id: callId,
            output: "ok",
          }),
        ]),
      );
    } finally {
      store.clearResponsesConversationByRequestId(routerRequestId);
      store.clearResponsesConversationByRequestId(responseId);
    }
  });

  it("clears retained responses store entries when JSON response is an error", async () => {
    const { sendPipelineResponse } =
      await import("../../../src/server/handlers/handler-response-utils.js");
    const bridge = await import("../../../src/modules/llmswitch/bridge.js");
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    const routerRequestId = "openai-responses-router-gpt-5.3-codex-json-error-cleanup";
    const providerRequestId = "openai-responses-provider-gpt-5.3-codex-json-error-cleanup";

    try {
      store.captureResponsesRequestContext({
        requestId: routerRequestId,
        sessionId: "sess-json-error-cleanup",
        payload: { model: "gpt-5.3-codex", store: true },
        context: {
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "will fail" }] }],
        },
      });
      store.captureResponsesRequestContext({
        requestId: providerRequestId,
        sessionId: "sess-json-error-cleanup",
        payload: { model: "gpt-5.3-codex", store: true },
        context: {
          input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "will fail provider" }] }],
        },
      });

      const res = new MockResponse();
      await sendPipelineResponse(
        res as any,
        {
          status: 500,
          body: { error: { message: "bad upstream", code: "HTTP_500" } },
          usageLogInfo: {
            timingRequestIds: [providerRequestId],
          },
        } as any,
        routerRequestId,
        { entryEndpoint: "/v1/responses" },
      );

      const stats = store.responsesConversationStore.getDebugStats();
      expect(stats.requestEntriesWithoutLastResponseId).toBe(0);
      expect(stats.retainedInputItems).toBe(0);
      expect(() =>
        store.resumeLatestResponsesContinuationByScope({
          requestId: `${routerRequestId}-resume`,
          sessionId: "sess-json-error-cleanup",
          payload: {
            model: "gpt-5.3-codex",
            store: true,
            input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "after error" }] }],
          },
        }),
      ).not.toThrow();
    } finally {
      store.clearResponsesConversationByRequestId(routerRequestId);
      store.clearResponsesConversationByRequestId(providerRequestId);
    }
  });

  it("records JSON /v1/responses tool_calls under client-visible response id and submit_tool_outputs resumes", async () => {
    const { sendPipelineResponse } =
      await import("../../../src/server/handlers/handler-response-utils.js");
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    const routerRequestId = "openai-responses-router-gpt-5.3-codex-json-resume";
    const responseId = "resp_provider_json_resume_1";
    const callId = "native:run_command:3";

    try {
      const res = new MockResponse();
      await sendPipelineResponse(
        res as any,
        {
          status: 200,
          body: responsesToolCallBody({
            responseId,
            callId,
            name: "shell_command",
            argumentsJson: '{"command":"printf native-provider-ok"}',
          }),
          usageLogInfo: {
            finishReason: "tool_calls",
            routeName: "thinking/gateway-priority-5520-thinking",
            sessionId: "rcc-json-resume-session",
          },
        } as any,
        routerRequestId,
        {
          entryEndpoint: "/v1/responses",
          responsesRequestContext: {
            payload: {
              model: "gpt-5.3-codex",
              store: true,
              input: [
                {
                  role: "user",
                  content: [{ type: "input_text", text: "call shell_command" }],
                },
              ],
              tools: [{ type: "function", name: "shell_command" }],
            },
            context: {
              input: [
                {
                  role: "user",
                  content: [{ type: "input_text", text: "call shell_command" }],
                },
              ],
              toolsRaw: [{ type: "function", name: "shell_command" }],
            },
            sessionId: "rcc-json-resume-session",
          },
        },
      );

      const stats = store.responsesConversationStore.getDebugStats();
      expect(stats.responseIndexSize).toBeGreaterThanOrEqual(1);

      const resumed = store.resumeResponsesConversation(responseId, {
        response_id: responseId,
        tool_outputs: [
          {
            tool_call_id: callId,
            output: "native-provider-ok",
          },
        ],
      });

      expect(resumed.payload.previous_response_id).toBe(responseId);
      expect(resumed.payload.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "function_call_output",
            call_id: callId,
            output: "native-provider-ok",
          }),
        ]),
      );
    } finally {
      store.clearResponsesConversationByRequestId(routerRequestId);
      store.clearResponsesConversationByRequestId(responseId);
    }
  });

  it("repairs missing response id secondary index from retained request entry before submit_tool_outputs resume", async () => {
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    const requestId = "openai-responses-router-index-repair";
    const responseId = "resp_index_repair_1";
    const callId = "call_index_repair_1";
    const storeObject = store.responsesConversationStore as unknown as {
      responseIndex?: Map<string, unknown>;
    };

    try {
      store.captureResponsesRequestContext({
        requestId,
        payload: {
          model: "gpt-5.5",
          store: true,
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "repair response index" }],
            },
          ],
          tools: [{ type: "function", name: "exec_command" }],
        },
        context: {
          input: [
            {
              role: "user",
              content: [{ type: "input_text", text: "repair response index" }],
            },
          ],
          toolsRaw: [{ type: "function", name: "exec_command" }],
        },
        sessionId: "index-repair-session",
        conversationId: "index-repair-session",
        entryKind: "responses",
        continuationOwner: "relay",
        matchedPort: 5555,
      });
      store.recordResponsesResponse({
        requestId,
        response: {
          id: responseId,
          object: "response",
          status: "requires_action",
          output: [
            {
              type: "function_call",
              id: `fc_${callId}`,
              call_id: callId,
              name: "exec_command",
              arguments: "{\"cmd\":\"pwd\"}",
            },
          ],
          required_action: {
            type: "submit_tool_outputs",
            submit_tool_outputs: {
              tool_calls: [
                {
                  id: callId,
                  type: "function",
                  function: {
                    name: "exec_command",
                    arguments: "{\"cmd\":\"pwd\"}",
                  },
                },
              ],
            },
          },
        },
        sessionId: "index-repair-session",
        conversationId: "index-repair-session",
        entryKind: "responses",
        continuationOwner: "relay",
        matchedPort: 5555,
        allowScopeContinuation: true,
      });
      store.finalizeResponsesConversationRequestRetention(requestId, {
        keepForSubmitToolOutputs: true,
      });
      storeObject.responseIndex?.delete(responseId);

      const resumed = store.resumeResponsesConversation(
        responseId,
        {
          response_id: responseId,
          tool_outputs: [{ tool_call_id: callId, output: "ok" }],
        },
        { entryKind: "responses", matchedPort: 5555 },
      );

      expect(resumed.payload.previous_response_id).toBe(responseId);
      expect(resumed.payload.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "function_call_output",
            call_id: callId,
            output: "ok",
          }),
        ]),
      );
      expect(store.responsesConversationStore.getDebugStats().responseIndexSize).toBe(0);
    } finally {
      store.clearResponsesConversationByRequestId(requestId);
      store.clearResponsesConversationByRequestId(responseId);
    }
  });

  it("RED: /v1/responses string input must be captured into store so submit_tool_outputs keeps terminal user history", async () => {
    const { sendPipelineResponse } =
      await import("../../../src/server/handlers/handler-response-utils.js");
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    const routerRequestId =
      "openai-responses-router-gpt-5.3-codex-string-input-submit";
    const responseId = "resp_provider_string_input_submit_1";
    const callId = "call_provider_string_input_submit_1";

    try {
      const res = new MockResponse();
      await sendPipelineResponse(
        res as any,
        {
          status: 200,
          body: {
            id: responseId,
            object: "response",
            status: "requires_action",
            output: [
              {
                type: "function_call",
                name: "apply_patch",
                arguments:
                  '{"filePath":"tmp/provider-live-smoke.txt","patch":"+ alpha"}',
                call_id: callId,
              },
            ],
            required_action: {
              type: "submit_tool_outputs",
              submit_tool_outputs: { tool_calls: [] },
            },
          },
          usageLogInfo: {
            finishReason: "tool_calls",
            routeName: "thinking/gateway-priority-5520-thinking",
            sessionId: "rcc-string-input-submit",
          },
        } as any,
        routerRequestId,
        {
          entryEndpoint: "/v1/responses",
          responsesRequestContext: {
            payload: {
              model: "gpt-5.3-codex",
              store: true,
              input:
                "Use apply_patch to create tmp/provider-live-smoke.txt with content alpha on one line. Do not answer directly; call the tool.",
              tools: [{ type: "function", function: { name: "apply_patch" } }],
            },
            context: {
              input: [
                {
                  type: "message",
                  role: "user",
                  content: [
                    {
                      type: "input_text",
                      text: "Use apply_patch to create tmp/provider-live-smoke.txt with content alpha on one line. Do not answer directly; call the tool.",
                    },
                  ],
                },
              ],
              toolsRaw: [
                { type: "function", function: { name: "apply_patch" } },
              ],
            },
            sessionId: "rcc-string-input-submit",
          },
        },
      );
      await waitForEnd(res);

      const resumed = store.resumeResponsesConversation(responseId, {
        previous_response_id: responseId,
        tool_outputs: [
          {
            tool_call_id: callId,
            output: "created tmp/provider-live-smoke.txt with alpha",
          },
        ],
      });

      const bridge =
        await import("../../../sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.js");
      const ctx = bridge.captureResponsesContext(
        resumed.payload as Record<string, unknown>,
        {
          route: { requestId: `${routerRequestId}-resume` },
        },
      );
      const chat = bridge.buildChatRequestFromResponses(
        resumed.payload as Record<string, unknown>,
        ctx as any,
      ).request;
      expect(Array.isArray((chat as any).messages)).toBe(true);
      expect((chat as any).messages).toEqual([
        {
          role: "user",
          content:
            "Use apply_patch to create tmp/provider-live-smoke.txt with content alpha on one line. Do not answer directly; call the tool.",
        },
        expect.objectContaining({
          role: "assistant",
          tool_calls: [
            expect.objectContaining({ id: callId, type: "function" }),
          ],
        }),
        expect.objectContaining({
          role: "tool",
          tool_call_id: callId,
          content: "created tmp/provider-live-smoke.txt with alpha",
        }),
      ]);
    } finally {
      store.clearResponsesConversationByRequestId(routerRequestId);
      store.clearResponsesConversationByRequestId(responseId);
    }
  });

  it("uses resume fullInput semantics to preserve assistant tool_calls before tool outputs", async () => {
    const bridge =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.js");

    const payload = {
      model: "gpt-5.4",
      tools: [{ type: "function", function: { name: "exec_command" } }],
      previous_response_id: "resp-full-input-resume-1",
      input: [
        {
          type: "function_call",
          id: "fc_full_input_1",
          call_id: "call_full_input_1",
          name: "exec_command",
          arguments: '{"cmd":"pwd"}',
        },
        {
          type: "function_call_output",
          id: "fc_full_input_1",
          call_id: "call_full_input_1",
          output: "ok",
        },
      ],
      semantics: {
        responses: {
          resume: {
            fullInput: [
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "run one command" }],
              },
              {
                type: "function_call",
                id: "fc_full_input_1",
                call_id: "call_full_input_1",
                name: "exec_command",
                arguments: '{"cmd":"pwd"}',
              },
              {
                type: "function_call_output",
                id: "fc_full_input_1",
                call_id: "call_full_input_1",
                output: "ok",
              },
            ],
            deltaInput: [
              {
                type: "function_call_output",
                id: "fc_full_input_1",
                call_id: "call_full_input_1",
                output: "ok",
              },
            ],
          },
        },
      },
    };

    const ctx = bridge.captureResponsesContext(payload as Record<string, unknown>, {
      route: { requestId: "req-full-input-resume-1" },
    });
    const chat = bridge.buildChatRequestFromResponses(
      payload as Record<string, unknown>,
      ctx as any,
    ).request as Record<string, unknown>;

    expect((chat as any).messages).toEqual([
      {
        role: "user",
        content: "run one command",
      },
      expect.objectContaining({
        role: "assistant",
        tool_calls: [
          expect.objectContaining({
            id: "call_full_input_1",
            type: "function",
          }),
        ],
      }),
      expect.objectContaining({
        role: "tool",
        tool_call_id: "call_full_input_1",
        content: "ok",
      }),
    ]);
  });

  it("clears superseded router/provider request contexts after client response id is known", async () => {
    const { sendPipelineResponse } =
      await import("../../../src/server/handlers/handler-response-utils.js");
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    const routerRequestId =
      "openai-responses-router-gpt-5.3-codex-orphan-cleanup";
    const providerRequestId =
      "openai-responses-openai.key1-gpt-5.4-none-orphan-cleanup";
    const responseId = "resp_provider_orphan_cleanup_1";

    store.captureResponsesRequestContext({
      requestId: routerRequestId,
      sessionId: "rcc-orphan-cleanup-session",
      payload: {
        model: "gpt-5.3-codex",
        store: true,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "call tool" }],
          },
        ],
        tools: [{ type: "function", name: "exec_command" }],
      },
      context: {
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "call tool" }],
          },
        ],
        toolsRaw: [{ type: "function", name: "exec_command" }],
      },
      routeHint: "tools/gateway-priority-5520-tools",
    });
    store.captureResponsesRequestContext({
      requestId: providerRequestId,
      sessionId: "rcc-orphan-cleanup-session",
      payload: {
        model: "gpt-5.3-codex",
        store: true,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "call tool" }],
          },
        ],
        tools: [{ type: "function", name: "exec_command" }],
      },
      context: {
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "call tool" }],
          },
        ],
        toolsRaw: [{ type: "function", name: "exec_command" }],
      },
      routeHint: "tools/gateway-priority-5520-tools",
    });

    const before = store.responsesConversationStore.getDebugStats();
    expect(before.requestEntriesWithoutLastResponseId).toBeGreaterThanOrEqual(1);
    expect(before.retainedInputItems).toBeGreaterThan(0);

    const res = new MockResponse();
    await sendPipelineResponse(
      res as any,
        {
          status: 200,
          body: responsesToolCallBody({
            responseId,
            callId: "call_orphan_cleanup",
            name: "exec_command",
            argumentsJson: '{"cmd":"pwd"}',
          }),
        usageLogInfo: {
          finishReason: "tool_calls",
          routeName: "tools/gateway-priority-5520-tools",
          sessionId: "rcc-orphan-cleanup-session",
          timingRequestIds: [providerRequestId, routerRequestId],
        },
      } as any,
      routerRequestId,
      {
        entryEndpoint: "/v1/responses",
        responsesRequestContext: {
          payload: {
            store: true,
            model: "gpt-5.3-codex",
            input: [
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "call tool" }],
              },
            ],
            tools: [{ type: "function", name: "exec_command" }],
          },
          context: {
            input: [
              {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "call tool" }],
              },
            ],
            toolsRaw: [{ type: "function", name: "exec_command" }],
          },
          sessionId: "rcc-orphan-cleanup-session",
        },
      },
    );

    const after = store.responsesConversationStore.getDebugStats();
    expect(after.responseIndexSize).toBeGreaterThanOrEqual(1);
    expect(after.scopeIndexSize).toBeGreaterThanOrEqual(1);
    expect(after.requestEntriesWithoutLastResponseId).toBeLessThanOrEqual(1);
    expect(after.retainedInputItems).toBeLessThanOrEqual(1);
  });

  it("keeps 5520 tool-lane continuation bounded across tool_calls then stop followup", async () => {
    const { sendPipelineResponse } =
      await import("../../../src/server/handlers/handler-response-utils.js");
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    const routerRequestId =
      "openai-responses-router-gpt-5.3-codex-20260523T212223310-222654-435";
    const providerRequestId =
      "openai-responses-openai.key1-gpt-5.4-none-20260523T212223310-222654-435";
    const stopRequestId =
      "openai-responses-openai.key1-gpt-5.4-none-20260523T212244407-223292-1073";
    const responseId = "resp_5520_tools_followup_1";
    const stopResponseId = "resp_5520_tools_followup_stop";
    const sessionId = "rcc-routecodex";
    const routeHint = "tools/gateway-priority-5520-tools";

    try {
      store.captureResponsesRequestContext({
        requestId: routerRequestId,
        sessionId,
        payload: {
          model: "gpt-5.3-codex",
          store: true,
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "先调用工具" }],
            },
          ],
          tools: [{ type: "function", name: "exec_command" }],
        },
        context: {
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "先调用工具" }],
            },
          ],
          toolsRaw: [{ type: "function", name: "exec_command" }],
        },
        routeHint,
      });

      const toolRes = new MockResponse();
      await sendPipelineResponse(
        toolRes as any,
        {
          status: 200,
          body: {
            id: responseId,
            object: "response",
            status: "requires_action",
            output: [
              {
                type: "function_call",
                name: "exec_command",
                arguments: '{"cmd":"pwd"}',
                call_id: "call_5520_followup",
              },
            ],
          },
          usageLogInfo: {
            finishReason: "tool_calls",
            routeName: routeHint,
            sessionId,
            timingRequestIds: [providerRequestId, routerRequestId],
          },
        } as any,
        routerRequestId,
        {
          entryEndpoint: "/v1/responses",
          responsesRequestContext: {
            payload: {
              model: "gpt-5.3-codex",
              store: true,
              input: [
                {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: "先调用工具" }],
                },
              ],
              tools: [{ type: "function", name: "exec_command" }],
            },
            context: {
              input: [
                {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: "先调用工具" }],
                },
              ],
              toolsRaw: [{ type: "function", name: "exec_command" }],
            },
            sessionId,
          },
        },
      );
      await waitForEnd(toolRes);

      const afterToolCall = store.responsesConversationStore.getDebugStats();
      expect(afterToolCall.requestEntriesWithoutLastResponseId).toBeLessThanOrEqual(1);
      expect(afterToolCall.responseIndexSize).toBeGreaterThanOrEqual(1);
      expect(afterToolCall.scopeIndexSize).toBeGreaterThanOrEqual(1);

      const stopRes = new MockResponse();
      await sendPipelineResponse(
        stopRes as any,
        {
          status: 200,
          body: {
            id: stopResponseId,
            object: "response",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "继续执行" }],
              },
            ],
          },
          usageLogInfo: {
            finishReason: "stop",
            routeName: routeHint,
            sessionId,
            timingRequestIds: [stopRequestId],
          },
        } as any,
        stopRequestId,
        {
          entryEndpoint: "/v1/responses",
          responsesRequestContext: {
            payload: {
              model: "gpt-5.3-codex",
              store: true,
              input: [
                {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: "先调用工具" }],
                },
              ],
            },
            context: {
              input: [
                {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: "先调用工具" }],
                },
              ],
            },
            sessionId,
          },
        },
      );
      await waitForEnd(stopRes);

      const afterStop = store.responsesConversationStore.getDebugStats();
      expect(afterStop.requestEntriesWithoutLastResponseId).toBe(0);
      expect(afterStop.responseIndexSize).toBeGreaterThanOrEqual(1);
      expect(afterStop.scopeIndexSize).toBeGreaterThanOrEqual(1);
      expect(afterStop.retainedInputItems).toBe(0);
    } finally {
      for (const requestId of [
        routerRequestId,
        providerRequestId,
        stopRequestId,
        responseId,
        stopResponseId,
      ]) {
        store.clearResponsesConversationByRequestId(requestId);
      }
    }
  });

  it("releases non-tool-call responses request context for /v1/responses json stop path", async () => {
    const { sendPipelineResponse } =
      await import("../../../src/server/handlers/handler-response-utils.js");
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    const requestId = "openai-responses-router-gpt-5.3-codex-json-stop-release";
    const sessionId = "rcc-json-stop-release";

    try {
      store.captureResponsesRequestContext({
        requestId,
        sessionId,
        payload: {
          model: "gpt-5.3-codex",
          store: true,
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "只回复 OK" }],
            },
          ],
        },
        context: {
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "只回复 OK" }],
            },
          ],
        },
        routeHint: "thinking/gateway-priority-5555-thinking",
      });

      const before = store.responsesConversationStore.getDebugStats();
      expect(before.requestMapSize).toBeGreaterThanOrEqual(1);
      expect(before.retainedInputItems).toBeGreaterThan(0);

      const res = new MockResponse();
      await sendPipelineResponse(
        res as any,
        {
          status: 200,
          body: {
            id: "resp_json_stop_release_1",
            object: "response",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "OK" }],
              },
            ],
          },
          usageLogInfo: {
            finishReason: "stop",
            routeName: "thinking/gateway-priority-5555-thinking",
            sessionId,
          },
        } as any,
        requestId,
        {
          entryEndpoint: "/v1/responses",
          responsesRequestContext: {
            payload: {
              model: "gpt-5.3-codex",
              store: true,
              input: [
                {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: "只回复 OK" }],
                },
              ],
            },
            context: {
              input: [
                {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: "只回复 OK" }],
                },
              ],
            },
            sessionId,
          },
        },
      );

      const after = store.responsesConversationStore.getDebugStats();
      expect(after.requestMapSize).toBeLessThanOrEqual(1);
      expect(after.retainedInputItems).toBeLessThanOrEqual(1);
      expect(after.requestEntriesWithoutLastResponseId).toBeLessThanOrEqual(1);
    } finally {
      store.clearResponsesConversationByRequestId(requestId);
    }
  });
});

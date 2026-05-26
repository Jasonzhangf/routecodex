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
      importCoreDist: jest.fn(),
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

describe("sendPipelineResponse responses store integration", () => {
  const requestIds = [
    "openai-responses-router-gpt-5.3-codex-native-sse-store",
    "openai-responses-router-gpt-5.3-codex-native-sse-premature-persist",
    "openai-responses-router-gpt-5.3-codex-native-sse-metadata-only-store",
    "openai-responses-router-gpt-5.3-codex-native-sse-no-final-delimiter",
    "openai-responses-router-gpt-5.3-codex-native-sse-tail-store",
    "openai-responses-sdfv.key1-gpt-5.4-live-shape-direct-sse",
    "openai-responses-windsurf.ws-pro-5-gpt-5.4-none-20260523T102906604-222183-867",
    "openai-responses-router-gpt-5.3-codex-20260523T102906604-222183-867",
    "resp_native_sse_premature_persist_1",
    "resp_native_sse_metadata_only_store_1",
    "resp_native_sse_no_final_delimiter_1",
    "resp_native_sse_store_1",
    "resp_native_sse_tail_store_1",
    "resp_04c9be1feb153bec016a1539bb89a08196b1c2349ac465d6a3",
    "resp_1779503404150",
    "resp_windsurf_json_resume_1",
    "openai-responses-router-gpt-5.3-codex-orphan-cleanup",
    "openai-responses-windsurf.ws-pro-4-gpt-5.4-none-orphan-cleanup",
    "resp_windsurf_orphan_cleanup_1",
    "req-windsurf-history-tool-next",
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

  it("RED: streamed Windsurf tool_calls records provider context so history plus tools restore together", async () => {
    const { sendPipelineResponse } =
      await import("../../../src/server/handlers/handler-response-utils.js");
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    const providerRequestId =
      "openai-responses-windsurf.ws-pro-5-gpt-5.4-none-20260523T102906604-222183-867";
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
        body: {
          id: responseId,
          object: "response",
          status: "requires_action",
          output: [
            {
              type: "function_call",
              name: "exec_command",
              arguments: '{"cmd":"pwd"}',
              call_id: "call_windsurf_history_tool",
            },
          ],
        },
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
      requestId: "req-windsurf-history-tool-next",
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
            call_id: "call_windsurf_history_tool",
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
      { type: "function", function: { name: "exec_command" } },
    ]);
    expect(restored?.payload.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_windsurf_history_tool",
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
          __sse_responses: Readable.from(delayedTerminalStream()),
          __routecodex_finish_reason: "tool_calls",
        },
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


  it("RED: direct 5555 live-shape SSE tool_calls with completed status must still retain responseIndex for submit_tool_outputs", async () => {
    const { sendPipelineResponse } =
      await import("../../../src/server/handlers/handler-response-utils.js");
    const bridge = await import("../../../src/modules/llmswitch/bridge.js");
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
        body: {
          __sse_responses: Readable.from([
            "event: response.created\n",
            `data: ${JSON.stringify({
              type: "response.created",
              response: {
                id: responseId,
                object: "response",
                status: "in_progress",
              },
            })}\n\n`,
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
                status: "completed",
                output: [],
              },
            })}\n\n`,
            "data: [DONE]\n\n",
          ]),
        },
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

    expect((bridge.recordResponsesResponseForRequest as jest.Mock).mock.calls.length).toBeGreaterThan(0);
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

  it("RED: native SSE (__sse_responses) tool_calls must record responses continuation context", async () => {
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
        body: {
          __sse_responses: Readable.from([
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
          __routecodex_stream_finish_reason: "tool_calls",
          __routecodex_stream_contract_probe_body: {
            id: responseId,
            object: "response",
            status: "requires_action",
            output: [
              {
                type: "function_call",
                call_id: callId,
                id: `fc_${callId}`,
                name: "update_plan",
                arguments: '{"plan":[{"step":"native-sse-store"}]}',
              },
            ],
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
          },
        },
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
        body: {
          __sse_responses: Readable.from([
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
          __routecodex_stream_finish_reason: "tool_calls",
        },
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

  it("RED: native SSE (__sse_responses) tool_calls with trailing tail must not leave continuation context half-closed", async () => {
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
        body: {
          __sse_responses: Readable.from([
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
          __routecodex_stream_finish_reason: "tool_calls",
          __routecodex_stream_contract_probe_body: {
            id: responseId,
            object: "response",
            status: "requires_action",
            output: [
              {
                type: "function_call",
                call_id: callId,
                id: `fc_${callId}`,
                name: "update_plan",
                arguments: '{"plan":[{"step":"native-sse-tail-store"}]}',
              },
            ],
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
          },
        },
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
        body: {
          __sse_responses: Readable.from([
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
          __routecodex_stream_finish_reason: "tool_calls",
        },
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
        body: {
          __sse_responses: Readable.from([
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
          __routecodex_stream_finish_reason: "tool_calls",
        },
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


  it("RED: store=false /v1/responses tool_calls must not persist submit_tool_outputs continuation state", async () => {
    const { sendPipelineResponse } =
      await import("../../../src/server/handlers/handler-response-utils.js");
    const bridge = await import("../../../src/modules/llmswitch/bridge.js");
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    const routerRequestId = "openai-responses-router-gpt-5.3-codex-store-false-no-retain";
    const responseId = "resp_store_false_no_retain_1";

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
                name: "exec_command",
                arguments: '{"cmd":"pwd"}',
                call_id: "call_store_false_no_retain_1",
              },
            ],
            required_action: {
              type: "submit_tool_outputs",
              submit_tool_outputs: { tool_calls: [] },
            },
          },
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

      expect(
        (bridge.captureResponsesRequestContextForRequest as jest.Mock).mock.calls.map(([arg]) => arg.requestId),
      ).not.toContain(responseId);
      expect(
        (bridge.finalizeResponsesConversationRequestRetention as jest.Mock).mock.calls,
      ).not.toContainEqual([responseId, { keepForSubmitToolOutputs: true }]);
      expect(
        (bridge.recordResponsesResponseForRequest as jest.Mock).mock.calls.map(([arg]) => arg.requestId),
      ).not.toContain(responseId);
      expect(() =>
        store.resumeResponsesConversation(responseId, {
          response_id: responseId,
          tool_outputs: [{ tool_call_id: "call_store_false_no_retain_1", output: "ok" }],
        }),
      ).toThrow(/Responses conversation expired or not found/);
    } finally {
      store.clearResponsesConversationByRequestId(routerRequestId);
      store.clearResponsesConversationByRequestId(responseId);
    }
  });

  it("records JSON /v1/responses tool_calls under client-visible response id and submit_tool_outputs resumes", async () => {
    const { sendPipelineResponse } =
      await import("../../../src/server/handlers/handler-response-utils.js");
    const bridge = await import("../../../src/modules/llmswitch/bridge.js");
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    const routerRequestId = "openai-responses-router-gpt-5.3-codex-json-resume";
    const responseId = "resp_windsurf_json_resume_1";

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
                name: "shell_command",
                arguments: '{"command":"printf native-windsurf-ok"}',
                call_id: "native:run_command:3",
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
      expect(
        (
          bridge.captureResponsesRequestContextForRequest as jest.Mock
        ).mock.calls.map(([arg]) => arg.requestId),
      ).toEqual(expect.arrayContaining([responseId]));
      expect(
        (bridge.recordResponsesResponseForRequest as jest.Mock).mock.calls.map(
          ([arg]) => arg.requestId,
        ),
      ).toEqual(expect.arrayContaining([responseId]));
      expect(
        (bridge.recordResponsesResponseForRequest as jest.Mock).mock.calls.map(
          ([arg]) => arg.response?.id,
        ),
      ).toEqual(expect.arrayContaining([responseId]));
      expect(stats.responseIndexSize).toBeGreaterThanOrEqual(1);

      const resumed = store.resumeResponsesConversation(responseId, {
        response_id: responseId,
        tool_outputs: [
          {
            tool_call_id: "native:run_command:3",
            output: "native-windsurf-ok",
          },
        ],
      });

      expect(resumed.payload.previous_response_id).toBe(responseId);
      expect(resumed.payload.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "function_call_output",
            call_id: "native:run_command:3",
            output: "native-windsurf-ok",
          }),
        ]),
      );
    } finally {
      store.clearResponsesConversationByRequestId(routerRequestId);
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
    const responseId = "resp_windsurf_string_input_submit_1";
    const callId = "call_windsurf_string_input_submit_1";

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
                  '{"filePath":"tmp/windsurf-live-smoke.txt","patch":"+ alpha"}',
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
                "Use apply_patch to create tmp/windsurf-live-smoke.txt with content alpha on one line. Do not answer directly; call the tool.",
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
                      text: "Use apply_patch to create tmp/windsurf-live-smoke.txt with content alpha on one line. Do not answer directly; call the tool.",
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
            output: "created tmp/windsurf-live-smoke.txt with alpha",
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
            "Use apply_patch to create tmp/windsurf-live-smoke.txt with content alpha on one line. Do not answer directly; call the tool.",
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
          content: "created tmp/windsurf-live-smoke.txt with alpha",
        }),
      ]);
    } finally {
      store.clearResponsesConversationByRequestId(routerRequestId);
      store.clearResponsesConversationByRequestId(responseId);
    }
  });

  it("clears superseded router/provider request contexts after client response id is known", async () => {
    const { sendPipelineResponse } =
      await import("../../../src/server/handlers/handler-response-utils.js");
    const bridge = await import("../../../src/modules/llmswitch/bridge.js");
    const store =
      await import("../../../sharedmodule/llmswitch-core/src/conversion/shared/responses-conversation-store.js");
    const routerRequestId =
      "openai-responses-router-gpt-5.3-codex-orphan-cleanup";
    const providerRequestId =
      "openai-responses-windsurf.ws-pro-4-gpt-5.4-none-orphan-cleanup";
    const responseId = "resp_windsurf_orphan_cleanup_1";

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
        body: {
          id: responseId,
          object: "response",
          status: "requires_action",
          output: [
            {
              type: "function_call",
              name: "exec_command",
              arguments: '{"cmd":"pwd"}',
              call_id: "call_orphan_cleanup",
            },
          ],
        },
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
    expect(
      (bridge.clearResponsesConversationByRequestId as jest.Mock).mock.calls
        .map(([requestId]) => requestId)
        .sort(),
    ).toEqual([providerRequestId, routerRequestId].sort());
    expect(
      (bridge.finalizeResponsesConversationRequestRetention as jest.Mock).mock
        .calls,
    ).toContainEqual([responseId, { keepForSubmitToolOutputs: true }]);
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
      "openai-responses-windsurf.ws-pro-4-gpt-5.4-none-20260523T212223310-222654-435";
    const stopRequestId =
      "openai-responses-windsurf.ws-pro-4-gpt-5.4-none-20260523T212244407-223292-1073";
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
    const bridge = await import("../../../src/modules/llmswitch/bridge.js");
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

      expect(
        (bridge.finalizeResponsesConversationRequestRetention as jest.Mock).mock
          .calls,
      ).toContainEqual([requestId, { keepForSubmitToolOutputs: false }]);
      const after = store.responsesConversationStore.getDebugStats();
      expect(after.requestMapSize).toBeLessThanOrEqual(1);
      expect(after.retainedInputItems).toBeLessThanOrEqual(1);
      expect(after.requestEntriesWithoutLastResponseId).toBeLessThanOrEqual(1);
    } finally {
      store.clearResponsesConversationByRequestId(requestId);
    }
  });
});

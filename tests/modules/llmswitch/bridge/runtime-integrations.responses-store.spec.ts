import { beforeEach, describe, expect, test, jest } from "@jest/globals";

const captureResponsesRequestContext = jest.fn();
const recordResponsesResponse = jest.fn();
const resumeResponsesConversation = jest.fn();
const resumeLatestResponsesContinuationByScope = jest.fn();

jest.unstable_mockModule(
  "../../../../src/modules/llmswitch/bridge/responses-conversation-store-host.js",
  () => ({
    captureResponsesRequestContext,
    recordResponsesResponse,
    resumeResponsesConversation,
    lookupResponsesContinuationByResponseId: jest.fn(),
    resumeLatestResponsesContinuationByScope,
    materializeLatestResponsesContinuationByScope: jest.fn(),
    rebindResponsesConversationRequestId: jest.fn(),
    clearResponsesConversationByRequestId: jest.fn(),
    finalizeResponsesConversationRequestRetention: jest.fn(),
    clearAllResponsesConversationState: jest.fn(),
    resetResponsesConversationStateForRestartSimulation: jest.fn(),
    clearUnresolvedResponsesConversationRequests: jest.fn(() => 0),
  }),
);

describe("llmswitch bridge runtime-integrations responses store authority", () => {
  beforeEach(() => {
    captureResponsesRequestContext.mockReset();
    recordResponsesResponse.mockReset();
    resumeResponsesConversation.mockReset();
    resumeLatestResponsesContinuationByScope.mockReset();
    resumeResponsesConversation.mockReturnValue({
      payload: { source: "host" },
      meta: { source: "host" },
    });
    resumeLatestResponsesContinuationByScope.mockReturnValue({
      payload: { source: "host-scope" },
      meta: { source: "host-scope" },
    });
  });

  test("responses helpers delegate to the native store host without global store state", async () => {
    const mod = await import("../../../../src/modules/llmswitch/bridge/runtime-integrations.js");

    await mod.captureResponsesRequestContextForRequest({
      requestId: "req_host_truth_1",
      payload: { model: "gpt-5.4" },
      context: { input: [] },
    });
    await mod.recordResponsesResponseForRequest({
      requestId: "req_host_truth_1",
      response: {
        id: "resp_host_truth_1",
        output: [{ type: "function_call", call_id: "call_1" }],
      },
    });
    const resumed = await mod.resumeResponsesConversation("resp_host_truth_1", {
      tool_outputs: [{ call_id: "call_1", output: "ok" }],
    });
    const resumedByScope = await mod.resumeLatestResponsesContinuationByScope({
      payload: { input: [] },
      sessionId: "sess_host_truth_1",
    });

    expect(captureResponsesRequestContext).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req_host_truth_1" }),
    );
    expect(recordResponsesResponse).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req_host_truth_1" }),
    );
    expect(resumeResponsesConversation).toHaveBeenCalledWith(
      "resp_host_truth_1",
      expect.objectContaining({
        tool_outputs: [{ call_id: "call_1", output: "ok" }],
      }),
      undefined,
    );
    expect(resumeLatestResponsesContinuationByScope).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess_host_truth_1" }),
    );
    expect(resumed).toEqual({
      payload: { source: "host" },
      meta: { source: "host" },
    });
    expect(resumedByScope).toEqual({
      payload: { source: "host-scope" },
      meta: { source: "host-scope" },
    });
  });
});

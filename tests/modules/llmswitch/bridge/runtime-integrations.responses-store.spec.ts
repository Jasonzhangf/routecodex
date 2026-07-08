import { beforeEach, describe, expect, test, jest } from "@jest/globals";

describe("llmswitch bridge runtime-integrations responses store authority", () => {
  beforeEach(() => {
    jest.resetModules();
    delete (globalThis as Record<string, unknown>)
      .__rccResponsesConversationStore;
  });

  test("RED: capture/record/resume helpers must prefer global authoritative responses store over imported module", async () => {
    const importCapture = jest.fn();
    const importRecord = jest.fn();
    const importResume = jest.fn(() => ({
      payload: { source: "import" },
      meta: { source: "import" },
    }));
    const importResumeByScope = jest.fn(() => ({
      payload: { source: "import-scope" },
      meta: { source: "import-scope" },
    }));

    const globalCapture = jest.fn();
    const globalRecord = jest.fn();
    const globalResume = jest.fn(() => ({
      payload: { source: "global" },
      meta: { source: "global" },
    }));
    const globalResumeByScope = jest.fn(() => ({
      payload: { source: "global-scope" },
      meta: { source: "global-scope" },
    }));

    (globalThis as Record<string, unknown>).__rccResponsesConversationStore = {
      captureRequestContext: globalCapture,
      recordResponse: globalRecord,
      resumeConversation: globalResume,
      resumeLatestContinuationByScope: globalResumeByScope,
      getDebugStats: () => ({}),
      startPruneTimer: () => {},
    };

    jest.unstable_mockModule(
      "../../../../src/modules/llmswitch/bridge/module-loader.js",
      () => ({
        requireCoreDist: jest.fn((subpath: string) => {
          throw new Error(`unexpected requireCoreDist: ${subpath}`);
        }),
        importCoreDist: jest.fn(async (subpath: string) => {
          throw new Error(`unexpected importCoreDist: ${subpath}`);
        }),
      }),
    );

    const mod =
      await import("../../../../src/modules/llmswitch/bridge/runtime-integrations.js");

    await mod.captureResponsesRequestContextForRequest({
      requestId: "req_global_truth_1",
      payload: { model: "gpt-5.4" },
      context: { input: [] },
    });
    await mod.recordResponsesResponseForRequest({
      requestId: "req_global_truth_1",
      response: {
        id: "resp_global_truth_1",
        output: [{ type: "function_call", call_id: "call_1" }],
      },
    });
    const resumed = await mod.resumeResponsesConversation(
      "resp_global_truth_1",
      {
        tool_outputs: [{ call_id: "call_1", output: "ok" }],
      },
    );
    const resumedByScope = await mod.resumeLatestResponsesContinuationByScope({
      payload: { input: [] },
      sessionId: "sess_global_truth_1",
    });

    expect(globalCapture).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req_global_truth_1" }),
    );
    expect(globalRecord).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "req_global_truth_1" }),
    );
    expect(globalResume).toHaveBeenCalledWith(
      "resp_global_truth_1",
      expect.objectContaining({
        tool_outputs: [{ call_id: "call_1", output: "ok" }],
      }),
      undefined,
    );
    expect(globalResumeByScope).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess_global_truth_1" }),
    );

    expect(importCapture).not.toHaveBeenCalled();
    expect(importRecord).not.toHaveBeenCalled();
    expect(importResume).not.toHaveBeenCalled();
    expect(importResumeByScope).not.toHaveBeenCalled();
    expect(resumed).toEqual({
      payload: { source: "global" },
      meta: { source: "global" },
    });
    expect(resumedByScope).toEqual({
      payload: { source: "global-scope" },
      meta: { source: "global-scope" },
    });
  });
});

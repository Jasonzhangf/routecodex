import { afterEach, describe, expect, it, jest } from "@jest/globals";

import {
  markHeavyInputFastpath,
  roughEstimateInputTokensFromRequest,
  shouldUseHeavyInputFastpath,
} from "../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-heavy-input-fastpath.js";
import {
  buildCapturedChatRequestInput,
} from "../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-route-and-outbound.js";

function clearFastpathEnv(): void {
  delete process.env.ROUTECODEX_HUB_FASTPATH_HEAVY_INPUT;
  delete process.env.ROUTECODEX_HUB_FASTPATH_INPUT_TOKEN_THRESHOLD;
}

describe("hub heavy-input fastpath", () => {
  afterEach(() => {
    clearFastpathEnv();
    jest.restoreAllMocks();
  });

  it("marks metadata when rough estimate exceeds threshold", () => {
    process.env.ROUTECODEX_HUB_FASTPATH_HEAVY_INPUT = "1";
    process.env.ROUTECODEX_HUB_FASTPATH_INPUT_TOKEN_THRESHOLD = "100";

    const metadata: Record<string, unknown> = {};
    const request = {
      model: "gpt-test",
      messages: [
        {
          role: "user",
          content: "x".repeat(2400),
        },
      ],
    };

    const estimated = roughEstimateInputTokensFromRequest(request);
    markHeavyInputFastpath({
      metadata,
      estimatedInputTokens: estimated,
      reason: "rough_estimate",
    });

    expect(estimated).toBeGreaterThanOrEqual(100);
    expect(shouldUseHeavyInputFastpath(metadata)).toBe(true);
    expect(metadata.estimatedInputTokens).toBe(estimated);
    expect((metadata.__rt as Record<string, unknown>).hubFastpathHeavyInput).toBe(true);
    expect((metadata.__rt as Record<string, unknown>).hubFastpathReason).toBe("rough_estimate");
  });

  it("marks captured snapshot when metadata estimate already exceeds threshold", () => {
    process.env.ROUTECODEX_HUB_FASTPATH_HEAVY_INPUT = "1";
    process.env.ROUTECODEX_HUB_FASTPATH_INPUT_TOKEN_THRESHOLD = "100";

    const metadata: Record<string, unknown> = {
      estimatedInputTokens: 500,
    };
    const request = {
      model: "gpt-test",
      parameters: {},
      tools: [{ type: "function", function: { name: "a" } }],
      messages: [
        { role: "system", content: "sys-aaaaabbbbbccccc" },
        { role: "user", content: "u-111112222233333" },
        { role: "assistant", content: "a-xyzxyzxyzxyz" },
      ],
    };

    const captured = buildCapturedChatRequestInput({
      workingRequest: request,
      normalizedMetadata: metadata,
    }) as Record<string, unknown>;

    expect(Array.isArray(captured.messages)).toBe(true);
    const messages = captured.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[2].role).toBe("assistant");
    expect((metadata.__rt as Record<string, unknown>).hubFastpathHeavyInput).toBe(true);
    expect((metadata.__rt as Record<string, unknown>).hubFastpathReason).toBe("captured_snapshot");
  });

  it("respects runtime fastpath marker on __rt even when estimate is below threshold", () => {
    process.env.ROUTECODEX_HUB_FASTPATH_HEAVY_INPUT = "1";
    process.env.ROUTECODEX_HUB_FASTPATH_INPUT_TOKEN_THRESHOLD = "100";

    const metadata: Record<string, unknown> = {
      estimatedInputTokens: 12,
      __rt: {
        hubFastpathHeavyInput: true,
      },
    };
    const request = {
      model: "gpt-test",
      messages: [{ role: "user", content: "short" }],
    };

    buildCapturedChatRequestInput({
      workingRequest: request,
      normalizedMetadata: metadata,
    });

    expect((metadata.__rt as Record<string, unknown>).hubFastpathHeavyInput).toBe(true);
    expect((metadata.__rt as Record<string, unknown>).hubFastpathReason).toBe("captured_snapshot");
  });
});

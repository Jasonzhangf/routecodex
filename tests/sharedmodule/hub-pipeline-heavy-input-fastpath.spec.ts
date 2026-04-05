import { afterEach, describe, expect, it, jest } from "@jest/globals";

import type {
  ProcessedRequest,
  StandardizedRequest,
} from "../../sharedmodule/llmswitch-core/src/conversion/hub/types/standardized.js";
import { estimateInputTokensForWorkingRequest } from "../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-chat-process-request-utils.js";
import {
  buildCapturedChatRequestInput,
} from "../../sharedmodule/llmswitch-core/src/conversion/hub/pipeline/hub-pipeline-heavy-input-fastpath.js";

function clearFastpathEnv(): void {
  delete process.env.ROUTECODEX_HUB_FASTPATH_HEAVY_INPUT;
  delete process.env.ROUTECODEX_HUB_FASTPATH_INPUT_TOKEN_THRESHOLD;
}

describe("hub heavy-input fastpath", () => {
  afterEach(() => {
    clearFastpathEnv();
    jest.restoreAllMocks();
  });

  it("skips tiktoken estimation when rough estimate already exceeds threshold", () => {
    process.env.ROUTECODEX_HUB_FASTPATH_HEAVY_INPUT = "1";
    process.env.ROUTECODEX_HUB_FASTPATH_INPUT_TOKEN_THRESHOLD = "100";

    const metadata: Record<string, unknown> = {};
    const request: StandardizedRequest = {
      model: "gpt-test",
      metadata: {},
      parameters: {},
      messages: [
        {
          role: "user",
          content: "x".repeat(2_400),
        } as any,
      ],
    };

    estimateInputTokensForWorkingRequest({
      workingRequest: request,
      normalizedMetadata: metadata,
    });

    expect(typeof metadata.estimatedInputTokens).toBe("number");
    expect((metadata.estimatedInputTokens as number) >= 100).toBe(true);
    expect((metadata.__rt as Record<string, unknown>).hubFastpathHeavyInput).toBe(
      true,
    );
    expect((metadata.__rt as Record<string, unknown>).hubFastpathReason).toBe(
      "rough_estimate",
    );
  });

  it("compacts captured chat request when fastpath is hit", () => {
    process.env.ROUTECODEX_HUB_FASTPATH_HEAVY_INPUT = "1";
    process.env.ROUTECODEX_HUB_FASTPATH_INPUT_TOKEN_THRESHOLD = "100";
    const metadata: Record<string, unknown> = {
      estimatedInputTokens: 500,
    };
    const request: StandardizedRequest | ProcessedRequest = {
      model: "gpt-test",
      metadata: {},
      parameters: {},
      tools: [{ type: "function", function: { name: "a" } }] as any,
      messages: [
        { role: "system", content: "sys-aaaaabbbbbccccc" },
        { role: "user", content: "u-111112222233333" },
        { role: "assistant", content: "a-xyzxyzxyzxyz" },
      ] as any,
    };

    const captured = buildCapturedChatRequestInput({
      workingRequest: request,
      normalizedMetadata: metadata,
    });

    expect(Array.isArray(captured.messages)).toBe(true);
    const messages = captured.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("system");
    expect(messages[1].role).toBe("user");
    expect(messages[2].role).toBe("assistant");
    expect((metadata.__rt as Record<string, unknown>).hubFastpathHeavyInput).toBe(
      true,
    );
  });

});

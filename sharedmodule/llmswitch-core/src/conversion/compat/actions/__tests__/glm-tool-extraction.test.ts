import { extractGlmToolMarkup } from "../glm-tool-extraction.js";

describe("glm-tool-extraction native wrapper", () => {
  test("extracts tool call from reasoning_content tagged markup, clears consumed reasoning text, and replaces nested payload in place", () => {
    const payload: any = {
      id: "glm_resp_1",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "",
            reasoning_content:
              "exec_command<arg_key>cmd</arg_key><arg_value>node scripts/start-headful.mjs --profile weibo_fresh</arg_value><arg_key>yield_time_ms</arg_key><arg_value>30000</arg_value></tool_call>",
          },
        },
      ],
    };
    const rootRef = payload;
    const originalChoices = payload.choices;
    const originalMessage = payload.choices[0].message;

    extractGlmToolMarkup(payload, {
      compatibilityProfile: "chat:glm",
      providerProtocol: "openai-chat",
      requestId: "req_glm_resp_1",
      entryEndpoint: "/v1/chat/completions",
    } as any);

    expect(payload).toBe(rootRef);
    expect(payload.choices).not.toBe(originalChoices);
    expect(payload.choices[0].message).not.toBe(originalMessage);
    expect(payload.choices[0].message.tool_calls[0].function.name).toBe(
      "exec_command",
    );
    expect(
      payload.choices[0].message.tool_calls[0].function.arguments,
    ).toContain("weibo_fresh");
    expect(payload.choices[0].message.reasoning_content).toBeUndefined();
  });

  test("leaves non-tool reasoning content untouched when no tool markup is present", () => {
    const payload: any = {
      id: "glm_resp_passthrough",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            reasoning_content: "I should think through the answer before replying.",
          },
        },
      ],
    };

    extractGlmToolMarkup(payload, {
      compatibilityProfile: "chat:glm",
      providerProtocol: "openai-chat",
      requestId: "req_glm_resp_passthrough",
      entryEndpoint: "/v1/chat/completions",
    } as any);

    expect(payload.choices[0].message.tool_calls).toBeUndefined();
    expect(payload.choices[0].message.reasoning_content).toBe(
      "I should think through the answer before replying.",
    );
  });

  test("does not mis-extract from malformed noise fragments", () => {
    const payload: any = {
      id: "glm_resp_noise",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            reasoning_content:
              '```tool\n{"name":"exec_command","arguments": }\n``` trailing noise [tool_call name="exec_command"]not-json[/tool_call]',
          },
        },
      ],
    };

    extractGlmToolMarkup(payload, {
      compatibilityProfile: "chat:glm",
      providerProtocol: "openai-chat",
      requestId: "req_glm_resp_noise",
      entryEndpoint: "/v1/chat/completions",
    } as any);

    expect(payload.choices[0].message.tool_calls).toBeUndefined();
    expect(payload.choices[0].message.reasoning_content).toContain("trailing noise");
  });

  test("extracts tool call from fenced json and clears consumed reasoning_content", () => {
    const payload: any = {
      id: "glm_resp_2",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            reasoning_content:
              '```tool\n{"name":"exec_command","arguments":{"cmd":"pwd"}}\n```',
          },
        },
      ],
    };

    extractGlmToolMarkup(payload, {
      compatibilityProfile: "chat:glm",
      providerProtocol: "openai-chat",
      requestId: "req_glm_resp_2",
      entryEndpoint: "/v1/chat/completions",
    } as any);

    expect(payload.choices[0].message.tool_calls[0].function.name).toBe(
      "exec_command",
    );
    expect(payload.choices[0].message.tool_calls[0].function.arguments).toBe(
      '{"cmd":"pwd"}',
    );
    expect(payload.choices[0].message.reasoning_content).toBeUndefined();
  });

  test("extracts tool call from bracketed block and preserves unrelated reasoning text", () => {
    const payload: any = {
      id: "glm_resp_3",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            reasoning_content:
              'Need a command first. [tool_call name="exec_command"]{"arguments":{"cmd":"ls"}}[/tool_call] Then summarize.',
          },
        },
      ],
    };

    extractGlmToolMarkup(payload, {
      compatibilityProfile: "chat:glm",
      providerProtocol: "openai-chat",
      requestId: "req_glm_resp_3",
      entryEndpoint: "/v1/chat/completions",
    } as any);

    expect(payload.choices[0].message.tool_calls[0].function.name).toBe(
      "exec_command",
    );
    expect(payload.choices[0].message.tool_calls[0].function.arguments).toBe(
      '{"cmd":"ls"}',
    );
    expect(payload.choices[0].message.reasoning_content).toBe(
      "Need a command first.  Then summarize.",
    );
  });
});

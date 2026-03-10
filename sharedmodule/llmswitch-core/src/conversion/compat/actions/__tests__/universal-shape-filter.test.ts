import { UniversalShapeFilter } from "../universal-shape-filter.js";

describe("universal-shape-filter native wrapper", () => {
  test("normalizes request allowTopLevel/messages/tools through native filter", () => {
    const filter = new UniversalShapeFilter({
      request: {
        allowTopLevel: ["model", "messages", "tools", "tool_choice"],
        messages: {
          allowedRoles: ["system", "user", "assistant", "tool"],
          assistantWithToolCallsContentNull: true,
        },
        tools: {
          normalize: true,
          forceToolChoiceAuto: true,
        },
        assistantToolCalls: {
          functionArgumentsType: "string",
        },
      },
      response: {
        allowTopLevel: ["id", "choices", "usage"],
        choices: {
          message: {
            allow: ["role", "content", "tool_calls"],
            roleDefault: "assistant",
            contentNullWhenToolCalls: true,
            tool_calls: {
              function: {
                argumentsType: "string",
              },
            },
          },
        },
        usage: { allow: ["prompt_tokens", "completion_tokens"] },
      },
    });

    const result = filter.applyRequestFilter({
      model: "glm-4.7",
      dropMe: true,
      messages: [
        {
          role: "assistant",
          content: "pending",
          tool_calls: [
            {
              id: "call_1",
              function: {
                name: "exec_command",
                arguments: { cmd: "pwd" },
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_1",
          content: { ok: true },
        },
      ],
      tools: [
        {
          name: "shell",
          parameters: { type: "object", properties: {} },
        },
      ],
      tool_choice: { type: "function" },
    } as any);

    expect((result as any).dropMe).toBeUndefined();
    expect((result as any).messages[0].content).toBeNull();
    expect((result as any).messages[0].tool_calls[0].function.arguments).toBe(
      '{"cmd":"pwd"}',
    );
    expect((result as any).messages[1].name).toBe("exec_command");
    expect((result as any).tool_choice).toBe("auto");
    expect((result as any).tools[0]).toEqual({
      type: "function",
      function: {
        name: "shell",
        parameters: {
          type: "object",
          properties: {
            command: {
              description:
                "Shell command. Prefer a single string; an array of argv tokens is also accepted.",
              oneOf: [
                { type: "string" },
                { type: "array", items: { type: "string" } },
              ],
            },
          },
          required: ["command"],
          additionalProperties: false,
        },
      },
    });
  });

  test("filters response allowTopLevel/choices/usage through native filter", () => {
    const prev = process.env.RCC_COMPAT_FILTER_OFF_RESPONSES;
    process.env.RCC_COMPAT_FILTER_OFF_RESPONSES = "0";
    const filter = new UniversalShapeFilter({
      request: {
        allowTopLevel: ["model", "messages"],
        messages: {
          allowedRoles: ["user"],
        },
      },
      response: {
        allowTopLevel: ["id", "choices", "usage"],
        choices: {
          message: {
            allow: ["role", "content", "tool_calls"],
            roleDefault: "assistant",
            contentNullWhenToolCalls: true,
            tool_calls: {
              function: {
                argumentsType: "string",
              },
            },
          },
        },
        usage: { allow: ["prompt_tokens", "completion_tokens"] },
      },
    });

    try {
      const result = filter.applyResponseFilter(
        {
          id: "resp_1",
          dropMe: true,
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: "call_1",
                    function: {
                      name: "exec_command",
                      arguments: { cmd: "pwd" },
                    },
                  },
                ],
              },
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 6,
            ignored: 1,
          },
        } as any,
        {
          entryEndpoint: "/v1/chat/completions",
          providerProtocol: "openai-chat",
          requestId: "req_shape_filter",
        } as any,
      );

      expect((result as any).dropMe).toBeUndefined();
      expect((result as any).choices[0].message.role).toBe("assistant");
      expect((result as any).choices[0].message.content).toBeNull();
      expect(
        (result as any).choices[0].message.tool_calls[0].function.arguments,
      ).toBe('{"cmd":"pwd"}');
      expect((result as any).choices[0].finish_reason).toBe("tool_calls");
      expect((result as any).usage).toEqual({
        prompt_tokens: 10,
        completion_tokens: 6,
      });
    } finally {
      if (prev === undefined) {
        delete process.env.RCC_COMPAT_FILTER_OFF_RESPONSES;
      } else {
        process.env.RCC_COMPAT_FILTER_OFF_RESPONSES = prev;
      }
    }
  });
});

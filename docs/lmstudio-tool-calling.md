# LM Studio Tool Calling API Documentation

## Overview

LM Studio provides comprehensive tool calling functionality that enables Large Language Models (LLMs) to interact with external functions and APIs. All models in LM Studio support at least some degree of tool use, with two levels of support: **Native** and **Default**.

## Tool Support Levels

### Native Tool Use Support
Models with native tool use support:
- Have a hammer badge in the LM Studio app
- Generally perform better in tool use scenarios
- Include chat templates that specifically support tool use
- Are trained for tool use functionality

**Currently supported models with native tool use:**
- **Qwen series**
  - `lmstudio-community/Qwen2.5-7B-Instruct-GGUF` (4.68 GB)
  - `mlx-community/Qwen2.5-7B-Instruct-4bit` (4.30 GB)
- **Llama series**
  - Llama-3.1, Llama-3.2 models

### Default Tool Use Support
**All models that don't have native tool use support will have default tool use support.**

LM Studio uses a standardized tool calling format that works with any model. The system provides a consistent interface regardless of the underlying model's capabilities.

## Tool Calling Format

### System Prompt Template

When tools are provided, LM Studio automatically formats the system prompt using this template:

```
# Tools

You may call one or more functions to assist with the user query.

You are provided with function signatures within <tools></tools> XML tags:
<tools>
{
  "type": "function",
  "function": {
    "name": "get_delivery_date",
    "description": "Get the delivery date for a customer's order",
    "parameters": {
      "type": "object",
      "properties": {
        "order_id": {"type": "string"}
      },
      "required": ["order_id"]
    }
  }
}
</tools>

For each function call, return a json object with function name and arguments within

{"name": "<function-name>", "arguments": <args-json-object>}```

**Important:** The model can only *request* calls to these tools because LLMs *cannot* directly call functions, APIs, or any other tools. They can only output text, which can then be parsed to programmatically call the functions.

### Response Options

When prompted, the LLM can either:

#### (a) Call one or more tools
```xml
User: Get me the delivery date for order 123
Model:```

#### (b) Respond normally
```xml
User: Hi
Model: Hello! How can I assist you today?
```

## API Usage

### Request Format

```bash
curl http://localhost:1234/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "lmstudio-community/qwen2.5-7b-instruct",
    "messages": [{"role": "user", "content": "What dell products do you have under $50 in electronics?"}],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "search_products",
          "description": "Search the product catalog by various criteria. Use this whenever a customer asks about product availability, pricing, or specifications.",
          "parameters": {
            "type": "object",
            "properties": {
              "query": {
                "type": "string",
                "description": "Search terms or product name"
              },
              "category": {
                "type": "string",
                "description": "Product category to filter by",
                "enum": ["electronics", "clothing", "home", "outdoor"]
              },
              "max_price": {
                "type": "number",
                "description": "Maximum price in dollars"
              }
            },
            "required": ["query"],
            "additionalProperties": false
          }
        }
      }
    ]
  }'
```

### Response Format

When the model decides to use tools, the response will include:

```json
{
  "id": "chatcmpl-gb1t1uqzefudice8ntxd9i",
  "object": "chat.completion",
  "created": 1730913210,
  "model": "lmstudio-community/qwen2.5-7b-instruct",
  "choices": [
    {
      "index": 0,
      "logprobs": null,
      "finish_reason": "tool_calls",
      "message": {
        "role": "assistant",
        "tool_calls": [
          {
            "id": "365174485",
            "type": "function",
            "function": {
              "name": "search_products",
              "arguments": "{\"query\": \"dell\", \"category\": \"electronics\", \"max_price\": 50}"
            }
          }
        ]
      }
    }
  ]
}
```

## LM Studio Processing

### Parsing Logic

LM Studio parses the text output from the model into an OpenAI-compliant `chat.completion` response object:

1. **With tools array**: LM Studio attempts to parse tool calls into the `response.choices[0].message.tool_calls` field
2. **No valid tool calls**: Returns response to the standard `response.choices[0].message.content` field
3. **Invalid format**: Tool calls with incorrect formatting won't be parsed into the `tool_calls` field

### Error Handling

**Note:** Smaller models and models that were not trained for tool use may output improperly formatted tool calls, resulting in LM Studio being unable to parse them into the `tool_calls` field.

**Example of improperly formatted tool call:**
```xml
```

This fails because:
- Brackets are incorrect (should be `{}` not `[]`)
- Does not follow the required `name, arguments` format
- `function: "date"` is not a valid argument structure

## Alternative Tool Call Format

For models that don't follow the standard XML format, LM Studio also supports an alternative format:

```
[TOOL_REQUEST]{"name": "get_delivery_date", "arguments": {"order_id": "123"}}[END_TOOL_REQUEST]
```

If a model follows this format exactly, LM Studio will parse those tool calls into the `chat.completions` object, just like for natively supported models.

## Implementation Notes

### Key Features

1. **Universal Support**: All models have at least default tool use support
2. **OpenAI Compatibility**: Responses follow OpenAI's chat.completion format
3. **Flexible Parsing**: Supports multiple tool call formats
4. **Error Resilience**: Gracefully handles malformed tool calls

### Best Practices

1. **Model Selection**: Use models with native tool support for better results
2. **Parameter Validation**: Ensure all required parameters are included in function definitions
3. **Error Handling**: Always check if `tool_calls` array is populated in responses
4. **Testing**: Test tool calling with your specific model as capabilities vary

### Troubleshooting

If you're not receiving `tool_calls` as expected:
1. Verify the model supports tool calling (native or default)
2. Check the tool call format in the model's response
3. Ensure all required parameters are properly defined
4. Test with a model that has native tool support for comparison

## File Information

- **Source**: LM Studio Tool Use Documentation
- **URL**: https://lmstudio.ai/docs/app/api/tools
- **Extracted**: September 22, 2025

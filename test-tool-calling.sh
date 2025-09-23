#!/bin/bash

# Test tool calling functionality
curl -X POST http://localhost:5506/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer rcc4-proxy-key" \
  -d '{
    "model": "gpt-4",
    "messages": [{"role": "user", "content": "List all folders in this directory"}],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "list_files",
          "description": "List files in directory",
          "parameters": {
            "type": "object",
            "properties": {
              "path": {
                "type": "string",
                "description": "Directory path"
              }
            },
            "required": []
          }
        }
      }
    ],
    "tool_choice": "auto"
  }'
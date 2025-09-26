#!/usr/bin/env python3

import requests
import json
import time

# Server configuration
BASE_URL = "http://localhost:4006"
API_KEY = "test-key"

def test_tool_calling():
    """Test tool calling functionality with ModelScope"""

    # Tool calling test request
    payload = {
        "model": "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        "messages": [
            {"role": "user", "content": "请列出当前目录中的所有文件夹"}
        ],
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "list_files",
                    "description": "列出指定目录中的文件和文件夹",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "path": {
                                "type": "string",
                                "description": "要列出的目录路径"
                            }
                        },
                        "required": ["path"]
                    }
                }
            }
        ],
        "tool_choice": "auto"
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}"
    }

    print("🧪 Testing tool calling functionality...")
    print(f"📡 Sending request to {BASE_URL}/v1/openai/chat/completions")
    print(f"📋 Payload: {json.dumps(payload, indent=2, ensure_ascii=False)}")
    print("-" * 50)

    try:
        response = requests.post(
            f"{BASE_URL}/v1/openai/chat/completions",
            headers=headers,
            json=payload,
            timeout=30
        )

        print(f"📊 Status Code: {response.status_code}")
        print(f"📋 Response Headers: {dict(response.headers)}")

        if response.status_code == 200:
            result = response.json()
            print(f"✅ Response: {json.dumps(result, indent=2, ensure_ascii=False)}")

            # Check if tool calls were made
            if "choices" in result and len(result["choices"]) > 0:
                choice = result["choices"][0]
                if "message" in choice and "tool_calls" in choice["message"]:
                    tool_calls = choice["message"]["tool_calls"]
                    print(f"🔧 Tool calls detected: {len(tool_calls)}")
                    for i, tool_call in enumerate(tool_calls):
                        print(f"  Tool {i+1}: {tool_call['function']['name']}")
                        print(f"    Arguments: {tool_call['function']['arguments']}")
                else:
                    print("⚠️ No tool calls in response")
            else:
                print("⚠️ No choices in response")

        else:
            print(f"❌ Error response: {response.text}")

    except requests.exceptions.Timeout:
        print("⏰ Request timed out")
    except requests.exceptions.ConnectionError:
        print("🔌 Connection error - is the server running?")
    except Exception as e:
        print(f"❌ Unexpected error: {e}")

def test_basic_chat():
    """Test basic chat functionality without tools"""

    payload = {
        "model": "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        "messages": [
            {"role": "user", "content": "Hello, how are you?"}
        ]
    }

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {API_KEY}"
    }

    print("\n🧪 Testing basic chat functionality...")
    print(f"📡 Sending request to {BASE_URL}/v1/openai/chat/completions")
    print("-" * 50)

    try:
        response = requests.post(
            f"{BASE_URL}/v1/openai/chat/completions",
            headers=headers,
            json=payload,
            timeout=30
        )

        print(f"📊 Status Code: {response.status_code}")

        if response.status_code == 200:
            result = response.json()
            print(f"✅ Response: {json.dumps(result, indent=2, ensure_ascii=False)}")
        else:
            print(f"❌ Error response: {response.text}")

    except Exception as e:
        print(f"❌ Error: {e}")

def check_server_health():
    """Check if server is healthy"""

    print("🏥 Checking server health...")
    print(f"📡 Checking {BASE_URL}/health")
    print("-" * 50)

    try:
        response = requests.get(f"{BASE_URL}/health", timeout=10)
        print(f"📊 Status Code: {response.status_code}")

        if response.status_code == 200:
            result = response.json()
            print(f"✅ Health check: {json.dumps(result, indent=2)}")
            return True
        else:
            print(f"❌ Health check failed: {response.text}")
            return False

    except Exception as e:
        print(f"❌ Health check error: {e}")
        return False

if __name__ == "__main__":
    print("🚀 RouteCodex Tool Calling Test")
    print("=" * 50)

    # Check server health first
    if not check_server_health():
        print("❌ Server is not healthy, exiting...")
        exit(1)

    # Test basic chat first
    test_basic_chat()

    # Test tool calling
    test_tool_calling()

    print("\n✅ Test completed!")
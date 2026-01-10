#!/usr/bin/env python3
"""
Task C: 测试Tools差异对429的影响
C1: 测试长prompt（不带tools）
C2: 逐步添加MCP tools，找出临界点
"""

import requests
import json
import os

ANTIGRAVITY_API_BASE = os.getenv('ANTIGRAVITY_API_BASE', 'https://daily-cloudcode-pa.sandbox.googleapis.com')
ACCESS_TOKEN = os.getenv('ANTIGRAVITY_ACCESS_TOKEN')

if not ACCESS_TOKEN:
    print("错误: 请设置 ANTIGRAVITY_ACCESS_TOKEN 环境变量")
    exit(1)

def test_request(desc, request_body):
    """发送测试请求"""
    print(f"\n{'='*80}")
    print(f"测试: {desc}")
    print(f"{'='*80}")
    
    headers = {
        'User-Agent': 'antigravity/1.11.3 windows/amd64',
        'Authorization': f'Bearer {ACCESS_TOKEN}',
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept': 'application/json',
        # 如果B1测试显示这些headers没问题，这里也加上
        'X-Goog-Api-Client': 'gl-node/22.17.0',
        'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI'
    }
    
    url = f"{ANTIGRAVITY_API_BASE}/v1internal:generateContent"
    
    # 显示请求信息  
    print(f"\nTools数量: {len(request_body['request'].get('tools', []))}")
    if 'tools' in request_body['request']:
        for i, tool in enumerate(request_body['request']['tools']):
            if 'functionDeclarations' in tool:
                func_count = len(tool['functionDeclarations'])
                func_names = [f['name'] for f in tool['functionDeclarations'][:3]]
                print(f"  Tool group {i+1}: {func_count} functions, 例如: {func_names}...")
            elif 'googleSearch' in tool:
                print(f"  Tool group {i+1}: googleSearch")
    
    try:
        response = requests.post(url, json=request_body, headers=headers, timeout=30)
        print(f"\n状态码: {response.status_code}")
        
        if response.status_code == 200:
            print("✅ 成功 (200)")
        elif response.status_code == 429:
            print("❌ 429 错误!")
            print(f"响应: {response.text[:300]}")
        else:
            print(f"⚠️  {response.status_code}")
            print(f"响应: {response.text[:300]}")
            
        return response.status_code
        
    except Exception as e:
        print(f"❌ 请求失败: {e}")
        return None

# 基础请求体（无tools）
base_request = {
    "requestId": "req-test-c",
    "model": "gemini-3-pro-low",
    "userAgent": "antigravity",
    "requestType": "agent",
    "request": {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "text": "你好，请用一句话介绍你自己。这是一个测试请求，用于验证Antigravity API的tools支持情况。"
                    }
                ]
            }
        ],
        "generationConfig": {
            "candidateCount": 1,
            "topK": 50,
            "temperature": 1.0
        },
        "session_id": "session-test-c"
    }
}

# 单个MCP tool示例
single_mcp_tool = {
    "functionDeclarations": [
        {
            "name": "test_function_1",
            "description": "A test function",
            "parameters": {
                "type": "object",
                "properties": {
                    "param1": {
                        "type": "string",
                        "description": "Test parameter"
                    }
                },
                "required": ["param1"]
            }
        }
    ]
}

# 多个MCP tools示例（简化版）
multiple_mcp_tools = [
    {
        "functionDeclarations": [
            {
                "name": f"test_function_{i}",
                "description": f"Test function {i}",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "param": {"type": "string"}
                    }
                }
            }
        ]
    }
    for i in range(5)
]

# googleSearch工具
google_search_tool = {
    "googleSearch": {}
}

print("=" * 80)
print("Task C: Tools差异测试")
print("=" * 80)

# C1.1: 无tools（基准）
req_c11 = base_request.copy()
status_c11 = test_request("C1.1 无tools（基准）", req_c11)

# C1.2: 添加googleSearch（Antigravity支持的）
req_c12 = json.loads(json.dumps(base_request))
req_c12['request']['tools'] = [google_search_tool]
status_c12 = test_request("C1.2 添加googleSearch工具", req_c12)

# C2.1: 添加单个MCP tool
req_c21 = json.loads(json.dumps(base_request))
req_c21['request']['tools'] = [single_mcp_tool]
status_c21 = test_request("C2.1 添加单个MCP tool", req_c21)

# C2.2: 添加5个MCP tools
req_c22 = json.loads(json.dumps(base_request))
req_c22['request']['tools'] = multiple_mcp_tools
status_c22 = test_request("C2.2 添加5个MCP tools", req_c22)

# C2.3: 混合：googleSearch + MCP tools
req_c23 = json.loads(json.dumps(base_request))
req_c23['request']['tools'] = [google_search_tool] + [single_mcp_tool]
status_c23 = test_request("C2.3 混合：googleSearch + 1个MCP tool", req_c23)

# 总结
print(f"\n{'='*80}")
print("测试总结:")
print(f"{'='*80}")
print(f"C1.1 无tools: {status_c11}")
print(f"C1.2 googleSearch: {status_c12}")
print(f"C2.1 单个MCP tool: {status_c21}")
print(f"C2.2 5个MCP tools: {status_c22}")
print(f"C2.3 混合: {status_c23}")

if status_c11 == 200 and status_c21 == 429:
    print("\n🔍 发现！单个MCP tool就会导致429")
elif status_c11 == 200 and status_c22 == 429 and status_c21 == 200:
    print("\n🔍 发现！多个MCP tools导致429（单个OK）")
elif status_c11 == 200 and status_c12 == 429:
    print("\n🔍 意外！googleSearch工具也会导致429")
else:
    print(f"\n✅ Tools不是问题，或者需要更多MCP tools才触发429")

#!/usr/bin/env python3
"""
Task B1: 在gcli2api中增加 X-Goog-Api-Client 与 Client-Metadata
测试这些额外headers是否会导致429
"""

import requests
import json
import os

# Antigravity API配置
ANTIGRAVITY_API_BASE = os.getenv('ANTIGRAVITY_API_BASE', 'https://daily-cloudcode-pa.sandbox.googleapis.com')
ACCESS_TOKEN = os.getenv('ANTIGRAVITY_ACCESS_TOKEN')  # 需要设置环境变量

if not ACCESS_TOKEN:
    print("错误: 请设置 ANTIGRAVITY_ACCESS_TOKEN 环境变量")
    exit(1)

# 测试用的请求体（简单版本，gcli2api已验证200的）
request_body = {
    "requestId": "req-test-b1",
    "model": "gemini-3-pro-low",
    "userAgent": "antigravity",
    "requestType": "agent",
    "request": {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "text": "Hello, 用一句话介绍自己"
                    }
                ]
            }
        ],
        "generationConfig": {
            "candidateCount": 1,
            "topK": 50,
            "temperature": 1.0
        },
        "session_id": "session-test-001"  # A1已验证OK
    }
}

def test_with_headers(headers_desc, extra_headers):
    """使用指定headers测试请求"""
    print(f"\n{'='*80}")
    print(f"测试: {headers_desc}")
    print(f"{'='*80}")
    
    # 基础headers (gcli2api默认)
    headers = {
        'User-Agent': 'antigravity/1.11.3 windows/amd64',
        'Authorization': f'Bearer {ACCESS_TOKEN}',
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip, deflate, br',  # A2已验证OK
        'Accept': 'application/json'  # A2已验证OK
    }
    
    # 添加额外headers
    headers.update(extra_headers)
    
    print("\nHeaders:")
    for k, v in headers.items():
        if k == 'Authorization':
            print(f"  {k}: Bearer {ACCESS_TOKEN[:10]}...{ACCESS_TOKEN[-10:]}")
        else:
            print(f"  {k}: {v}")
    
    # 发送请求
    url = f"{ANTIGRAVITY_API_BASE}/v1internal:generateContent"
    print(f"\nURL: {url}")
    print(f"Body: {json.dumps(request_body, indent=2, ensure_ascii=False)[:500]}...")
    
    try:
        response = requests.post(url, json=request_body, headers=headers, timeout=30)
        print(f"\n✅ 状态码: {response.status_code}")
        
        if response.status_code == 200:
            print("✅ 成功! (200 OK)")
            # 显示部分响应
            try:
                resp_json = response.json()
                if 'response' in resp_json:
                    candidates = resp_json.get('response', {}).get('candidates', [])
                    if candidates:
                        first_part = candidates[0].get('content', {}).get('parts', [{}])[0]
                        text = first_part.get('text', '')[:100]
                        print(f"响应片段: {text}...")
            except:
                pass
        elif response.status_code == 429:
            print("❌ 429 错误!")
            print(f"响应: {response.text[:500]}")
        else:
            print(f"⚠️  其他错误: {response.status_code}")
            print(f"响应: {response.text[:500]}")
            
        return response.status_code
        
    except Exception as e:
        print(f"❌ 请求失败: {e}")
        return None

# 执行测试序列
print("=" * 80)
print("Task B1: Header深度对齐测试")
print("基于gcli2api已200的基础，逐步添加RouteCodex特有headers")
print("=" * 80)

# B1.1: 基准测试（gcli2api默认，应该200）
status1 = test_with_headers("B1.1 基准（gcli2api默认）", {})

# B1.2: 添加 X-Goog-Api-Client
status2 = test_with_headers("B1.2 添加 X-Goog-Api-Client", {
    'X-Goog-Api-Client': 'gl-node/22.17.0'
})

# B1.3: 添加 Client-Metadata
status3 = test_with_headers("B1.3 添加 Client-Metadata", {
    'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI'
})

# B1.4: 同时添加两者（完整RouteCodex headers）
status4 = test_with_headers("B1.4 同时添加两者（RouteCodex完整）", {
    'X-Goog-Api-Client': 'gl-node/22.17.0',
    'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI'
})

# 总结
print(f"\n{'='*80}")
print("测试总结:")
print(f"{'='*80}")
print(f"B1.1 基准（gcli2api默认）: {status1}")
print(f"B1.2 + X-Goog-Api-Client: {status2}")
print(f"B1.3 + Client-Metadata: {status3}")
print(f"B1.4 + 两者都加: {status4}")

if status1 == 200 and status4 == 429:
    print("\n🔍 发现！Headers差异导致了429错误")
elif status1 == 200 and status4 == 200:
    print("\n✅ Headers不是问题，继续测试其他差异（Step C: Tools）")
else:
    print(f"\n⚠️  基准测试结果异常: {status1}")

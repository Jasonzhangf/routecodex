# GLM 对话补全（本地快照）

源: https://docs.bigmodel.cn/api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%AF%B9%E8%AF%9D%E8%A1%A5%E5%85%A8

((a,b,c,d,e,f,g,h)=>{let i=document.documentElement,j=\["light","dark"\];function k(b){var c;(Array.isArray(a)?a:\[a\]).forEach(a=>{let c="class"===a,d=c&&f?e.map(a=>f\[a\]||a):e;c?(i.classList.remove(...d),i.classList.add(f&&f\[b\]?f\[b\]:b)):i.setAttribute(a,b)}),c=b,h&&j.includes(c)&&(i.style.colorScheme=c)}if(d)k(d);else try{let a=localStorage.getItem(b)||c,d=g&&"system"===a?window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light":a;k(d)}catch(a){}})("class","isDarkMode","light",null,\["dark","light","true","false","system"\],{"true":"dark","false":"light","dark":"dark","light":"light"},true,true)(self.\_\_next\_s=self.\_\_next\_s||\[\]).push(\[0,{"children":"(function m(a,b,c,d){try{let e=document.getElementById(\\"banner\\"),f=e?.innerText;if(!f)return void document.documentElement.setAttribute(d,\\"hidden\\");let g=localStorage.getItem(a),h=g!==f&&g!==b;null!=g&&(h?(localStorage.removeItem(c),localStorage.removeItem(a)):(localStorage.setItem(c,b),localStorage.setItem(a,b))),document.documentElement.setAttribute(d,!g||h?\\"visible\\":\\"hidden\\")}catch(a){console.error(a),document.documentElement.setAttribute(d,\\"hidden\\")}})(\\n \\"zhipu-ef7018ed-bannerDismissed\\",\\n \\"🚀 \*\*GLM-4.6 代码编程专享计划\*\* • \[限时优惠 Coding Plan ➞\](https://bigmodel.cn/claude-code?utm\_source=bigModel&utm\_medium=Frontend%20Group&utm\_content=glm%20code&utm\_campaign=Platform\_Ops&\_channel\_track\_key=WW2t6PJI)\\",\\n \\"\_\_mintlify-bannerDismissed\\",\\n \\"data-banner-state\\",\\n)","id":"\_mintlify-banner-script"}\]):root { --primary: 19 76 255; --primary-light: 159 160 160; --primary-dark: 19 76 255; --background-light: 255 255 255; --background-dark: 12 12 14; --gray-50: 243 245 250; --gray-100: 238 240 245; --gray-200: 223 224 230; --gray-300: 206 208 213; --gray-400: 159 160 166; --gray-500: 112 114 119; --gray-600: 80 82 87; --gray-700: 63 64 70; --gray-800: 37 39 45; --gray-900: 23 25 30; --gray-950: 10 12 17; }

(self.\_\_next\_s=self.\_\_next\_s||\[\]).push(\[0,{"suppressHydrationWarning":true,"children":"(function(e,t,r,n){var a;let l,o=\\"mint\\"===n||\\"linden\\"===n?\\"sidebar\\":\\"sidebar-content\\",c=(l=\\"navbar-transition\\",\\"maple\\"===(a=n)&&(l+=\\"-maple\\"),\\"willow\\"===a&&(l+=\\"-willow\\"),l);function s(){document.documentElement.classList.add(\\"lg:\[--scroll-mt:9.5rem\]\\")}function i(e){document.getElementById(o)?.style.setProperty(\\"top\\",\`${e}rem\`)}function m(e){document.getElementById(o)?.style.setProperty(\\"height\\",\`calc(100vh - ${e}rem)\`)}function d(e,t){!e&&t||e&&!t?(s(),document.documentElement.classList.remove(\\"lg:\[--scroll-mt:12rem\]\\")):e&&t&&(document.documentElement.classList.add(\\"lg:\[--scroll-mt:12rem\]\\"),document.documentElement.classList.remove(\\"lg:\[--scroll-mt:9.5rem\]\\"))}let u=document.documentElement.getAttribute(\\"data-banner-state\\"),h=null!=u?\\"visible\\"===u:t;switch(n){case\\"mint\\":i(r),d(e,h);break;case\\"palm\\":case\\"aspen\\":i(r),m(r),d(e,h);break;case\\"linden\\":i(r),h&&s();break;case\\"almond\\":document.documentElement.style.setProperty(\\"--scroll-mt\\",\\"2.5rem\\"),i(r),m(r)}let p=function(){let e=document.createElement(\\"style\\");return e.appendChild(document.createTextNode(\\"\*,\*::before,\*::after{-webkit-transition:none!important;-moz-transition:none!important;-o-transition:none!important;-ms-transition:none!important;transition:none!important}\\")),document.head.appendChild(e),function(){window.getComputedStyle(document.body),setTimeout(()=>{document.head.removeChild(e)},1)}}();(\\"requestAnimationFrame\\"in globalThis?requestAnimationFrame:setTimeout)(()=>{let e;e=!1,e=window.scrollY>50,document.getElementById(c)?.setAttribute(\\"data-is-opaque\\",\`${!!e}\`),p()})})(\\n true,\\n true,\\n (function i(e,t,r){let n=document.documentElement.getAttribute(\\"data-banner-state\\"),a=2.5\*!!(null!=n?\\"visible\\"===n:t),l=3\*!!e,o=4,c=a+4+l;switch(r){case\\"mint\\":case\\"palm\\":break;case\\"aspen\\":o=3.5,c=a+(l=2.5\*!!e)+o;break;case\\"linden\\":c=a+(o=4);break;case\\"almond\\":c=a+(o=3.5)}return c})(true, true, \\"mint\\"),\\n \\"mint\\",\\n)","id":"\_mintlify-scroll-top-script"}\])[Skip to main content](#content-area)

🚀 **GLM-4.6 代码编程专享计划** • [限时优惠 Coding Plan ➞](https://bigmodel.cn/claude-code?utm_source=bigModel&utm_medium=Frontend%20Group&utm_content=glm%20code&utm_campaign=Platform_Ops&_channel_track_key=WW2t6PJI)

[智谱AI开放文档 home page![light logo](https://cdn.bigmodel.cn/static/logo/dark.svg)![dark logo](https://cdn.bigmodel.cn/static/logo/light.svg)](https://bigmodel.cn/)

Search...

⌘K

-   [控制台](https://bigmodel.cn/console/overview)
-   [财务](https://bigmodel.cn/finance/overview)
-   [个人中心](https://bigmodel.cn/usercenter/settings/account)

Search...

Navigation

模型 API

对话补全

[使用指南

](/cn/guide/start/introduction)[API 文档

](/cn/api/introduction)[场景示例

](/cn/guide/develop/claude)[编码套餐

](/cn/coding-plan/overview)[更新日志

](/cn/update/new-releases)[上新活动

](/cn/update/promotion)[条款与协议

](/cn/terms/user-agreement)[常见问题

](/cn/faq/api-code)

##### API 指引

-   [
    
    使用概述
    
    
    
    ](/cn/api/introduction)
-   [
    
    错误码
    
    
    
    ](/cn/api/api-code)

##### 模型 API

-   [POST
    
    对话补全
    
    
    
    ](/api-reference/模型-api/对话补全)
-   [POST
    
    对话补全(异步)
    
    
    
    ](/api-reference/模型-api/对话补全异步)
-   [POST
    
    生成视频(异步)
    
    
    
    ](/api-reference/模型-api/生成视频异步)
-   [GET
    
    查询异步结果
    
    
    
    ](/api-reference/模型-api/查询异步结果)
-   [POST
    
    图像生成
    
    
    
    ](/api-reference/模型-api/图像生成)
-   [POST
    
    语音转文本
    
    
    
    ](/api-reference/模型-api/语音转文本)
-   [POST
    
    文本转语音
    
    
    
    ](/api-reference/模型-api/文本转语音)
-   [POST
    
    音色复刻
    
    
    
    ](/api-reference/模型-api/音色复刻)
-   [GET
    
    音色列表
    
    
    
    ](/api-reference/模型-api/音色列表)
-   [POST
    
    删除音色
    
    
    
    ](/api-reference/模型-api/删除音色)
-   [POST
    
    文本嵌入
    
    
    
    ](/api-reference/模型-api/文本嵌入)
-   [POST
    
    文本重排序
    
    
    
    ](/api-reference/模型-api/文本重排序)
-   [POST
    
    文本分词器
    
    
    
    ](/api-reference/模型-api/文本分词器)

##### 工具 API

-   [POST
    
    网络搜索
    
    
    
    ](/api-reference/工具-api/网络搜索)
-   [POST
    
    内容安全
    
    
    
    ](/api-reference/工具-api/内容安全)
-   [POST
    
    文件解析
    
    
    
    ](/api-reference/工具-api/文件解析)
-   [GET
    
    解析结果
    
    
    
    ](/api-reference/工具-api/解析结果)

##### Agent API

-   [POST
    
    智能体对话
    
    
    
    ](/api-reference/agent-api/智能体对话)
-   [POST
    
    异步结果
    
    
    
    ](/api-reference/agent-api/异步结果)
-   [POST
    
    对话历史
    
    
    
    ](/api-reference/agent-api/对话历史)

##### 文件 API

-   [GET
    
    文件列表
    
    
    
    ](/api-reference/文件-api/文件列表)
-   [POST
    
    上传文件
    
    
    
    ](/api-reference/文件-api/上传文件)
-   [DEL
    
    删除文件
    
    
    
    ](/api-reference/文件-api/删除文件)
-   [GET
    
    文件内容
    
    
    
    ](/api-reference/文件-api/文件内容)

##### 批处理 API

-   [GET
    
    列出批处理任务
    
    
    
    ](/api-reference/批处理-api/列出批处理任务)
-   [POST
    
    创建批处理任务
    
    
    
    ](/api-reference/批处理-api/创建批处理任务)
-   [GET
    
    检索批处理任务
    
    
    
    ](/api-reference/批处理-api/检索批处理任务)
-   [POST
    
    取消批处理任务
    
    
    
    ](/api-reference/批处理-api/取消批处理任务)

##### 知识库 API

-   [GET
    
    知识库列表
    
    
    
    ](/api-reference/知识库-api/知识库列表)
-   [POST
    
    创建知识库
    
    
    
    ](/api-reference/知识库-api/创建知识库)
-   [GET
    
    知识库详情
    
    
    
    ](/api-reference/知识库-api/知识库详情)
-   [PUT
    
    编辑知识库
    
    
    
    ](/api-reference/知识库-api/编辑知识库)
-   [DEL
    
    删除知识库
    
    
    
    ](/api-reference/知识库-api/删除知识库)
-   [GET
    
    知识库使用量
    
    
    
    ](/api-reference/知识库-api/知识库使用量)
-   [GET
    
    文档列表
    
    
    
    ](/api-reference/知识库-api/文档列表)
-   [POST
    
    上传文件文档
    
    
    
    ](/api-reference/知识库-api/上传文件文档)
-   [POST
    
    上传URL文档
    
    
    
    ](/api-reference/知识库-api/上传url文档)
-   [POST
    
    解析文档图片
    
    
    
    ](/api-reference/知识库-api/解析文档图片)
-   [GET
    
    文档详情
    
    
    
    ](/api-reference/知识库-api/文档详情)
-   [DEL
    
    删除文档
    
    
    
    ](/api-reference/知识库-api/删除文档)
-   [POST
    
    重新向量化
    
    
    
    ](/api-reference/知识库-api/重新向量化)

##### 实时 API

-   [WSS
    
    音视频通话
    
    
    
    ](/cn/asyncapi/realtime)

##### 助理 API

-   [POST
    
    助手对话
    
    deprecated
    
    
    
    ](/api-reference/助理-api/助手对话)
-   [POST
    
    助手列表
    
    deprecated
    
    
    
    ](/api-reference/助理-api/助手列表)
-   [POST
    
    助手会话列表
    
    deprecated
    
    
    
    ](/api-reference/助理-api/助手会话列表)

##### 智能体 API（旧）

-   [GET
    
    获取智能体输入参数
    
    deprecated
    
    
    
    ](/api-reference/智能体-api（旧）/获取智能体输入参数)
-   [POST
    
    文件上传
    
    deprecated
    
    
    
    ](/api-reference/智能体-api（旧）/文件上传)
-   [POST
    
    获取文件解析状态
    
    deprecated
    
    
    
    ](/api-reference/智能体-api（旧）/获取文件解析状态)
-   [POST
    
    创建新会话
    
    deprecated
    
    
    
    ](/api-reference/智能体-api（旧）/创建新会话)
-   [POST
    
    推理接口
    
    deprecated
    
    
    
    ](/api-reference/智能体-api（旧）/推理接口)
-   [POST
    
    知识库切片引用位置信息
    
    deprecated
    
    
    
    ](/api-reference/智能体-api（旧）/知识库切片引用位置信息)
-   [GET
    
    推荐问题接口
    
    deprecated
    
    
    
    ](/api-reference/智能体-api（旧）/推荐问题接口)

(self.\_\_next\_s=self.\_\_next\_s||\[\]).push(\[0,{"children":"document.documentElement.setAttribute('data-page-mode', 'none');","id":"\_mintlify-page-mode-script"}\])(self.\_\_next\_s=self.\_\_next\_s||\[\]).push(\[0,{"suppressHydrationWarning":true,"children":"(function d(e,t){if(!document.getElementById(\\"footer\\")?.classList.contains(\\"advanced-footer\\")||\\"maple\\"===t||\\"willow\\"===t||\\"almond\\"===t)return;let r=document.documentElement.getAttribute(\\"data-page-mode\\"),n=document.getElementById(\\"navbar\\"),a=document.getElementById(\\"sidebar\\"),l=document.getElementById(\\"footer\\"),o=document.getElementById(\\"table-of-contents-content\\");if(!l||\\"center\\"===r)return;let c=l.getBoundingClientRect().top,s=window.innerHeight-c;a&&(s>0?(a.style.top=\`-${s}px\`,a.style.height=\`${window.innerHeight}px\`):(a.style.top=\`${e}rem\`,a.style.height=\\"auto\\")),o&&n&&(s>0?o.style.top=\\"custom\\"===r?\`${n.clientHeight-s}px\`:\`${40+n.clientHeight-s}px\`:o.style.top=\\"\\")})(\\n (function i(e,t,r){let n=document.documentElement.getAttribute(\\"data-banner-state\\"),a=2.5\*!!(null!=n?\\"visible\\"===n:t),l=3\*!!e,o=4,c=a+4+l;switch(r){case\\"mint\\":case\\"palm\\":break;case\\"aspen\\":o=3.5,c=a+(l=2.5\*!!e)+o;break;case\\"linden\\":c=a+(o=4);break;case\\"almond\\":c=a+(o=3.5)}return c})(true, true, \\"mint\\"),\\n \\"mint\\",\\n)","id":"\_mintlify-footer-and-sidebar-scroll-script"}\])#footer div:last-child { display: none; } /\* 表格样式优化 \*/ .table-container { overflow-x: auto; margin: 20px 0; border: 1px solid #e1e5e9; border-radius: 4px; } table { width: 100%; min-width: 600px; /\* 设置最小宽度确保表格不会过度压缩 \*/ border-collapse: collapse; margin: 0; font-size: 14px; line-height: 1.6; } table th, table td { padding: 12px 8px; min-width: 80px; border: 1px solid #e1e5e9; vertical-align: top; word-wrap: break-word; } /\* 第一列增加左内边距 \*/ table th:first-child, table td:first-child { padding-left: 8px; } table th { font-weight: 600; text-align: center; } .prose :where(thead th):not(:where(\[class~=not-prose\],\[class~=not-prose\] \*)) { padding-top: 8px; } /\* 响应式表格 \*/ @media (max-width: 768px) { .table-container { margin: 15px 0; } table { font-size: 12px; min-width: 600px; /\* 移动端也保持最小宽度 \*/ } table th, table td { padding: 8px 4px; white-space: nowrap; /\* 防止文字换行导致表格变形 \*/ } } /\*\* banner \*\*/ .md\\:h-10 { height: 3rem; } .bg-primary-dark { background-color: #134cff1a; } .prose-dark :where(a):not(:where(\[class~=not-prose\],\[class~=not-prose\] \*)) { color: #134CFF; font-weight: 900; } .prose-dark :where(strong):not(:where(\[class~=not-prose\],\[class~=not-prose\] \*)) { color: #3b2f2f; font-weight: 900; } .\\\[\\&\\>\\\*\\\]\\:text-white\\/90>\* { color: #3b2f2f; } /\*\* banner \*\*/

cURL

基础调用示例

Copy

```
curl --request POST \  --url https://open.bigmodel.cn/api/paas/v4/chat/completions \  --header 'Authorization: Bearer <token>' \  --header 'Content-Type: application/json' \  --data '{  "model": "glm-4.6",  "messages": [    {      "role": "system",      "content": "你是一个有用的AI助手。"    },    {      "role": "user",      "content": "请介绍一下人工智能的发展历程。"    }  ],  "temperature": 1,  "max_tokens": 65536,  "stream": false}'
```

200

default

Copy

```
{
  "id": "<string>",
  "request_id": "<string>",
  "created": 123,
  "model": "<string>",
  "choices": [
    {
      "index": 123,
      "message": {
        "role": "assistant",
        "content": "<string>",
        "reasoning_content": "<string>",
        "audio": {
          "id": "<string>",
          "data": "<string>",
          "expires_at": "<string>"
        },
        "tool_calls": [
          {
            "function": {
              "name": "<string>",
              "arguments": {}
            },
            "mcp": {
              "id": "<string>",
              "type": "mcp_list_tools",
              "server_label": "<string>",
              "error": "<string>",
              "tools": [
                {
                  "name": "<string>",
                  "description": "<string>",
                  "annotations": {},
                  "input_schema": {
                    "type": "object",
                    "properties": {},
                    "required": [
                      "<any>"
                    ],
                    "additionalProperties": true
                  }
                }
              ],
              "arguments": "<string>",
              "name": "<string>",
              "output": {}
            },
            "id": "<string>",
            "type": "<string>"
          }
        ]
      },
      "finish_reason": "<string>"
    }
  ],
  "usage": {
    "prompt_tokens": 123,
    "completion_tokens": 123,
    "prompt_tokens_details": {
      "cached_tokens": 123
    },
    "total_tokens": 123
  },
  "video_result": [
    {
      "url": "<string>",
      "cover_image_url": "<string>"
    }
  ],
  "web_search": [
    {
      "icon": "<string>",
      "title": "<string>",
      "link": "<string>",
      "media": "<string>",
      "publish_date": "<string>",
      "content": "<string>",
      "refer": "<string>"
    }
  ],
  "content_filter": [
    {
      "role": "<string>",
      "level": 123
    }
  ]
}
```

模型 API

# 对话补全

Copy page

和 [指定模型](/cn/guide/start/model-overview) 对话，模型根据请求给出响应。支持多种模型，支持多模态（文本、图片、音频、视频、文件），流式和非流式输出，可配置采样，温度，最大令牌数，工具调用等。

Copy page

POST

/

paas

/

v4

/

chat

/

completions

Try it

cURL

基础调用示例

Copy

```
curl --request POST \  --url https://open.bigmodel.cn/api/paas/v4/chat/completions \  --header 'Authorization: Bearer <token>' \  --header 'Content-Type: application/json' \  --data '{  "model": "glm-4.6",  "messages": [    {      "role": "system",      "content": "你是一个有用的AI助手。"    },    {      "role": "user",      "content": "请介绍一下人工智能的发展历程。"    }  ],  "temperature": 1,  "max_tokens": 65536,  "stream": false}'
```

200

default

Copy

```
{
  "id": "<string>",
  "request_id": "<string>",
  "created": 123,
  "model": "<string>",
  "choices": [
    {
      "index": 123,
      "message": {
        "role": "assistant",
        "content": "<string>",
        "reasoning_content": "<string>",
        "audio": {
          "id": "<string>",
          "data": "<string>",
          "expires_at": "<string>"
        },
        "tool_calls": [
          {
            "function": {
              "name": "<string>",
              "arguments": {}
            },
            "mcp": {
              "id": "<string>",
              "type": "mcp_list_tools",
              "server_label": "<string>",
              "error": "<string>",
              "tools": [
                {
                  "name": "<string>",
                  "description": "<string>",
                  "annotations": {},
                  "input_schema": {
                    "type": "object",
                    "properties": {},
                    "required": [
                      "<any>"
                    ],
                    "additionalProperties": true
                  }
                }
              ],
              "arguments": "<string>",
              "name": "<string>",
              "output": {}
            },
            "id": "<string>",
            "type": "<string>"
          }
        ]
      },
      "finish_reason": "<string>"
    }
  ],
  "usage": {
    "prompt_tokens": 123,
    "completion_tokens": 123,
    "prompt_tokens_details": {
      "cached_tokens": 123
    },
    "total_tokens": 123
  },
  "video_result": [
    {
      "url": "<string>",
      "cover_image_url": "<string>"
    }
  ],
  "web_search": [
    {
      "icon": "<string>",
      "title": "<string>",
      "link": "<string>",
      "media": "<string>",
      "publish_date": "<string>",
      "content": "<string>",
      "refer": "<string>"
    }
  ],
  "content_filter": [
    {
      "role": "<string>",
      "level": 123
    }
  ]
}
```

#### Authorizations

[​

](#authorization-authorization)

Authorization

string

header

required

使用以下格式进行身份验证：Bearer [<your api key>](https://bigmodel.cn/usercenter/proj-mgmt/apikeys)

#### Body

application/json

-   文本模型
    
-   视觉模型
    
-   音频模型
    
-   角色模型
    

普通对话模型请求，支持纯文本对话和工具调用

[​

](#body-model)

model

enum<string>

default:glm-4.6

required

调用的普通对话模型代码。`GLM-4.6` 是最新的旗舰模型系列，专为智能体应用打造的基础模型。`GLM-4.6` `GLM-4.5` 系列提供了复杂推理、超长上下文、极快推理速度等多款模型。

Available options:

`glm-4.6`,

`glm-4.5`,

`glm-4.5-air`,

`glm-4.5-x`,

`glm-4.5-airx`,

`glm-4.5-flash`,

`glm-4-plus`,

`glm-4-air-250414`,

`glm-4-airx`,

`glm-4-flashx`,

`glm-4-flashx-250414`,

`glm-z1-air`,

`glm-z1-airx`,

`glm-z1-flash`,

`glm-z1-flashx`

Example:

`"glm-4.6"`

[​

](#body-messages)

messages

(用户消息 · object | 系统消息 · object | 助手消息 · object | 工具消息 · object)\[\]

required

对话消息列表，包含当前对话的完整上下文信息。每条消息都有特定的角色和内容，模型会根据这些消息生成回复。消息按时间顺序排列，支持四种角色：`system`（系统消息，用于设定`AI`的行为和角色）、`user`（用户消息，来自用户的输入）、`assistant`（助手消息，来自`AI`的回复）、`tool`（工具消息，工具调用的结果）。普通对话模型主要支持纯文本内容。注意不能只包含系统消息或助手消息。

Minimum length: `1`

-   用户消息
    
-   系统消息
    
-   助手消息
    
-   工具消息
    

Hide child attributes

[​

](#body-messages-role)

role

enum<string>

default:user

required

消息作者的角色

Available options:

`user`

[​

](#body-messages-content)

content

string

required

文本消息内容

Example:

`"What opportunities and challenges will the Chinese large model industry face in 2025?"`

[​

](#body-stream)

stream

boolean

default:false

是否启用流式输出模式。默认值为 `false`。当设置为 `false` 时，模型会在生成完整响应后一次性返回所有内容，适合短文本生成和批处理场景。当设置为 `true` 时，模型会通过`Server-Sent Events (SSE)`流式返回生成的内容，用户可以实时看到文本生成过程，适合聊天对话和长文本生成场景，能提供更好的用户体验。流式输出结束时会返回 `data: [DONE]` 消息。

Example:

`false`

[​

](#body-thinking)

thinking

object

仅 `GLM-4.5` 及以上模型支持此参数配置. 控制大模型是否开启思维链。

Hide child attributes

[​

](#body-thinking-type)

thinking.type

enum<string>

default:enabled

是否开启思维链(当开启后 `GLM-4.5` 为模型自动判断是否思考，`GLM-4.5V` 为强制思考), 默认: `enabled`.

Available options:

`enabled`,

`disabled`

[​

](#body-do-sample)

do\_sample

boolean

default:true

是否启用采样策略来生成文本。默认值为 `true`。当设置为 `true` 时，模型会使用 `temperature、top_p` 等参数进行随机采样，生成更多样化的输出；当设置为 `false` 时，模型总是选择概率最高的词汇，生成更确定性的输出，此时 `temperature` 和 `top_p` 参数将被忽略。对于需要一致性和可重复性的任务（如代码生成、翻译），建议设置为 `false`。

Example:

`true`

[​

](#body-temperature)

temperature

number

default:1

采样温度，控制输出的随机性和创造性，取值范围为 `[0.0, 1.0]`，限两位小数。对于`GLM-4.6`系列默认值为 `1.0`，`GLM-4.5`系列默认值为 `0.6`，`GLM-Z1`系列和`GLM-4`系列默认值为 `0.75`。较高的值（如`0.8`）会使输出更随机、更具创造性，适合创意写作和头脑风暴；较低的值（如`0.2`）会使输出更稳定、更确定，适合事实性问答和代码生成。建议根据应用场景调整 `top_p` 或 `temperature` 参数，但不要同时调整两个参数。

Required range: `0 <= x <= 1`

Example:

`1`

[​

](#body-top-p)

top\_p

number

default:0.95

核采样（`nucleus sampling`）参数，是`temperature`采样的替代方法，取值范围为 `(0.0, 1.0]`，限两位小数。对于`GLM-4.6` `GLM-4.5`系列默认值为 `0.95`，`GLM-Z1`系列和`GLM-4`系列默认值为 `0.9`。模型只考虑累积概率达到`top_p`的候选词汇。例如：`0.1`表示只考虑前`10%`概率的词汇，`0.9`表示考虑前`90%`概率的词汇。较小的值会产生更集中、更一致的输出；较大的值会增加输出的多样性。建议根据应用场景调整 `top_p` 或 `temperature` 参数，但不建议同时调整两个参数。

Required range: `0 <= x <= 1`

Example:

`0.95`

[​

](#body-max-tokens)

max\_tokens

integer

模型输出的最大令牌`token`数量限制。`GLM-4.6`最大支持`128K`输出长度，`GLM-4.5`最大支持`96K`输出长度，`GLM-Z1`系列最大支持`32K`输出长度，建议设置不小于`1024`。令牌是文本的基本单位，通常`1`个令牌约等于`0.75`个英文单词或`1.5`个中文字符。设置合适的`max_tokens`可以控制响应长度和成本，避免过长的输出。如果模型在达到`max_tokens`限制前完成回答，会自然结束；如果达到限制，输出可能被截断。 默认值和最大值等更多详见 [max\_tokens 文档](/cn/guide/start/concept-param#max_tokens)

Required range: `1 <= x <= 131072`

Example:

`1024`

[​

](#body-tool-stream)

tool\_stream

boolean

是否开启流式响应`Function Calls`，仅限`GLM-4.6`支持此参数。

[​

](#body-tools)

tools

Function Call · object\[\]Retrieval · object\[\]Web Search · object\[\]MCP · object\[\]

模型可以调用的工具列表。支持函数调用、知识库检索和网络搜索。使用此参数提供模型可以生成 `JSON` 输入的函数列表或配置其他工具。最多支持 `128` 个函数。目前 `GLM-4` 系列已支持所有 `tools`，`GLM-4.5` 已支持 `web search` 和 `retrieval`。

Hide child attributes

[​

](#body-tools-type)

type

enum<string>

default:function

required

Available options:

`function`

[​

](#body-tools-function)

function

object

required

Hide child attributes

[​

](#body-function-name)

function.name

string

required

要调用的函数名称。必须是 `a-z、A-Z、0-9`，或包含下划线和破折号，最大长度为 `64`。

Required string length: `1 - 64`

[​

](#body-function-description)

function.description

string

required

函数功能的描述，供模型选择何时以及如何调用函数。

[​

](#body-function-parameters)

function.parameters

object

required

使用 `JSON Schema` 定义的参数。必须传递 `JSON Schema` 对象以准确定义接受的参数。如果调用函数时不需要参数，则省略。

[​

](#body-tool-choice)

tool\_choice

enum<string>

控制模型如何选择工具。 用于控制模型选择调用哪个函数的方式，仅在工具类型为`function`时补充。默认`auto`且仅支持`auto`。

Available options:

`auto`

[​

](#body-stop)

stop

string\[\]

停止词列表，当模型生成的文本中遇到这些指定的字符串时会立即停止生成。目前仅支持单个停止词，格式为\["stop\_word1"\]。停止词不会包含在返回的文本中。这对于控制输出格式、防止模型生成不需要的内容非常有用，例如在对话场景中可以设置\["Human:"\]来防止模型模拟用户发言。

Maximum length: `1`

[​

](#body-response-format)

response\_format

object

指定模型的响应输出格式，默认为`text`，仅文本模型支持此字段。支持两种格式：{ "type": "text" } 表示普通文本输出模式，模型返回自然语言文本；{ "type": "json\_object" } 表示`JSON`输出模式，模型会返回有效的`JSON`格式数据，适用于结构化数据提取、`API`响应生成等场景。使用`JSON`模式时，建议在提示词中明确说明需要`JSON`格式输出。

Hide child attributes

[​

](#body-response-format-type)

response\_format.type

enum<string>

default:text

required

输出格式类型：`text`表示普通文本输出，`json_object`表示`JSON`格式输出

Available options:

`text`,

`json_object`

[​

](#body-request-id)

request\_id

string

请求唯一标识符。由用户端传递，建议使用`UUID`格式确保唯一性，若未提供平台将自动生成。

[​

](#body-user-id)

user\_id

string

终端用户的唯一标识符。`ID`长度要求：最少`6`个字符，最多`128`个字符，建议使用不包含敏感信息的唯一标识。

Required string length: `6 - 128`

#### Response

200

application/json

业务处理成功

[​

](#response-id)

id

string

任务 `ID`

[​

](#response-request-id)

request\_id

string

请求 `ID`

[​

](#response-created)

created

integer

请求创建时间，`Unix` 时间戳（秒）

[​

](#response-model)

model

string

模型名称

[​

](#response-choices)

choices

object\[\]

模型响应列表

Hide child attributes

[​

](#response-choices-index)

index

integer

结果索引

[​

](#response-choices-message)

message

object

Hide child attributes

[​

](#response-message-role)

message.role

string

当前对话角色，默认为 `assistant`

Example:

`"assistant"`

[​

](#response-message-content)

message.content

Option 1 · string | nullOption 2 · object\[\] | nullOption 3 · string | null

当前对话文本内容。如果调用函数则为 `null`，否则返回推理结果。 对于`GLM-Z1`系列模型，返回内容可能包含思考过程标签 `<think> </think>`。 对于`GLM-4.5V`系列模型，返回内容可能包含思考过程标签 `<think> </think>`，文本边界标签 `<|begin_of_box|> <|end_of_box|>`。

[​

](#response-message-reasoning-content)

message.reasoning\_content

string

思维链内容，仅在使用 `glm-4.5` 系列, `glm-4.1v-thinking` 系列模型时返回。对于 `GLM-Z1` 系列模型，思考过程会直接在 `content` 字段中的 `<think>` 标签中返回。

[​

](#response-message-audio)

message.audio

object

当使用 `glm-4-voice` 模型时返回的音频内容

Hide child attributes

[​

](#response-message-audio-id)

message.audio.id

string

当前对话的音频内容`id`，可用于多轮对话输入

[​

](#response-message-audio-data)

message.audio.data

string

当前对话的音频内容`base64`编码

[​

](#response-message-audio-expires-at)

message.audio.expires\_at

string

当前对话的音频内容过期时间

[​

](#response-message-tool-calls)

message.tool\_calls

object\[\]

生成的应该被调用的函数名称和参数。

Hide child attributes

[​

](#response-message-tool-calls-function)

function

object

包含生成的函数名称和 `JSON` 格式参数。

Hide child attributes

[​

](#response-function-name)

function.name

string

required

生成的函数名称。

[​

](#response-function-arguments)

function.arguments

object

required

生成的函数调用参数的 `JSON` 格式。调用函数前请验证参数。

[​

](#response-message-tool-calls-mcp)

mcp

object

`MCP` 工具调用参数

Hide child attributes

[​

](#response-mcp-id)

mcp.id

string

`mcp` 工具调用唯一标识

[​

](#response-mcp-type)

mcp.type

enum<string>

工具调用类型, 例如 `mcp_list_tools, mcp_call`

Available options:

`mcp_list_tools`,

`mcp_call`

[​

](#response-mcp-server-label)

mcp.server\_label

string

`MCP`服务器标签

[​

](#response-mcp-error)

mcp.error

string

错误信息

[​

](#response-mcp-tools)

mcp.tools

object\[\]

`type = mcp_list_tools` 时的工具列表

Hide child attributes

[​

](#response-mcp-tools-name)

name

string

工具名称

[​

](#response-mcp-tools-description)

description

string

工具描述

[​

](#response-mcp-tools-annotations)

annotations

object

工具注解

[​

](#response-mcp-tools-input-schema)

input\_schema

object

工具输入参数规范

Hide child attributes

[​

](#response-input-schema-type)

input\_schema.type

enum<string>

default:object

固定值 'object'

Available options:

`object`

[​

](#response-input-schema-properties)

input\_schema.properties

object

参数属性定义

[​

](#response-input-schema-required)

input\_schema.required

string\[\]

必填属性列表

[​

](#response-input-schema-additional-properties)

input\_schema.additionalProperties

boolean

是否允许额外参数

[​

](#response-mcp-arguments)

mcp.arguments

string

工具调用参数，参数为 `json` 字符串

[​

](#response-mcp-name)

mcp.name

string

工具名称

[​

](#response-mcp-output)

mcp.output

object

工具返回的结果输出

[​

](#response-message-tool-calls-id)

id

string

命中函数的唯一标识符。

[​

](#response-message-tool-calls-type)

type

string

调用的工具类型，目前仅支持 'function', 'mcp'。

[​

](#response-choices-finish-reason)

finish\_reason

string

推理终止原因。'stop’表示自然结束或触发stop词，'tool\_calls’表示模型命中函数，'length’表示达到token长度限制，'sensitive’表示内容被安全审核接口拦截（用户应判断并决定是否撤回公开内容），'network\_error’表示模型推理异常。

[​

](#response-usage)

usage

object

调用结束时返回的 `Token` 使用统计。

Hide child attributes

[​

](#response-usage-prompt-tokens)

usage.prompt\_tokens

number

用户输入的 `Token` 数量。

[​

](#response-usage-completion-tokens)

usage.completion\_tokens

number

输出的 `Token` 数量

[​

](#response-usage-prompt-tokens-details)

usage.prompt\_tokens\_details

object

Hide child attributes

[​

](#response-usage-prompt-tokens-details-cached-tokens)

usage.prompt\_tokens\_details.cached\_tokens

number

命中的缓存 `Token` 数量

[​

](#response-usage-total-tokens)

usage.total\_tokens

integer

`Token` 总数，对于 `glm-4-voice` 模型，`1`秒音频=`12.5 Tokens`，向上取整

[​

](#response-video-result)

video\_result

object\[\]

视频生成结果。

Hide child attributes

[​

](#response-video-result-url)

url

string

视频链接。

[​

](#response-video-result-cover-image-url)

cover\_image\_url

string

视频封面链接。

[​

](#response-web-search)

web\_search

object\[\]

返回与网页搜索相关的信息，使用`WebSearchToolSchema`时返回

Hide child attributes

[​

](#response-web-search-icon)

icon

string

来源网站的图标

[​

](#response-web-search-title)

title

string

搜索结果的标题

[​

](#response-web-search-link)

link

string

搜索结果的网页链接

[​

](#response-web-search-media)

media

string

搜索结果网页的媒体来源名称

[​

](#response-web-search-publish-date)

publish\_date

string

网站发布时间

[​

](#response-web-search-content)

content

string

搜索结果网页引用的文本内容

[​

](#response-web-search-refer)

refer

string

角标序号

[​

](#response-content-filter)

content\_filter

object\[\]

返回内容安全的相关信息

Hide child attributes

[​

](#response-content-filter-role)

role

string

安全生效环节，包括 `role = assistant` 模型推理，`role = user` 用户输入，`role = history` 历史上下文

[​

](#response-content-filter-level)

level

integer

严重程度 `level 0-3`，`level 0`表示最严重，`3`表示轻微

[错误码](/cn/api/api-code)[对话补全(异步)](/api-reference/模型-api/对话补全异步)

[Powered by Mintlify](https://mintlify.com?utm_campaign=poweredBy&utm_medium=referral&utm_source=zhipu-ef7018ed)

Assistant

Responses are generated using AI and may contain mistakes.

(self.\_\_next\_f=self.\_\_next\_f||\[\]).push(\[0\])self.\_\_next\_f.push(\[1,"1:\\"$Sreact.fragment\\"\\n2:I\[47132,\[\],\\"\\"\]\\n3:I\[55983,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"4518\\",\\"static/chunks/4518-b0a96e1f34946e18.js\\",\\"8039\\",\\"static/chunks/app/error-c71fdcf240936e31.js\\"\],\\"default\\",1\]\\n4:I\[75082,\[\],\\"\\"\]\\n"\])self.\_\_next\_f.push(\[1,"5:I\[85506,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"803\\",\\"static/chunks/cd24890f-e1794187b185fa8f.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"5157\\",\\"static/chunks/5157-873f9d3c1759de0b.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"7728\\",\\"static/chunks/7728-26bf4c4a9d26d130.js\\",\\"5456\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/layout-e62e55538b1b942e.js\\"\],\\"ThemeProvider\\"\]\\n"\])self.\_\_next\_f.push(\[1,"6:I\[89481,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"2967\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/not-found-c7a60708c9552ed1.js\\"\],\\"RecommendedPagesList\\"\]\\n11:I\[71256,\[\],\\"\\"\]\\n:HL\[\\"/mintlify-assets/\_next/static/media/bb3ef058b751a6ad-s.p.woff2\\",\\"font\\",{\\"crossOrigin\\":\\"\\",\\"type\\":\\"font/woff2\\"}\]\\n:HL\[\\"/mintlify-assets/\_next/static/media/e4af272ccee01ff0-s.p.woff2\\",\\"font\\",{\\"crossOrigin\\":\\"\\",\\"type\\":\\"font/woff2\\"}\]\\n:HL\[\\"/mintlify-assets/\_next/static/css/6dcf705974f06398.css\\",\\"style\\"\]\\n:HL\[\\"/mintlify-assets/\_next/static/css/d910ce6c26d880b3.css\\",\\"style\\"\]\\n:HL\[\\"/mintlify-assets/\_next/static/css/2a2041dd309ddd5a.css\\",\\"style\\"\]\\n"\])self.\_\_next\_f.push(\[1,"0:{\\"P\\":null,\\"b\\":\\"bBhHbCvVZb8Zd8RD0DDYB\\",\\"p\\":\\"/mintlify-assets\\",\\"c\\":\[\\"\\",\\"\_sites\\",\\"zhipu-ef7018ed\\",\\"api-reference\\",\\"%E6%A8%A1%E5%9E%8B-api\\",\\"%E5%AF%B9%E8%AF%9D%E8%A1%A5%E5%85%A8\\"\],\\"i\\":false,\\"f\\":\[\[\[\\"\\",{\\"children\\":\[\\"%5Fsites\\",{\\"children\\":\[\[\\"subdomain\\",\\"zhipu-ef7018ed\\",\\"d\\"\],{\\"children\\":\[\\"(multitenant)\\",{\\"topbar\\":\[\\"children\\",{\\"children\\":\[\[\\"slug\\",\\"api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%AF%B9%E8%AF%9D%E8%A1%A5%E5%85%A8\\",\\"oc\\"\],{\\"children\\":\[\\"\_\_PAGE\_\_\\",{}\]}\]}\],\\"children\\":\[\[\\"slug\\",\\"api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%AF%B9%E8%AF%9D%E8%A1%A5%E5%85%A8\\",\\"oc\\"\],{\\"children\\":\[\\"\_\_PAGE\_\_\\",{}\]}\]}\]}\]}\]},\\"$undefined\\",\\"$undefined\\",true\],\[\\"\\",\[\\"$\\",\\"$1\\",\\"c\\",{\\"children\\":\[\[\[\\"$\\",\\"link\\",\\"0\\",{\\"rel\\":\\"stylesheet\\",\\"href\\":\\"/mintlify-assets/\_next/static/css/6dcf705974f06398.css\\",\\"precedence\\":\\"next\\",\\"crossOrigin\\":\\"$undefined\\",\\"nonce\\":\\"$undefined\\"}\],\[\\"$\\",\\"link\\",\\"1\\",{\\"rel\\":\\"stylesheet\\",\\"href\\":\\"/mintlify-assets/\_next/static/css/d910ce6c26d880b3.css\\",\\"precedence\\":\\"next\\",\\"crossOrigin\\":\\"$undefined\\",\\"nonce\\":\\"$undefined\\"}\]\],\[\\"$\\",\\"html\\",null,{\\"suppressHydrationWarning\\":true,\\"lang\\":\\"en\\",\\"className\\":\\"\_\_variable\_8c6b06 \_\_variable\_3bbdad dark\\",\\"data-banner-state\\":\\"visible\\",\\"data-page-mode\\":\\"none\\",\\"children\\":\[\[\\"$\\",\\"head\\",null,{\\"children\\":\[\[\\"$\\",\\"script\\",null,{\\"type\\":\\"text/javascript\\",\\"dangerouslySetInnerHTML\\":{\\"\_\_html\\":\\"(function(a,b,c){try{let d=localStorage.getItem(a);if(null==d)for(let c=0;c\\u003clocalStorage.length;c++){let e=localStorage.key(c);if(e?.endsWith(\`-${b}\`)\\u0026\\u0026(d=localStorage.getItem(e),null!=d)){localStorage.setItem(a,d),localStorage.setItem(e,d);break}}let e=document.getElementById(\\\\\\"banner\\\\\\")?.innerText,f=null==d||!!e\\u0026\\u0026d!==e;document.documentElement.setAttribute(c,f?\\\\\\"visible\\\\\\":\\\\\\"hidden\\\\\\")}catch(a){console.error(a),document.documentElement.setAttribute(c,\\\\\\"hidden\\\\\\")}})(\\\\n \\\\\\"\_\_mintlify-bannerDismissed\\\\\\",\\\\n \\\\\\"bannerDismissed\\\\\\",\\\\n \\\\\\"data-banner-state\\\\\\",\\\\n)\\"}}\],\[\\"$\\",\\"link\\",null,{\\"rel\\":\\"preload\\",\\"href\\":\\"https://d4tuoctqmanu0.cloudfront.net/katex.min.css\\",\\"as\\":\\"style\\"}\],\[\\"$\\",\\"script\\",null,{\\"type\\":\\"text/javascript\\",\\"children\\":\\"\\\\n document.addEventListener('DOMContentLoaded', () =\\u003e {\\\\n const link = document.querySelector('link\[href=\\\\\\"https://d4tuoctqmanu0.cloudfront.net/katex.min.css\\\\\\"\]');\\\\n link.rel = 'stylesheet';\\\\n });\\\\n \\"}\]\]}\],\[\\"$\\",\\"body\\",null,{\\"children\\":\[\[\\"$\\",\\"$L2\\",null,{\\"parallelRouterKey\\":\\"children\\",\\"error\\":\\"$3\\",\\"errorStyles\\":\[\],\\"errorScripts\\":\[\],\\"template\\":\[\\"$\\",\\"$L4\\",null,{}\],\\"templateStyles\\":\\"$undefined\\",\\"templateScripts\\":\\"$undefined\\",\\"notFound\\":\[\[\\"$\\",\\"$L5\\",null,{\\"children\\":\[\[\\"$\\",\\"style\\",null,{\\"children\\":\\":root {\\\\n --primary: 22 163 74;\\\\n --primary-light: 74 222 128;\\\\n --primary-dark: 22 101 52;\\\\n --background-light: 255 255 255;\\\\n --background-dark: 10 13 13;\\\\n --gray-50: 243 247 245;\\\\n --gray-100: 238 242 240;\\\\n --gray-200: 223 227 224;\\\\n --gray-300: 206 211 208;\\\\n --gray-400: 159 163 160;\\\\n --gray-500: 112 116 114;\\\\n --gray-600: 80 84 82;\\\\n --gray-700: 63 67 64;\\\\n --gray-800: 38 42 39;\\\\n --gray-900: 23 27 25;\\\\n --gray-950: 10 15 12;\\\\n }\\"}\],null,null,\[\\"$\\",\\"style\\",null,{\\"children\\":\\":root {\\\\n --primary: 17 120 102;\\\\n --primary-light: 74 222 128;\\\\n --primary-dark: 22 101 52;\\\\n --background-light: 255 255 255;\\\\n --background-dark: 15 17 23;\\\\n}\\"}\],\[\\"$\\",\\"main\\",null,{\\"className\\":\\"h-screen bg-background-light dark:bg-background-dark text-left\\",\\"children\\":\[\\"$\\",\\"article\\",null,{\\"className\\":\\"bg-custom bg-fixed bg-center bg-cover relative flex flex-col items-center justify-center h-full\\",\\"children\\":\[\\"$\\",\\"div\\",null,{\\"className\\":\\"w-full max-w-xl px-10\\",\\"children\\":\[\[\\"$\\",\\"span\\",null,{\\"className\\":\\"inline-flex mb-6 rounded-full px-3 py-1 text-sm font-semibold mr-4 text-white p-1 bg-primary\\",\\"children\\":\[\\"Error \\",404\]}\],\[\\"$\\",\\"h1\\",null,{\\"className\\":\\"font-semibold mb-3 text-3xl\\",\\"children\\":\\"Page not found!\\"}\],\[\\"$\\",\\"p\\",null,{\\"className\\":\\"text-lg text-gray-600 dark:text-gray-400 mb-6\\",\\"children\\":\\"We couldn't find the page you were looking for\\"}\],\[\\"$\\",\\"$L6\\",null,{}\]\]}\]}\]}\]\]}\],\[\]\],\\"forbidden\\":\\"$undefined\\",\\"unauthorized\\":\\"$undefined\\"}\],\\"$L7\\"\]}\]\]}\]\]}\],{\\"children\\":\[\\"%5Fsites\\",\\"$L8\\",{\\"children\\":\[\[\\"subdomain\\",\\"zhipu-ef7018ed\\",\\"d\\"\],\\"$L9\\",{\\"children\\":\[\\"(multitenant)\\",\\"$La\\",{\\"topbar\\":\[\\"children\\",\\"$Lb\\",{\\"children\\":\[\[\\"slug\\",\\"api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%AF%B9%E8%AF%9D%E8%A1%A5%E5%85%A8\\",\\"oc\\"\],\\"$Lc\\",{\\"children\\":\[\\"\_\_PAGE\_\_\\",\\"$Ld\\",{},null,false\]},null,false\]},null,false\],\\"children\\":\[\[\\"slug\\",\\"api-reference/%E6%A8%A1%E5%9E%8B-api/%E5%AF%B9%E8%AF%9D%E8%A1%A5%E5%85%A8\\",\\"oc\\"\],\\"$Le\\",{\\"children\\":\[\\"\_\_PAGE\_\_\\",\\"$Lf\\",{},null,false\]},null,false\]},null,false\]},null,false\]},null,false\]},null,false\],\\"$L10\\",false\]\],\\"m\\":\\"$undefined\\",\\"G\\":\[\\"$11\\",\[\]\],\\"s\\":false,\\"S\\":true}\\n"\])self.\_\_next\_f.push(\[1,"12:I\[81925,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"4518\\",\\"static/chunks/4518-b0a96e1f34946e18.js\\",\\"9249\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/error-af6a71d00b1ffdab.js\\"\],\\"default\\",1\]\\n15:I\[50700,\[\],\\"OutletBoundary\\"\]\\n1a:I\[87748,\[\],\\"AsyncMetadataOutlet\\"\]\\n1c:I\[50700,\[\],\\"ViewportBoundary\\"\]\\n1e:I\[50700,\[\],\\"MetadataBoundary\\"\]\\n1f:\\"$Sreact.suspense\\"\\n7:null\\n8:\[\\"$\\",\\"$1\\",\\"c\\",{\\"children\\":\[null,\[\\"$\\",\\"$L2\\",null,{\\"parallelRouterKey\\":\\"children\\",\\"error\\":\\"$undefined\\",\\"errorStyles\\":\\"$undefined\\",\\"errorScripts\\":\\"$undefined\\",\\"template\\":\[\\"$\\",\\"$L4\\",null,{}\],\\"templateStyles\\":\\"$undefined\\",\\"templateScripts\\":\\"$undefined\\",\\"notFound\\":\\"$undefined\\",\\"forbidden\\":\\"$undefined\\",\\"unauthorized\\":\\"$undefined\\"}\]\]}\]\\n"\])self.\_\_next\_f.push(\[1,"9:\[\\"$\\",\\"$1\\",\\"c\\",{\\"children\\":\[null,\[\\"$\\",\\"$L2\\",null,{\\"parallelRouterKey\\":\\"children\\",\\"error\\":\\"$12\\",\\"errorStyles\\":\[\],\\"errorScripts\\":\[\],\\"template\\":\[\\"$\\",\\"$L4\\",null,{}\],\\"templateStyles\\":\\"$undefined\\",\\"templateScripts\\":\\"$undefined\\",\\"notFound\\":\[\[\\"$\\",\\"$L5\\",null,{\\"children\\":\[\[\\"$\\",\\"style\\",null,{\\"children\\":\\":root {\\\\n --primary: 22 163 74;\\\\n --primary-light: 74 222 128;\\\\n --primary-dark: 22 101 52;\\\\n --background-light: 255 255 255;\\\\n --background-dark: 10 13 13;\\\\n --gray-50: 243 247 245;\\\\n --gray-100: 238 242 240;\\\\n --gray-200: 223 227 224;\\\\n --gray-300: 206 211 208;\\\\n --gray-400: 159 163 160;\\\\n --gray-500: 112 116 114;\\\\n --gray-600: 80 84 82;\\\\n --gray-700: 63 67 64;\\\\n --gray-800: 38 42 39;\\\\n --gray-900: 23 27 25;\\\\n --gray-950: 10 15 12;\\\\n }\\"}\],null,null,\[\\"$\\",\\"style\\",null,{\\"children\\":\\":root {\\\\n --primary: 17 120 102;\\\\n --primary-light: 74 222 128;\\\\n --primary-dark: 22 101 52;\\\\n --background-light: 255 255 255;\\\\n --background-dark: 15 17 23;\\\\n}\\"}\],\[\\"$\\",\\"main\\",null,{\\"className\\":\\"h-screen bg-background-light dark:bg-background-dark text-left\\",\\"children\\":\[\\"$\\",\\"article\\",null,{\\"className\\":\\"bg-custom bg-fixed bg-center bg-cover relative flex flex-col items-center justify-center h-full\\",\\"children\\":\[\\"$\\",\\"div\\",null,{\\"className\\":\\"w-full max-w-xl px-10\\",\\"children\\":\[\[\\"$\\",\\"span\\",null,{\\"className\\":\\"inline-flex mb-6 rounded-full px-3 py-1 text-sm font-semibold mr-4 text-white p-1 bg-primary\\",\\"children\\":\[\\"Error \\",404\]}\],\[\\"$\\",\\"h1\\",null,{\\"className\\":\\"font-semibold mb-3 text-3xl\\",\\"children\\":\\"Page not found!\\"}\],\[\\"$\\",\\"p\\",null,{\\"className\\":\\"text-lg text-gray-600 dark:text-gray-400 mb-6\\",\\"children\\":\\"We couldn't find the page you were looking for\\"}\],\[\\"$\\",\\"$L6\\",null,{}\]\]}\]}\]}\]\]}\],\[\]\],\\"forbidden\\":\\"$undefined\\",\\"unauthorized\\":\\"$undefined\\"}\]\]}\]\\n"\])self.\_\_next\_f.push(\[1,"a:\[\\"$\\",\\"$1\\",\\"c\\",{\\"children\\":\[\[\[\\"$\\",\\"link\\",\\"0\\",{\\"rel\\":\\"stylesheet\\",\\"href\\":\\"/mintlify-assets/\_next/static/css/2a2041dd309ddd5a.css\\",\\"precedence\\":\\"next\\",\\"crossOrigin\\":\\"$undefined\\",\\"nonce\\":\\"$undefined\\"}\]\],\\"$L13\\"\]}\]\\nb:\[\\"$\\",\\"$1\\",\\"c\\",{\\"children\\":\[null,\[\\"$\\",\\"$L2\\",null,{\\"parallelRouterKey\\":\\"children\\",\\"error\\":\\"$undefined\\",\\"errorStyles\\":\\"$undefined\\",\\"errorScripts\\":\\"$undefined\\",\\"template\\":\[\\"$\\",\\"$L4\\",null,{}\],\\"templateStyles\\":\\"$undefined\\",\\"templateScripts\\":\\"$undefined\\",\\"notFound\\":\\"$undefined\\",\\"forbidden\\":\\"$undefined\\",\\"unauthorized\\":\\"$undefined\\"}\]\]}\]\\nc:\[\\"$\\",\\"$1\\",\\"c\\",{\\"children\\":\[null,\[\\"$\\",\\"$L2\\",null,{\\"parallelRouterKey\\":\\"children\\",\\"error\\":\\"$undefined\\",\\"errorStyles\\":\\"$undefined\\",\\"errorScripts\\":\\"$undefined\\",\\"template\\":\[\\"$\\",\\"$L4\\",null,{}\],\\"templateStyles\\":\\"$undefined\\",\\"templateScripts\\":\\"$undefined\\",\\"notFound\\":\\"$undefined\\",\\"forbidden\\":\\"$undefined\\",\\"unauthorized\\":\\"$undefined\\"}\]\]}\]\\nd:\[\\"$\\",\\"$1\\",\\"c\\",{\\"children\\":\[\\"$L14\\",null,\[\\"$\\",\\"$L15\\",null,{\\"children\\":\[\\"$L16\\",\\"$L17\\"\]}\]\]}\]\\ne:\[\\"$\\",\\"$1\\",\\"c\\",{\\"children\\":\[null,\[\\"$\\",\\"$L2\\",null,{\\"parallelRouterKey\\":\\"children\\",\\"error\\":\\"$undefined\\",\\"errorStyles\\":\\"$undefined\\",\\"errorScripts\\":\\"$undefined\\",\\"template\\":\[\\"$\\",\\"$L4\\",null,{}\],\\"templateStyles\\":\\"$undefined\\",\\"templateScripts\\":\\"$undefined\\",\\"notFound\\":\\"$undefined\\",\\"forbidden\\":\\"$undefined\\",\\"unauthorized\\":\\"$undefined\\"}\]\]}\]\\nf:\[\\"$\\",\\"$1\\",\\"c\\",{\\"children\\":\[\\"$L18\\",null,\[\\"$\\",\\"$L15\\",null,{\\"children\\":\[\\"$L19\\",\[\\"$\\",\\"$L1a\\",null,{\\"promise\\":\\"$@1b\\"}\]\]}\]\]}\]\\n10:\[\\"$\\",\\"$1\\",\\"h\\",{\\"children\\":\[null,\[\[\\"$\\",\\"$L1c\\",null,{\\"children\\":\\"$L1d\\"}\],\[\\"$\\",\\"meta\\",null,{\\"name\\":\\"next-size-adjust\\",\\"content\\":\\"\\"}\]\],\[\\"$\\",\\"$L1e\\",null,{\\"children\\":\[\\"$\\",\\"div\\",null,{\\"hidden\\":true,\\"children\\":\[\\"$\\",\\"$1f\\",null,{\\"fallback\\":null,\\"children\\":\\"$L20\\"}\]}\]}\]\]}\]\\n"\])self.\_\_next\_f.push(\[1,"16:null\\n17:null\\n"\])self.\_\_next\_f.push(\[1,"1d:\[\[\\"$\\",\\"meta\\",\\"0\\",{\\"charSet\\":\\"utf-8\\"}\],\[\\"$\\",\\"meta\\",\\"1\\",{\\"name\\":\\"viewport\\",\\"content\\":\\"width=device-width, initial-scale=1\\"}\]\]\\n19:null\\n"\])self.\_\_next\_f.push(\[1,"21:T718,"\])self.\_\_next\_f.push(\[1,"https://zhipu-ef7018ed.mintlify.app/mintlify-assets/\_next/image?url=%2F\_mintlify%2Fapi%2Fog%3Fdivision%3D%25E6%25A8%25A1%25E5%259E%258B%2BAPI%26appearance%3Dlight%26title%3D%25E5%25AF%25B9%25E8%25AF%259D%25E8%25A1%25A5%25E5%2585%25A8%26description%3D%25E5%2592%258C%2B%255B%25E6%258C%2587%25E5%25AE%259A%25E6%25A8%25A1%25E5%259E%258B%255D%2528%252Fcn%252Fguide%252Fstart%252Fmodel-overview%2529%2B%25E5%25AF%25B9%25E8%25AF%259D%25EF%25BC%258C%25E6%25A8%25A1%25E5%259E%258B%25E6%25A0%25B9%25E6%258D%25AE%25E8%25AF%25B7%25E6%25B1%2582%25E7%25BB%2599%25E5%2587%25BA%25E5%2593%258D%25E5%25BA%2594%25E3%2580%2582%25E6%2594%25AF%25E6%258C%2581%25E5%25A4%259A%25E7%25A7%258D%25E6%25A8%25A1%25E5%259E%258B%25EF%25BC%258C%25E6%2594%25AF%25E6%258C%2581%25E5%25A4%259A%25E6%25A8%25A1%25E6%2580%2581%25EF%25BC%2588%25E6%2596%2587%25E6%259C%25AC%25E3%2580%2581%25E5%259B%25BE%25E7%2589%2587%25E3%2580%2581%25E9%259F%25B3%25E9%25A2%2591%25E3%2580%2581%25E8%25A7%2586%25E9%25A2%2591%25E3%2580%2581%25E6%2596%2587%25E4%25BB%25B6%25EF%25BC%2589%25EF%25BC%258C%25E6%25B5%2581%25E5%25BC%258F%25E5%2592%258C%25E9%259D%259E%25E6%25B5%2581%25E5%25BC%258F%25E8%25BE%2593%25E5%2587%25BA%25EF%25BC%258C%25E5%258F%25AF%25E9%2585%258D%25E7%25BD%25AE%25E9%2587%2587%25E6%25A0%25B7%25EF%25BC%258C%25E6%25B8%25A9%25E5%25BA%25A6%25EF%25BC%258C%25E6%259C%2580%25E5%25A4%25A7%25E4%25BB%25A4%25E7%2589%258C%25E6%2595%25B0%25EF%25BC%258C%25E5%25B7%25A5%25E5%2585%25B7%25E8%25B0%2583%25E7%2594%25A8%25E7%25AD%2589%25E3%2580%2582%26logoLight%3Dhttps%253A%252F%252Fcdn.bigmodel.cn%252Fstatic%252Flogo%252Fdark.svg%26logoDark%3Dhttps%253A%252F%252Fcdn.bigmodel.cn%252Fstatic%252Flogo%252Flight.svg%26primaryColor%3D%2523134cff%26lightColor%3D%25239fa0a0%26darkColor%3D%2523134cff%26backgroundLight%3D%2523ffffff%26backgroundDark%3D%25230c0c0e\\u0026w=1200\\u0026q=100"\])self.\_\_next\_f.push(\[1,"22:T718,"\])self.\_\_next\_f.push(\[1,"https://zhipu-ef7018ed.mintlify.app/mintlify-assets/\_next/image?url=%2F\_mintlify%2Fapi%2Fog%3Fdivision%3D%25E6%25A8%25A1%25E5%259E%258B%2BAPI%26appearance%3Dlight%26title%3D%25E5%25AF%25B9%25E8%25AF%259D%25E8%25A1%25A5%25E5%2585%25A8%26description%3D%25E5%2592%258C%2B%255B%25E6%258C%2587%25E5%25AE%259A%25E6%25A8%25A1%25E5%259E%258B%255D%2528%252Fcn%252Fguide%252Fstart%252Fmodel-overview%2529%2B%25E5%25AF%25B9%25E8%25AF%259D%25EF%25BC%258C%25E6%25A8%25A1%25E5%259E%258B%25E6%25A0%25B9%25E6%258D%25AE%25E8%25AF%25B7%25E6%25B1%2582%25E7%25BB%2599%25E5%2587%25BA%25E5%2593%258D%25E5%25BA%2594%25E3%2580%2582%25E6%2594%25AF%25E6%258C%2581%25E5%25A4%259A%25E7%25A7%258D%25E6%25A8%25A1%25E5%259E%258B%25EF%25BC%258C%25E6%2594%25AF%25E6%258C%2581%25E5%25A4%259A%25E6%25A8%25A1%25E6%2580%2581%25EF%25BC%2588%25E6%2596%2587%25E6%259C%25AC%25E3%2580%2581%25E5%259B%25BE%25E7%2589%2587%25E3%2580%2581%25E9%259F%25B3%25E9%25A2%2591%25E3%2580%2581%25E8%25A7%2586%25E9%25A2%2591%25E3%2580%2581%25E6%2596%2587%25E4%25BB%25B6%25EF%25BC%2589%25EF%25BC%258C%25E6%25B5%2581%25E5%25BC%258F%25E5%2592%258C%25E9%259D%259E%25E6%25B5%2581%25E5%25BC%258F%25E8%25BE%2593%25E5%2587%25BA%25EF%25BC%258C%25E5%258F%25AF%25E9%2585%258D%25E7%25BD%25AE%25E9%2587%2587%25E6%25A0%25B7%25EF%25BC%258C%25E6%25B8%25A9%25E5%25BA%25A6%25EF%25BC%258C%25E6%259C%2580%25E5%25A4%25A7%25E4%25BB%25A4%25E7%2589%258C%25E6%2595%25B0%25EF%25BC%258C%25E5%25B7%25A5%25E5%2585%25B7%25E8%25B0%2583%25E7%2594%25A8%25E7%25AD%2589%25E3%2580%2582%26logoLight%3Dhttps%253A%252F%252Fcdn.bigmodel.cn%252Fstatic%252Flogo%252Fdark.svg%26logoDark%3Dhttps%253A%252F%252Fcdn.bigmodel.cn%252Fstatic%252Flogo%252Flight.svg%26primaryColor%3D%2523134cff%26lightColor%3D%25239fa0a0%26darkColor%3D%2523134cff%26backgroundLight%3D%2523ffffff%26backgroundDark%3D%25230c0c0e\\u0026w=1200\\u0026q=100"\])self.\_\_next\_f.push(\[1,"1b:{\\"metadata\\":\[\[\\"$\\",\\"title\\",\\"0\\",{\\"children\\":\\"对话补全 - 智谱AI开放文档\\"}\],\[\\"$\\",\\"meta\\",\\"1\\",{\\"name\\":\\"description\\",\\"content\\":\\"和 \[指定模型\](/cn/guide/start/model-overview) 对话，模型根据请求给出响应。支持多种模型，支持多模态（文本、图片、音频、视频、文件），流式和非流式输出，可配置采样，温度，最大令牌数，工具调用等。\\"}\],\[\\"$\\",\\"meta\\",\\"2\\",{\\"name\\":\\"application-name\\",\\"content\\":\\"智谱AI开放文档\\"}\],\[\\"$\\",\\"meta\\",\\"3\\",{\\"name\\":\\"generator\\",\\"content\\":\\"Mintlify\\"}\],\[\\"$\\",\\"meta\\",\\"4\\",{\\"name\\":\\"msapplication-config\\",\\"content\\":\\"/mintlify-assets/\_mintlify/favicons/zhipu-ef7018ed/uX\_6lYCPLvdOcSdM/\_generated/favicon/browserconfig.xml\\"}\],\[\\"$\\",\\"meta\\",\\"5\\",{\\"name\\":\\"apple-mobile-web-app-title\\",\\"content\\":\\"智谱AI开放文档\\"}\],\[\\"$\\",\\"meta\\",\\"6\\",{\\"name\\":\\"msapplication-TileColor\\",\\"content\\":\\"#134cff\\"}\],\[\\"$\\",\\"meta\\",\\"7\\",{\\"name\\":\\"charset\\",\\"content\\":\\"utf-8\\"}\],\[\\"$\\",\\"meta\\",\\"8\\",{\\"name\\":\\"og:site\_name\\",\\"content\\":\\"智谱AI开放文档\\"}\],\[\\"$\\",\\"link\\",\\"9\\",{\\"rel\\":\\"alternate\\",\\"type\\":\\"application/xml\\",\\"href\\":\\"/sitemap.xml\\"}\],\[\\"$\\",\\"meta\\",\\"10\\",{\\"property\\":\\"og:title\\",\\"content\\":\\"对话补全 - 智谱AI开放文档\\"}\],\[\\"$\\",\\"meta\\",\\"11\\",{\\"property\\":\\"og:description\\",\\"content\\":\\"和 \[指定模型\](/cn/guide/start/model-overview) 对话，模型根据请求给出响应。支持多种模型，支持多模态（文本、图片、音频、视频、文件），流式和非流式输出，可配置采样，温度，最大令牌数，工具调用等。\\"}\],\[\\"$\\",\\"meta\\",\\"12\\",{\\"property\\":\\"og:image\\",\\"content\\":\\"$21\\"}\],\[\\"$\\",\\"meta\\",\\"13\\",{\\"property\\":\\"og:image:width\\",\\"content\\":\\"1200\\"}\],\[\\"$\\",\\"meta\\",\\"14\\",{\\"property\\":\\"og:image:height\\",\\"content\\":\\"630\\"}\],\[\\"$\\",\\"meta\\",\\"15\\",{\\"property\\":\\"og:type\\",\\"content\\":\\"website\\"}\],\[\\"$\\",\\"meta\\",\\"16\\",{\\"name\\":\\"twitter:card\\",\\"content\\":\\"summary\_large\_image\\"}\],\[\\"$\\",\\"meta\\",\\"17\\",{\\"name\\":\\"twitter:title\\",\\"content\\":\\"对话补全 - 智谱AI开放文档\\"}\],\[\\"$\\",\\"meta\\",\\"18\\",{\\"name\\":\\"twitter:description\\",\\"content\\":\\"和 \[指定模型\](/cn/guide/start/model-overview) 对话，模型根据请求给出响应。支持多种模型，支持多模态（文本、图片、音频、视频、文件），流式和非流式输出，可配置采样，温度，最大令牌数，工具调用等。\\"}\],\[\\"$\\",\\"meta\\",\\"19\\",{\\"name\\":\\"twitter:image\\",\\"content\\":\\"$22\\"}\],\\"$L23\\",\\"$L24\\",\\"$L25\\",\\"$L26\\",\\"$L27\\",\\"$L28\\",\\"$L29\\",\\"$L2a\\",\\"$L2b\\",\\"$L2c\\"\],\\"error\\":null,\\"digest\\":\\"$undefined\\"}\\n"\])self.\_\_next\_f.push(\[1,"20:\\"$1b:metadata\\"\\n"\])self.\_\_next\_f.push(\[1,"2d:I\[74780,\[\],\\"IconMark\\"\]\\n"\])self.\_\_next\_f.push(\[1,"2e:I\[44760,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"8788\\",\\"static/chunks/271c4271-94b34610517d5e19.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"7260\\",\\"static/chunks/7260-2f74dac3fc8e4da1.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"5143\\",\\"static/chunks/5143-6dfa098ca16d5b95.js\\",\\"1398\\",\\"static/chunks/1398-3f18b33a9f298cda.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"2820\\",\\"static/chunks/2820-a1a77459d2af49c8.js\\",\\"9841\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/%5B%5B...slug%5D%5D/page-7b8c58820341dd2a.js\\"\],\\"\\"\]\\n"\])self.\_\_next\_f.push(\[1,"2f:I\[63792,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"803\\",\\"static/chunks/cd24890f-e1794187b185fa8f.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"5157\\",\\"static/chunks/5157-873f9d3c1759de0b.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"7728\\",\\"static/chunks/7728-26bf4c4a9d26d130.js\\",\\"5456\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/layout-e62e55538b1b942e.js\\"\],\\"default\\"\]\\n"\])self.\_\_next\_f.push(\[1,"30:I\[71197,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"8788\\",\\"static/chunks/271c4271-94b34610517d5e19.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"7260\\",\\"static/chunks/7260-2f74dac3fc8e4da1.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"5143\\",\\"static/chunks/5143-6dfa098ca16d5b95.js\\",\\"1398\\",\\"static/chunks/1398-3f18b33a9f298cda.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"2820\\",\\"static/chunks/2820-a1a77459d2af49c8.js\\",\\"9841\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/%5B%5B...slug%5D%5D/page-7b8c58820341dd2a.js\\"\],\\"AuthProvider\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"31:I\[71197,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"8788\\",\\"static/chunks/271c4271-94b34610517d5e19.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"7260\\",\\"static/chunks/7260-2f74dac3fc8e4da1.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"5143\\",\\"static/chunks/5143-6dfa098ca16d5b95.js\\",\\"1398\\",\\"static/chunks/1398-3f18b33a9f298cda.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"2820\\",\\"static/chunks/2820-a1a77459d2af49c8.js\\",\\"9841\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/%5B%5B...slug%5D%5D/page-7b8c58820341dd2a.js\\"\],\\"DeploymentMetadataProvider\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"32:I\[71197,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"8788\\",\\"static/chunks/271c4271-94b34610517d5e19.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"7260\\",\\"static/chunks/7260-2f74dac3fc8e4da1.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"5143\\",\\"static/chunks/5143-6dfa098ca16d5b95.js\\",\\"1398\\",\\"static/chunks/1398-3f18b33a9f298cda.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"2820\\",\\"static/chunks/2820-a1a77459d2af49c8.js\\",\\"9841\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/%5B%5B...slug%5D%5D/page-7b8c58820341dd2a.js\\"\],\\"DocsConfigProvider\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"23:\[\\"$\\",\\"meta\\",\\"20\\",{\\"name\\":\\"twitter:image:width\\",\\"content\\":\\"1200\\"}\]\\n24:\[\\"$\\",\\"meta\\",\\"21\\",{\\"name\\":\\"twitter:image:height\\",\\"content\\":\\"630\\"}\]\\n25:\[\\"$\\",\\"link\\",\\"22\\",{\\"rel\\":\\"apple-touch-icon\\",\\"href\\":\\"/mintlify-assets/\_mintlify/favicons/zhipu-ef7018ed/uX\_6lYCPLvdOcSdM/\_generated/favicon/apple-touch-icon.png\\",\\"type\\":\\"image/png\\",\\"sizes\\":\\"180x180\\",\\"media\\":\\"$undefined\\"}\]\\n26:\[\\"$\\",\\"link\\",\\"23\\",{\\"rel\\":\\"icon\\",\\"href\\":\\"/mintlify-assets/\_mintlify/favicons/zhipu-ef7018ed/uX\_6lYCPLvdOcSdM/\_generated/favicon/favicon-16x16.png\\",\\"type\\":\\"image/png\\",\\"sizes\\":\\"16x16\\",\\"media\\":\\"(prefers-color-scheme: light)\\"}\]\\n27:\[\\"$\\",\\"link\\",\\"24\\",{\\"rel\\":\\"icon\\",\\"href\\":\\"/mintlify-assets/\_mintlify/favicons/zhipu-ef7018ed/uX\_6lYCPLvdOcSdM/\_generated/favicon/favicon-32x32.png\\",\\"type\\":\\"image/png\\",\\"sizes\\":\\"32x32\\",\\"media\\":\\"(prefers-color-scheme: light)\\"}\]\\n28:\[\\"$\\",\\"link\\",\\"25\\",{\\"rel\\":\\"shortcut icon\\",\\"href\\":\\"/mintlify-assets/\_mintlify/favicons/zhipu-ef7018ed/uX\_6lYCPLvdOcSdM/\_generated/favicon/favicon.ico\\",\\"type\\":\\"image/x-icon\\",\\"sizes\\":\\"$undefined\\",\\"media\\":\\"(prefers-color-scheme: light)\\"}\]\\n29:\[\\"$\\",\\"link\\",\\"26\\",{\\"rel\\":\\"icon\\",\\"href\\":\\"/mintlify-assets/\_mintlify/favicons/zhipu-ef7018ed/uX\_6lYCPLvdOcSdM/\_generated/favicon-dark/favicon-16x16.png\\",\\"type\\":\\"image/png\\",\\"sizes\\":\\"16x16\\",\\"media\\":\\"(prefers-color-scheme: dark)\\"}\]\\n2a:\[\\"$\\",\\"link\\",\\"27\\",{\\"rel\\":\\"icon\\",\\"href\\":\\"/mintlify-assets/\_mintlify/favicons/zhipu-ef7018ed/uX\_6lYCPLvdOcSdM/\_generated/favicon-dark/favicon-32x32.png\\",\\"type\\":\\"image/png\\",\\"sizes\\":\\"32x32\\",\\"media\\":\\"(prefers-color-scheme: dark)\\"}\]\\n2b:\[\\"$\\",\\"link\\",\\"28\\",{\\"rel\\":\\"shortcut icon\\",\\"href\\":\\"/mintlify-assets/\_mintlify/favicons/zhipu-ef7018ed/uX\_6lYCPLvdOcSdM/\_generated/favicon-dark/favicon.ico\\",\\"type\\":\\"image/x-icon\\",\\"sizes\\":\\"$undefined\\",\\"media\\":\\"(prefers-color-scheme: dark)\\"}\]\\n2c:\[\\"$\\",\\"$L2d\\",\\"29\\",{}\]\\n"\])self.\_\_next\_f.push(\[1,"13:\[\\"$\\",\\"$L5\\",null,{\\"appearance\\":{\\"default\\":\\"light\\",\\"strict\\":false},\\"children\\":\[false,\[\\"$\\",\\"$L2e\\",null,{\\"id\\":\\"\_mintlify-banner-script\\",\\"strategy\\":\\"beforeInteractive\\",\\"dangerouslySetInnerHTML\\":{\\"\_\_html\\":\\"(function m(a,b,c,d){try{let e=document.getElementById(\\\\\\"banner\\\\\\"),f=e?.innerText;if(!f)return void document.documentElement.setAttribute(d,\\\\\\"hidden\\\\\\");let g=localStorage.getItem(a),h=g!==f\\u0026\\u0026g!==b;null!=g\\u0026\\u0026(h?(localStorage.removeItem(c),localStorage.removeItem(a)):(localStorage.setItem(c,b),localStorage.setItem(a,b))),document.documentElement.setAttribute(d,!g||h?\\\\\\"visible\\\\\\":\\\\\\"hidden\\\\\\")}catch(a){console.error(a),document.documentElement.setAttribute(d,\\\\\\"hidden\\\\\\")}})(\\\\n \\\\\\"zhipu-ef7018ed-bannerDismissed\\\\\\",\\\\n \\\\\\"🚀 \*\*GLM-4.6 代码编程专享计划\*\* • \[限时优惠 Coding Plan ➞\](https://bigmodel.cn/claude-code?utm\_source=bigModel\\u0026utm\_medium=Frontend%20Group\\u0026utm\_content=glm%20code\\u0026utm\_campaign=Platform\_Ops\\u0026\_channel\_track\_key=WW2t6PJI)\\\\\\",\\\\n \\\\\\"\_\_mintlify-bannerDismissed\\\\\\",\\\\n \\\\\\"data-banner-state\\\\\\",\\\\n)\\"}}\],\[\\"$\\",\\"$L2f\\",null,{\\"appId\\":\\"$undefined\\",\\"autoBoot\\":true,\\"children\\":\[\\"$\\",\\"$L30\\",null,{\\"value\\":{\\"auth\\":\\"$undefined\\",\\"userAuth\\":\\"$undefined\\"},\\"children\\":\[\\"$\\",\\"$L31\\",null,{\\"value\\":{\\"subdomain\\":\\"zhipu-ef7018ed\\",\\"actualSubdomain\\":\\"zhipu-ef7018ed\\",\\"gitSource\\":{\\"type\\":\\"github\\",\\"owner\\":\\"metaglm\\",\\"repo\\":\\"devbook\\",\\"deployBranch\\":\\"main\\",\\"contentDirectory\\":\\"\\",\\"isPrivate\\":true},\\"inkeep\\":\\"$undefined\\",\\"trieve\\":{\\"datasetId\\":\\"a0b7a44b-5a33-4d25-ba0f-6f971b94e7b1\\"},\\"feedback\\":{\\"thumbs\\":false},\\"entitlements\\":{\\"AI\_CHAT\\":{\\"status\\":\\"DISABLED\\"}},\\"buildId\\":\\"68dcebf53a4911e543084a47:success\\",\\"clientVersion\\":\\"0.0.1799\\",\\"preview\\":\\"$undefined\\"},\\"children\\":\[\\"$\\",\\"$L32\\",null,{\\"value\\":{\\"mintConfig\\":\\"$undefined\\",\\"docsConfig\\":{\\"theme\\":\\"mint\\",\\"$schema\\":\\"https://mintlify.com/docs.json\\",\\"name\\":\\"智谱AI开放文档\\",\\"description\\":\\"Z智谱AI开放平台开发者文档中心\\",\\"colors\\":{\\"primary\\":\\"#134cff\\",\\"light\\":\\"#9fa0a0\\",\\"dark\\":\\"#134cff\\"},\\"logo\\":{\\"light\\":\\"https://cdn.bigmodel.cn/static/logo/dark.svg\\",\\"dark\\":\\"https://cdn.bigmodel.cn/static/logo/light.svg\\",\\"href\\":\\"https://bigmodel.cn/\\"},\\"favicon\\":\\"/resource/favicon.ico\\",\\"api\\":{\\"openapi\\":{\\"source\\":\\"openapi/openapi.json\\",\\"directory\\":\\"openapi\\"},\\"params\\":{\\"expanded\\":\\"all\\"},\\"playground\\":{\\"display\\":\\"interactive\\",\\"proxy\\":false},\\"examples\\":{\\"defaults\\":\\"all\\",\\"languages\\":\[\\"curl\\",\\"python\\",\\"javascript\\",\\"java\\",\\"go\\",\\"php\\"\]}},\\"appearance\\":\\"$13:props:appearance\\",\\"navbar\\":{\\"links\\":\[{\\"label\\":\\"控制台\\",\\"href\\":\\"https://bigmodel.cn/console/overview\\"},{\\"label\\":\\"财务\\",\\"href\\":\\"https://bigmodel.cn/finance/overview\\"},{\\"label\\":\\"个人中心\\",\\"href\\":\\"https://bigmodel.cn/usercenter/settings/account\\"}\]},\\"navigation\\":{\\"tabs\\":\[{\\"tab\\":\\"使用指南\\",\\"pages\\":\[{\\"group\\":\\"开始使用\\",\\"pages\\":\[\\"cn/guide/start/introduction\\",\\"cn/guide/start/model-overview\\",\\"cn/guide/start/quick-start\\",\\"cn/guide/start/concept-param\\",{\\"group\\":\\"开发指南\\",\\"pages\\":\[\\"cn/guide/develop/http/introduction\\",\\"cn/guide/develop/python/introduction\\",\\"cn/guide/develop/java/introduction\\",\\"cn/guide/develop/claude/introduction\\",\\"cn/guide/develop/openai/introduction\\",\\"cn/guide/develop/langchain/introduction\\"\]}\]},{\\"group\\":\\"模型介绍\\",\\"pages\\":\[{\\"group\\":\\"文本模型\\",\\"pages\\":\[\\"cn/guide/models/text/glm-4.6\\",\\"cn/guide/models/text/glm-4.5\\",\\"cn/guide/models/text/glm-4\\",\\"cn/guide/models/text/glm-z1\\"\]},{\\"group\\":\\"视觉理解模型\\",\\"pages\\":\[\\"cn/guide/models/vlm/glm-4.5v\\",\\"cn/guide/models/vlm/glm-4.1v-thinking\\",\\"cn/guide/models/vlm/glm-4v-plus-0111\\"\]},{\\"group\\":\\"图像生成模型\\",\\"pages\\":\[\\"cn/guide/models/image-generation/cogview-4\\"\]},{\\"group\\":\\"视频生成模型\\",\\"pages\\":\[\\"cn/guide/models/video-generation/cogvideox-3\\",\\"cn/guide/models/video-generation/cogvideox-2\\",\\"cn/guide/models/video-generation/viduq1\\",\\"cn/guide/models/video-generation/vidu2\\"\]},{\\"group\\":\\"音视频模型\\",\\"pages\\":\[\\"cn/guide/models/sound-and-video/cogtts\\",\\"cn/guide/models/sound-and-video/glm-realtime\\",\\"cn/guide/models/sound-and-video/glm-4-voice\\",\\"cn/guide/models/sound-and-video/glm-asr\\"\]},{\\"group\\":\\"向量模型\\",\\"pages\\":\[\\"cn/guide/models/embedding/embedding-3\\",\\"cn/guide/models/embedding/embedding-2\\"\]},{\\"group\\":\\"角色模型\\",\\"pages\\":\[\\"cn/guide/models/humanoid/charglm-4\\",\\"cn/guide/models/humanoid/emohaa\\"\]},{\\"group\\":\\"免费模型\\",\\"pages\\":\[\\"cn/guide/models/free/glm-4.5-flash\\",\\"cn/guide/models/free/glm-4.1v-thinking-flash\\",\\"cn/guide/models/free/glm-4-flash-250414\\",\\"cn/guide/models/free/glm-4v-flash\\",\\"cn/guide/models/free/glm-z1-flash\\",\\"cn/guide/models/free/cogview-3-flash\\",\\"cn/guide/models/free/cogvideox-flash\\"\]}\]},{\\"group\\":\\"模型工具\\",\\"pages\\":\[\\"cn/guide/tools/web-search\\",\\"cn/guide/tools/function-calling\\",\\"cn/guide/tools/retrieval\\",\\"cn/guide/tools/model-deploy\\",\\"cn/guide/tools/fine-tuning\\",\\"cn/guide/tools/evaluation\\",\\"cn/guide/tools/batch\\",{\\"group\\":\\"文件解析\\",\\"pages\\":\[\\"cn/guide/tools/file-parser\\",\\"cn/guide/tools/file-extract\\"\]},\\"cn/guide/tools/json-mode\\",\\"cn/guide/tools/stream-tool\\"\]},{\\"group\\":\\"智能体\\",\\"pages\\":\[{\\"group\\":\\"语言翻译\\",\\"pages\\":\[\\"cn/guide/agents/translation\\",\\"cn/guide/agents/documenttranslation\\",\\"cn/guide/agents/film\\",\\"cn/guide/agents/social\\",\\"cn/guide/agents/media\\"\]},{\\"group\\":\\"内容生成\\",\\"pages\\":\[\\"cn/guide/agents/aidrawing\\",\\"cn/guide/agents/aicaricature\\",\\"cn/guide/agents/specialeffectsvideos\\"\]},{\\"group\\":\\"办公效能\\",\\"pages\\":\[\\"cn/guide/agents/glm-ppt\\",\\"cn/guide/agents/job\\",\\"cn/guide/agents/customer\\",\\"cn/guide/agents/sale\\"\]},{\\"group\\":\\"信息提取\\",\\"pages\\":\[\\"cn/guide/agents/winningbidder\\",\\"cn/guide/agents/tender\\",\\"cn/guide/agents/contract\\",\\"cn/guide/agents/clothes\\",\\"cn/guide/agents/bill\\"\]},{\\"group\\":\\"智慧教育\\",\\"pages\\":\[\\"cn/guide/agents/solving\\",\\"cn/guide/agents/homeworkcorrection\\"\]}\]},{\\"group\\":\\"平台服务\\",\\"pages\\":\[\\"cn/guide/platform/intelligent-agent\\",\\"cn/guide/platform/prompt\\",\\"cn/guide/platform/securityaudit\\",\\"cn/guide/platform/model-migration\\",\\"cn/guide/platform/equity-explain\\",\\"cn/guide/platform/filing\\"\]}\]},{\\"tab\\":\\"API 文档\\",\\"pages\\":\[{\\"group\\":\\"API 指引\\",\\"pages\\":\[\\"cn/api/introduction\\",\\"cn/api/api-code\\"\]},{\\"group\\":\\"模型 API\\",\\"pages\\":\[\\"api-reference/模型-api/对话补全\\",\\"api-reference/模型-api/对话补全异步\\",\\"api-reference/模型-api/生成视频异步\\",\\"api-reference/模型-api/查询异步结果\\",\\"api-reference/模型-api/图像生成\\",\\"api-reference/模型-api/语音转文本\\",\\"api-reference/模型-api/文本转语音\\",\\"api-reference/模型-api/音色复刻\\",\\"api-reference/模型-api/音色列表\\",\\"api-reference/模型-api/删除音色\\",\\"api-reference/模型-api/文本嵌入\\",\\"api-reference/模型-api/文本重排序\\",\\"api-reference/模型-api/文本分词器\\"\]},{\\"group\\":\\"工具 API\\",\\"pages\\":\[\\"api-reference/工具-api/网络搜索\\",\\"api-reference/工具-api/内容安全\\",\\"api-reference/工具-api/文件解析\\",\\"api-reference/工具-api/解析结果\\"\]},{\\"group\\":\\"Agent API\\",\\"pages\\":\[\\"api-reference/agent-api/智能体对话\\",\\"api-reference/agent-api/异步结果\\",\\"api-reference/agent-api/对话历史\\"\]},{\\"group\\":\\"文件 API\\",\\"pages\\":\[\\"api-reference/文件-api/文件列表\\",\\"api-reference/文件-api/上传文件\\",\\"api-reference/文件-api/删除文件\\",\\"api-reference/文件-api/文件内容\\"\]},{\\"group\\":\\"批处理 API\\",\\"pages\\":\[\\"api-reference/批处理-api/列出批处理任务\\",\\"api-reference/批处理-api/创建批处理任务\\",\\"api-reference/批处理-api/检索批处理任务\\",\\"api-reference/批处理-api/取消批处理任务\\"\]},{\\"group\\":\\"知识库 API\\",\\"pages\\":\[\\"api-reference/知识库-api/知识库列表\\",\\"api-reference/知识库-api/创建知识库\\",\\"api-reference/知识库-api/知识库详情\\",\\"api-reference/知识库-api/编辑知识库\\",\\"api-reference/知识库-api/删除知识库\\",\\"api-reference/知识库-api/知识库使用量\\",\\"api-reference/知识库-api/文档列表\\",\\"api-reference/知识库-api/上传文件文档\\",\\"api-reference/知识库-api/上传url文档\\",\\"api-reference/知识库-api/解析文档图片\\",\\"api-reference/知识库-api/文档详情\\",\\"api-reference/知识库-api/删除文档\\",\\"api-reference/知识库-api/重新向量化\\"\]},{\\"group\\":\\"实时 API\\",\\"pages\\":\[\\"cn/asyncapi/realtime\\"\]},{\\"group\\":\\"助理 API\\",\\"pages\\":\[\\"api-reference/助理-api/助手对话\\",\\"api-reference/助理-api/助手列表\\",\\"api-reference/助理-api/助手会话列表\\"\]},{\\"group\\":\\"智能体 API（旧）\\",\\"pages\\":\[\\"api-reference/智能体-api（旧）/获取智能体输入参数\\",\\"api-reference/智能体-api（旧）/文件上传\\",\\"api-reference/智能体-api（旧）/获取文件解析状态\\",\\"api-reference/智能体-api（旧）/创建新会话\\",\\"api-reference/智能体-api（旧）/推理接口\\",\\"api-reference/智能体-api（旧）/知识库切片引用位置信息\\",\\"api-reference/智能体-api（旧）/推荐问题接口\\"\]}\],\\"openapi\\":\\"openapi/openapi.json\\"},{\\"tab\\":\\"场景示例\\",\\"pages\\":\[{\\"group\\":\\"开发工具\\",\\"pages\\":\[\\"cn/guide/develop/claude\\",\\"cn/guide/develop/cline\\",\\"cn/guide/develop/kilo\\",\\"cn/guide/develop/roo\\",\\"cn/guide/develop/gemini\\",\\"cn/guide/develop/gork\\",\\"cn/guide/develop/monkey\\"\]},{\\"group\\":\\"Prompt 工程\\",\\"pages\\":\[\\"cn/best-practice/prompt/talk-prompt\\",\\"cn/best-practice/prompt/video-prompt\\",\\"cn/best-practice/prompt/image-prompt\\",\\"cn/best-practice/prompt/batch-prompt\\",\\"cn/best-practice/prompt/modelevaluation\\"\]},{\\"group\\":\\"场景案例\\",\\"pages\\":\[\\"cn/best-practice/case/intelligent-translation\\",\\"cn/best-practice/case/social-media-translation\\",\\"cn/best-practice/case/hr-recruitment\\",\\"cn/best-practice/case/academic-data\\",\\"cn/best-practice/case/ai-search-engine\\",\\"cn/best-practice/case/ai-essay-correction\\",\\"cn/best-practice/case/data-extraction\\",\\"cn/best-practice/case/data-analysis\\",\\"cn/best-practice/case/office-efficiency\\",\\"cn/best-practice/case/financial-application\\"\]},{\\"group\\":\\"创意实践\\",\\"pages\\":\[\\"cn/best-practice/creativepractice/aimockinterviewer\\",\\"cn/best-practice/creativepractice/aimorningnewspaper\\",\\"cn/best-practice/creativepractice/graphrag\\",\\"cn/best-practice/creativepractice/interpretation\\",\\"cn/best-practice/creativepractice/podcastgeneration\\",\\"cn/best-practice/creativepractice/video\\"\]}\]},{\\"tab\\":\\"编码套餐\\",\\"pages\\":\[{\\"group\\":\\"GLM Coding Plan\\",\\"pages\\":\[\\"cn/coding-plan/overview\\",\\"cn/coding-plan/quick-start\\",\\"cn/coding-plan/faq\\"\]},{\\"group\\":\\"调用 MCP 指南\\",\\"pages\\":\[\\"cn/coding-plan/mcp/vision-mcp-server\\",\\"cn/coding-plan/mcp/search-mcp-server\\"\]},{\\"group\\":\\"在开发工具中使用\\",\\"pages\\":\[\\"cn/coding-plan/tool/claude\\",\\"cn/coding-plan/tool/cline\\",\\"cn/coding-plan/tool/kilo\\",\\"cn/coding-plan/tool/roo\\",\\"cn/coding-plan/tool/open_code\\",\\"cn/coding-plan/tool/crush\\",\\"cn/coding-plan/tool/goose\\",\\"cn/coding-plan/tool/others\\"\]},{\\"group\\":\\"\\\\\\"拼好模\\\\\\"活动\\",\\"pages\\":\[\\"cn/coding-plan/credit-campaign-rules\\"\]},{\\"group\\":\\"最佳实践\\",\\"pages\\":\[\\"cn/coding-plan/best-practice/3d-game\\"\]}\]},{\\"tab\\":\\"更新日志\\",\\"pages\\":\[\\"cn/update/new-releases\\",\\"cn/update/feature-updates\\"\]},{\\"tab\\":\\"上新活动\\",\\"pages\\":\[\\"cn/update/promotion\\"\]},{\\"tab\\":\\"条款与协议\\",\\"pages\\":\[\\"cn/terms/user-agreement\\",\\"cn/terms/privacy-policy\\",\\"cn/terms/service-agreement\\",\\"cn/terms/recharge-agreement\\",\\"cn/terms/subscription-agreement\\",\\"cn/terms/cancellation-agreement\\",\\"cn/terms/entity-change-agreement\\",\\"cn/terms/university-program\\",\\"cn/terms/principle\\",\\"cn/terms/security-risk-notice\\",\\"cn/terms/model-commercial-use\\"\]},{\\"tab\\":\\"常见问题\\",\\"pages\\":\[{\\"group\\":\\"API 错误码\\",\\"pages\\":\[\\"cn/faq/api-code\\"\]},{\\"group\\":\\"账号问题\\",\\"pages\\":\[\\"cn/faq/registration-login\\",\\"cn/faq/authentication-issues\\",\\"cn/faq/user-rights\\"\]},{\\"group\\":\\"API 调用问题\\",\\"pages\\":\[\\"cn/faq/api-issues\\",\\"cn/faq/batch-api-issues\\",\\"cn/faq/knowledge-base\\"\]},{\\"group\\":\\"财务问题\\",\\"pages\\":\[\\"cn/faq/fee-issues\\",\\"cn/faq/invoice-issues\\"\]},{\\"group\\":\\"商业授权问题\\",\\"pages\\":\[\\"cn/faq/business-authorization\\"\]}\]}\]},\\"footer\\":{},\\"banner\\":{\\"content\\":\\"🚀 \*\*GLM-4.6 代码编程专享计划\*\* • \[限时优惠 Coding Plan ➞\](https://bigmodel.cn/claude-code?utm\_source=bigModel\\u0026utm\_medium=Frontend%20Group\\u0026utm\_content=glm%20code\\u0026utm\_campaign=Platform\_Ops\\u0026\_channel\_track\_key=WW2t6PJI)\\"},\\"contextual\\":{\\"options\\":\[\\"copy\\",\\"view\\"\]},\\"styling\\":{\\"codeblocks\\":\\"system\\"}},\\"docsNavWithMetadata\\":{\\"global\\":null,\\"tabs\\":\[{\\"tab\\":\\"使用指南\\",\\"pages\\":\[{\\"group\\":\\"开始使用\\",\\"pages\\":\[{\\"title\\":\\"平台介绍\\",\\"description\\":\\"Z智谱·一站式大模型开发平台\\",\\"href\\":\\"/cn/guide/start/introduction\\"},{\\"title\\":\\"模型概览\\",\\"description\\":null,\\"href\\":\\"/cn/guide/start/model-overview\\"},{\\"title\\":\\"快速开始\\",\\"description\\":null,\\"href\\":\\"/cn/guide/start/quick-start\\"},{\\"title\\":\\"核心参数\\",\\"description\\":null,\\"href\\":\\"/cn/guide/start/concept-param\\"},{\\"group\\":\\"开发指南\\",\\"pages\\":\[{\\"title\\":\\"HTTP API 调用\\",\\"description\\":null,\\"href\\":\\"/cn/guide/develop/http/introduction\\"},{\\"title\\":\\"官方 Python SDK\\",\\"description\\":null,\\"href\\":\\"/cn/guide/develop/python/introduction\\"},{\\"title\\":\\"官方 Java SDK\\",\\"description\\":null,\\"href\\":\\"/cn/guide/develop/java/introduction\\"},{\\"title\\":\\"Claude API 兼容\\",\\"description\\":null,\\"href\\":\\"/cn/guide/develop/claude/introduction\\"},{\\"title\\":\\"OpenAI API 兼容\\",\\"description\\":null,\\"href\\":\\"/cn/guide/develop/openai/introduction\\"},{\\"title\\":\\"LangChain 集成\\",\\"description\\":null,\\"href\\":\\"/cn/guide/develop/langchain/introduction\\"}\]}\]},{\\"group\\":\\"模型介绍\\",\\"pages\\":\[{\\"group\\":\\"文本模型\\",\\"pages\\":\[{\\"title\\":\\"GLM-4.6\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/text/glm-4.6\\"},{\\"title\\":\\"GLM-4.5\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/text/glm-4.5\\"},{\\"title\\":\\"GLM-4\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/text/glm-4\\"},{\\"title\\":\\"GLM-Z1\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/text/glm-z1\\"}\]},{\\"group\\":\\"视觉理解模型\\",\\"pages\\":\[{\\"title\\":\\"GLM-4.5V\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/vlm/glm-4.5v\\"},{\\"title\\":\\"GLM-4.1V-Thinking\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/vlm/glm-4.1v-thinking\\"},{\\"title\\":\\"GLM-4V-Plus-0111\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/vlm/glm-4v-plus-0111\\"}\]},{\\"group\\":\\"图像生成模型\\",\\"pages\\":\[{\\"title\\":\\"CogView-4\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/image-generation/cogview-4\\"}\]},{\\"group\\":\\"视频生成模型\\",\\"pages\\":\[{\\"title\\":\\"CogVideoX-3\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/video-generation/cogvideox-3\\"},{\\"title\\":\\"CogVideoX-2\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/video-generation/cogvideox-2\\"},{\\"title\\":\\"Vidu Q1\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/video-generation/viduq1\\"},{\\"title\\":\\"Vidu 2\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/video-generation/vidu2\\"}\]},{\\"group\\":\\"音视频模型\\",\\"pages\\":\[{\\"title\\":\\"CogTTS\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/sound-and-video/cogtts\\"},{\\"title\\":\\"GLM-Realtime\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/sound-and-video/glm-realtime\\"},{\\"title\\":\\"GLM-4-Voice\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/sound-and-video/glm-4-voice\\"},{\\"title\\":\\"GLM-ASR\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/sound-and-video/glm-asr\\"}\]},{\\"group\\":\\"向量模型\\",\\"pages\\":\[{\\"title\\":\\"Embedding-3\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/embedding/embedding-3\\"},{\\"title\\":\\"Embedding-2\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/embedding/embedding-2\\"}\]},{\\"group\\":\\"角色模型\\",\\"pages\\":\[{\\"title\\":\\"CharGLM-4\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/humanoid/charglm-4\\"},{\\"title\\":\\"Emohaa\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/humanoid/emohaa\\"}\]},{\\"group\\":\\"免费模型\\",\\"pages\\":\[{\\"title\\":\\"GLM-4.5-Flash\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/free/glm-4.5-flash\\"},{\\"title\\":\\"GLM-4.1V-Thinking-Flash\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/free/glm-4.1v-thinking-flash\\"},{\\"title\\":\\"GLM-4-Flash-250414\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/free/glm-4-flash-250414\\"},{\\"title\\":\\"GLM-4V-Flash\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/free/glm-4v-flash\\"},{\\"title\\":\\"GLM-Z1-Flash\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/free/glm-z1-flash\\"},{\\"title\\":\\"Cogview-3-Flash\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/free/cogview-3-flash\\"},{\\"title\\":\\"CogVideoX-Flash\\",\\"description\\":null,\\"href\\":\\"/cn/guide/models/free/cogvideox-flash\\"}\]}\]},{\\"group\\":\\"模型工具\\",\\"pages\\":\[{\\"title\\":\\"联网搜索\\",\\"keywords\\":\[\\"智谱AI\\",\\"web search\\",\\"网络搜索\\"\],\\"description\\":null,\\"href\\":\\"/cn/guide/tools/web-search\\"},{\\"title\\":\\"函数调用\\",\\"description\\":\\"智能体函数调用功能详细介绍\\",\\"href\\":\\"/cn/guide/tools/function-calling\\"},{\\"title\\":\\"知识库检索\\",\\"description\\":null,\\"href\\":\\"/cn/guide/tools/retrieval\\"},{\\"title\\":\\"模型部署\\",\\"description\\":null,\\"href\\":\\"/cn/guide/tools/model-deploy\\"},{\\"title\\":\\"模型微调\\",\\"description\\":null,\\"href\\":\\"/cn/guide/tools/fine-tuning\\"},{\\"title\\":\\"模型评测\\",\\"description\\":null,\\"href\\":\\"/cn/guide/tools/evaluation\\"},{\\"title\\":\\"批量处理\\",\\"description\\":null,\\"href\\":\\"/cn/guide/tools/batch\\"},{\\"group\\":\\"文件解析\\",\\"pages\\":\[{\\"title\\":\\"新文件解析服务\\",\\"description\\":null,\\"href\\":\\"/cn/guide/tools/file-parser\\"},{\\"title\\":\\"(旧)文件内容抽取\\",\\"description\\":\\"从文件中提取文本信息，可用于文件问答等 AI 服务。文件管理请参考文件 API。\\",\\"href\\":\\"/cn/guide/tools/file-extract\\"}\]},{\\"title\\":\\"JSON 格式化\\",\\"description\\":\\"智能体结构化输出功能详细介绍\\",\\"href\\":\\"/cn/guide/tools/json-mode\\"},{\\"title\\":\\"工具流式输出\\",\\"description\\":null,\\"href\\":\\"/cn/guide/tools/stream-tool\\"}\]},{\\"group\\":\\"智能体\\",\\"pages\\":\[{\\"group\\":\\"语言翻译\\",\\"pages\\":\[{\\"title\\":\\"通用翻译\\",\\"description\\":null,\\"href\\":\\"/cn/guide/agents/translation\\"},{\\"title\\":\\"专业文档翻译\\",\\"description\\":null,\\"href\\":\\"/cn/guide/agents/documenttranslation\\"},{\\"title\\":\\"影视字幕翻译\\",\\"description\\":null,\\"href\\":\\"/cn/guide/agents/film\\"},{\\"title\\":\\"社科文学翻译\\",\\"description\\":null,\\"href\\":\\"/cn/guide/agents/social\\"},{\\"title\\":\\"社交媒体翻译\\",\\"description\\":null,\\"href\\":\\"/cn/guide/agents/media\\"}\]},{\\"group\\":\\"内容生成\\",\\"pages\\":\[{\\"title\\":\\"AI绘图\\",\\"description\\":null,\\"href\\":\\"/cn/guide/agents/aidrawing\\"},{\\"title\\":\\"AI漫画\\",\\"description\\":null,\\"href\\":\\"/cn/guide/agents/aicaricature\\"},{\\"title\\":\\"热门特效视频\\",\\"description\\":null,\\"href\\":\\"/cn/guide/agents/specialeffectsvideos\\"}\]},{\\"group\\":\\"办公效能\\",\\"pages\\":\[{\\"title\\":\\"GLM PPT\\",\\"description\\":null,\\"href\\":\\"/cn/guide/agents/glm-ppt\\"},{\\"title\\":\\"简历与岗位匹配助手\\",\\"description\\":null,\\"href\\":\\"/cn/guide/agents/job\\"},{\\"title\\":\\"客服话术质检\\",\\"description\\":null,\\"href\\":\\"/cn/guide/agents/customer\\"},{\\"title\\":\\"销售质检\\",\\"description\\":null,\\"href\\":\\"/cn/guide/agents/sale\\"}\]},{\\"group\\":\\"信息提取\\",\\"pages\\":\[{\\"title\\":\\"中标解析\\",\\"description\\":null,\\"href\\":\\"/cn/guide/agents/winningbidder\\"},{\\"title\\":\\"招标解析\\",\\"description\\":null,\\"href\\":\\"/cn/guide/agents/tender\\"},{\\"title\\":\\"合同解析\\",\\"description\\":null,\\"href\\":\\"/cn/guide/agents/contract\\"},{\\"title\\":\\"衣物识别\\",\\"description\\":null,\\"href\\":\\"/cn/guide/agents/clothes\\"},{\\"title\\":\\"票据识别\\",\\"description\\":null,\\"href\\":\\"/cn/guide/agents/bill\\"}\]},{\\"group\\":\\"智慧教育\\",\\"pages\\":\[{\\"title\\":\\"智能解题\\",\\"description\\":null,\\"href\\":\\"/cn/guide/agents/solving\\"},{\\"title\\":\\"作业批改\\",\\"description\\":null,\\"href\\":\\"/cn/guide/agents/homeworkcorrection\\"}\]}\]},{\\"group\\":\\"平台服务\\",\\"pages\\":\[{\\"title\\":\\"智能体开发平台\\",\\"description\\":null,\\"href\\":\\"/cn/guide/platform/intelligent-agent\\"},{\\"title\\":\\"提示词工程\\",\\"description\\":\\"掌握GLM语言模型和CogView图像生成模型的提示词技巧，获得更好的生成效果\\",\\"href\\":\\"/cn/guide/platform/prompt\\"},{\\"title\\":\\"内容安全\\",\\"description\\":\\"了解智谱AI的内容安全审核机制，确保AI应用的安全可控和合规使用\\",\\"href\\":\\"/cn/guide/platform/securityaudit\\"},{\\"title\\":\\"模型迁移\\",\\"description\\":\\"从 OpenAI 模型快速迁移到智谱AI，享受便捷的搬家计划和兼容性支持\\",\\"href\\":\\"/cn/guide/platform/model-migration\\"},{\\"title\\":\\"用户权益\\",\\"description\\":\\"了解智谱AI 用户权益体系，通过积分提升等级，享受模型计费折扣和平台服务\\",\\"href\\":\\"/cn/guide/platform/equity-explain\\"},{\\"title\\":\\"模型备案\\",\\"description\\":\\"查看智谱AI已备案的生成式人工智能服务信息，确保合规使用\\",\\"href\\":\\"/cn/guide/platform/filing\\"}\]}\]},{\\"tab\\":\\"API 文档\\",\\"pages\\":\[{\\"group\\":\\"API 指引\\",\\"pages\\":\[{\\"title\\":\\"使用概述\\",\\"description\\":null,\\"href\\":\\"/cn/api/introduction\\"},{\\"title\\":\\"错误码\\",\\"description\\":null,\\"href\\":\\"/cn/api/api-code\\"}\]},{\\"group\\":\\"模型 API\\",\\"pages\\":\[{\\"title\\":\\"对话补全\\",\\"description\\":\\"和 \[指定模型\](/cn/guide/start/model-overview) 对话，模型根据请求给出响应。支持多种模型，支持多模态（文本、图片、音频、视频、文件），流式和非流式输出，可配置采样，温度，最大令牌数，工具调用等。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/chat/completions\\",\\"href\\":\\"/api-reference/模型-api/对话补全\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"对话补全(异步)\\",\\"description\\":\\"和 \[指定模型\](/cn/guide/start/model-overview) 对话，通过查询异步结果获取模型响应。支持多种模型，支持多模态（文本、图片、音频、视频、文件），可配置采样，温度，最大令牌数，工具调用等。注意此为异步接口，通过 \[查询异步结果\](/api-reference/%E6%A8%A1%E5%9E%8B-api/%E6%9F%A5%E8%AF%A2%E5%BC%82%E6%AD%A5%E7%BB%93%E6%9E%9C) 获取生成结果。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/async/chat/completions\\",\\"href\\":\\"/api-reference/模型-api/对话补全异步\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"生成视频(异步)\\",\\"description\\":\\"通过调用 \[视频模型\](/cn/guide/models/video-generation/cogvideox-3) 能力生成视频内容。支持多种视频生成方式，包括文本转视频、图像转视频等。注意此为异步接口，通过 \[查询异步结果\](/api-reference/%E6%A8%A1%E5%9E%8B-api/%E6%9F%A5%E8%AF%A2%E5%BC%82%E6%AD%A5%E7%BB%93%E6%9E%9C) 获取生成视频结果。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/videos/generations\\",\\"href\\":\\"/api-reference/模型-api/生成视频异步\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"查询异步结果\\",\\"description\\":\\"查询对话补全和视频生成异步请求的处理结果和状态。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json get /paas/v4/async-result/{id}\\",\\"href\\":\\"/api-reference/模型-api/查询异步结果\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"图像生成\\",\\"description\\":\\"使用 \[CogView-4\](/cn/guide/models/image-generation/cogview-4) 系列模型从文本提示生成高质量图像。\`CogView-4\` 适用于图像生成任务，通过对用户文字描述快速、精准的理解，让 \`AI\` 的图像表达更加精确和个性化。支持 \`cogview-4-250304、cogview-4、cogview-3-flash\` 等模型。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/images/generations\\",\\"href\\":\\"/api-reference/模型-api/图像生成\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"语音转文本\\",\\"description\\":\\"使用 \[GLM ASR\](/cn/guide/models/sound-and-video/glm-asr) 模型将音频文件转录为文本，支持多语言和实时流式转录。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/audio/transcriptions\\",\\"href\\":\\"/api-reference/模型-api/语音转文本\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"文本转语音\\",\\"description\\":\\"使用 \`CogTTS\` 将文本转换为自然语音，支持多种声音、情感控制和语调调整。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/audio/speech\\",\\"href\\":\\"/api-reference/模型-api/文本转语音\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"音色复刻\\",\\"description\\":\\"使用音色复刻技术，基于示例音频生成指定音色、文本内容的语音合成。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/voice/clone\\",\\"href\\":\\"/api-reference/模型-api/音色复刻\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"音色列表\\",\\"description\\":\\"获取音色列表，支持按音色名称模糊搜索、按音色类型过滤。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json get /paas/v4/voice/list\\",\\"href\\":\\"/api-reference/模型-api/音色列表\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"删除音色\\",\\"description\\":\\"删除指定的音色。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/voice/delete\\",\\"href\\":\\"/api-reference/模型-api/删除音色\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"文本嵌入\\",\\"description\\":\\"使用 \[GLM Embedding\](/cn/guide/models/embedding/embedding-3) 系列模型将文本转换为高维向量表示，用于语义相似性和搜索。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/embeddings\\",\\"href\\":\\"/api-reference/模型-api/文本嵌入\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"文本重排序\\",\\"description\\":\\"\`Rerank\` 用于文本重排序，通过接收用户的查询文本及候选文本列表，使用模型计算候选文本与查询文本的相关性得分并返回分数。适用于智能问答、信息检索等场景。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/rerank\\",\\"href\\":\\"/api-reference/模型-api/文本重排序\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"文本分词器\\",\\"description\\":\\"\`Tokenizer\` 用于将文本切分为模型可识别的 \`token\` 并计算数量。它接收用户输入的文本，通过模型进行分词处理，最终返回对应的 \`token\` 数量。适用于文本长度评估、模型输入预估、对话上下文截断、费用计算等。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/tokenizer\\",\\"href\\":\\"/api-reference/模型-api/文本分词器\\",\\"autogeneratedByOpenApi\\":true}\]},{\\"group\\":\\"工具 API\\",\\"pages\\":\[{\\"title\\":\\"网络搜索\\",\\"description\\":\\"\`Web Search API\` 是一个专给大模型用的搜索引擎，在传统搜索引擎网页抓取、排序的能力基础上，增强了意图识别能力，返回更适合大模型处理的结果（网页标题、\`URL\`、摘要、名称、图标等）。支持意图增强检索、结构化输出和多引擎支持。见 \[网络搜索服务\](/cn/guide/tools/web-search)\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/web\_search\\",\\"href\\":\\"/api-reference/工具-api/网络搜索\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"内容安全\\",\\"description\\":\\"可对文本、图片、音频、视频格式类型的内容进行检测，精准识别涉黄、涉暴、违法违规等风险内容，并输出结构化审核结果（包括内容类型、风险类型及具体风险内容片段），快速定位和处理违规信息。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/moderations\\",\\"href\\":\\"/api-reference/工具-api/内容安全\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"文件解析\\",\\"description\\":\\"创建文件解析任务，支持多种文件格式和解析工具。见 \[文件解析服务\](/cn/guide/tools/file-parser)\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/files/parser/create\\",\\"href\\":\\"/api-reference/工具-api/文件解析\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"解析结果\\",\\"description\\":\\"异步获取文件解析任务的结果，支持返回纯文本或下载链接格式。见 \[文件解析服务\](/cn/guide/tools/file-parser)\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json get /paas/v4/files/parser/result/{taskId}/{format\_type}\\",\\"href\\":\\"/api-reference/工具-api/解析结果\\",\\"autogeneratedByOpenApi\\":true}\]},{\\"group\\":\\"Agent API\\",\\"pages\\":\[{\\"title\\":\\"智能体对话\\",\\"description\\":\\"与智能体进行对话交互。支持同步和流式调用，提供智能体的专业能力。见 \[智能体文档\](/cn/guide/agents/translation)\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /v1/agents\\",\\"href\\":\\"/api-reference/agent-api/智能体对话\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"异步结果\\",\\"description\\":\\"查询智能体异步任务的处理结果和状态。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /v1/agents/async-result\\",\\"href\\":\\"/api-reference/agent-api/异步结果\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"对话历史\\",\\"description\\":\\"查询智能体对话历史，现仅支持 \`slides\_glm\_agent\` 智能体\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /v1/agents/conversation\\",\\"href\\":\\"/api-reference/agent-api/对话历史\\",\\"autogeneratedByOpenApi\\":true}\]},{\\"group\\":\\"文件 API\\",\\"pages\\":\[{\\"title\\":\\"文件列表\\",\\"description\\":\\"获取已上传文件的分页列表，支持按用途和排序过滤。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json get /paas/v4/files\\",\\"href\\":\\"/api-reference/文件-api/文件列表\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"上传文件\\",\\"description\\":\\"上传用于 \`Batch 任务\`、\`文件内容抽取\`、\`智能体\` 等功能的文件。注意 \`Try it\` 功能仅支持小文件上传，实际支持的文件大小请参见下文 \`purpose\` 相关说明。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/files\\",\\"href\\":\\"/api-reference/文件-api/上传文件\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"删除文件\\",\\"description\\":\\"永久删除指定文件及其所有关联数据。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json delete /paas/v4/files/{file\_id}\\",\\"href\\":\\"/api-reference/文件-api/删除文件\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"文件内容\\",\\"description\\":\\"获取文件内容。只支持 \`batch\` 与 \`file-extract\` 文件类型。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json get /paas/v4/files/{file\_id}/content\\",\\"href\\":\\"/api-reference/文件-api/文件内容\\",\\"autogeneratedByOpenApi\\":true}\]},{\\"group\\":\\"批处理 API\\",\\"pages\\":\[{\\"title\\":\\"列出批处理任务\\",\\"description\\":\\"获取批量处理任务列表，支持分页。见 \[批量服务\](/cn/guide/tools/batch)\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json get /paas/v4/batches\\",\\"href\\":\\"/api-reference/批处理-api/列出批处理任务\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"创建批处理任务\\",\\"description\\":\\"创建一个新的批量处理任务。见 \[批量服务\](/cn/guide/tools/batch)\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/batches\\",\\"href\\":\\"/api-reference/批处理-api/创建批处理任务\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"检索批处理任务\\",\\"description\\":\\"根据批处理任务\`ID\`获取批量处理任务详情。见 \[批量服务\](/cn/guide/tools/batch)\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json get /paas/v4/batches/{batch\_id}\\",\\"href\\":\\"/api-reference/批处理-api/检索批处理任务\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"取消批处理任务\\",\\"description\\":\\"根据批处理任务\`ID\`取消正在运行的批量处理任务。见 \[批量服务\](/cn/guide/tools/batch)\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/batches/{batch\_id}/cancel\\",\\"href\\":\\"/api-reference/批处理-api/取消批处理任务\\",\\"autogeneratedByOpenApi\\":true}\]},{\\"group\\":\\"知识库 API\\",\\"pages\\":\[{\\"title\\":\\"知识库列表\\",\\"description\\":\\"获取个人知识库列表，支持分页。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json get /llm-application/open/knowledge\\",\\"href\\":\\"/api-reference/知识库-api/知识库列表\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"创建知识库\\",\\"description\\":\\"用于创建个人知识库，支持绑定向量化模型、设置名称、描述、背景色和图标。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /llm-application/open/knowledge\\",\\"href\\":\\"/api-reference/知识库-api/创建知识库\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"知识库详情\\",\\"description\\":\\"根据知识库\`ID\`获取个人知识库详情。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json get /llm-application/open/knowledge/{id}\\",\\"href\\":\\"/api-reference/知识库-api/知识库详情\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"编辑知识库\\",\\"description\\":\\"用于编辑已经创建好的个人知识库，仅传入要修改的字段。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json put /llm-application/open/knowledge/{id}\\",\\"href\\":\\"/api-reference/知识库-api/编辑知识库\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"删除知识库\\",\\"description\\":\\"根据知识库\`ID\`删除个人知识库。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json delete /llm-application/open/knowledge/{id}\\",\\"href\\":\\"/api-reference/知识库-api/删除知识库\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"知识库使用量\\",\\"description\\":\\"获取个人知识库的使用量详情，包括字数和字节数。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json get /llm-application/open/knowledge/capacity\\",\\"href\\":\\"/api-reference/知识库-api/知识库使用量\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"文档列表\\",\\"description\\":\\"获取指定知识库下的文档列表。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json get /llm-application/open/document\\",\\"href\\":\\"/api-reference/知识库-api/文档列表\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"上传文件文档\\",\\"description\\":\\"向指定知识库上传文件类型文档，支持多种切片方式和回调。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /llm-application/open/document/upload\_document/{id}\\",\\"href\\":\\"/api-reference/知识库-api/上传文件文档\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"上传URL文档\\",\\"description\\":\\"上传\`URL\`类型的文档或网页作为内容填充知识库。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /llm-application/open/document/upload\_url\\",\\"href\\":\\"/api-reference/知识库-api/上传url文档\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"解析文档图片\\",\\"description\\":\\"用于获取文件下解析到的图片序号和图片链接映射关系。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /llm-application/open/document/slice/image\_list/{id}\\",\\"href\\":\\"/api-reference/知识库-api/解析文档图片\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"文档详情\\",\\"description\\":\\"根据文档\`ID\`获取文档详情。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json get /llm-application/open/document/{id}\\",\\"href\\":\\"/api-reference/知识库-api/文档详情\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"删除文档\\",\\"description\\":\\"根据文档\`ID\`删除文档。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json delete /llm-application/open/document/{id}\\",\\"href\\":\\"/api-reference/知识库-api/删除文档\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"重新向量化\\",\\"description\\":\\"用于重新向量化文档（重试等操作）。同步返回成功表示调用成功，向量化完成后调用\`callback\_url\`进行通知，也可调用知识详情接口获取结果。多用于\`url\`知识场景。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /llm-application/open/document/embedding/{id}\\",\\"href\\":\\"/api-reference/知识库-api/重新向量化\\",\\"autogeneratedByOpenApi\\":true}\]},{\\"group\\":\\"实时 API\\",\\"pages\\":\[{\\"title\\":\\"音视频通话\\",\\"asyncapi\\":\\"asyncapi/asyncapi.json realtime\\",\\"description\\":\\"\[GLM-Realtime\](/cn/guide/models/sound-and-video/glm-realtime) 提供实时音视频通话和多模态交互能力，支持实时语音对话、视频理解、函数调用等功能。\\u003cbr/\\u003e 由于浏览器安全考虑禁止 \`WebSocket\` 添加鉴权认证请求头，无法在此直接体验，使用详情请参考 \[Realtime 指南使用\](/cn/guide/models/sound-and-video/glm-realtime)。\\",\\"href\\":\\"/cn/asyncapi/realtime\\"}\]},{\\"group\\":\\"助理 API\\",\\"pages\\":\[{\\"title\\":\\"助手对话\\",\\"description\\":\\"与\`AI\`助手进行对话，支持流式和同步模式。\\",\\"deprecated\\":true,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/assistant\\",\\"href\\":\\"/api-reference/助理-api/助手对话\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"助手列表\\",\\"description\\":\\"查询指定的智能体助手列表信息，包括智能体助手的详细配置、工具和元数据。\\",\\"deprecated\\":true,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/assistant/list\\",\\"href\\":\\"/api-reference/助理-api/助手列表\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"助手会话列表\\",\\"description\\":\\"查询指定智能体助手的会话列表，支持分页查询。\\",\\"deprecated\\":true,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/assistant/conversation/list\\",\\"href\\":\\"/api-reference/助理-api/助手会话列表\\",\\"autogeneratedByOpenApi\\":true}\]},{\\"group\\":\\"智能体 API（旧）\\",\\"pages\\":\[{\\"title\\":\\"获取智能体输入参数\\",\\"description\\":\\"获取指定智能体应用的输入参数列表。\\",\\"deprecated\\":true,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json get /llm-application/open/v2/application/{app\_id}/variables\\",\\"href\\":\\"/api-reference/智能体-api（旧）/获取智能体输入参数\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"文件上传\\",\\"description\\":\\"上传文件到智能体（应用），同步返回上传结果。需通过文件解析状态接口获取解析结果。\\",\\"deprecated\\":true,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /llm-application/open/v2/application/file\_upload\\",\\"href\\":\\"/api-reference/智能体-api（旧）/文件上传\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"获取文件解析状态\\",\\"description\\":\\"获取指定文件的解析状态。\\",\\"deprecated\\":true,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /llm-application/open/v2/application/file\_stat\\",\\"href\\":\\"/api-reference/智能体-api（旧）/获取文件解析状态\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"创建新会话\\",\\"description\\":\\"为指定智能体（应用）创建新会话，返回会话\`ID\`。\\",\\"deprecated\\":true,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /llm-application/open/v2/application/{app\_id}/conversation\\",\\"href\\":\\"/api-reference/智能体-api（旧）/创建新会话\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"推理接口\\",\\"description\\":\\"对话型或文本型应用推理接口，支持同步和流式\`SSE\`调用。\\",\\"deprecated\\":true,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /llm-application/open/v3/application/invoke\\",\\"href\\":\\"/api-reference/智能体-api（旧）/推理接口\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"知识库切片引用位置信息\\",\\"description\\":\\"获取知识库切片引用的位置信息。\\",\\"deprecated\\":true,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /llm-application/open/v2/application/slice\_info\\",\\"href\\":\\"/api-reference/智能体-api（旧）/知识库切片引用位置信息\\",\\"autogeneratedByOpenApi\\":true},{\\"title\\":\\"推荐问题接口\\",\\"description\\":\\"获取推荐问题列表。\\",\\"deprecated\\":true,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json get /llm-application/open/history\_session\_record/{app\_id}/{conversation\_id}\\",\\"href\\":\\"/api-reference/智能体-api（旧）/推荐问题接口\\",\\"autogeneratedByOpenApi\\":true}\]}\]},{\\"tab\\":\\"场景示例\\",\\"pages\\":\[{\\"group\\":\\"开发工具\\",\\"pages\\":\[{\\"title\\":\\"接入 Claude Code\\",\\"description\\":\\"将智谱最新 GLM-4.6 系列模型集成到 Claude Code 的方法\\",\\"href\\":\\"/cn/guide/develop/claude\\"},{\\"title\\":\\"接入 Cline\\",\\"description\\":\\"在 VS Code 中使用 Cline 插件接入智谱 GLM 模型的完整指南\\",\\"href\\":\\"/cn/guide/develop/cline\\"},{\\"title\\":\\"接入 Kilo Code\\",\\"description\\":\\"在 VS Code 中使用 Kilo Code 插件接入智谱 GLM 模型的完整指南\\",\\"href\\":\\"/cn/guide/develop/kilo\\"},{\\"title\\":\\"接入 Roo Code\\",\\"description\\":\\"在 VS Code 中使用 Roo Code 插件接入智谱 GLM 模型的完整指南\\",\\"href\\":\\"/cn/guide/develop/roo\\"},{\\"title\\":\\"接入 Gemini CLI\\",\\"description\\":\\"使用定制版 Gemini CLI 接入智谱 GLM 模型的完整指南\\",\\"href\\":\\"/cn/guide/develop/gemini\\"},{\\"title\\":\\"接入 Grok CLI\\",\\"description\\":\\"使用 Grok CLI 接入智谱 GLM 模型的快速指南\\",\\"href\\":\\"/cn/guide/develop/gork\\"},{\\"title\\":\\"接入 Monkey Code\\",\\"description\\":\\"在 VS Code 中使用 Monkey Code 插件接入智谱 GLM 模型的完整指南\\",\\"href\\":\\"/cn/guide/develop/monkey\\"}\]},{\\"group\\":\\"Prompt 工程\\",\\"pages\\":\[{\\"title\\":\\"语言模型\\",\\"description\\":\\"掌握复杂场景下的语言模型 Prompt 工程\\",\\"href\\":\\"/cn/best-practice/prompt/talk-prompt\\"},{\\"title\\":\\"视频生成\\",\\"description\\":\\"Prompt 工程视频生成模型\\",\\"href\\":\\"/cn/best-practice/prompt/video-prompt\\"},{\\"title\\":\\"图像生成\\",\\"description\\":\\"掌握图像生成模型 Prompt 设计的核心方法\\",\\"href\\":\\"/cn/best-practice/prompt/image-prompt\\"},{\\"title\\":\\"批量处理\\",\\"description\\":\\"适用于无需即时反馈但需要处理大量请求的场景。\\",\\"href\\":\\"/cn/best-practice/prompt/batch-prompt\\"},{\\"title\\":\\"评测工具\\",\\"description\\":\\"智谱 Bigmodel 目前支持的两种自动评测方式。\\",\\"href\\":\\"/cn/best-practice/prompt/modelevaluation\\"}\]},{\\"group\\":\\"场景案例\\",\\"pages\\":\[{\\"title\\":\\"智能翻译\\",\\"description\\":\\"从传统机翻到智能语境适配。\\",\\"href\\":\\"/cn/best-practice/case/intelligent-translation\\"},{\\"title\\":\\"社媒翻译\\",\\"description\\":\\"社交媒体多语种翻译\\",\\"href\\":\\"/cn/best-practice/case/social-media-translation\\"},{\\"title\\":\\"人力招聘\\",\\"description\\":\\"智能人岗匹配综合解决方案\\",\\"href\\":\\"/cn/best-practice/case/hr-recruitment\\"},{\\"title\\":\\"学术数据处理\\",\\"description\\":\\"论文总结翻译润色\\",\\"href\\":\\"/cn/best-practice/case/academic-data\\"},{\\"title\\":\\"AI搜索引擎\\",\\"description\\":\\"多智能体 - AI搜索引擎\\",\\"href\\":\\"/cn/best-practice/case/ai-search-engine\\"},{\\"title\\":\\"智能作文批改\\",\\"description\\":\\"多文体作文批改\\",\\"href\\":\\"/cn/best-practice/case/ai-essay-correction\\"},{\\"title\\":\\"数据提取\\",\\"description\\":\\"招投标数据提取方案\\",\\"href\\":\\"/cn/best-practice/case/data-extraction\\"},{\\"title\\":\\" 数据分析\\",\\"description\\":\\"一种能够自动化处理数据分析任务的解决方案\\",\\"href\\":\\"/cn/best-practice/case/data-analysis\\"},{\\"title\\":\\"办公提效\\",\\"description\\":\\"飞书多维表格字段插件\\",\\"href\\":\\"/cn/best-practice/case/office-efficiency\\"},{\\"title\\":\\"金融应用\\",\\"description\\":\\"金融行业大模型应用的背景、业务需求、解决方案\\",\\"href\\":\\"/cn/best-practice/case/financial-application\\"}\]},{\\"group\\":\\"创意实践\\",\\"pages\\":\[{\\"title\\":\\"AI 模拟面试官\\",\\"description\\":null,\\"href\\":\\"/cn/best-practice/creativepractice/aimockinterviewer\\"},{\\"title\\":\\"AI早报生成\\",\\"description\\":null,\\"href\\":\\"/cn/best-practice/creativepractice/aimorningnewspaper\\"},{\\"title\\":\\"GraphRAG\\",\\"description\\":null,\\"href\\":\\"/cn/best-practice/creativepractice/graphrag\\"},{\\"title\\":\\"汉语新解\\",\\"description\\":null,\\"href\\":\\"/cn/best-practice/creativepractice/interpretation\\"},{\\"title\\":\\"播客生成\\",\\"description\\":null,\\"href\\":\\"/cn/best-practice/creativepractice/podcastgeneration\\"},{\\"title\\":\\"编辑视频\\",\\"description\\":null,\\"href\\":\\"/cn/best-practice/creativepractice/video\\"}\]}\]},{\\"tab\\":\\"编码套餐\\",\\"pages\\":\[{\\"group\\":\\"GLM Coding Plan\\",\\"pages\\":\[{\\"title\\":\\"套餐概览\\",\\"description\\":null,\\"href\\":\\"/cn/coding-plan/overview\\"},{\\"title\\":\\"快速开始\\",\\"description\\":null,\\"href\\":\\"/cn/coding-plan/quick-start\\"},{\\"title\\":\\"常见问题\\",\\"description\\":null,\\"href\\":\\"/cn/coding-plan/faq\\"}\]},{\\"group\\":\\"调用 MCP 指南\\",\\"pages\\":\[{\\"title\\":\\"视觉理解 MCP\\",\\"description\\":null,\\"href\\":\\"/cn/coding-plan/mcp/vision-mcp-server\\"},{\\"title\\":\\"联网搜索 MCP\\",\\"description\\":null,\\"href\\":\\"/cn/coding-plan/mcp/search-mcp-server\\"}\]},{\\"group\\":\\"在开发工具中使用\\",\\"pages\\":\[{\\"title\\":\\"Claude Code\\",\\"description\\":\\"在 Claude Code 中使用 GLM Coding Plan的方法\\",\\"href\\":\\"/cn/coding-plan/tool/claude\\"},{\\"title\\":\\"Cline\\",\\"description\\":\\"在 Cline 插件中使用 GLM Coding Plan 的方法\\",\\"href\\":\\"/cn/coding-plan/tool/cline\\"},{\\"title\\":\\"Kilo Code\\",\\"description\\":\\"在 Kilo Code 插件中使用 GLM Coding Plan 的方法\\",\\"href\\":\\"/cn/coding-plan/tool/kilo\\"},{\\"title\\":\\"Roo Code\\",\\"description\\":\\"在 Roo Code 插件中使用 GLM Coding Plan 的方法\\",\\"href\\":\\"/cn/coding-plan/tool/roo\\"},{\\"title\\":\\"open_code\\",\\"description\\":\\"在 open_code 中使用 GLM Coding Plan 的方法\\",\\"href\\":\\"/cn/coding-plan/tool/open_code\\"},{\\"title\\":\\"Crush\\",\\"description\\":\\"在 Crush 中使用 GLM Coding Plan 的方法\\",\\"href\\":\\"/cn/coding-plan/tool/crush\\"},{\\"title\\":\\"Goose\\",\\"description\\":\\"在 Goose 中使用 GLM Coding Plan 的方法\\",\\"href\\":\\"/cn/coding-plan/tool/goose\\"},{\\"title\\":\\"其他工具\\",\\"description\\":\\"在其他工具中使用 GLM Coding Plan 的方法\\",\\"href\\":\\"/cn/coding-plan/tool/others\\"}\]},{\\"group\\":\\"\\\\\\"拼好模\\\\\\"活动\\",\\"pages\\":\[{\\"title\\":\\"活动规则\\",\\"description\\":\\"邀请好友得赠金\\",\\"href\\":\\"/cn/coding-plan/credit-campaign-rules\\"}\]},{\\"group\\":\\"最佳实践\\",\\"pages\\":\[{\\"title\\":\\"3D 游戏\\",\\"description\\":\\"从 Game Boy 到 3D Tetris：GLM-4.5帮我重构童年幻想\\",\\"href\\":\\"/cn/coding-plan/best-practice/3d-game\\"}\]}\]},{\\"tab\\":\\"更新日志\\",\\"pages\\":\[{\\"title\\":\\"新品发布\\",\\"description\\":\\"最新模型和产品发布公告\\",\\"href\\":\\"/cn/update/new-releases\\"},{\\"title\\":\\"功能更新\\",\\"description\\":\\"平台功能改进和优化记录\\",\\"href\\":\\"/cn/update/feature-updates\\"}\]},{\\"tab\\":\\"上新活动\\",\\"pages\\":\[{\\"title\\":\\"上新活动\\",\\"description\\":null,\\"href\\":\\"/cn/update/promotion\\"}\]},{\\"tab\\":\\"条款与协议\\",\\"pages\\":\[{\\"title\\":\\"用户协议\\",\\"description\\":\\"用户服务协议\\",\\"href\\":\\"/cn/terms/user-agreement\\"},{\\"title\\":\\"隐私政策\\",\\"description\\":\\"隐私保护政策说明\\",\\"href\\":\\"/cn/terms/privacy-policy\\"},{\\"title\\":\\"服务协议\\",\\"description\\":\\"服务条款和使用协议\\",\\"href\\":\\"/cn/terms/service-agreement\\"},{\\"title\\":\\"充值协议\\",\\"description\\":\\"尊敬的用户，为保障您的合法权益，请您在点击“购买”按钮前，完整、仔细地阅读本充值协议，当您点击“立即购买”按钮，即表示您已阅读、理解本协议内容，并同意按照本协议约定的规则进行充值和使用余额行为。如您不接受本协议的部分或全部内容，请您不要点击“立即购买”按钮。\\",\\"href\\":\\"/cn/terms/recharge-agreement\\"},{\\"title\\":\\"订阅服务协议\\",\\"description\\":null,\\"href\\":\\"/cn/terms/subscription-agreement\\"},{\\"title\\":\\"注销协议\\",\\"description\\":\\"账户注销服务协议\\",\\"href\\":\\"/cn/terms/cancellation-agreement\\"},{\\"title\\":\\"主体变更协议\\",\\"description\\":\\"服务主体变更协议\\",\\"href\\":\\"/cn/terms/entity-change-agreement\\"},{\\"title\\":\\"高校X计划 - 申请须知\\",\\"description\\":\\"高校合作计划申请须知\\",\\"href\\":\\"/cn/terms/university-program\\"},{\\"title\\":\\"自律性原则声明\\",\\"description\\":\\"智谱以增进人类共同福祉为目标，致力于人工智能技术研究，坚持技术中立原则，推进人工智能技术的合理应用。\\",\\"href\\":\\"/cn/terms/principle\\"},{\\"title\\":\\"安全与风险提示\\",\\"description\\":\\"平台的 API 可以支持广泛的应用，例如问答、写作和对话。虽然使用我们的 API 能为最终用户创造便利，但它也可能产生安全问题，本文档旨在帮助客户了解使用 API 时可能出现的安全问题。\\\\n本文档首先介绍如何将 API 作为产品或服务的一部分并进行安全调用，然后列举了几个要考虑的特定问题，提供了有关风险的一般指导，并特别提供了关于稳健性和公平性的进一步指导。\\",\\"href\\":\\"/cn/terms/security-risk-notice\\"},{\\"title\\":\\"模型商用许可协议\\",\\"description\\":\\"特别提示：您在选择使用北京智谱华章科技股份有限公司的模型前，请事先认真阅读本协议的条款及内容，特别是关于使用者义务、保证否认及责任限制的条款。使用者使用《模型商用授权申请》及本协议中所涉及的模型即表示完全接受并同意遵守本协议的全部内容。如您不同意本协议的条款，请不要选择付款并立即停止使用大模型。\\",\\"href\\":\\"/cn/terms/model-commercial-use\\"}\]},{\\"tab\\":\\"常见问题\\",\\"pages\\":\[{\\"group\\":\\"API 错误码\\",\\"pages\\":\[{\\"title\\":\\"API 错误码\\",\\"description\\":null,\\"href\\":\\"/cn/faq/api-code\\"}\]},{\\"group\\":\\"账号问题\\",\\"pages\\":\[{\\"title\\":\\"注册登录问题\\",\\"description\\":\\"注册登录常见问题解答\\",\\"href\\":\\"/cn/faq/registration-login\\"},{\\"title\\":\\"实名认证问题\\",\\"description\\":\\"实名认证常见问题解答\\",\\"href\\":\\"/cn/faq/authentication-issues\\"},{\\"title\\":\\"用户权益问题\\",\\"description\\":\\"用户权益问题解答\\",\\"href\\":\\"/cn/faq/user-rights\\"}\]},{\\"group\\":\\"API 调用问题\\",\\"pages\\":\[{\\"title\\":\\"API 调用问题\\",\\"description\\":\\"API 调用常见问题解答\\",\\"href\\":\\"/cn/faq/api-issues\\"},{\\"title\\":\\"Batch API 问题\\",\\"description\\":\\"Batch API 常见问题解答\\",\\"href\\":\\"/cn/faq/batch-api-issues\\"},{\\"title\\":\\"知识库问题\\",\\"description\\":\\"知识库问题解答\\",\\"href\\":\\"/cn/faq/knowledge-base\\"}\]},{\\"group\\":\\"财务问题\\",\\"pages\\":\[{\\"title\\":\\"费用问题\\",\\"description\\":\\"费用相关常见问题解答\\",\\"href\\":\\"/cn/faq/fee-issues\\"},{\\"title\\":\\"发票问题\\",\\"description\\":\\"发票相关常见问题解答\\",\\"href\\":\\"/cn/faq/invoice-issues\\"}\]},{\\"group\\":\\"商业授权问题\\",\\"pages\\":\[{\\"title\\":\\"商业授权申请\\",\\"description\\":\\"商业授权申请常见问题解答\\",\\"href\\":\\"/cn/faq/business-authorization\\"}\]}\]}\]},\\"legacyThemeSettings\\":{\\"isSidePrimaryNav\\":false,\\"isSolidSidenav\\":false,\\"isTopbarGradient\\":false,\\"isSearchAtSidebar\\":false,\\"shouldUseTabsInTopNav\\":false,\\"sidebarStyle\\":\\"container\\",\\"rounded\\":\\"default\\"}},\\"children\\":\\"$L33\\"}\]}\]}\]}\]\]}\]\\n"\])self.\_\_next\_f.push(\[1,"34:I\[74190,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"803\\",\\"static/chunks/cd24890f-e1794187b185fa8f.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"5157\\",\\"static/chunks/5157-873f9d3c1759de0b.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"7728\\",\\"static/chunks/7728-26bf4c4a9d26d130.js\\",\\"5456\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/layout-e62e55538b1b942e.js\\"\],\\"LoginButtonProvider\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"35:I\[84922,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"803\\",\\"static/chunks/cd24890f-e1794187b185fa8f.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"5157\\",\\"static/chunks/5157-873f9d3c1759de0b.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"7728\\",\\"static/chunks/7728-26bf4c4a9d26d130.js\\",\\"5456\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/layout-e62e55538b1b942e.js\\"\],\\"SidebarLoginButtonProvider\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"36:I\[93351,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"803\\",\\"static/chunks/cd24890f-e1794187b185fa8f.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"5157\\",\\"static/chunks/5157-873f9d3c1759de0b.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"7728\\",\\"static/chunks/7728-26bf4c4a9d26d130.js\\",\\"5456\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/layout-e62e55538b1b942e.js\\"\],\\"NavigationContextController\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"37:I\[80976,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"803\\",\\"static/chunks/cd24890f-e1794187b185fa8f.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"5157\\",\\"static/chunks/5157-873f9d3c1759de0b.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"7728\\",\\"static/chunks/7728-26bf4c4a9d26d130.js\\",\\"5456\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/layout-e62e55538b1b942e.js\\"\],\\"BannerProvider\\"\]\\n"\])self.\_\_next\_f.push(\[1,"38:I\[99543,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"8788\\",\\"static/chunks/271c4271-94b34610517d5e19.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"7260\\",\\"static/chunks/7260-2f74dac3fc8e4da1.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"5143\\",\\"static/chunks/5143-6dfa098ca16d5b95.js\\",\\"1398\\",\\"static/chunks/1398-3f18b33a9f298cda.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"2820\\",\\"static/chunks/2820-a1a77459d2af49c8.js\\",\\"9841\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/%5B%5B...slug%5D%5D/page-7b8c58820341dd2a.js\\"\],\\"ScrollTopScript\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"39:I\[13050,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"803\\",\\"static/chunks/cd24890f-e1794187b185fa8f.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"5157\\",\\"static/chunks/5157-873f9d3c1759de0b.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"7728\\",\\"static/chunks/7728-26bf4c4a9d26d130.js\\",\\"5456\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/layout-e62e55538b1b942e.js\\"\],\\"LocalStorageAndAnalyticsProviders\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"3a:I\[71476,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"803\\",\\"static/chunks/cd24890f-e1794187b185fa8f.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"5157\\",\\"static/chunks/5157-873f9d3c1759de0b.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"7728\\",\\"static/chunks/7728-26bf4c4a9d26d130.js\\",\\"5456\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/layout-e62e55538b1b942e.js\\"\],\\"SearchProvider\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"3b:I\[32549,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"803\\",\\"static/chunks/cd24890f-e1794187b185fa8f.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"5157\\",\\"static/chunks/5157-873f9d3c1759de0b.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"7728\\",\\"static/chunks/7728-26bf4c4a9d26d130.js\\",\\"5456\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/layout-e62e55538b1b942e.js\\"\],\\"SkipToContent\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"3c:I\[46826,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"803\\",\\"static/chunks/cd24890f-e1794187b185fa8f.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"5157\\",\\"static/chunks/5157-873f9d3c1759de0b.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"7728\\",\\"static/chunks/7728-26bf4c4a9d26d130.js\\",\\"5456\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/layout-e62e55538b1b942e.js\\"\],\\"NavScroller\\"\]\\n"\])self.\_\_next\_f.push(\[1,"3d:I\[44464,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"803\\",\\"static/chunks/cd24890f-e1794187b185fa8f.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"5157\\",\\"static/chunks/5157-873f9d3c1759de0b.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"7728\\",\\"static/chunks/7728-26bf4c4a9d26d130.js\\",\\"5456\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/layout-e62e55538b1b942e.js\\"\],\\"MainContentLayout\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"3e:I\[27791,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"803\\",\\"static/chunks/cd24890f-e1794187b185fa8f.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"5157\\",\\"static/chunks/5157-873f9d3c1759de0b.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"7728\\",\\"static/chunks/7728-26bf4c4a9d26d130.js\\",\\"5456\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/layout-e62e55538b1b942e.js\\"\],\\"ChatAssistantSheet\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"3f:I\[4400,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"8788\\",\\"static/chunks/271c4271-94b34610517d5e19.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"7260\\",\\"static/chunks/7260-2f74dac3fc8e4da1.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"5143\\",\\"static/chunks/5143-6dfa098ca16d5b95.js\\",\\"1398\\",\\"static/chunks/1398-3f18b33a9f298cda.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"2820\\",\\"static/chunks/2820-a1a77459d2af49c8.js\\",\\"9841\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/%5B%5B...slug%5D%5D/page-7b8c58820341dd2a.js\\"\],\\"TopBar\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"40:I\[71197,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"8788\\",\\"static/chunks/271c4271-94b34610517d5e19.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"7260\\",\\"static/chunks/7260-2f74dac3fc8e4da1.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"5143\\",\\"static/chunks/5143-6dfa098ca16d5b95.js\\",\\"1398\\",\\"static/chunks/1398-3f18b33a9f298cda.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"2820\\",\\"static/chunks/2820-a1a77459d2af49c8.js\\",\\"9841\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/%5B%5B...slug%5D%5D/page-7b8c58820341dd2a.js\\"\],\\"ApiReferenceProvider\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"33:\[\\"$\\",\\"$L34\\",null,{\\"children\\":\[\\"$\\",\\"$L35\\",null,{\\"children\\":\[\\"$\\",\\"$L36\\",null,{\\"children\\":\[null,\[\[\\"$\\",\\"style\\",null,{\\"children\\":\\":root {\\\\n --primary: 19 76 255;\\\\n --primary-light: 159 160 160;\\\\n --primary-dark: 19 76 255;\\\\n --background-light: 255 255 255;\\\\n --background-dark: 12 12 14;\\\\n --gray-50: 243 245 250;\\\\n --gray-100: 238 240 245;\\\\n --gray-200: 223 224 230;\\\\n --gray-300: 206 208 213;\\\\n --gray-400: 159 160 166;\\\\n --gray-500: 112 114 119;\\\\n --gray-600: 80 82 87;\\\\n --gray-700: 63 64 70;\\\\n --gray-800: 37 39 45;\\\\n --gray-900: 23 25 30;\\\\n --gray-950: 10 12 17;\\\\n }\\"}\],null,\[\\"$\\",\\"div\\",null,{\\"className\\":\\"relative antialiased text-gray-500 dark:text-gray-400\\",\\"children\\":\[\\"$\\",\\"$L37\\",null,{\\"initialBanner\\":{\\"compiledSource\\":\\"\\\\\\"use strict\\\\\\";\\\\nconst {jsx: \_jsx, jsxs: \_jsxs} = arguments\[0\];\\\\nconst {useMDXComponents: \_provideComponents} = arguments\[0\];\\\\nfunction \_createMdxContent(props) {\\\\n const \_components = {\\\\n a: \\\\\\"a\\\\\\",\\\\n p: \\\\\\"p\\\\\\",\\\\n strong: \\\\\\"strong\\\\\\",\\\\n ...\_provideComponents(),\\\\n ...props.components\\\\n };\\\\n return \_jsxs(\_components.p, {\\\\n children: \[\\\\\\"🚀 \\\\\\", \_jsx(\_components.strong, {\\\\n children: \\\\\\"GLM-4.6 代码编程专享计划\\\\\\"\\\\n }), \\\\\\" • \\\\\\", \_jsx(\_components.a, {\\\\n href: \\\\\\"https://bigmodel.cn/claude-code?utm\_source=bigModel\\u0026utm\_medium=Frontend%20Group\\u0026utm\_content=glm%20code\\u0026utm\_campaign=Platform\_Ops\\u0026\_channel\_track\_key=WW2t6PJI\\\\\\",\\\\n children: \\\\\\"限时优惠 Coding Plan ➞\\\\\\"\\\\n })\]\\\\n });\\\\n}\\\\nfunction MDXContent(props = {}) {\\\\n const {wrapper: MDXLayout} = {\\\\n ...\_provideComponents(),\\\\n ...props.components\\\\n };\\\\n return MDXLayout ? \_jsx(MDXLayout, {\\\\n ...props,\\\\n children: \_jsx(\_createMdxContent, {\\\\n ...props\\\\n })\\\\n }) : \_createMdxContent(props);\\\\n}\\\\nreturn {\\\\n default: MDXContent\\\\n};\\\\n\\",\\"frontmatter\\":{},\\"scope\\":{}},\\"config\\":\\"$13:props:children:2:props:children:props:children:props:children:props:value:docsConfig:banner\\",\\"subdomain\\":\\"zhipu-ef7018ed\\",\\"children\\":\[\[\\"$\\",\\"$L38\\",null,{\\"theme\\":\\"mint\\"}\],\[\\"$\\",\\"$L39\\",null,{\\"subdomain\\":\\"zhipu-ef7018ed\\",\\"internalAnalyticsWriteKey\\":\\"phc\_TXdpocbGVeZVm5VJmAsHTMrCofBQu3e0kN8HGMNGTVW\\",\\"org\\":{\\"plan\\":\\"hobby\\",\\"createdAt\\":\\"2025-07-18T02:35:45.667Z\\"},\\"children\\":\[\\"$\\",\\"$L3a\\",null,{\\"subdomain\\":\\"zhipu-ef7018ed\\",\\"hasChatPermissions\\":false,\\"assistantConfig\\":{},\\"children\\":\[\[\\"$\\",\\"$L3b\\",null,{}\],\[\[\\"$\\",\\"$L3c\\",null,{}\],\[\[\\"$\\",\\"$L2\\",null,{\\"parallelRouterKey\\":\\"topbar\\",\\"error\\":\\"$undefined\\",\\"errorStyles\\":\\"$undefined\\",\\"errorScripts\\":\\"$undefined\\",\\"template\\":\[\\"$\\",\\"$L4\\",null,{}\],\\"templateStyles\\":\\"$undefined\\",\\"templateScripts\\":\\"$undefined\\",\\"notFound\\":\\"$undefined\\",\\"forbidden\\":\\"$undefined\\",\\"unauthorized\\":\\"$undefined\\"}\],\[\\"$\\",\\"$L3d\\",null,{\\"children\\":\[\[\\"$\\",\\"$L2\\",null,{\\"parallelRouterKey\\":\\"children\\",\\"error\\":\\"$undefined\\",\\"errorStyles\\":\\"$undefined\\",\\"errorScripts\\":\\"$undefined\\",\\"template\\":\[\\"$\\",\\"$L4\\",null,{}\],\\"templateStyles\\":\\"$undefined\\",\\"templateScripts\\":\\"$undefined\\",\\"notFound\\":\\"$undefined\\",\\"forbidden\\":\\"$undefined\\",\\"unauthorized\\":\\"$undefined\\"}\],\[\\"$\\",\\"$L3e\\",null,{}\]\]}\]\]\]\]}\]}\]\]}\]}\]\]\]}\]}\]}\]\\n"\])self.\_\_next\_f.push(\[1,"14:\[\\"$\\",\\"$L3f\\",null,{\\"className\\":\\"peer is-not-custom peer is-not-center peer is-not-wide peer is-not-frame\\",\\"pageMetadata\\":{\\"title\\":\\"对话补全\\",\\"description\\":\\"和 \[指定模型\](/cn/guide/start/model-overview) 对话，模型根据请求给出响应。支持多种模型，支持多模态（文本、图片、音频、视频、文件），流式和非流式输出，可配置采样，温度，最大令牌数，工具调用等。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/chat/completions\\",\\"href\\":\\"/api-reference/模型-api/对话补全\\",\\"autogeneratedByOpenApi\\":true}}\]\\n"\])self.\_\_next\_f.push(\[1,"18:\[\\"$\\",\\"$L40\\",null,{\\"value\\":{\\"apiReferenceData\\":{\\"endpoint\\":{\\"title\\":\\"对话补全\\",\\"description\\":\\"和 \[指定模型\](/cn/guide/start/model-overview) 对话，模型根据请求给出响应。支持多种模型，支持多模态（文本、图片、音频、视频、文件），流式和非流式输出，可配置采样，温度，最大令牌数，工具调用等。\\",\\"path\\":\\"/paas/v4/chat/completions\\",\\"method\\":\\"post\\",\\"servers\\":\[{\\"url\\":\\"https://open.bigmodel.cn/api/\\",\\"description\\":\\"开放平台服务\\"}\],\\"request\\":{\\"security\\":\[{\\"title\\":\\"bearerAuth\\",\\"parameters\\":{\\"query\\":{},\\"header\\":{\\"Authorization\\":{\\"type\\":\\"http\\",\\"scheme\\":\\"bearer\\",\\"description\\":\\"使用以下格式进行身份验证：Bearer \[\\u003cyour api key\\u003e\](https://bigmodel.cn/usercenter/proj-mgmt/apikeys)\\"}},\\"cookie\\":{}}}\],\\"parameters\\":{\\"path\\":{},\\"query\\":{},\\"header\\":{},\\"cookie\\":{}},\\"body\\":{\\"application/json\\":{\\"schemaArray\\":\[{\\"type\\":\\"object\\",\\"properties\\":{\\"model\\":{\\"allOf\\":\[{\\"type\\":\\"string\\",\\"description\\":\\"调用的普通对话模型代码。\`GLM-4.6\` 是最新的旗舰模型系列，专为智能体应用打造的基础模型。\`GLM-4.6\` \`GLM-4.5\` 系列提供了复杂推理、超长上下文、极快推理速度等多款模型。\\",\\"example\\":\\"glm-4.6\\",\\"default\\":\\"glm-4.6\\",\\"enum\\":\[\\"glm-4.6\\",\\"glm-4.5\\",\\"glm-4.5-air\\",\\"glm-4.5-x\\",\\"glm-4.5-airx\\",\\"glm-4.5-flash\\",\\"glm-4-plus\\",\\"glm-4-air-250414\\",\\"glm-4-airx\\",\\"glm-4-flashx\\",\\"glm-4-flashx-250414\\",\\"glm-z1-air\\",\\"glm-z1-airx\\",\\"glm-z1-flash\\",\\"glm-z1-flashx\\"\]}\]},\\"messages\\":{\\"allOf\\":\[{\\"type\\":\\"array\\",\\"description\\":\\"对话消息列表，包含当前对话的完整上下文信息。每条消息都有特定的角色和内容，模型会根据这些消息生成回复。消息按时间顺序排列，支持四种角色：\`system\`（系统消息，用于设定\`AI\`的行为和角色）、\`user\`（用户消息，来自用户的输入）、\`assistant\`（助手消息，来自\`AI\`的回复）、\`tool\`（工具消息，工具调用的结果）。普通对话模型主要支持纯文本内容。注意不能只包含系统消息或助手消息。\\",\\"items\\":{\\"oneOf\\":\[{\\"title\\":\\"用户消息\\",\\"type\\":\\"object\\",\\"properties\\":{\\"role\\":{\\"type\\":\\"string\\",\\"enum\\":\[\\"user\\"\],\\"description\\":\\"消息作者的角色\\",\\"default\\":\\"user\\"},\\"content\\":{\\"type\\":\\"string\\",\\"description\\":\\"文本消息内容\\",\\"example\\":\\"What opportunities and challenges will the Chinese large model industry face in 2025?\\"}},\\"required\\":\[\\"role\\",\\"content\\"\]},{\\"title\\":\\"系统消息\\",\\"type\\":\\"object\\",\\"properties\\":{\\"role\\":{\\"type\\":\\"string\\",\\"enum\\":\[\\"system\\"\],\\"description\\":\\"消息作者的角色\\",\\"default\\":\\"system\\"},\\"content\\":{\\"type\\":\\"string\\",\\"description\\":\\"消息文本内容\\",\\"example\\":\\"You are a helpful assistant.\\"}},\\"required\\":\[\\"role\\",\\"content\\"\]},{\\"title\\":\\"助手消息\\",\\"type\\":\\"object\\",\\"description\\":\\"可包含工具调用\\",\\"properties\\":{\\"role\\":{\\"type\\":\\"string\\",\\"enum\\":\[\\"assistant\\"\],\\"description\\":\\"消息作者的角色\\",\\"default\\":\\"assistant\\"},\\"content\\":{\\"type\\":\\"string\\",\\"description\\":\\"文本消息内容\\",\\"example\\":\\"I'll help you with that analysis.\\"},\\"tool\_calls\\":{\\"type\\":\\"array\\",\\"description\\":\\"模型生成的工具调用消息。当提供此字段时，\`content\`通常为空。\\",\\"items\\":{\\"type\\":\\"object\\",\\"properties\\":{\\"id\\":{\\"type\\":\\"string\\",\\"description\\":\\"工具调用ID\\"},\\"type\\":{\\"type\\":\\"string\\",\\"description\\":\\"工具类型，支持 \`web\_search、retrieval、function\`\\",\\"enum\\":\[\\"function\\",\\"web\_search\\",\\"retrieval\\"\]},\\"function\\":{\\"type\\":\\"object\\",\\"description\\":\\"函数调用信息，当\`type\`为\`function\`时不为空\\",\\"properties\\":{\\"name\\":{\\"type\\":\\"string\\",\\"description\\":\\"函数名称\\"},\\"arguments\\":{\\"type\\":\\"string\\",\\"description\\":\\"函数参数，\`JSON\`格式字符串\\"}},\\"required\\":\[\\"name\\",\\"arguments\\"\]}},\\"required\\":\[\\"id\\",\\"type\\"\]}}},\\"required\\":\[\\"role\\"\]},{\\"title\\":\\"工具消息\\",\\"type\\":\\"object\\",\\"properties\\":{\\"role\\":{\\"type\\":\\"string\\",\\"enum\\":\[\\"tool\\"\],\\"description\\":\\"消息作者的角色\\",\\"default\\":\\"tool\\"},\\"content\\":{\\"type\\":\\"string\\",\\"description\\":\\"消息文本内容\\",\\"example\\":\\"Function executed successfully with result: ...\\"},\\"tool\_call\_id\\":{\\"type\\":\\"string\\",\\"description\\":\\"指示此消息对应的工具调用 \`ID\`\\"}},\\"required\\":\[\\"role\\",\\"content\\"\]}\]},\\"minItems\\":1}\]},\\"stream\\":{\\"allOf\\":\[{\\"type\\":\\"boolean\\",\\"example\\":false,\\"default\\":false,\\"description\\":\\"是否启用流式输出模式。默认值为 \`false\`。当设置为 \`false\` 时，模型会在生成完整响应后一次性返回所有内容，适合短文本生成和批处理场景。当设置为 \`true\` 时，模型会通过\`Server-Sent Events (SSE)\`流式返回生成的内容，用户可以实时看到文本生成过程，适合聊天对话和长文本生成场景，能提供更好的用户体验。流式输出结束时会返回 \`data: \[DONE\]\` 消息。\\"}\]},\\"thinking\\":{\\"allOf\\":\[{\\"$ref\\":\\"#/components/schemas/ChatThinking\\"}\]},\\"do\_sample\\":{\\"allOf\\":\[{\\"type\\":\\"boolean\\",\\"example\\":true,\\"default\\":true,\\"description\\":\\"是否启用采样策略来生成文本。默认值为 \`true\`。当设置为 \`true\` 时，模型会使用 \`temperature、top\_p\` 等参数进行随机采样，生成更多样化的输出；当设置为 \`false\` 时，模型总是选择概率最高的词汇，生成更确定性的输出，此时 \`temperature\` 和 \`top\_p\` 参数将被忽略。对于需要一致性和可重复性的任务（如代码生成、翻译），建议设置为 \`false\`。\\"}\]},\\"temperature\\":{\\"allOf\\":\[{\\"type\\":\\"number\\",\\"description\\":\\"采样温度，控制输出的随机性和创造性，取值范围为 \`\[0.0, 1.0\]\`，限两位小数。对于\`GLM-4.6\`系列默认值为 \`1.0\`，\`GLM-4.5\`系列默认值为 \`0.6\`，\`GLM-Z1\`系列和\`GLM-4\`系列默认值为 \`0.75\`。较高的值（如\`0.8\`）会使输出更随机、更具创造性，适合创意写作和头脑风暴；较低的值（如\`0.2\`）会使输出更稳定、更确定，适合事实性问答和代码生成。建议根据应用场景调整 \`top\_p\` 或 \`temperature\` 参数，但不要同时调整两个参数。\\",\\"format\\":\\"float\\",\\"example\\":1,\\"default\\":1,\\"minimum\\":0,\\"maximum\\":1}\]},\\"top\_p\\":{\\"allOf\\":\[{\\"type\\":\\"number\\",\\"description\\":\\"核采样（\`nucleus sampling\`）参数，是\`temperature\`采样的替代方法，取值范围为 \`(0.0, 1.0\]\`，限两位小数。对于\`GLM-4.6\` \`GLM-4.5\`系列默认值为 \`0.95\`，\`GLM-Z1\`系列和\`GLM-4\`系列默认值为 \`0.9\`。模型只考虑累积概率达到\`top\_p\`的候选词汇。例如：\`0.1\`表示只考虑前\`10%\`概率的词汇，\`0.9\`表示考虑前\`90%\`概率的词汇。较小的值会产生更集中、更一致的输出；较大的值会增加输出的多样性。建议根据应用场景调整 \`top\_p\` 或 \`temperature\` 参数，但不建议同时调整两个参数。\\",\\"format\\":\\"float\\",\\"example\\":0.95,\\"default\\":0.95,\\"minimum\\":0,\\"maximum\\":1}\]},\\"max\_tokens\\":{\\"allOf\\":\[{\\"type\\":\\"integer\\",\\"description\\":\\"模型输出的最大令牌\`token\`数量限制。\`GLM-4.6\`最大支持\`128K\`输出长度，\`GLM-4.5\`最大支持\`96K\`输出长度，\`GLM-Z1\`系列最大支持\`32K\`输出长度，建议设置不小于\`1024\`。令牌是文本的基本单位，通常\`1\`个令牌约等于\`0.75\`个英文单词或\`1.5\`个中文字符。设置合适的\`max\_tokens\`可以控制响应长度和成本，避免过长的输出。如果模型在达到\`max\_tokens\`限制前完成回答，会自然结束；如果达到限制，输出可能被截断。\\\\n默认值和最大值等更多详见 \[max\_tokens 文档\](/cn/guide/start/concept-param#max\_tokens)\\",\\"example\\":1024,\\"minimum\\":1,\\"maximum\\":131072}\]},\\"tool\_stream\\":{\\"allOf\\":\[{\\"type\\":\\"boolean\\",\\"description\\":\\"是否开启流式响应\`Function Calls\`，仅限\`GLM-4.6\`支持此参数。\\"}\]},\\"tools\\":{\\"allOf\\":\[{\\"type\\":\\"array\\",\\"description\\":\\"模型可以调用的工具列表。支持函数调用、知识库检索和网络搜索。使用此参数提供模型可以生成 \`JSON\` 输入的函数列表或配置其他工具。最多支持 \`128\` 个函数。目前 \`GLM-4\` 系列已支持所有 \`tools\`，\`GLM-4.5\` 已支持 \`web search\` 和 \`retrieval\`。\\",\\"anyOf\\":\[{\\"items\\":{\\"$ref\\":\\"#/components/schemas/FunctionToolSchema\\"}},{\\"items\\":{\\"$ref\\":\\"#/components/schemas/RetrievalToolSchema\\"}},{\\"items\\":{\\"$ref\\":\\"#/components/schemas/WebSearchToolSchema\\"}},{\\"items\\":{\\"$ref\\":\\"#/components/schemas/MCPToolSchema\\"}}\]}\]},\\"tool\_choice\\":{\\"allOf\\":\[{\\"oneOf\\":\[{\\"type\\":\\"string\\",\\"enum\\":\[\\"auto\\"\],\\"description\\":\\"用于控制模型选择调用哪个函数的方式，仅在工具类型为\`function\`时补充。默认\`auto\`且仅支持\`auto\`。\\"}\],\\"description\\":\\"控制模型如何选择工具。\\"}\]},\\"stop\\":{\\"allOf\\":\[{\\"type\\":\\"array\\",\\"description\\":\\"停止词列表，当模型生成的文本中遇到这些指定的字符串时会立即停止生成。目前仅支持单个停止词，格式为\[\\\\\\"stop\_word1\\\\\\"\]。停止词不会包含在返回的文本中。这对于控制输出格式、防止模型生成不需要的内容非常有用，例如在对话场景中可以设置\[\\\\\\"Human:\\\\\\"\]来防止模型模拟用户发言。\\",\\"items\\":{\\"type\\":\\"string\\"},\\"maxItems\\":1}\]},\\"response\_format\\":{\\"allOf\\":\[{\\"type\\":\\"object\\",\\"description\\":\\"指定模型的响应输出格式，默认为\`text\`，仅文本模型支持此字段。支持两种格式：{ \\\\\\"type\\\\\\": \\\\\\"text\\\\\\" } 表示普通文本输出模式，模型返回自然语言文本；{ \\\\\\"type\\\\\\": \\\\\\"json\_object\\\\\\" } 表示\`JSON\`输出模式，模型会返回有效的\`JSON\`格式数据，适用于结构化数据提取、\`API\`响应生成等场景。使用\`JSON\`模式时，建议在提示词中明确说明需要\`JSON\`格式输出。\\",\\"properties\\":{\\"type\\":{\\"type\\":\\"string\\",\\"enum\\":\[\\"text\\",\\"json\_object\\"\],\\"default\\":\\"text\\",\\"description\\":\\"输出格式类型：\`text\`表示普通文本输出，\`json\_object\`表示\`JSON\`格式输出\\"}},\\"required\\":\[\\"type\\"\]}\]},\\"request\_id\\":{\\"allOf\\":\[{\\"type\\":\\"string\\",\\"description\\":\\"请求唯一标识符。由用户端传递，建议使用\`UUID\`格式确保唯一性，若未提供平台将自动生成。\\"}\]},\\"user\_id\\":{\\"allOf\\":\[{\\"type\\":\\"string\\",\\"description\\":\\"终端用户的唯一标识符。\`ID\`长度要求：最少\`6\`个字符，最多\`128\`个字符，建议使用不包含敏感信息的唯一标识。\\",\\"minLength\\":6,\\"maxLength\\":128}\]}},\\"required\\":true,\\"title\\":\\"文本模型\\",\\"description\\":\\"普通对话模型请求，支持纯文本对话和工具调用\\",\\"refIdentifier\\":\\"#/components/schemas/ChatCompletionTextRequest\\",\\"requiredProperties\\":\[\\"model\\",\\"messages\\"\]},{\\"type\\":\\"object\\",\\"properties\\":{\\"model\\":{\\"allOf\\":\[{\\"type\\":\\"string\\",\\"description\\":\\"调用的视觉模型代码。\`GLM-4.5V\` 系列支持视觉理解，具备卓越的多模态理解能力。\`GLM-4.1v-thinking\` 系列支持视觉推理思考。\\",\\"example\\":\\"glm-4.5v\\",\\"default\\":\\"glm-4.5v\\",\\"enum\\":\[\\"glm-4.5v\\",\\"glm-4v-plus-0111\\",\\"glm-4v-flash\\",\\"glm-4.1v-thinking-flashx\\",\\"glm-4.1v-thinking-flash\\"\]}\]},\\"messages\\":{\\"allOf\\":\[{\\"type\\":\\"array\\",\\"description\\":\\"对话消息列表，包含当前对话的完整上下文信息。每条消息都有特定的角色和内容，模型会根据这些消息生成回复。消息按时间顺序排列，支持角色：\`system\`（系统消息，用于设定\`AI\`的行为和角色）、\`user\`（用户消息，来自用户的输入）、\`assistant\`（助手消息，来自\`AI\`的回复）。视觉模型支持纯文本和多模态内容（文本、图片、视频、文件）。注意不能只包含系统或助手消息。\\",\\"items\\":{\\"oneOf\\":\[{\\"title\\":\\"用户消息\\",\\"type\\":\\"object\\",\\"properties\\":{\\"role\\":{\\"type\\":\\"string\\",\\"enum\\":\[\\"user\\"\],\\"description\\":\\"消息作者的角色\\",\\"default\\":\\"user\\"},\\"content\\":{\\"oneOf\\":\[{\\"type\\":\\"array\\",\\"description\\":\\"多模态消息内容，支持文本、图片、文件、视频（可从上方切换至文本消息）\\",\\"items\\":{\\"$ref\\":\\"#/components/schemas/VisionMultimodalContentItem\\"}},{\\"type\\":\\"string\\",\\"description\\":\\"文本消息内容（可从上方切换至多模态消息）\\",\\"example\\":\\"What opportunities and challenges will the Chinese large model industry face in 2025?\\"}\]}},\\"required\\":\[\\"role\\",\\"content\\"\]},{\\"title\\":\\"系统消息\\",\\"type\\":\\"object\\",\\"properties\\":{\\"role\\":{\\"type\\":\\"string\\",\\"enum\\":\[\\"system\\"\],\\"description\\":\\"消息作者的角色\\",\\"default\\":\\"system\\"},\\"content\\":{\\"oneOf\\":\[{\\"type\\":\\"string\\",\\"description\\":\\"消息文本内容\\",\\"example\\":\\"You are a helpful assistant.\\"}\]}},\\"required\\":\[\\"role\\",\\"content\\"\]},{\\"title\\":\\"助手消息\\",\\"type\\":\\"object\\",\\"properties\\":{\\"role\\":{\\"type\\":\\"string\\",\\"enum\\":\[\\"assistant\\"\],\\"description\\":\\"消息作者的角色\\",\\"default\\":\\"assistant\\"},\\"content\\":{\\"oneOf\\":\[{\\"type\\":\\"string\\",\\"description\\":\\"文本消息内容\\",\\"example\\":\\"I'll help you with that analysis.\\"}\]}},\\"required\\":\[\\"role\\"\]}\]},\\"minItems\\":1}\]},\\"stream\\":{\\"allOf\\":\[{\\"type\\":\\"boolean\\",\\"example\\":false,\\"default\\":false,\\"description\\":\\"是否启用流式输出模式。默认值为 \`false\`。当设置为 \`false\` 时，模型会在生成完整响应后一次性返回所有内容，适合短文本生成和批处理场景。当设置为 \`true\` 时，模型会通过\`Server-Sent Events (SSE)\`流式返回生成的内容，用户可以实时看到文本生成过程，适合聊天对话和长文本生成场景，能提供更好的用户体验。流式输出结束时会返回 \`data: \[DONE\]\` 消息。\\"}\]},\\"thinking\\":{\\"allOf\\":\[{\\"$ref\\":\\"#/components/schemas/ChatThinking\\"}\]},\\"do\_sample\\":{\\"allOf\\":\[{\\"type\\":\\"boolean\\",\\"example\\":true,\\"default\\":true,\\"description\\":\\"是否启用采样策略来生成文本。默认值为 \`true\`。当设置为 \`true\` 时，模型会使用 \`temperature、top\_p\` 等参数进行随机采样，生成更多样化的输出；当设置为 \`false\` 时，模型总是选择概率最高的词汇，生成更确定性的输出，此时 \`temperature\` 和 \`top\_p\` 参数将被忽略。对于需要一致性和可重复性的任务（如代码生成、翻译），建议设置为 \`false\`。\\"}\]},\\"temperature\\":{\\"allOf\\":\[{\\"type\\":\\"number\\",\\"description\\":\\"采样温度，控制输出的随机性和创造性，取值范围为 \`\[0.0, 1.0\]\`，限两位小数。对于\`GLM-4.5V\`系列默认值为 \`0.8\`，\`GLM-4.1v\`系列默认值为 \`0.8\`。较高的值（如\`0.8\`）会使输出更随机、更具创造性，适合创意写作和头脑风暴；较低的值（如\`0.2\`）会使输出更稳定、更确定，适合事实性问答和代码生成。建议根据应用场景调整 \`top\_p\` 或 \`temperature\` 参数，但不要同时调整两个参数。\\",\\"format\\":\\"float\\",\\"example\\":0.8,\\"default\\":0.8,\\"minimum\\":0,\\"maximum\\":1}\]},\\"top\_p\\":{\\"allOf\\":\[{\\"type\\":\\"number\\",\\"description\\":\\"核采样（\`nucleus sampling\`）参数，是\`temperature\`采样的替代方法，取值范围为 \`\[0.0, 1.0\]\`，限两位小数。对于\`GLM-4.5V\`系列默认值为 \`0.6\`，\`GLM-4.1v\`系列默认值为 \`0.6\`。模型只考虑累积概率达到\`top\_p\`的候选词汇。例如：\`0.1\`表示只考虑前\`10%\`概率的词汇，\`0.9\`表示考虑前\`90%\`概率的词汇。较小的值会产生更集中、更一致的输出；较大的值会增加输出的多样性。建议根据应用场景调整 \`top\_p\` 或 \`temperature\` 参数，但不要同时调整两个参数。\\",\\"format\\":\\"float\\",\\"example\\":0.6,\\"default\\":0.6,\\"minimum\\":0,\\"maximum\\":1}\]},\\"max\_tokens\\":{\\"allOf\\":\[{\\"type\\":\\"integer\\",\\"description\\":\\"模型输出的最大令牌\`token\`数量限制。\`GLM-4.5V\`最大支持\`16K\`输出长度，\`GLM-4.1v\`系列最大支持\`16K\`输出长度，建议设置不小于\`1024\`。令牌是文本的基本单位，通常\`1\`个令牌约等于\`0.75\`个英文单词或\`1.5\`个中文字符。设置合适的\`max\_tokens\`可以控制响应长度和成本，避免过长的输出。如果模型在达到\`max\_tokens\`限制前完成回答，会自然结束；如果达到限制，输出可能被截断。\\\\n默认值和最大值等更多详见 \[max\_tokens 文档\](/cn/guide/start/concept-param#max\_tokens)\\",\\"example\\":1024,\\"minimum\\":1,\\"maximum\\":16384}\]},\\"stop\\":{\\"allOf\\":\[{\\"type\\":\\"array\\",\\"description\\":\\"停止词列表，当模型生成的文本中遇到这些指定的字符串时会立即停止生成。目前仅支持单个停止词，格式为\[\\\\\\"stop\_word1\\\\\\"\]。停止词不会包含在返回的文本中。这对于控制输出格式、防止模型生成不需要的内容非常有用，例如在对话场景中可以设置\[\\\\\\"Human:\\\\\\"\]来防止模型模拟用户发言。\\",\\"items\\":{\\"type\\":\\"string\\"},\\"maxItems\\":1}\]},\\"request\_id\\":{\\"allOf\\":\[{\\"type\\":\\"string\\",\\"description\\":\\"请求唯一标识符。由用户端传递，建议使用\`UUID\`格式确保唯一性，若未提供平台将自动生成。\\"}\]},\\"user\_id\\":{\\"allOf\\":\[{\\"type\\":\\"string\\",\\"description\\":\\"终端用户的唯一标识符。\`ID\`长度要求：最少\`6\`个字符，最多\`128\`个字符，建议使用不包含敏感信息的唯一标识。\\",\\"minLength\\":6,\\"maxLength\\":128}\]}},\\"required\\":true,\\"title\\":\\"视觉模型\\",\\"description\\":\\"视觉模型请求，支持多模态内容（文本、图片、视频、文件）\\",\\"refIdentifier\\":\\"#/components/schemas/ChatCompletionVisionRequest\\",\\"requiredProperties\\":\[\\"model\\",\\"messages\\"\]},{\\"type\\":\\"object\\",\\"properties\\":{\\"model\\":{\\"allOf\\":\[{\\"type\\":\\"string\\",\\"description\\":\\"调用的音频模型代码。\`GLM-4-Voice\` 支持语音理解和生成。\\",\\"example\\":\\"glm-4-voice\\",\\"default\\":\\"glm-4-voice\\",\\"enum\\":\[\\"glm-4-voice\\",\\"禁用仅占位\\"\]}\]},\\"messages\\":{\\"allOf\\":\[{\\"type\\":\\"array\\",\\"description\\":\\"对话消息列表，包含当前对话的完整上下文信息。每条消息都有特定的角色和内容，模型会根据这些消息生成回复。消息按时间顺序排列，支持角色：\`system\`（系统消息，用于设定\`AI\`的行为和角色）、\`user\`（用户消息，来自用户的输入）、\`assistant\`（助手消息，来自\`AI\`的回复）。音频模型支持文本和音频内容。注意不能只包含系统或助手消息。\\",\\"items\\":{\\"oneOf\\":\[{\\"title\\":\\"用户消息\\",\\"type\\":\\"object\\",\\"properties\\":{\\"role\\":{\\"type\\":\\"string\\",\\"enum\\":\[\\"user\\"\],\\"description\\":\\"消息作者的角色\\",\\"default\\":\\"user\\"},\\"content\\":{\\"oneOf\\":\[{\\"type\\":\\"array\\",\\"description\\":\\"多模态消息内容，支持文本、音频\\",\\"items\\":{\\"$ref\\":\\"#/components/schemas/AudioMultimodalContentItem\\"}},{\\"type\\":\\"string\\",\\"description\\":\\"消息文本内容\\",\\"example\\":\\"You are a helpful assistant.\\"}\]}},\\"required\\":\[\\"role\\",\\"content\\"\]},{\\"title\\":\\"系统消息\\",\\"type\\":\\"object\\",\\"properties\\":{\\"role\\":{\\"type\\":\\"string\\",\\"enum\\":\[\\"system\\"\],\\"description\\":\\"消息作者的角色\\",\\"default\\":\\"system\\"},\\"content\\":{\\"type\\":\\"string\\",\\"description\\":\\"消息文本内容\\",\\"example\\":\\"你是一个专业的语音助手，能够理解和生成自然语音。\\"}},\\"required\\":\[\\"role\\",\\"content\\"\]},{\\"title\\":\\"助手消息\\",\\"type\\":\\"object\\",\\"properties\\":{\\"role\\":{\\"type\\":\\"string\\",\\"enum\\":\[\\"assistant\\"\],\\"description\\":\\"消息作者的角色\\",\\"default\\":\\"assistant\\"},\\"content\\":{\\"oneOf\\":\[{\\"type\\":\\"string\\",\\"description\\":\\"文本消息内容\\",\\"example\\":\\"I'll help you with that analysis.\\"}\]},\\"audio\\":{\\"type\\":\\"object\\",\\"description\\":\\"语音消息\\",\\"properties\\":{\\"id\\":{\\"type\\":\\"string\\",\\"description\\":\\"语音消息\`id\`，用于多轮对话\\"}}}},\\"required\\":\[\\"role\\"\]}\]},\\"minItems\\":1}\]},\\"stream\\":{\\"allOf\\":\[{\\"type\\":\\"boolean\\",\\"example\\":false,\\"default\\":false,\\"description\\":\\"是否启用流式输出模式。默认值为 \`false\`。当设置为 \`false\` 时，模型会在生成完整响应后一次性返回所有内容，适合语音识别和批处理场景。当设置为 \`true\` 时，模型会通过\`Server-Sent Events (SSE)\`流式返回生成的内容，用户可以实时看到文本生成过程，适合实时语音对话场景，能提供更好的用户体验。流式输出结束时会返回 \`data: \[DONE\]\` 消息。\\"}\]},\\"do\_sample\\":{\\"allOf\\":\[{\\"type\\":\\"boolean\\",\\"example\\":true,\\"default\\":true,\\"description\\":\\"是否启用采样策略来生成文本。默认值为 \`true\`。当设置为 \`true\` 时，模型会使用 \`temperature、top\_p\` 等参数进行随机采样，生成更多样化的输出；当设置为 \`false\` 时，模型总是选择概率最高的词汇，生成更确定性的输出，此时 \`temperature\` 和 \`top\_p\` 参数将被忽略。对于需要一致性和可重复性的任务（如语音识别、转录），建议设置为 \`false\`。\\"}\]},\\"temperature\\":{\\"allOf\\":\[{\\"type\\":\\"number\\",\\"description\\":\\"采样温度，控制输出的随机性和创造性，取值范围为 \`\[0.0, 1.0\]\`，限两位小数。对于\`GLM-4-Voice\`默认值为 \`0.8\`。较高的值（如\`0.8\`）会使输出更随机、更具创造性，适合语音生成和对话；较低的值（如\`0.1\`）会使输出更稳定、更确定，适合语音识别和转录。建议根据应用场景调整 \`top\_p\` 或 \`temperature\` 参数，但不要同时调整两个参数。\\",\\"format\\":\\"float\\",\\"example\\":0.8,\\"default\\":0.8,\\"minimum\\":0,\\"maximum\\":1}\]},\\"top\_p\\":{\\"allOf\\":\[{\\"type\\":\\"number\\",\\"description\\":\\"核采样（\`nucleus sampling\`）参数，是\`temperature\`采样的替代方法，取值范围为 \`\[0.0, 1.0\]\`，限两位小数。对于\`GLM-4-Voice\`默认值为 \`0.6\`。模型只考虑累积概率达到\`top\_p\`的候选词汇。例如：\`0.1\`表示只考虑前\`10%\`概率的词汇，\`0.9\`表示考虑前\`90%\`概率的词汇。较小的值会产生更集中、更一致的输出；较大的值会增加输出的多样性。建议根据应用场景调整 \`top\_p\` 或 \`temperature\` 参数，但不要同时调整两个参数。\\",\\"format\\":\\"float\\",\\"example\\":0.6,\\"default\\":0.6,\\"minimum\\":0,\\"maximum\\":1}\]},\\"max\_tokens\\":{\\"allOf\\":\[{\\"type\\":\\"integer\\",\\"description\\":\\"模型输出的最大令牌\`token\`数量限制。\`GLM-4-Voice\`最大支持\`4K\`输出长度，默认\`1024\`。令牌是文本的基本单位。\\",\\"example\\":1024,\\"minimum\\":1,\\"maximum\\":4096}\]},\\"watermark\_enabled\\":{\\"allOf\\":\[{\\"type\\":\\"boolean\\",\\"description\\":\\"控制\`AI\`生成图片时是否添加水印。\\\\n - \`true\`: 默认启用\`AI\`生成的显式水印及隐式数字水印，符合政策要求。\\\\n - \`false\`: 关闭所有水印，仅允许已签署免责声明的客户使用，签署路径：个人中心-安全管理-去水印管理\\",\\"example\\":true}\]},\\"stop\\":{\\"allOf\\":\[{\\"type\\":\\"array\\",\\"description\\":\\"停止词列表，当模型生成的文本中遇到这些指定的字符串时会立即停止生成。目前仅支持单个停止词，格式为\[\\\\\\"stop\_word1\\\\\\"\]。停止词不会包含在返回的文本中。这对于控制输出格式、防止模型生成不需要的内容非常有用。\\",\\"items\\":{\\"type\\":\\"string\\"},\\"maxItems\\":1}\]},\\"request\_id\\":{\\"allOf\\":\[{\\"type\\":\\"string\\",\\"description\\":\\"请求唯一标识符。由用户端传递，建议使用\`UUID\`格式确保唯一性，若未提供平台将自动生成。\\"}\]},\\"user\_id\\":{\\"allOf\\":\[{\\"type\\":\\"string\\",\\"description\\":\\"终端用户的唯一标识符。\`ID\`长度要求：最少\`6\`个字符，最多\`128\`个字符，建议使用不包含敏感信息的唯一标识。\\",\\"minLength\\":6,\\"maxLength\\":128}\]}},\\"required\\":true,\\"title\\":\\"音频模型\\",\\"description\\":\\"音频模型请求，支持语音理解、生成和识别功能\\",\\"refIdentifier\\":\\"#/components/schemas/ChatCompletionAudioRequest\\",\\"requiredProperties\\":\[\\"model\\",\\"messages\\"\]},{\\"type\\":\\"object\\",\\"properties\\":{\\"model\\":{\\"allOf\\":\[{\\"type\\":\\"string\\",\\"description\\":\\"调用的专用模型代码。\`CharGLM-4\` 是角色扮演专用模型，\`Emohaa\` 是专业心理咨询模型。\\",\\"example\\":\\"charglm-4\\",\\"default\\":\\"charglm-4\\",\\"enum\\":\[\\"charglm-4\\",\\"emohaa\\"\]}\]},\\"meta\\":{\\"allOf\\":\[{\\"type\\":\\"object\\",\\"description\\":\\"角色及用户信息数据(仅限 \`Emohaa\` 支持此参数)\\",\\"required\\":\[\\"user\_info\\",\\"bot\_info\\",\\"bot\_name\\",\\"user\_name\\"\],\\"properties\\":{\\"user\_info\\":{\\"type\\":\\"string\\",\\"description\\":\\"用户信息描述\\"},\\"bot\_info\\":{\\"type\\":\\"string\\",\\"description\\":\\"角色信息描述\\"},\\"bot\_name\\":{\\"type\\":\\"string\\",\\"description\\":\\"角色名称\\"},\\"user\_name\\":{\\"type\\":\\"string\\",\\"description\\":\\"用户名称\\"}}}\]},\\"messages\\":{\\"allOf\\":\[{\\"type\\":\\"array\\",\\"description\\":\\"对话消息列表，包含当前对话的完整上下文信息。每条消息都有特定的角色和内容，模型会根据这些消息生成回复。消息按时间顺序排列，支持角色：\`system\`（系统消息，用于设定\`AI\`的行为和角色）、\`user\`（用户消息，来自用户的输入）、\`assistant\`（助手消息，来自\`AI\`的回复）。注意不能只包含系统消息或助手消息。\\",\\"items\\":{\\"oneOf\\":\[{\\"title\\":\\"用户消息\\",\\"type\\":\\"object\\",\\"properties\\":{\\"role\\":{\\"type\\":\\"string\\",\\"enum\\":\[\\"user\\"\],\\"description\\":\\"消息作者的角色\\",\\"default\\":\\"user\\"},\\"content\\":{\\"type\\":\\"string\\",\\"description\\":\\"文本消息内容\\",\\"example\\":\\"我最近工作压力很大，经常感到焦虑，不知道该怎么办\\"}},\\"required\\":\[\\"role\\",\\"content\\"\]},{\\"title\\":\\"系统消息\\",\\"type\\":\\"object\\",\\"properties\\":{\\"role\\":{\\"type\\":\\"string\\",\\"enum\\":\[\\"system\\"\],\\"description\\":\\"消息作者的角色\\",\\"default\\":\\"system\\"},\\"content\\":{\\"type\\":\\"string\\",\\"description\\":\\"消息文本内容\\",\\"example\\":\\"你乃苏东坡。人生如梦，何不活得潇洒一些？在这忙碌纷繁的现代生活中，帮助大家找到那份属于自己的自在与豁达，共赏人生之美好\\"}},\\"required\\":\[\\"role\\",\\"content\\"\]},{\\"title\\":\\"助手消息\\",\\"type\\":\\"object\\",\\"properties\\":{\\"role\\":{\\"type\\":\\"string\\",\\"enum\\":\[\\"assistant\\"\],\\"description\\":\\"消息作者的角色\\",\\"default\\":\\"assistant\\"},\\"content\\":{\\"type\\":\\"string\\",\\"description\\":\\"文本消息内容\\",\\"example\\":\\"I'll help you with that analysis.\\"}},\\"required\\":\[\\"role\\",\\"content\\"\]}\]},\\"minItems\\":1}\]},\\"stream\\":{\\"allOf\\":\[{\\"type\\":\\"boolean\\",\\"example\\":false,\\"default\\":false,\\"description\\":\\"是否启用流式输出模式。默认值为 \`false\`。当设置为 \`fals\`e 时，模型会在生成完整响应后一次性返回所有内容，适合语音识别和批处理场景。当设置为 \`true\` 时，模型会通过\`Server-Sent Events (SSE)\`流式返回生成的内容，用户可以实时看到文本生成过程，适合实时语音对话场景，能提供更好的用户体验。流式输出结束时会返回 \`data: \[DONE\]\` 消息。\\"}\]},\\"do\_sample\\":{\\"allOf\\":\[{\\"type\\":\\"boolean\\",\\"example\\":true,\\"default\\":true,\\"description\\":\\"是否启用采样策略来生成文本。默认值为 \`true\`。当设置为 \`true\` 时，模型会使用 \`temperature、top\_p\` 等参数进行随机采样，生成更多样化的输出；当设置为 \`false\` 时，模型总是选择概率最高的词汇，生成更确定性的输出，此时 \`temperatur\`e 和 \`top\_p\` 参数将被忽略。对于需要一致性和可重复性的任务（如语音识别、转录），建议设置为 \`false\`。\\"}\]},\\"temperature\\":{\\"allOf\\":\[{\\"type\\":\\"number\\",\\"description\\":\\"采样温度，控制输出的随机性和创造性，取值范围为 \`\[0.0, 1.0\]\`，限两位小数。\`Charglm-4\` 和 \`Emohaa\` 默认值为 \`0.95\`。建议根据应用场景调整 \`top\_p\` 或 \`temperature\` 参数，但不要同时调整两个参数。\\",\\"format\\":\\"float\\",\\"example\\":0.8,\\"default\\":0.8,\\"minimum\\":0,\\"maximum\\":1}\]},\\"top\_p\\":{\\"allOf\\":\[{\\"type\\":\\"number\\",\\"description\\":\\"核采样（\`nucleus sampling\`）参数，是\`temperature\`采样的替代方法，取值范围为 \`\[0.0, 1.0\]\`，限两位小数。\`Charglm-4\` 和 \`Emohaa\` 默认值为 \`0.7\`。建议根据应用场景调整 \`top\_p\` 或 \`temperature\` 参数，但不要同时调整两个参数。\\",\\"format\\":\\"float\\",\\"example\\":0.6,\\"default\\":0.6,\\"minimum\\":0,\\"maximum\\":1}\]},\\"max\_tokens\\":{\\"allOf\\":\[{\\"type\\":\\"integer\\",\\"description\\":\\"模型输出的最大令牌\`token\`数量限制。\`Charglm-4\` 和 \`Emohaa\` 最大支持\`4K\`输出长度，默认\`1024\`。令牌是文本的基本单位。\\",\\"example\\":1024,\\"minimum\\":1,\\"maximum\\":4096}\]},\\"stop\\":{\\"allOf\\":\[{\\"type\\":\\"array\\",\\"description\\":\\"停止词列表，当模型生成的文本中遇到这些指定的字符串时会立即停止生成。目前仅支持单个停止词，格式为\[\\\\\\"stop\_word1\\\\\\"\]。停止词不会包含在返回的文本中。这对于控制输出格式、防止模型生成不需要的内容非常有用。\\",\\"items\\":{\\"type\\":\\"string\\"},\\"maxItems\\":1}\]},\\"request\_id\\":{\\"allOf\\":\[{\\"type\\":\\"string\\",\\"description\\":\\"请求唯一标识符。由用户端传递，建议使用\`UUID\`格式确保唯一性，若未提供平台将自动生成。\\"}\]},\\"user\_id\\":{\\"allOf\\":\[{\\"type\\":\\"string\\",\\"description\\":\\"终端用户的唯一标识符。\`ID\`长度要求：最少\`6\`个字符，最多\`128\`个字符，建议使用不包含敏感信息的唯一标识。\\",\\"minLength\\":6,\\"maxLength\\":128}\]}},\\"required\\":true,\\"title\\":\\"角色模型\\",\\"description\\":\\"角色扮演，专业心理咨询专用模型\\",\\"refIdentifier\\":\\"#/components/schemas/ChatCompletionHumanOidRequest\\",\\"requiredProperties\\":\[\\"model\\",\\"messages\\"\]}\],\\"examples\\":{\\"基础调用示例\\":{\\"value\\":{\\"model\\":\\"glm-4.6\\",\\"messages\\":\[{\\"role\\":\\"system\\",\\"content\\":\\"你是一个有用的AI助手。\\"},{\\"role\\":\\"user\\",\\"content\\":\\"请介绍一下人工智能的发展历程。\\"}\],\\"temperature\\":1,\\"max\_tokens\\":65536,\\"stream\\":false}},\\"流式调用示例\\":{\\"value\\":{\\"model\\":\\"glm-4.6\\",\\"messages\\":\[{\\"role\\":\\"user\\",\\"content\\":\\"写一首关于春天的诗。\\"}\],\\"temperature\\":1,\\"max\_tokens\\":65536,\\"stream\\":true}},\\"深度思考示例\\":{\\"value\\":{\\"model\\":\\"glm-4.6\\",\\"messages\\":\[{\\"role\\":\\"user\\",\\"content\\":\\"写一首关于春天的诗。\\"}\],\\"thinking\\":{\\"type\\":\\"enabled\\"},\\"stream\\":true}},\\"多轮对话示例\\":{\\"value\\":{\\"model\\":\\"glm-4.6\\",\\"messages\\":\[{\\"role\\":\\"system\\",\\"content\\":\\"你是一个专业的编程助手\\"},{\\"role\\":\\"user\\",\\"content\\":\\"什么是递归？\\"},{\\"role\\":\\"assistant\\",\\"content\\":\\"递归是一种编程技术，函数调用自身来解决问题...\\"},{\\"role\\":\\"user\\",\\"content\\":\\"能给我一个 Python 递归的例子吗？\\"}\],\\"stream\\":true}},\\"图片理解示例\\":{\\"value\\":{\\"model\\":\\"glm-4.5v\\",\\"messages\\":\[{\\"role\\":\\"user\\",\\"content\\":\[{\\"type\\":\\"image\_url\\",\\"image\_url\\":{\\"url\\":\\"https://cdn.bigmodel.cn/static/logo/register.png\\"}},{\\"type\\":\\"image\_url\\",\\"image\_url\\":{\\"url\\":\\"https://cdn.bigmodel.cn/static/logo/api-key.png\\"}},{\\"type\\":\\"text\\",\\"text\\":\\"What are the pics talk about?\\"}\]}\]}},\\"视频理解示例\\":{\\"value\\":{\\"model\\":\\"glm-4.5v\\",\\"messages\\":\[{\\"role\\":\\"user\\",\\"content\\":\[{\\"type\\":\\"video\_url\\",\\"video\_url\\":{\\"url\\":\\"https://cdn.bigmodel.cn/agent-demos/lark/113123.mov\\"}},{\\"type\\":\\"text\\",\\"text\\":\\"What are the video show about?\\"}\]}\]}},\\"文件理解示例\\":{\\"value\\":{\\"model\\":\\"glm-4.5v\\",\\"messages\\":\[{\\"role\\":\\"user\\",\\"content\\":\[{\\"type\\":\\"file\_url\\",\\"file\_url\\":{\\"url\\":\\"https://cdn.bigmodel.cn/static/demo/demo2.txt\\"}},{\\"type\\":\\"file\_url\\",\\"file\_url\\":{\\"url\\":\\"https://cdn.bigmodel.cn/static/demo/demo1.pdf\\"}},{\\"type\\":\\"text\\",\\"text\\":\\"What are the files show about?\\"}\]}\]}},\\"音频对话示例\\":{\\"value\\":{\\"model\\":\\"glm-4-voice\\",\\"messages\\":\[{\\"role\\":\\"user\\",\\"content\\":\[{\\"type\\":\\"text\\",\\"text\\":\\"你好，这是我的语音输入测试，请慢速复述一遍\\"},{\\"type\\":\\"input\_audio\\",\\"input\_audio\\":{\\"data\\":\\"base64\_voice\_xxx\\",\\"format\\":\\"wav\\"}}\]}\]}},\\"Function Call 示例\\":{\\"value\\":{\\"model\\":\\"glm-4.6\\",\\"messages\\":\[{\\"role\\":\\"user\\",\\"content\\":\\"今天北京的天气怎么样？\\"}\],\\"tools\\":\[{\\"type\\":\\"function\\",\\"function\\":{\\"name\\":\\"get\_weather\\",\\"description\\":\\"获取指定城市的天气信息\\",\\"parameters\\":{\\"type\\":\\"object\\",\\"properties\\":{\\"city\\":{\\"type\\":\\"string\\",\\"description\\":\\"城市名称\\"}},\\"required\\":\[\\"city\\"\]}}}\],\\"tool\_choice\\":\\"auto\\",\\"temperature\\":0.3}}}}}},\\"response\\":{\\"200\\":{\\"application/json\\":{\\"schemaArray\\":\[{\\"type\\":\\"object\\",\\"properties\\":{\\"id\\":{\\"allOf\\":\[{\\"description\\":\\"任务 \`ID\`\\",\\"type\\":\\"string\\"}\]},\\"request\_id\\":{\\"allOf\\":\[{\\"description\\":\\"请求 \`ID\`\\",\\"type\\":\\"string\\"}\]},\\"created\\":{\\"allOf\\":\[{\\"description\\":\\"请求创建时间，\`Unix\` 时间戳（秒）\\",\\"type\\":\\"integer\\"}\]},\\"model\\":{\\"allOf\\":\[{\\"description\\":\\"模型名称\\",\\"type\\":\\"string\\"}\]},\\"choices\\":{\\"allOf\\":\[{\\"type\\":\\"array\\",\\"description\\":\\"模型响应列表\\",\\"items\\":{\\"type\\":\\"object\\",\\"properties\\":{\\"index\\":{\\"type\\":\\"integer\\",\\"description\\":\\"结果索引\\"},\\"message\\":{\\"$ref\\":\\"#/components/schemas/ChatCompletionResponseMessage\\"},\\"finish\_reason\\":{\\"type\\":\\"string\\",\\"description\\":\\"推理终止原因。'stop’表示自然结束或触发stop词，'tool\_calls’表示模型命中函数，'length’表示达到token长度限制，'sensitive’表示内容被安全审核接口拦截（用户应判断并决定是否撤回公开内容），'network\_error’表示模型推理异常。\\"}}}}\]},\\"usage\\":{\\"allOf\\":\[{\\"type\\":\\"object\\",\\"description\\":\\"调用结束时返回的 \`Token\` 使用统计。\\",\\"properties\\":{\\"prompt\_tokens\\":{\\"type\\":\\"number\\",\\"description\\":\\"用户输入的 \`Token\` 数量。\\"},\\"completion\_tokens\\":{\\"type\\":\\"number\\",\\"description\\":\\"输出的 \`Token\` 数量\\"},\\"prompt\_tokens\_details\\":{\\"type\\":\\"object\\",\\"properties\\":{\\"cached\_tokens\\":{\\"type\\":\\"number\\",\\"description\\":\\"命中的缓存 \`Token\` 数量\\"}}},\\"total\_tokens\\":{\\"type\\":\\"integer\\",\\"description\\":\\"\`Token\` 总数，对于 \`glm-4-voice\` 模型，\`1\`秒音频=\`12.5 Tokens\`，向上取整\\"}}}\]},\\"video\_result\\":{\\"allOf\\":\[{\\"type\\":\\"array\\",\\"description\\":\\"视频生成结果。\\",\\"items\\":{\\"type\\":\\"object\\",\\"properties\\":{\\"url\\":{\\"type\\":\\"string\\",\\"description\\":\\"视频链接。\\"},\\"cover\_image\_url\\":{\\"type\\":\\"string\\",\\"description\\":\\"视频封面链接。\\"}}}}\]},\\"web\_search\\":{\\"allOf\\":\[{\\"type\\":\\"array\\",\\"description\\":\\"返回与网页搜索相关的信息，使用\`WebSearchToolSchema\`时返回\\",\\"items\\":{\\"type\\":\\"object\\",\\"properties\\":{\\"icon\\":{\\"type\\":\\"string\\",\\"description\\":\\"来源网站的图标\\"},\\"title\\":{\\"type\\":\\"string\\",\\"description\\":\\"搜索结果的标题\\"},\\"link\\":{\\"type\\":\\"string\\",\\"description\\":\\"搜索结果的网页链接\\"},\\"media\\":{\\"type\\":\\"string\\",\\"description\\":\\"搜索结果网页的媒体来源名称\\"},\\"publish\_date\\":{\\"type\\":\\"string\\",\\"description\\":\\"网站发布时间\\"},\\"content\\":{\\"type\\":\\"string\\",\\"description\\":\\"搜索结果网页引用的文本内容\\"},\\"refer\\":{\\"type\\":\\"string\\",\\"description\\":\\"角标序号\\"}}}}\]},\\"content\_filter\\":{\\"allOf\\":\[{\\"type\\":\\"array\\",\\"description\\":\\"返回内容安全的相关信息\\",\\"items\\":{\\"type\\":\\"object\\",\\"properties\\":{\\"role\\":{\\"type\\":\\"string\\",\\"description\\":\\"安全生效环节，包括 \`role = assistant\` 模型推理，\`role = user\` 用户输入，\`role = history\` 历史上下文\\"},\\"level\\":{\\"type\\":\\"integer\\",\\"description\\":\\"严重程度 \`level 0-3\`，\`level 0\`表示最严重，\`3\`表示轻微\\"}}}}\]}},\\"refIdentifier\\":\\"#/components/schemas/ChatCompletionResponse\\"}\],\\"examples\\":{\\"example\\":{\\"value\\":{\\"id\\":\\"\\u003cstring\\u003e\\",\\"request\_id\\":\\"\\u003cstring\\u003e\\",\\"created\\":123,\\"model\\":\\"\\u003cstring\\u003e\\",\\"choices\\":\[{\\"index\\":123,\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":\\"\\u003cstring\\u003e\\",\\"reasoning\_content\\":\\"\\u003cstring\\u003e\\",\\"audio\\":{\\"id\\":\\"\\u003cstring\\u003e\\",\\"data\\":\\"\\u003cstring\\u003e\\",\\"expires\_at\\":\\"\\u003cstring\\u003e\\"},\\"tool\_calls\\":\[{\\"function\\":{\\"name\\":\\"\\u003cstring\\u003e\\",\\"arguments\\":{}},\\"mcp\\":{\\"id\\":\\"\\u003cstring\\u003e\\",\\"type\\":\\"mcp\_list\_tools\\",\\"server\_label\\":\\"\\u003cstring\\u003e\\",\\"error\\":\\"\\u003cstring\\u003e\\",\\"tools\\":\[{\\"name\\":\\"\\u003cstring\\u003e\\",\\"description\\":\\"\\u003cstring\\u003e\\",\\"annotations\\":{},\\"input\_schema\\":{\\"type\\":\\"object\\",\\"properties\\":{},\\"required\\":\[\\"\\u003cany\\u003e\\"\],\\"additionalProperties\\":true}}\],\\"arguments\\":\\"\\u003cstring\\u003e\\",\\"name\\":\\"\\u003cstring\\u003e\\",\\"output\\":{}},\\"id\\":\\"\\u003cstring\\u003e\\",\\"type\\":\\"\\u003cstring\\u003e\\"}\]},\\"finish\_reason\\":\\"\\u003cstring\\u003e\\"}\],\\"usage\\":{\\"prompt\_tokens\\":123,\\"completion\_tokens\\":123,\\"prompt\_tokens\_details\\":{\\"cached\_tokens\\":123},\\"total\_tokens\\":123},\\"video\_result\\":\[{\\"url\\":\\"\\u003cstring\\u003e\\",\\"cover\_image\_url\\":\\"\\u003cstring\\u003e\\"}\],\\"web\_search\\":\[{\\"icon\\":\\"\\u003cstring\\u003e\\",\\"title\\":\\"\\u003cstring\\u003e\\",\\"link\\":\\"\\u003cstring\\u003e\\",\\"media\\":\\"\\u003cstring\\u003e\\",\\"publish\_date\\":\\"\\u003cstring\\u003e\\",\\"content\\":\\"\\u003cstring\\u003e\\",\\"refer\\":\\"\\u003cstring\\u003e\\"}\],\\"content\_filter\\":\[{\\"role\\":\\"\\u003cstring\\u003e\\",\\"level\\":123}\]}}},\\"description\\":\\"业务处理成功\\"},\\"text/event-stream\\":{\\"schemaArray\\":\[{\\"type\\":\\"object\\",\\"properties\\":{\\"id\\":{\\"allOf\\":\[{\\"type\\":\\"string\\",\\"description\\":\\"任务 ID\\"}\]},\\"created\\":{\\"allOf\\":\[{\\"type\\":\\"integer\\",\\"description\\":\\"请求创建时间，\`Unix\` 时间戳（秒）\\"}\]},\\"model\\":{\\"allOf\\":\[{\\"type\\":\\"string\\",\\"description\\":\\"模型名称\\"}\]},\\"choices\\":{\\"allOf\\":\[{\\"type\\":\\"array\\",\\"description\\":\\"模型响应列表\\",\\"items\\":{\\"type\\":\\"object\\",\\"properties\\":{\\"index\\":{\\"type\\":\\"integer\\",\\"description\\":\\"结果索引\\"},\\"delta\\":{\\"type\\":\\"object\\",\\"description\\":\\"模型增量返回的文本信息\\",\\"properties\\":{\\"role\\":{\\"type\\":\\"string\\",\\"description\\":\\"当前对话的角色，目前默认为 \`assistant\`（模型）\\"},\\"content\\":{\\"oneOf\\":\[{\\"type\\":\\"string\\",\\"description\\":\\"当前对话文本内容。如果调用函数则为 \`null\`，否则返回推理结果。\\\\n对于\`GLM-Z1\`系列模型，返回内容可能包含思考过程标签 \`\\u003cthink\\u003e \\u003c/think\\u003e\`。\\\\n对于\`GLM-4.5V\`系列模型，返回内容可能包含思考过程标签 \`\\u003cthink\\u003e \\u003c/think\\u003e\`，文本边界标签 \`\\u003c|begin\_of\_box|\\u003e \\u003c|end\_of\_box|\\u003e\`。\\"},{\\"type\\":\\"array\\",\\"description\\":\\"当前对话的多模态内容（适用于\`GLM-4V\`系列）\\",\\"items\\":{\\"type\\":\\"object\\",\\"properties\\":{\\"type\\":{\\"type\\":\\"string\\",\\"enum\\":\[\\"text\\"\],\\"description\\":\\"内容类型，目前为文本\\"},\\"text\\":{\\"type\\":\\"string\\",\\"description\\":\\"文本内容\\"}}}},{\\"type\\":\\"string\\",\\"nullable\\":true,\\"description\\":\\"当使用\`tool\_calls\`时，\`content\`可能为\`null\`\\"}\]},\\"audio\\":{\\"type\\":\\"object\\",\\"description\\":\\"当使用 \`glm-4-voice\` 模型时返回的音频内容\\",\\"properties\\":{\\"id\\":{\\"type\\":\\"string\\",\\"description\\":\\"当前对话的音频内容\`id\`，可用于多轮对话输入\\"},\\"data\\":{\\"type\\":\\"string\\",\\"description\\":\\"当前对话的音频内容\`base64\`编码\\"},\\"expires\_at\\":{\\"type\\":\\"string\\",\\"description\\":\\"当前对话的音频内容过期时间\\"}}},\\"reasoning\_content\\":{\\"type\\":\\"string\\",\\"description\\":\\"思维链内容, 仅 \`glm-4.5\` 系列支持\\"},\\"tool\_calls\\":{\\"type\\":\\"array\\",\\"description\\":\\"生成的应该被调用的工具信息，流式返回时会逐步生成\\",\\"items\\":{\\"type\\":\\"object\\",\\"properties\\":{\\"index\\":{\\"type\\":\\"integer\\",\\"description\\":\\"工具调用索引\\"},\\"id\\":{\\"type\\":\\"string\\",\\"description\\":\\"工具调用的唯一标识符\\"},\\"type\\":{\\"type\\":\\"string\\",\\"description\\":\\"工具类型，目前支持\`function\`\\",\\"enum\\":\[\\"function\\"\]},\\"function\\":{\\"type\\":\\"object\\",\\"properties\\":{\\"name\\":{\\"type\\":\\"string\\",\\"description\\":\\"函数名称\\"},\\"arguments\\":{\\"type\\":\\"string\\",\\"description\\":\\"函数参数，\`JSON\`格式字符串\\"}}}}}}}},\\"finish\_reason\\":{\\"type\\":\\"string\\",\\"description\\":\\"模型推理终止的原因。\`stop\` 表示自然结束或触发stop词，\`tool\_calls\` 表示模型命中函数，\`length\` 表示达到 \`token\` 长度限制，\`sensitive\` 表示内容被安全审核接口拦截（用户应判断并决定是否撤回公开内容），\`network\_error\` 表示模型推理异常。\\",\\"enum\\":\[\\"stop\\",\\"length\\",\\"tool\_calls\\",\\"sensitive\\",\\"network\_error\\"\]}}}}\]},\\"usage\\":{\\"allOf\\":\[{\\"type\\":\\"object\\",\\"description\\":\\"本次模型调用的 \`tokens\` 数量统计\\",\\"properties\\":{\\"prompt\_tokens\\":{\\"type\\":\\"integer\\",\\"description\\":\\"用户输入的 \`tokens\` 数量。对于 \`glm-4-voice\`，\`1\`秒音频=\`12.5 Tokens\`，向上取整。\\"},\\"completion\_tokens\\":{\\"type\\":\\"integer\\",\\"description\\":\\"模型输出的 \`tokens\` 数量\\"},\\"total\_tokens\\":{\\"type\\":\\"integer\\",\\"description\\":\\"总 \`tokens\` 数量，对于 \`glm-4-voice\` 模型，\`1\`秒音频=\`12.5 Tokens\`，向上取整\\"}}}\]},\\"content\_filter\\":{\\"allOf\\":\[{\\"type\\":\\"array\\",\\"description\\":\\"返回内容安全的相关信息\\",\\"items\\":{\\"type\\":\\"object\\",\\"properties\\":{\\"role\\":{\\"type\\":\\"string\\",\\"description\\":\\"安全生效环节，包括：\`role = assistant\` 模型推理，\`role = user\` 用户输入，\`role = history\` 历史上下文\\"},\\"level\\":{\\"type\\":\\"integer\\",\\"description\\":\\"严重程度 \`level 0-3\`，\`level 0\` 表示最严重，\`3\` 表示轻微\\"}}}}\]}},\\"refIdentifier\\":\\"#/components/schemas/ChatCompletionChunk\\"}\],\\"examples\\":{\\"example\\":{\\"value\\":{\\"id\\":\\"\\u003cstring\\u003e\\",\\"created\\":123,\\"model\\":\\"\\u003cstring\\u003e\\",\\"choices\\":\[{\\"index\\":123,\\"delta\\":{\\"role\\":\\"\\u003cstring\\u003e\\",\\"content\\":\\"\\u003cstring\\u003e\\",\\"audio\\":{\\"id\\":\\"\\u003cstring\\u003e\\",\\"data\\":\\"\\u003cstring\\u003e\\",\\"expires\_at\\":\\"\\u003cstring\\u003e\\"},\\"reasoning\_content\\":\\"\\u003cstring\\u003e\\",\\"tool\_calls\\":\[{\\"index\\":123,\\"id\\":\\"\\u003cstring\\u003e\\",\\"type\\":\\"function\\",\\"function\\":{\\"name\\":\\"\\u003cstring\\u003e\\",\\"arguments\\":\\"\\u003cstring\\u003e\\"}}\]},\\"finish\_reason\\":\\"stop\\"}\],\\"usage\\":{\\"prompt\_tokens\\":123,\\"completion\_tokens\\":123,\\"total\_tokens\\":123},\\"content\_filter\\":\[{\\"role\\":\\"\\u003cstring\\u003e\\",\\"level\\":123}\]}}},\\"description\\":\\"业务处理成功\\"}},\\"default\\":{\\"application/json\\":{\\"schemaArray\\":\[{\\"type\\":\\"object\\",\\"properties\\":{\\"error\\":{\\"allOf\\":\[{\\"required\\":\[\\"code\\",\\"message\\"\],\\"type\\":\\"object\\",\\"properties\\":{\\"code\\":{\\"type\\":\\"string\\"},\\"message\\":{\\"type\\":\\"string\\"}}}\]}},\\"refIdentifier\\":\\"#/components/schemas/Error\\"}\],\\"examples\\":{\\"example\\":{\\"value\\":{\\"error\\":{\\"code\\":\\"\\u003cstring\\u003e\\",\\"message\\":\\"\\u003cstring\\u003e\\"}}}},\\"description\\":\\"请求失败\\"}}},\\"deprecated\\":false,\\"type\\":\\"path\\"},\\"metadata\\":{\\"id\\":305323,\\"subdomain\\":\\"zhipu-ef7018ed\\",\\"filename\\":\\"openapi\\",\\"eTag\\":\\"\\\\\\"9013d3ffb34ff5f32cfdad6fa774cbde\\\\\\"\\",\\"location\\":null,\\"originalFileLocation\\":\\"openapi/openapi.json\\",\\"uploadId\\":null,\\"uuid\\":\\"7642110f-2d45-4536-a959-e945270bcd89\\",\\"versionId\\":null,\\"source\\":\\"LOCAL\_FILE\\",\\"createdAt\\":\\"2025-07-18T02:48:19.585Z\\",\\"updatedAt\\":\\"2025-09-30T06:49:37.864Z\\",\\"deletedAt\\":null},\\"componentSchemas\\":{\\"VisionMultimodalContentItem\\":{\\"oneOf\\":\[{\\"title\\":\\"文本\\",\\"type\\":\\"object\\",\\"properties\\":{\\"type\\":{\\"type\\":\\"string\\",\\"enum\\":\[\\"text\\"\],\\"description\\":\\"内容类型为文本\\",\\"default\\":\\"text\\"},\\"text\\":{\\"type\\":\\"string\\",\\"description\\":\\"文本内容\\"}},\\"required\\":\[\\"type\\",\\"text\\"\],\\"additionalProperties\\":false},{\\"title\\":\\"图片\\",\\"type\\":\\"object\\",\\"properties\\":{\\"type\\":{\\"type\\":\\"string\\",\\"enum\\":\[\\"image\_url\\"\],\\"description\\":\\"内容类型为图片\`URL\`\\",\\"default\\":\\"image\_url\\"},\\"image\_url\\":{\\"type\\":\\"object\\",\\"description\\":\\"图片信息\\",\\"properties\\":{\\"url\\":{\\"type\\":\\"string\\",\\"description\\":\\"图片的\`URL\`地址或\`Base64\`编码。图像大小上传限制为每张图像\`5M\`以下，且像素不超过\`6000\*6000\`。支持\`jpg、png、jpeg\`格式。\`GLM4.5V\` 限制\`50\`张，\`GLM-4V-Plus-0111\` 限制\`5\`张，\`GLM-4V-Flash\`限制\`1\`张图像，不支持\`Base64\`编码。\\"}},\\"required\\":\[\\"url\\"\],\\"additionalProperties\\":false}},\\"required\\":\[\\"type\\",\\"image\_url\\"\],\\"additionalProperties\\":false},{\\"title\\":\\"视频\\",\\"type\\":\\"object\\",\\"properties\\":{\\"type\\":{\\"type\\":\\"string\\",\\"enum\\":\[\\"video\_url\\"\],\\"description\\":\\"内容类型为视频输入\\",\\"default\\":\\"video\_url\\"},\\"video\_url\\":{\\"type\\":\\"object\\",\\"description\\":\\"视频信息。注意：\`GLM-4V-Plus-0111\` 的 \`video\_url\` 参数必须在 \`content\` 数组的第一位。\\",\\"properties\\":{\\"url\\":{\\"type\\":\\"string\\",\\"description\\":\\"视频的\`URL\`地址。\`GLM-4.5V\`视频大小限制为 \`200M\` 以内。\`GLM-4V-Plus\`视频大小限制为\`20M\`以内，视频时长不超过\`30s\`。对于其他多模态模型，视频大小限制为\`200M\`以内。视频类型：\`mp4\`。\\"}},\\"required\\":\[\\"url\\"\],\\"additionalProperties\\":false}},\\"required\\":\[\\"type\\",\\"video\_url\\"\],\\"additionalProperties\\":false},{\\"title\\":\\"文件\\",\\"type\\":\\"object\\",\\"properties\\":{\\"type\\":{\\"type\\":\\"string\\",\\"enum\\":\[\\"file\_url\\"\],\\"description\\":\\"内容类型为文件输入(仅\`GLM-4.5V\`支持)\\",\\"default\\":\\"file\_url\\"},\\"file\_url\\":{\\"type\\":\\"object\\",\\"description\\":\\"文件信息。\\",\\"properties\\":{\\"url\\":{\\"type\\":\\"string\\",\\"description\\":\\"文件的\`URL\`地址，不支持\`Base64\`编码。支持\`PDF、Word\`等格式，最多支持\`50\`个。\\"}},\\"required\\":\[\\"url\\"\],\\"additionalProperties\\":false}},\\"required\\":\[\\"type\\",\\"file\_url\\"\],\\"additionalProperties\\":false}\]},\\"AudioMultimodalContentItem\\":{\\"oneOf\\":\[{\\"title\\":\\"文本\\",\\"type\\":\\"object\\",\\"properties\\":{\\"type\\":{\\"type\\":\\"string\\",\\"enum\\":\[\\"text\\"\],\\"description\\":\\"内容类型为文本\\",\\"default\\":\\"text\\"},\\"text\\":{\\"type\\":\\"string\\",\\"description\\":\\"文本内容\\"}},\\"required\\":\[\\"type\\",\\"text\\"\],\\"additionalProperties\\":false},{\\"title\\":\\"音频\\",\\"type\\":\\"object\\",\\"properties\\":{\\"type\\":{\\"type\\":\\"string\\",\\"enum\\":\[\\"input\_audio\\"\],\\"description\\":\\"内容类型为音频输入\\",\\"default\\":\\"input\_audio\\"},\\"input\_audio\\":{\\"type\\":\\"object\\",\\"description\\":\\"音频信息，仅\`glm-4-voice\`支持音频输入\\",\\"properties\\":{\\"data\\":{\\"type\\":\\"string\\",\\"description\\":\\"语音文件的\`base64\`编码。音频最长不超过 \`10\` 分钟。\`1s\`音频=\`12.5 Tokens\`，向上取整。\\"},\\"format\\":{\\"type\\":\\"string\\",\\"description\\":\\"语音文件的格式，支持\`wav\`和\`mp3\`\\",\\"enum\\":\[\\"wav\\",\\"mp3\\"\]}},\\"required\\":\[\\"data\\",\\"format\\"\],\\"additionalProperties\\":false}},\\"required\\":\[\\"type\\",\\"input\_audio\\"\],\\"additionalProperties\\":false}\]},\\"FunctionToolSchema\\":{\\"type\\":\\"object\\",\\"title\\":\\"Function Call\\",\\"properties\\":{\\"type\\":{\\"type\\":\\"string\\",\\"default\\":\\"function\\",\\"enum\\":\[\\"function\\"\]},\\"function\\":{\\"$ref\\":\\"#/components/schemas/FunctionObject\\"}},\\"required\\":\[\\"type\\",\\"function\\"\],\\"additionalProperties\\":false},\\"FunctionObject\\":{\\"type\\":\\"object\\",\\"properties\\":{\\"name\\":{\\"type\\":\\"string\\",\\"description\\":\\"要调用的函数名称。必须是 \`a-z、A-Z、0-9\`，或包含下划线和破折号，最大长度为 \`64\`。\\",\\"minLength\\":1,\\"maxLength\\":64,\\"pattern\\":\\"^\[a-zA-Z0-9\_-\]+$\\"},\\"description\\":{\\"type\\":\\"string\\",\\"description\\":\\"函数功能的描述，供模型选择何时以及如何调用函数。\\"},\\"parameters\\":{\\"$ref\\":\\"#/components/schemas/FunctionParameters\\"}},\\"required\\":\[\\"name\\",\\"description\\",\\"parameters\\"\]},\\"FunctionParameters\\":{\\"type\\":\\"object\\",\\"description\\":\\"使用 \`JSON Schema\` 定义的参数。必须传递 \`JSON Schema\` 对象以准确定义接受的参数。如果调用函数时不需要参数，则省略。\\",\\"additionalProperties\\":true},\\"RetrievalToolSchema\\":{\\"type\\":\\"object\\",\\"title\\":\\"Retrieval\\",\\"properties\\":{\\"type\\":{\\"type\\":\\"string\\",\\"default\\":\\"retrieval\\",\\"enum\\":\[\\"retrieval\\"\]},\\"retrieval\\":{\\"$ref\\":\\"#/components/schemas/RetrievalObject\\"}},\\"required\\":\[\\"type\\",\\"retrieval\\"\],\\"additionalProperties\\":false},\\"RetrievalObject\\":{\\"type\\":\\"object\\",\\"properties\\":{\\"knowledge\_id\\":{\\"type\\":\\"string\\",\\"description\\":\\"知识库 \`ID\`，从平台创建或获取\\"},\\"prompt\_template\\":{\\"type\\":\\"string\\",\\"description\\":\\"请求模型的提示模板，包含占位符 \`{{ knowledge }}\` 和 \`{{ question }}\` 的自定义请求模板。默认模板：\`在文档 \`{{ knowledge }}\` 中搜索问题 \`{{question}}\` 的答案。如果找到答案，仅使用文档中的陈述进行回应；如果没有找到答案，使用你自己的知识回答并告知用户信息不来自文档。不要重复问题，直接开始答案。\`\\"}},\\"required\\":\[\\"knowledge\_id\\"\]},\\"ChatThinking\\":{\\"type\\":\\"object\\",\\"description\\":\\"仅 \`GLM-4.5\` 及以上模型支持此参数配置. 控制大模型是否开启思维链。\\",\\"properties\\":{\\"type\\":{\\"type\\":\\"string\\",\\"description\\":\\"是否开启思维链(当开启后 \`GLM-4.5\` 为模型自动判断是否思考，\`GLM-4.5V\` 为强制思考), 默认: \`enabled\`.\\",\\"default\\":\\"enabled\\",\\"enum\\":\[\\"enabled\\",\\"disabled\\"\]}}},\\"WebSearchToolSchema\\":{\\"type\\":\\"object\\",\\"title\\":\\"Web Search\\",\\"properties\\":{\\"type\\":{\\"type\\":\\"string\\",\\"default\\":\\"web\_search\\",\\"enum\\":\[\\"web\_search\\"\]},\\"web\_search\\":{\\"$ref\\":\\"#/components/schemas/WebSearchObject\\"}},\\"required\\":\[\\"type\\",\\"web\_search\\"\],\\"additionalProperties\\":false},\\"WebSearchObject\\":{\\"type\\":\\"object\\",\\"properties\\":{\\"enable\\":{\\"type\\":\\"boolean\\",\\"description\\":\\"是否启用搜索功能，默认值为 \`false\`，启用时设置为 \`true\`\\"},\\"search\_engine\\":{\\"type\\":\\"string\\",\\"description\\":\\"搜索引擎类型，默认为 \`search\_std\`；支持\`search\_std、search\_pro、search\_pro\_sogou、search\_pro\_quark\`。\\",\\"enum\\":\[\\"search\_std\\",\\"search\_pro\\",\\"search\_pro\_sogou\\",\\"search\_pro\_quark\\"\]},\\"search\_query\\":{\\"type\\":\\"string\\",\\"description\\":\\"强制触发搜索\\"},\\"search\_intent\\":{\\"type\\":\\"string\\",\\"description\\":\\"是否进行搜索意图识别，默认执行搜索意图识别。\`true\`：执行搜索意图识别，有搜索意图后执行搜索；\`false\`：跳过搜索意图识别，直接执行搜索\\"},\\"count\\":{\\"type\\":\\"integer\\",\\"description\\":\\"返回结果的条数。可填范围：\`1-50\`，最大单次搜索返回\`50\`条，默认为\`10\`。支持的搜索引擎：\`search\_std、search\_pro、search\_pro\_sogou\`。对于\`search\_pro\_sogou\`: 可选枚举值，\`10、20、30、40、50\`\\",\\"minimum\\":1,\\"maximum\\":50},\\"search\_domain\_filter\\":{\\"type\\":\\"string\\",\\"description\\":\\"用于限定搜索结果的范围，仅返回指定白名单域名的内容。\\\\n白名单域名:（如 \`www.example.com\`）。\\\\n支持的搜索引擎：\`search\_std、search\_pro、search\_pro\_sogou\`\\"},\\"search\_recency\_filter\\":{\\"type\\":\\"string\\",\\"description\\":\\"搜索指定时间范围内的网页。默认为\`noLimit\`。可填值：\`oneDay\`（一天内）、\`oneWeek\`（一周内）、\`oneMonth\`（一个月内）、\`oneYear\`（一年内）、\`noLimit\`（不限，默认）。支持的搜索引擎：\`search\_std、search\_pro、search\_pro\_sogou、search\_pro\_quark\`\\",\\"enum\\":\[\\"oneDay\\",\\"oneWeek\\",\\"oneMonth\\",\\"oneYear\\",\\"noLimit\\"\]},\\"content\_size\\":{\\"type\\":\\"string\\",\\"description\\":\\"控制网页摘要的字数。默认值为\`medium\`。\`medium\`：返回摘要信息，满足大模型的基础推理需求。\`high\`：最大化上下文，信息量较大但内容详细，适合需要信息细节的场景。\\",\\"enum\\":\[\\"medium\\",\\"high\\"\]},\\"result\_sequence\\":{\\"type\\":\\"string\\",\\"description\\":\\"指定搜索结果返回的顺序是在模型回复结果之前还是之后，可选值：\`before\`、\`after\`，默认 \`after\`\\",\\"enum\\":\[\\"before\\",\\"after\\"\]},\\"search\_result\\":{\\"type\\":\\"boolean\\",\\"description\\":\\"是否返回搜索来源的详细信息，默认值 \`false\`\\"},\\"require\_search\\":{\\"type\\":\\"boolean\\",\\"description\\":\\"是否强制搜索结果才返回回答，默认值 \`false\`\\"},\\"search\_prompt\\":{\\"type\\":\\"string\\",\\"description\\":\\"用于定制搜索结果处理的\`Prompt\`，默认\`Prompt\`：\\\\n\\\\n你是一位智能问答专家，具备整合信息的能力，能够进行时间识别、语义理解与矛盾信息清洗处理。\\\\n当前日期是{{current\_date}}，请以此时间为唯一基准，参考以下信息，全面、准确地回答用户问题。\\\\n仅提炼有价值的内容用于回答，确保答案具有实时性与权威性，直接陈述答案，无需说明数据来源或内部处理过程。\\"}},\\"required\\":\[\\"search\_engine\\"\]},\\"MCPToolSchema\\":{\\"type\\":\\"object\\",\\"title\\":\\"MCP\\",\\"properties\\":{\\"type\\":{\\"type\\":\\"string\\",\\"default\\":\\"mcp\\",\\"enum\\":\[\\"mcp\\"\]},\\"mcp\\":{\\"$ref\\":\\"#/components/schemas/MCPObject\\"}},\\"required\\":\[\\"type\\",\\"mcp\\"\],\\"additionalProperties\\":false},\\"MCPObject\\":{\\"type\\":\\"object\\",\\"properties\\":{\\"server\_label\\":{\\"description\\":\\"\`mcp server\`标识，如果连接智谱的\`mcp server\`，以\`mcp code\`填充该字段，且无需填写\`server\_url\`\\",\\"type\\":\\"string\\"},\\"server\_url\\":{\\"description\\":\\"\`mcp server\`地址\\",\\"type\\":\\"string\\"},\\"transport\_type\\":{\\"description\\":\\"传输类型\\",\\"type\\":\\"string\\",\\"default\\":\\"streamable-http\\",\\"enum\\":\[\\"sse\\",\\"streamable-http\\"\]},\\"allowed\_tools\\":{\\"description\\":\\"允许的工具集合\\",\\"type\\":\\"array\\",\\"items\\":{\\"type\\":\\"string\\"}},\\"headers\\":{\\"description\\":\\"\`mcp server\` 需要的鉴权信息\\",\\"type\\":\\"object\\"}},\\"required\\":\[\\"server\_label\\"\]},\\"ChatCompletionResponseMessage\\":{\\"type\\":\\"object\\",\\"properties\\":{\\"role\\":{\\"type\\":\\"string\\",\\"description\\":\\"当前对话角色，默认为 \`assistant\`\\",\\"example\\":\\"assistant\\"},\\"content\\":{\\"oneOf\\":\[{\\"type\\":\\"string\\",\\"description\\":\\"当前对话文本内容。如果调用函数则为 \`null\`，否则返回推理结果。\\\\n对于\`GLM-Z1\`系列模型，返回内容可能包含思考过程标签 \`\\u003cthink\\u003e \\u003c/think\\u003e\`。\\\\n对于\`GLM-4.5V\`系列模型，返回内容可能包含思考过程标签 \`\\u003cthink\\u003e \\u003c/think\\u003e\`，文本边界标签 \`\\u003c|begin\_of\_box|\\u003e \\u003c|end\_of\_box|\\u003e\`。\\"},{\\"type\\":\\"array\\",\\"description\\":\\"多模态回复内容，适用于\`GLM-4V\`系列模型\\",\\"items\\":{\\"type\\":\\"object\\",\\"properties\\":{\\"type\\":{\\"type\\":\\"string\\",\\"enum\\":\[\\"text\\"\],\\"description\\":\\"回复内容类型，目前为文本\\"},\\"text\\":{\\"type\\":\\"string\\",\\"description\\":\\"文本内容\\"}}}},{\\"type\\":\\"string\\",\\"nullable\\":true,\\"description\\":\\"当使用\`tool\_calls\`时，\`content\`可能为\`null\`\\"}\]},\\"reasoning\_content\\":{\\"type\\":\\"string\\",\\"description\\":\\"思维链内容，仅在使用 \`glm-4.5\` 系列, \`glm-4.1v-thinking\` 系列模型时返回。对于 \`GLM-Z1\` 系列模型，思考过程会直接在 \`content\` 字段中的 \`\\u003cthink\\u003e\` 标签中返回。\\"},\\"audio\\":{\\"type\\":\\"object\\",\\"description\\":\\"当使用 \`glm-4-voice\` 模型时返回的音频内容\\",\\"properties\\":{\\"id\\":{\\"type\\":\\"string\\",\\"description\\":\\"当前对话的音频内容\`id\`，可用于多轮对话输入\\"},\\"data\\":{\\"type\\":\\"string\\",\\"description\\":\\"当前对话的音频内容\`base64\`编码\\"},\\"expires\_at\\":{\\"type\\":\\"string\\",\\"description\\":\\"当前对话的音频内容过期时间\\"}}},\\"tool\_calls\\":{\\"type\\":\\"array\\",\\"description\\":\\"生成的应该被调用的函数名称和参数。\\",\\"items\\":{\\"$ref\\":\\"#/components/schemas/ChatCompletionResponseMessageToolCall\\"}}}},\\"ChatCompletionResponseMessageToolCall\\":{\\"type\\":\\"object\\",\\"properties\\":{\\"function\\":{\\"type\\":\\"object\\",\\"description\\":\\"包含生成的函数名称和 \`JSON\` 格式参数。\\",\\"properties\\":{\\"name\\":{\\"type\\":\\"string\\",\\"description\\":\\"生成的函数名称。\\"},\\"arguments\\":{\\"type\\":\\"object\\",\\"description\\":\\"生成的函数调用参数的 \`JSON\` 格式。调用函数前请验证参数。\\"}},\\"required\\":\[\\"name\\",\\"arguments\\"\]},\\"mcp\\":{\\"type\\":\\"object\\",\\"description\\":\\"\`MCP\` 工具调用参数\\",\\"properties\\":{\\"id\\":{\\"description\\":\\"\`mcp\` 工具调用唯一标识\\",\\"type\\":\\"string\\"},\\"type\\":{\\"description\\":\\"工具调用类型, 例如 \`mcp\_list\_tools, mcp\_call\`\\",\\"type\\":\\"string\\",\\"enum\\":\[\\"mcp\_list\_tools\\",\\"mcp\_call\\"\]},\\"server\_label\\":{\\"description\\":\\"\`MCP\`服务器标签\\",\\"type\\":\\"string\\"},\\"error\\":{\\"description\\":\\"错误信息\\",\\"type\\":\\"string\\"},\\"tools\\":{\\"description\\":\\"\`type = mcp\_list\_tools\` 时的工具列表\\",\\"type\\":\\"array\\",\\"items\\":{\\"type\\":\\"object\\",\\"properties\\":{\\"name\\":{\\"description\\":\\"工具名称\\",\\"type\\":\\"string\\"},\\"description\\":{\\"description\\":\\"工具描述\\",\\"type\\":\\"string\\"},\\"annotations\\":{\\"description\\":\\"工具注解\\",\\"type\\":\\"object\\"},\\"input\_schema\\":{\\"description\\":\\"工具输入参数规范\\",\\"type\\":\\"object\\",\\"properties\\":{\\"type\\":{\\"description\\":\\"固定值 'object'\\",\\"type\\":\\"string\\",\\"default\\":\\"object\\",\\"enum\\":\[\\"object\\"\]},\\"properties\\":{\\"description\\":\\"参数属性定义\\",\\"type\\":\\"object\\"},\\"required\\":{\\"description\\":\\"必填属性列表\\",\\"type\\":\\"array\\",\\"items\\":{\\"type\\":\\"string\\"}},\\"additionalProperties\\":{\\"description\\":\\"是否允许额外参数\\",\\"type\\":\\"boolean\\"}}}}}},\\"arguments\\":{\\"description\\":\\"工具调用参数，参数为 \`json\` 字符串\\",\\"type\\":\\"string\\"},\\"name\\":{\\"description\\":\\"工具名称\\",\\"type\\":\\"string\\"},\\"output\\":{\\"description\\":\\"工具返回的结果输出\\",\\"type\\":\\"object\\"}}},\\"id\\":{\\"type\\":\\"string\\",\\"description\\":\\"命中函数的唯一标识符。\\"},\\"type\\":{\\"type\\":\\"string\\",\\"description\\":\\"调用的工具类型，目前仅支持 'function', 'mcp'。\\"}}}}}},\\"children\\":\\"$L41\\"}\]\\n"\])self.\_\_next\_f.push(\[1,"42:I\[71197,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"8788\\",\\"static/chunks/271c4271-94b34610517d5e19.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"7260\\",\\"static/chunks/7260-2f74dac3fc8e4da1.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"5143\\",\\"static/chunks/5143-6dfa098ca16d5b95.js\\",\\"1398\\",\\"static/chunks/1398-3f18b33a9f298cda.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"2820\\",\\"static/chunks/2820-a1a77459d2af49c8.js\\",\\"9841\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/%5B%5B...slug%5D%5D/page-7b8c58820341dd2a.js\\"\],\\"PageProvider\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"43:I\[99543,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"8788\\",\\"static/chunks/271c4271-94b34610517d5e19.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"7260\\",\\"static/chunks/7260-2f74dac3fc8e4da1.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"5143\\",\\"static/chunks/5143-6dfa098ca16d5b95.js\\",\\"1398\\",\\"static/chunks/1398-3f18b33a9f298cda.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"2820\\",\\"static/chunks/2820-a1a77459d2af49c8.js\\",\\"9841\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/%5B%5B...slug%5D%5D/page-7b8c58820341dd2a.js\\"\],\\"FooterAndSidebarScrollScript\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"45:I\[35319,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"8788\\",\\"static/chunks/271c4271-94b34610517d5e19.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"7260\\",\\"static/chunks/7260-2f74dac3fc8e4da1.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"5143\\",\\"static/chunks/5143-6dfa098ca16d5b95.js\\",\\"1398\\",\\"static/chunks/1398-3f18b33a9f298cda.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"2820\\",\\"static/chunks/2820-a1a77459d2af49c8.js\\",\\"9841\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/%5B%5B...slug%5D%5D/page-7b8c58820341dd2a.js\\"\],\\"MDXContentProvider\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"46:I\[86022,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"8788\\",\\"static/chunks/271c4271-94b34610517d5e19.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"7260\\",\\"static/chunks/7260-2f74dac3fc8e4da1.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"5143\\",\\"static/chunks/5143-6dfa098ca16d5b95.js\\",\\"1398\\",\\"static/chunks/1398-3f18b33a9f298cda.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"2820\\",\\"static/chunks/2820-a1a77459d2af49c8.js\\",\\"9841\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/%5B%5B...slug%5D%5D/page-7b8c58820341dd2a.js\\"\],\\"ContainerWrapper\\"\]\\n"\])self.\_\_next\_f.push(\[1,"47:I\[93010,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"8788\\",\\"static/chunks/271c4271-94b34610517d5e19.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"7260\\",\\"static/chunks/7260-2f74dac3fc8e4da1.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"5143\\",\\"static/chunks/5143-6dfa098ca16d5b95.js\\",\\"1398\\",\\"static/chunks/1398-3f18b33a9f298cda.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"2820\\",\\"static/chunks/2820-a1a77459d2af49c8.js\\",\\"9841\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/%5B%5B...slug%5D%5D/page-7b8c58820341dd2a.js\\"\],\\"SidePanel\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"44:T62e,"\])self.\_\_next\_f.push(\[1,"#footer div:last-child {\\n display: none;\\n}\\n\\n/\* 表格样式优化 \*/\\n.table-container {\\n overflow-x: auto;\\n margin: 20px 0;\\n border: 1px solid #e1e5e9;\\n border-radius: 4px;\\n}\\n\\ntable {\\n width: 100%;\\n min-width: 600px; /\* 设置最小宽度确保表格不会过度压缩 \*/\\n border-collapse: collapse;\\n margin: 0;\\n font-size: 14px;\\n line-height: 1.6;\\n}\\n\\ntable th,\\ntable td {\\n padding: 12px 8px;\\n min-width: 80px;\\n border: 1px solid #e1e5e9;\\n vertical-align: top;\\n word-wrap: break-word;\\n}\\n\\n/\* 第一列增加左内边距 \*/\\ntable th:first-child,\\ntable td:first-child {\\n padding-left: 8px;\\n}\\n\\ntable th {\\n font-weight: 600;\\n text-align: center;\\n}\\n\\n.prose :where(thead th):not(:where(\[class~=not-prose\],\[class~=not-prose\] \*)) {\\n padding-top: 8px;\\n}\\n\\n/\* 响应式表格 \*/\\n@media (max-width: 768px) {\\n .table-container {\\n margin: 15px 0;\\n }\\n \\n table {\\n font-size: 12px;\\n min-width: 600px; /\* 移动端也保持最小宽度 \*/\\n }\\n \\n table th,\\n table td {\\n padding: 8px 4px;\\n white-space: nowrap; /\* 防止文字换行导致表格变形 \*/\\n }\\n}\\n\\n/\*\* banner \*\*/\\n\\n.md\\\\:h-10 {\\n height: 3rem;\\n}\\n\\n.bg-primary-dark {\\n background-color: #134cff1a;\\n}\\n\\n.prose-dark :where(a):not(:where(\[class~=not-prose\],\[class~=not-prose\] \*)) {\\n color: #134CFF;\\n font-weight: 900;\\n}\\n\\n.prose-dark :where(strong):not(:where(\[class~=not-prose\],\[class~=not-prose\] \*)) {\\n color: #3b2f2f;\\n font-weight: 900;\\n}\\n\\n.\\\\\[\\\\\\u0026\\\\\\u003e\\\\\*\\\\\]\\\\:text-white\\\\/90\\u003e\* {\\n color: #3b2f2f;\\n}\\n\\n/\*\* banner \*\*/"\])self.\_\_next\_f.push(\[1,"41:\[\\"$\\",\\"$L42\\",null,{\\"value\\":{\\"pageMetadata\\":{\\"title\\":\\"对话补全\\",\\"description\\":\\"和 \[指定模型\](/cn/guide/start/model-overview) 对话，模型根据请求给出响应。支持多种模型，支持多模态（文本、图片、音频、视频、文件），流式和非流式输出，可配置采样，温度，最大令牌数，工具调用等。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/chat/completions\\",\\"href\\":\\"/api-reference/模型-api/对话补全\\",\\"autogeneratedByOpenApi\\":true},\\"description\\":{\\"compiledSource\\":\\"\\\\\\"use strict\\\\\\";\\\\nconst {jsx: \_jsx, jsxs: \_jsxs} = arguments\[0\];\\\\nconst {useMDXComponents: \_provideComponents} = arguments\[0\];\\\\nfunction \_createMdxContent(props) {\\\\n const \_components = {\\\\n a: \\\\\\"a\\\\\\",\\\\n p: \\\\\\"p\\\\\\",\\\\n ...\_provideComponents(),\\\\n ...props.components\\\\n };\\\\n return \_jsxs(\_components.p, {\\\\n children: \[\\\\\\"和 \\\\\\", \_jsx(\_components.a, {\\\\n href: \\\\\\"/cn/guide/start/model-overview\\\\\\",\\\\n children: \\\\\\"指定模型\\\\\\"\\\\n }), \\\\\\" 对话，模型根据请求给出响应。支持多种模型，支持多模态（文本、图片、音频、视频、文件），流式和非流式输出，可配置采样，温度，最大令牌数，工具调用等。\\\\\\"\]\\\\n });\\\\n}\\\\nfunction MDXContent(props = {}) {\\\\n const {wrapper: MDXLayout} = {\\\\n ...\_provideComponents(),\\\\n ...props.components\\\\n };\\\\n return MDXLayout ? \_jsx(MDXLayout, {\\\\n ...props,\\\\n children: \_jsx(\_createMdxContent, {\\\\n ...props\\\\n })\\\\n }) : \_createMdxContent(props);\\\\n}\\\\nreturn {\\\\n default: MDXContent\\\\n};\\\\n\\",\\"frontmatter\\":{},\\"scope\\":{}},\\"mdxExtracts\\":{\\"tableOfContents\\":\[\],\\"codeExamples\\":{}},\\"pageType\\":\\"$undefined\\",\\"panelMdxSource\\":\\"$undefined\\",\\"panelMdxSourceWithNoJs\\":\\"$undefined\\"},\\"children\\":\[\[\\"$\\",\\"$L2e\\",null,{\\"id\\":\\"\_mintlify-page-mode-script\\",\\"strategy\\":\\"beforeInteractive\\",\\"dangerouslySetInnerHTML\\":{\\"\_\_html\\":\\"document.documentElement.setAttribute('data-page-mode', 'none');\\"}}\],\[\\"$\\",\\"$L43\\",null,{\\"theme\\":\\"mint\\"}\],\[\[\\"$\\",\\"span\\",null,{\\"className\\":\\"fixed inset-0 bg-background-light dark:bg-background-dark -z-10 pointer-events-none\\"}\],null,false,false\],\[\[\\"$\\",\\"style\\",\\"0\\",{\\"dangerouslySetInnerHTML\\":{\\"\_\_html\\":\\"$44\\"}}\]\],\[\],\[\[\\"$\\",\\"$L45\\",\\"api-reference/模型-api/对话补全\\",{\\"children\\":\[\\"$\\",\\"$L46\\",null,{\\"isCustom\\":false,\\"children\\":\[\[\\"$\\",\\"$L47\\",null,{}\],\[\\"$\\",\\"div\\",null,{\\"className\\":\\"relative grow box-border flex-col w-full mx-auto px-1 lg:pl-\[23.7rem\] lg:-ml-12 xl:w-\[calc(100%-28rem)\]\\",\\"id\\":\\"content-area\\",\\"children\\":\\"$L48\\"}\]\]}\]}\]\]\]}\]\\n"\])self.\_\_next\_f.push(\[1,"49:I\[10457,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"8788\\",\\"static/chunks/271c4271-94b34610517d5e19.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"7260\\",\\"static/chunks/7260-2f74dac3fc8e4da1.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"5143\\",\\"static/chunks/5143-6dfa098ca16d5b95.js\\",\\"1398\\",\\"static/chunks/1398-3f18b33a9f298cda.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"2820\\",\\"static/chunks/2820-a1a77459d2af49c8.js\\",\\"9841\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/%5B%5B...slug%5D%5D/page-7b8c58820341dd2a.js\\"\],\\"PageHeader\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"4a:I\[98959,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"8788\\",\\"static/chunks/271c4271-94b34610517d5e19.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"7260\\",\\"static/chunks/7260-2f74dac3fc8e4da1.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"5143\\",\\"static/chunks/5143-6dfa098ca16d5b95.js\\",\\"1398\\",\\"static/chunks/1398-3f18b33a9f298cda.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"2820\\",\\"static/chunks/2820-a1a77459d2af49c8.js\\",\\"9841\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/%5B%5B...slug%5D%5D/page-7b8c58820341dd2a.js\\"\],\\"MdxPanel\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"4b:I\[32907,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"8788\\",\\"static/chunks/271c4271-94b34610517d5e19.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"7260\\",\\"static/chunks/7260-2f74dac3fc8e4da1.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"5143\\",\\"static/chunks/5143-6dfa098ca16d5b95.js\\",\\"1398\\",\\"static/chunks/1398-3f18b33a9f298cda.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"2820\\",\\"static/chunks/2820-a1a77459d2af49c8.js\\",\\"9841\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/%5B%5B...slug%5D%5D/page-7b8c58820341dd2a.js\\"\],\\"Api\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"4c:I\[41270,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"8788\\",\\"static/chunks/271c4271-94b34610517d5e19.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"7260\\",\\"static/chunks/7260-2f74dac3fc8e4da1.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"5143\\",\\"static/chunks/5143-6dfa098ca16d5b95.js\\",\\"1398\\",\\"static/chunks/1398-3f18b33a9f298cda.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"2820\\",\\"static/chunks/2820-a1a77459d2af49c8.js\\",\\"9841\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/%5B%5B...slug%5D%5D/page-7b8c58820341dd2a.js\\"\],\\"default\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"4d:I\[1514,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"8788\\",\\"static/chunks/271c4271-94b34610517d5e19.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"7260\\",\\"static/chunks/7260-2f74dac3fc8e4da1.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"5143\\",\\"static/chunks/5143-6dfa098ca16d5b95.js\\",\\"1398\\",\\"static/chunks/1398-3f18b33a9f298cda.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"2820\\",\\"static/chunks/2820-a1a77459d2af49c8.js\\",\\"9841\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/%5B%5B...slug%5D%5D/page-7b8c58820341dd2a.js\\"\],\\"default\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"4e:I\[44105,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"8788\\",\\"static/chunks/271c4271-94b34610517d5e19.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"7260\\",\\"static/chunks/7260-2f74dac3fc8e4da1.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"5143\\",\\"static/chunks/5143-6dfa098ca16d5b95.js\\",\\"1398\\",\\"static/chunks/1398-3f18b33a9f298cda.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"2820\\",\\"static/chunks/2820-a1a77459d2af49c8.js\\",\\"9841\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/%5B%5B...slug%5D%5D/page-7b8c58820341dd2a.js\\"\],\\"UserFeedback\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"4f:I\[52604,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"8788\\",\\"static/chunks/271c4271-94b34610517d5e19.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"7260\\",\\"static/chunks/7260-2f74dac3fc8e4da1.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"5143\\",\\"static/chunks/5143-6dfa098ca16d5b95.js\\",\\"1398\\",\\"static/chunks/1398-3f18b33a9f298cda.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"2820\\",\\"static/chunks/2820-a1a77459d2af49c8.js\\",\\"9841\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/%5B%5B...slug%5D%5D/page-7b8c58820341dd2a.js\\"\],\\"Pagination\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"50:I\[48973,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"8788\\",\\"static/chunks/271c4271-94b34610517d5e19.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"7260\\",\\"static/chunks/7260-2f74dac3fc8e4da1.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"5143\\",\\"static/chunks/5143-6dfa098ca16d5b95.js\\",\\"1398\\",\\"static/chunks/1398-3f18b33a9f298cda.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"2820\\",\\"static/chunks/2820-a1a77459d2af49c8.js\\",\\"9841\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/%5B%5B...slug%5D%5D/page-7b8c58820341dd2a.js\\"\],\\"default\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"51:I\[16385,\[\\"3473\\",\\"static/chunks/891cff7f-2c9e6e8550c9a551.js\\",\\"1725\\",\\"static/chunks/d30757c7-de787cbe1c08669b.js\\",\\"8788\\",\\"static/chunks/271c4271-94b34610517d5e19.js\\",\\"1924\\",\\"static/chunks/1924-842b4e45a55fda6c.js\\",\\"4368\\",\\"static/chunks/4368-343e792408d92162.js\\",\\"7261\\",\\"static/chunks/7261-d416a358707b6550.js\\",\\"9612\\",\\"static/chunks/9612-721a613038e349db.js\\",\\"2264\\",\\"static/chunks/2264-3b3484ecce0ec10c.js\\",\\"4436\\",\\"static/chunks/4436-d0ce83d5e11f11de.js\\",\\"6527\\",\\"static/chunks/6527-0cfb2d96505d7cbd.js\\",\\"9242\\",\\"static/chunks/9242-3e34f8ac634357ac.js\\",\\"2864\\",\\"static/chunks/2864-04288363fc5c3c65.js\\",\\"3258\\",\\"static/chunks/3258-4939df85402d2773.js\\",\\"7498\\",\\"static/chunks/7498-d60d0260f7ab29fc.js\\",\\"7260\\",\\"static/chunks/7260-2f74dac3fc8e4da1.js\\",\\"1251\\",\\"static/chunks/1251-e86f0db42d04bc3c.js\\",\\"5907\\",\\"static/chunks/5907-e7dfd196b302058d.js\\",\\"3484\\",\\"static/chunks/3484-3ba99c7de029d5fd.js\\",\\"9319\\",\\"static/chunks/9319-76d9d7acc8378798.js\\",\\"1750\\",\\"static/chunks/1750-85b6e0b4fe2862ba.js\\",\\"5143\\",\\"static/chunks/5143-6dfa098ca16d5b95.js\\",\\"1398\\",\\"static/chunks/1398-3f18b33a9f298cda.js\\",\\"3972\\",\\"static/chunks/3972-c3112bdb66f82343.js\\",\\"2820\\",\\"static/chunks/2820-a1a77459d2af49c8.js\\",\\"9841\\",\\"static/chunks/app/%255Fsites/%5Bsubdomain%5D/(multitenant)/%5B%5B...slug%5D%5D/page-7b8c58820341dd2a.js\\"\],\\"Footer\\",1\]\\n"\])self.\_\_next\_f.push(\[1,"48:\[\[\\"$\\",\\"$L49\\",null,{}\],\[\\"$\\",\\"$L4a\\",null,{\\"mobile\\":true}\],\[\\"$\\",\\"$L4b\\",null,{}\],\[\\"$\\",\\"div\\",null,{\\"className\\":\\"mdx-content relative mt-8 mb-14 prose prose-gray dark:prose-invert\\",\\"data-page-title\\":\\"对话补全\\",\\"data-page-href\\":\\"/api-reference/模型-api/对话补全\\",\\"id\\":\\"content\\",\\"children\\":\[\[\\"$\\",\\"$L4c\\",null,{\\"mdxSource\\":{\\"compiledSource\\":\\"\\\\\\"use strict\\\\\\";\\\\nconst {Fragment: \_Fragment, jsx: \_jsx} = arguments\[0\];\\\\nconst {useMDXComponents: \_provideComponents} = arguments\[0\];\\\\nfunction \_createMdxContent(props) {\\\\n return \_jsx(\_Fragment, {});\\\\n}\\\\nfunction MDXContent(props = {}) {\\\\n const {wrapper: MDXLayout} = {\\\\n ...\_provideComponents(),\\\\n ...props.components\\\\n };\\\\n return MDXLayout ? \_jsx(MDXLayout, {\\\\n ...props,\\\\n children: \_jsx(\_createMdxContent, {\\\\n ...props\\\\n })\\\\n }) : \_createMdxContent(props);\\\\n}\\\\nreturn {\\\\n default: MDXContent\\\\n};\\\\n\\",\\"frontmatter\\":{},\\"scope\\":{\\"pageMetadata\\":{\\"title\\":\\"对话补全\\",\\"description\\":\\"和指定模型对话，模型根据请求给出响应。支持多种模型，支持多模态（文本、图片、音频、视频、文件），流式和非流式输出，可配置采样，温度，最大令牌数，工具调用等。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/chat/completions\\",\\"href\\":\\"/api-reference/模型-api/对话补全\\",\\"autogeneratedByOpenApi\\":true},\\"config\\":{}}},\\"mdxSourceWithNoJs\\":{\\"compiledSource\\":\\"\\\\\\"use strict\\\\\\";\\\\nconst {Fragment: \_Fragment, jsx: \_jsx} = arguments\[0\];\\\\nconst {useMDXComponents: \_provideComponents} = arguments\[0\];\\\\nfunction \_createMdxContent(props) {\\\\n return \_jsx(\_Fragment, {});\\\\n}\\\\nfunction MDXContent(props = {}) {\\\\n const {wrapper: MDXLayout} = {\\\\n ...\_provideComponents(),\\\\n ...props.components\\\\n };\\\\n return MDXLayout ? \_jsx(MDXLayout, {\\\\n ...props,\\\\n children: \_jsx(\_createMdxContent, {\\\\n ...props\\\\n })\\\\n }) : \_createMdxContent(props);\\\\n}\\\\nreturn {\\\\n default: MDXContent\\\\n};\\\\n\\",\\"frontmatter\\":{},\\"scope\\":{\\"pageMetadata\\":{\\"title\\":\\"对话补全\\",\\"description\\":\\"和指定模型对话，模型根据请求给出响应。支持多种模型，支持多模态（文本、图片、音频、视频、文件），流式和非流式输出，可配置采样，温度，最大令牌数，工具调用等。\\",\\"deprecated\\":null,\\"version\\":null,\\"openapi\\":\\"openapi/openapi.json post /paas/v4/chat/completions\\",\\"href\\":\\"/api-reference/模型-api/对话补全\\",\\"autogeneratedByOpenApi\\":true},\\"config\\":{}}}}\],\[\\"$\\",\\"$L4d\\",null,{}\],\\"$undefined\\"\]}\],\[\\"$\\",\\"$L4e\\",null,{}\],\[\\"$\\",\\"$L4f\\",null,{}\],\[\\"$\\",\\"$L50\\",null,{}\],\[\\"$\\",\\"$L51\\",null,{\\"className\\":\\"mt-10 sm:mt-0\\"}\]\]\\n"\])

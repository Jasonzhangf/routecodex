export const V3_REQ04_TOOL_GOVERNANCE_REVIEW_PATH = 'docs/architecture/wiki/v3-req04-tool-governance-review.md';

const SOURCE_DOCS = [
  'docs/architecture/v3-mainline-call-map.yml',
  'docs/architecture/v3-resource-operation-map.yml',
  'docs/architecture/v3-architecture-audit-locks.yml',
  'docs/architecture/wiki/v3-mainline-skeleton-sop.md',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/relay_request.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/req_chat_process_04_governed.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_chat_process_03_governed.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/resp_continuation_04_committed.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/servertool_hooks.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/request_outbound_format.rs',
  'v3/crates/routecodex-v3-runtime/src/hub_v1/anthropic_codec.rs',
];

const REQUIRED_HTML_MARKERS = [
  'Client SSE Request Start',
  'Server SSE Frame Accepted',
  'Request Normalization',
  'Tool Output Pair Normalization',
  'Continuation Owner Check',
  'Continuation Restore at Req04',
  'Merge Current Tool Surfaces',
  'Preserve Client Tool Feedback',
  'Request Tool Governance Flow',
  'Response Tool Governance Flow',
  'Request node logic',
  'Response node logic',
  'Error feedback is preserved',
  'Provider codec owns malformed provider fields',
  'Resp03 owns response governance',
  'Resp04 continuation save is Chat Process endpoint',
  'RespOutbound Client Semantic',
  'JSON to SSE Client Frame',
  'Diagnostics stay side-channel only',
];

const REQUEST_NODES = [
  {
    id: 'RQ00',
    kind: 'boundary',
    title: 'Client SSE Request Start',
    raw: 'Client HTTP/SSE /v1/responses stream=true',
    does: '客户端发出 SSE 请求；审计计时和 request lifecycle 从这里开始。',
    logic: '客户端请求 intent 是 SSE，server 对这个入口后续必须按 SSE client response 语义返回；这不等同于 provider 一定 SSE。',
  },
  {
    id: 'RQ01',
    kind: 'boundary',
    title: 'Server SSE Frame Accepted',
    raw: 'V3Server03HttpRequestRaw',
    does: 'server 接收 HTTP/SSE 请求、绑定 endpoint、request id、port/server id。',
    logic: 'server 只捕获原始请求和入口事实；不做工具配对、不修 history、不恢复 continuation。',
  },
  {
    id: 'RQ02',
    kind: 'normalize',
    title: 'Request Normalization',
    raw: 'V3HubReqInbound02Normalized',
    does: '把客户端协议请求非破坏性归一化为 Hub request normal payload。',
    logic: '只做入口协议解析、stream intent、input/messages 形状归一；不得裁剪真实 payload 或把工具输出降级成文本。',
  },
  {
    id: 'RQ03',
    kind: 'normalize',
    title: 'Tool Output Pair Normalization',
    raw: 'function_call_output / custom_tool_call_output adjacency',
    does: '归一化客户端提交的工具输出结果，并保持它和对应 tool call 的 call_id/type 关系。',
    logic: 'parse-error、unknown-tool、unsupported feedback 是客户端反馈结果；这里只归一配对关系和顺序，不删除、不补造。',
  },
  {
    id: 'RQ04',
    kind: 'boundary',
    title: 'Continuation Owner Check',
    raw: 'V3HubReqContinuation03Classified',
    does: '校验 entry protocol、continuationOwner、session/conversation、port/group scope。',
    logic: '只分类 owner/scope；不恢复 payload。owner 不匹配、entry 不匹配、scope 不匹配必须 fail-fast。',
  },
  {
    id: 'RQ05',
    kind: 'restore',
    title: 'Continuation Restore at Req04',
    raw: 'V3LocalContinuationStore::restore_at_req04',
    does: '在 request Chat Process 入口恢复上一轮 Resp04 保存的 canonical local context。',
    logic: '恢复的是 Resp04 已保存的 canonical context，不是重新读取一遍历史；恢复后只合并当前请求增量工具输出和工具 surface。',
  },
  {
    id: 'RQ06',
    kind: 'load',
    title: 'Merge Current Tool Surfaces',
    raw: 'top-level tools + input[].additional_tools.tools',
    does: '合并当前请求携带的 top-level tools 和 Codex additional_tools。',
    logic: '保留原 surface；additional_tools 是 Codex capability declaration surface，不能为了内部工具注入而 flatten/drop。',
  },
  {
    id: 'RQ07',
    kind: 'preserve',
    title: 'Preserve Client Tool Feedback',
    raw: 'function_call_output / custom output truth',
    does: '把当前客户端工具执行结果并入 governed request truth。',
    logic: '只根据显式协议字段配对 call_id/type；错误反馈是模型下一轮纠错输入，不能按错误文本删除。',
  },
  {
    id: 'RQ08',
    kind: 'inject',
    title: 'Inject Current Internal Tools',
    raw: 'reasoningStop / servertool request hook profile',
    does: '按当前 turn policy 注入 reasoningStop 等内部工具和必要 guidance。',
    logic: '最多一次；append/augment 当前 turn，不覆盖客户端工具，不清空 system/developer/user context。',
  },
  {
    id: 'RQ09',
    kind: 'emit',
    title: 'Emit Req04 Governed Request',
    raw: 'V3HubReqExecution05Planned',
    does: '把 restored context + 当前请求工具 surface + 当前工具输出结果交给 ReqExecution05。',
    logic: 'Req04 到此结束；provider wire 字段错误只能在 ReqOutbound/provider codec 修，不能在 Req04 删除 transcript truth。',
  },
];

const RESPONSE_NODES = [
  {
    id: 'RS00',
    kind: 'boundary',
    title: 'Provider Response Raw',
    raw: 'V3ProviderRespInbound01Raw',
    does: '接收 provider 原始响应 JSON/SSE 事件。',
    logic: '这里只保留 provider raw truth；不做工具治理、不解释 finish_reason、不投影 client。',
  },
  {
    id: 'RS01',
    kind: 'compat',
    title: 'Provider Response Compat',
    raw: 'ProviderRespCompat02ProviderCompat',
    does: '先做 provider-specific response compat，把上游差异映射到 Hub 可解析形状。',
    logic: 'compat 只处理 provider 协议差异；不得承担 servertool、stopless、普通工具治理。',
  },
  {
    id: 'RS02',
    kind: 'normalize',
    title: 'RespInbound Normalization',
    raw: 'V3HubRespInbound02Normalized',
    does: '把 compat 后的 provider 响应归一化成 Hub response semantic。',
    logic: '归一化只建立 Hub response 语义输入；finish_reason 分流和工具治理还不能在这里做。',
  },
  {
    id: 'RS03',
    kind: 'harvest',
    title: 'Text Harvest First',
    raw: 'Resp03 text harvest',
    does: '进入 Resp03 后先收割文本、reasoning、delta 累积片段。',
    logic: '先把文本/增量收齐，避免后续工具补齐和 finish_reason 判定基于不完整响应。',
  },
  {
    id: 'RS04',
    kind: 'repair',
    title: 'Complete / Repair Tool Frames',
    raw: 'Resp03 tool frame completion',
    does: '补齐/修正可从响应语义确定的 tool frame，例如 text-harvest 后形成完整 tool call。',
    logic: '这个阶段可能改写 finish_reason，例如从 stop 修正为 tool_call；这是 finish_reason 分流前的最后治理准备点。',
  },
  {
    id: 'RS05',
    kind: 'decision',
    title: 'Inspect finish_reason',
    raw: 'finish_reason: tool_call | stop | other',
    does: '根据补齐修复后的 finish_reason 选择响应治理路径。',
    logic: 'tool_call 和 stop 走不同 servertool hook；两条响应治理分支在 Resp03 内并行建模，但不和请求图混合。',
  },
  {
    id: 'RS06',
    kind: 'servertool',
    title: 'Tool-call Servertool Hook',
    raw: 'servertool hook under finish_reason=tool_call',
    does: '在 tool_call 分支先判断模型 tool call 是否属于 servertool/内部工具。',
    logic: 'servertool 拦截优先于普通工具治理；如果被 servertool 接管，就进入 servertool response governance，不再当普通 exec/apply_patch 处理。',
  },
  {
    id: 'RS07',
    kind: 'govern',
    title: 'Ordinary Tool Governance',
    raw: 'exec_command / apply_patch / client tool governance',
    does: 'servertool 未拦截的 tool_call 进入普通工具治理，例如 exec_command、apply_patch、客户端工具调用治理。',
    logic: '这里治理普通工具 identity、arguments、call_id、required_action/client projection 输入；不得删除客户端可见工具真相。',
  },
  {
    id: 'RS08',
    kind: 'servertool',
    title: 'Stop Servertool Hook',
    raw: 'servertool hook under finish_reason=stop',
    does: '在 stop 分支执行 stop/servertool/stopless 相关 hook。',
    logic: 'stop 下的 servertool hook 和 tool_call 下的 servertool hook 是不同入口；可治理 natural stop、reasoningStop、guard/pass-through 等响应状态。',
  },
  {
    id: 'RS09',
    kind: 'sidechannel',
    title: 'Update Runtime Control Side-Channel',
    raw: 'StoplessCenterMetadataControl',
    does: '根据 tool_call/stop 分支治理结果更新 runtime control side-channel。',
    logic: '只写 side-channel；不得把 stopless/servertool/debug/control 字段放进 provider body 或 client normal payload。',
  },
  {
    id: 'RS10',
    kind: 'govern',
    title: 'Emit Resp03 Governed Semantic',
    raw: 'V3HubRespChatProcess03Governed::output',
    does: '合流输出 Resp03 已治理的 response semantic。',
    logic: '到 Resp03 出口时响应治理完成；后续节点只能 save / project，不再解释工具语义。',
  },
  {
    id: 'RS11',
    kind: 'save',
    title: 'Resp04 Continuation Save',
    raw: 'V3HubRespContinuation04Committed',
    does: '保存 Resp03 已治理结果形成下一轮 Req04 可恢复的 canonical local context；这是 Chat Process 终点。',
    logic: 'Resp04 只 commit/release continuation；禁止重新解释响应、补工具、修 history 或注入 guidance。保存完成后才允许进入 RespOutbound。',
  },
  {
    id: 'RS12',
    kind: 'emit',
    title: 'RespOutbound Client Semantic',
    raw: 'V3HubRespOutbound05ClientSemantic',
    does: 'Chat Process 结束后，把已治理/已保存的 Hub response semantic 投影为入口协议可见的 client semantic。',
    logic: '只做 client protocol projection；不保存 continuation，不恢复请求，不吞上游错误。',
  },
  {
    id: 'RS13',
    kind: 'frame',
    title: 'JSON to SSE Client Frame',
    raw: 'V3ServerRespOutbound06ClientFrame / json2sse',
    does: '对客户端 SSE 入口，把 outbound client semantic 转成 SSE frame 并发送。',
    logic: '这是传输 framing：JSON/Semantic → SSE frame；不得再治理工具、保存 continuation 或修响应语义。',
  },
];

const NOTE_CARDS = [
  {
    title: 'Client SSE request lifecycle split from response governance',
    badge: 'split',
    text: '请求侧从 Client SSE 开始，经过 server accept、ReqInbound normalize、工具输出配对归一、continuation owner check、Req04 restore、当前请求 merge/governance；响应侧先 compat 再归一化，Resp03 内先文本收割/工具补齐，再按 finish_reason 分 tool_call/stop 两条 servertool hook 分支。两边不能混成一张图。',
  },
  {
    title: 'Error feedback is preserved',
    badge: 'request',
    text: '普通模型 tool call 和客户端 tool output 是 transcript truth。即使 output 是 parse error、unknown tool、unsupported call、schema reject 或 execution failure，也必须回给模型纠错。',
  },
  {
    title: 'No request-side artifact-removal path',
    badge: 'request',
    text: '这张小骨架不声明请求侧内部产物移除路径；没有已确认需求就不画、不实现、不锁这条边。',
  },
  {
    title: 'Resp03 owns response governance',
    badge: 'response',
    text: '响应侧 compat 和归一化之后，文本收割、工具补齐修复、finish_reason 分流、servertool hooks、普通工具治理都只能在 Resp03 做；RespOutbound/handler 不能补第二套治理。',
  },
  {
    title: 'Resp04 continuation save is Chat Process endpoint',
    badge: 'response',
    text: 'Resp04 是 Chat Process 终点：只保存 Resp03 已治理的 continuation truth。之后才进入 RespOutbound，再由 json2sse 做客户端 SSE framing。',
  },
  {
    title: 'Provider codec owns malformed provider fields',
    badge: 'owner',
    text: 'provider 因字段 shape 报错时，修 ReqOutbound / provider codec，目标是 provider-bound request 不再产生错误字段；不是在 Req04/Resp03 删除正常 transcript。',
  },
  {
    title: 'Diagnostics stay side-channel only',
    badge: 'side-channel',
    text: 'debug、metadata、stopless runtime control、snapshot 只能走 side-channel carrier；不得混进 provider body 或 client normal payload。',
  },
];

const RESOURCE_ROWS = [
  ['Client SSE request', 'Server entry / ReqInbound', 'Request lifecycle starts here; preserve client stream intent.'],
  ['Client tool output result', 'Tool Output Pair Normalization / Req04', 'Pair by explicit protocol call_id/type; preserve error feedback.'],
  ['Local continuation context', 'Resp04 save / Req04 restore', 'Save after Resp03, restore before Req04 current-turn merge; immutable between those points.'],
  ['Client tool declarations', 'Request data plane / Req04 reader', 'Preserve by default; do not delete because a provider cannot consume the exact shape.'],
  ['additional_tools', 'Codex capability declaration surface / Req04 reader', 'Preserve original Responses input surface; do not flatten or drop it for convenience.'],
  ['Provider response tool calls', 'Resp03 response governance truth', 'Classify and harvest before Resp04 commit; do not leave response governance to RespOutbound.'],
  ['Stopless runtime control', 'Metadata side-channel / StoplessCenter', 'Read at Req04, update at Resp03; never enter provider/client normal payload.'],
  ['Provider malformed fields', 'ReqOutbound / provider codec owner', 'Fix provider-bound field generation before send; do not delete transcript truth in Req04.'],
];

const CHECKLIST_ROWS = [
  ['C1', 'Request diagram starts at Client SSE Request Start.', 'Locks client-origin lifecycle.'],
  ['C2', 'Request diagram includes server accept and request normalization.', 'Locks no Req04-only shortcut.'],
  ['C3', 'Request diagram includes tool output pair normalization before continuation restore/governance.', 'Locks client tool result handling.'],
  ['C4', 'Continuation owner check is separate from continuation restore.', 'Locks owner/scope fail-fast before restore.'],
  ['C5', 'Restored canonical context is not read as raw history again.', 'Locks save/restore lifecycle semantics.'],
  ['C6', 'Req04 merges current request deltas after restore.', 'Locks current-turn merge point.'],
  ['C7', 'No request-side internal artifact-removal path is declared in this small skeleton.', 'Locks removal of unproven artifact-removal path.'],
  ['C8', 'Error feedback is preserved.', 'Locks parse-error / unknown-tool feedback preservation.'],
  ['C9', 'additional_tools reach provider-visible tools.', 'Locks Codex capability declaration surface.'],
  ['C10', 'Resp03 owns response-side tool/servertool/stopless governance.', 'Locks no handler/RespOutbound duplicate response governance.'],
  ['C11', 'Resp04 saves/commits continuation truth as the Chat Process endpoint; RespOutbound and JSON→SSE happen after it.', 'Locks Chat Process endpoint before outbound/json2sse.'],
  ['C12', 'Provider-specific malformed fields are fixed in ReqOutbound/provider codec.', 'Locks provider codec owner.'],
  ['C13', 'Metadata/debug remains side-channel only.', 'Locks normal payload purity.'],
];

const RED_FIXTURE_ROWS = [
  ['Client SSE request lifecycle begins before Req04', 'Request audit cannot omit server accept and ReqInbound normalization.'],
  ['Tool output pair normalization preserves parse-error function_call_output', 'Client tool result feedback remains model correction input.'],
  ['Continuation owner mismatch rejects before restore', 'Owner/scope check is not hidden inside restore.'],
  ['Restore canonical context then merge current deltas', 'Req04 does not read restored context as raw history again.'],
  ['Preserve malformed ordinary function_call', 'Ordinary malformed call stays transcript truth; provider codec emits legal provider shape.'],
  ['Preserve unknown-tool feedback', 'Client rejection stays feedback instead of being silently deleted.'],
  ['Reject one-sided deletion of a paired call/output', 'Call/output adjacency cannot be broken.'],
  ['Preserve additional_tools', 'Codex capability declarations remain visible.'],
  ['Classify response tool/servertool actions only in Resp03', 'Response governance cannot move to RespInbound, RespOutbound, handler, or SSE.'],
  ['Reject Resp04 semantic repair', 'Resp04 cannot reinterpret tools or fix history after Resp03.'],
  ['Keep provider malformed-field repair in codec/builder', 'Req04 cannot become provider-specific workaround layer.'],
  ['Reject metadata/control leaks into provider/client payload', 'Side-channel remains isolated.'],
];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function flowLabel(node) {
  return [
    `<b>${escapeHtml(node.title)}</b>`,
    escapeHtml(node.does),
    `<small>${escapeHtml(node.raw)}</small>`,
  ].join('<br/>');
}

function renderRequestMermaid() {
  const lines = [
    '%%{init: {"flowchart": {"htmlLabels": true, "curve": "basis", "rankSpacing": 112, "nodeSpacing": 70}, "themeVariables": {"fontSize": "21px"}} }%%',
    'flowchart TD',
    '  title_note["<b>Request Tool Governance Flow</b><br/><small>starts at client SSE request; normalizes tool outputs; restores continuation at Req04</small>"]',
  ];
  for (const node of REQUEST_NODES) lines.push(`  ${node.id}["${flowLabel(node)}"]`);
  lines.push('  title_note --> RQ00');
  lines.push('  RQ00 -->|client SSE request enters server| RQ01');
  lines.push('  RQ01 -->|bind endpoint/request/port facts| RQ02');
  lines.push('  RQ02 -->|non-destructive protocol normalization| RQ03');
  lines.push('  RQ03 -->|normalize tool output pairing and order| RQ04');
  lines.push('  RQ04 -->|owner/scope keys valid| RQ05');
  lines.push('  RQ05 -->|restore canonical context before merge| RQ06');
  lines.push('  RQ06 -->|merge current tool declarations| RQ07');
  lines.push('  RQ07 -->|preserve current client feedback truth| RQ08');
  lines.push('  RQ08 -->|exactly-one current internal tool policy| RQ09');
  lines.push(...renderClassDefs('request'));
  return lines.join('\n');
}

function renderResponseMermaid() {
  const lines = [
    '%%{init: {"flowchart": {"htmlLabels": true, "curve": "basis", "rankSpacing": 112, "nodeSpacing": 70}, "themeVariables": {"fontSize": "21px"}} }%%',
    'flowchart TD',
    '  title_note["<b>Response Tool Governance Flow</b><br/><small>Provider raw → compat → normalization → Resp03 governance → Resp04 save endpoint → outbound → json2sse</small>"]',
  ];
  for (const node of RESPONSE_NODES) lines.push(`  ${node.id}["${flowLabel(node)}"]`);
  lines.push('  title_note --> RS00');
  lines.push('  RS00 -->|provider raw enters response chain| RS01');
  lines.push('  RS01 -->|provider-specific compat first| RS02');
  lines.push('  RS02 -->|Hub normalized response enters Resp03| RS03');
  lines.push('  RS03 -->|text/reasoning/delta harvest complete| RS04');
  lines.push('  RS04 -->|finish_reason may be corrected| RS05');
  lines.push('  RS05 -->|finish_reason=tool_call| RS06');
  lines.push('  RS05 -->|finish_reason=stop| RS08');
  lines.push('  RS05 -->|other terminal / pass-through| RS10');
  lines.push('  RS06 -->|servertool intercepted| RS09');
  lines.push('  RS06 -->|not servertool| RS07');
  lines.push('  RS07 -->|ordinary tool governed| RS09');
  lines.push('  RS08 -->|stop hook governed| RS09');
  lines.push('  RS09 -->|side-channel state updated only| RS10');
  lines.push('  RS10 -->|Chat Process governed semantic complete| RS11');
  lines.push('  RS11 -->|Chat Process endpoint: continuation saved| RS12');
  lines.push('  RS12 -->|client SSE entry framing| RS13');
  lines.push(...renderClassDefs('response'));
  return lines.join('\n');
}

function renderClassDefs(prefix) {
  const classPrefix = prefix === 'request' ? 'RQ' : 'RS';
  const nodeSet = prefix === 'request' ? REQUEST_NODES : RESPONSE_NODES;
  const decisionIds = '';
  const lines = [
    '  classDef boundary fill:#eff6ff,stroke:#2563eb,stroke-width:2px,color:#172554;',
    '  classDef restore fill:#f0f9ff,stroke:#0284c7,stroke-width:2px,color:#0c4a6e;',
    '  classDef compat fill:#fff7ed,stroke:#ea580c,stroke-width:2px,color:#7c2d12;',
    '  classDef repair fill:#fef3c7,stroke:#d97706,stroke-width:2px,color:#78350f;',
    '  classDef servertool fill:#eef2ff,stroke:#4f46e5,stroke-width:2px,color:#312e81;',,
    '  classDef normalize fill:#f8fafc,stroke:#334155,stroke-width:1.5px,color:#0f172a;',
    '  classDef load fill:#f8fafc,stroke:#334155,stroke-width:1.5px,color:#0f172a;',
    '  classDef decision fill:#fef3c7,stroke:#d97706,stroke-width:2px,color:#78350f;',
    '  classDef preserve fill:#ecfdf5,stroke:#047857,stroke-width:2px,color:#064e3b;',
    '  classDef inject fill:#eef2ff,stroke:#4f46e5,stroke-width:2px,color:#312e81;',
    '  classDef govern fill:#f0fdfa,stroke:#0f766e,stroke-width:2px,color:#134e4a;',
    '  classDef classify fill:#fefce8,stroke:#ca8a04,stroke-width:2px,color:#713f12;',
    '  classDef harvest fill:#faf5ff,stroke:#9333ea,stroke-width:2px,color:#581c87;',
    '  classDef sidechannel fill:#f1f5f9,stroke:#475569,stroke-width:2px,color:#0f172a;',
    '  classDef save fill:#ecfeff,stroke:#0891b2,stroke-width:2px,color:#164e63;',
    '  classDef emit fill:#f0fdfa,stroke:#0f766e,stroke-width:2px,color:#134e4a;',
    '  classDef frame fill:#f8fafc,stroke:#64748b,stroke-width:2px,color:#0f172a;',
  ];
  for (const kind of ['boundary', 'restore', 'compat', 'normalize', 'load', 'preserve', 'inject', 'emit', 'frame', 'govern', 'classify', 'harvest', 'repair', 'servertool', 'sidechannel', 'save']) {
    const ids = nodeSet.filter((node) => node.kind === kind).map((node) => node.id);
    if (ids.length) lines.push(`  class ${ids.join(',')} ${kind};`);
  }
  if (decisionIds) lines.push(`  class ${decisionIds} decision;`);
  if (!nodeSet.some((node) => node.id.startsWith(classPrefix))) {
    throw new Error(`unexpected ${prefix} node ids`);
  }
  return lines;
}

function renderTable(headers, rows) {
  return `<table>
    <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
    <tbody>
${rows.map((row) => `      <tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`).join('\n')}
    </tbody>
  </table>`;
}

function renderSourceList() {
  return `<ul class="source-list">
${SOURCE_DOCS.map((source) => `    <li><code>${escapeHtml(source)}</code></li>`).join('\n')}
  </ul>`;
}

function renderNodeLogicCards(title, nodes) {
  return `<section class="panel">
      <h2>${escapeHtml(title)}</h2>
      <div class="logic-grid">
${nodes.map((node) => `        <article class="logic-card ${escapeHtml(node.kind)}">
          <div class="node-card-top"><span>${escapeHtml(node.id)}</span><small>${escapeHtml(node.raw)}</small></div>
          <h3>${escapeHtml(node.title)}</h3>
          <dl>
            <dt>干什么</dt><dd>${escapeHtml(node.does)}</dd>
            <dt>逻辑</dt><dd>${escapeHtml(node.logic)}</dd>
          </dl>
        </article>`).join('\n')}
      </div>
    </section>`;
}

function renderNoteCards() {
  return `<div class="note-grid">
${NOTE_CARDS.map((card) => `    <article class="note-card">
      <span class="badge">${escapeHtml(card.badge)}</span>
      <h3>${escapeHtml(card.title)}</h3>
      <p>${escapeHtml(card.text)}</p>
    </article>`).join('\n')}
  </div>`;
}

function renderInvariantList() {
  const invariants = [
    'Request lifecycle starts at Client SSE Request Start, then server accept, request normalization, tool output pair normalization, continuation owner check, Req04 restore, current-turn merge/governance, and ReqExecution handoff.',
    'Restored context is already canonical; after restore, Req04 merges only current request deltas and current tool surfaces.',
    'This small skeleton does not declare a request-side internal artifact removal path because no confirmed requirement exists.',
    'Error feedback is preserved: parse-error, unknown-tool, unsupported, schema reject, and execution failure outputs remain model correction input.',
    'Response chain runs provider raw → compat → RespInbound normalization before Resp03. Resp03 first harvests text, completes/repairs tool frames, may correct finish_reason, then branches tool_call/stop into different servertool hooks.',
    'Provider codec owns malformed provider fields; Req04/Resp03 cannot become provider-specific workaround or error projection layer.',
    'Diagnostics stay side-channel only and must not enter provider body or client normal payload.',
  ];
  return `<ol class="invariant-list">
${invariants.map((item) => `    <li>${escapeHtml(item)}</li>`).join('\n')}
  </ol>`;
}

export function auditV3Req04ToolGovernanceReviewHtmlText(htmlText, relPath = V3_REQ04_TOOL_GOVERNANCE_REVIEW_PATH) {
  const failures = [];
  for (const token of REQUIRED_HTML_MARKERS) {
    if (!htmlText.includes(token)) {
      failures.push(`${relPath}: generated tool-governance HTML missing annotation token ${token}`);
    }
  }
  const mermaidCount = (htmlText.match(/<pre class="mermaid">/g) ?? []).length;
  if (mermaidCount < 2 || !htmlText.includes('flowchart TD')) {
    failures.push(`${relPath}: generated tool-governance HTML must contain separate request and response top-down Mermaid flows`);
  }
  if (!htmlText.includes('Canonical Markdown source:')) {
    failures.push(`${relPath}: generated tool-governance HTML missing canonical markdown source`);
  }
  if (/Drop Explicit|provenance|cleanup|剥离/u.test(htmlText)) {
    failures.push(`${relPath}: generated tool-governance HTML still contains removed request artifact-removal semantics`);
  }
  return failures;
}

export function renderV3Req04ToolGovernanceReviewHtml() {
  const requestMermaid = renderRequestMermaid();
  const responseMermaid = renderResponseMermaid();
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>V3 Req04 / Resp03 Tool Governance Review</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <script>mermaid.initialize({ startOnLoad: true, theme: 'default', securityLevel: 'loose' });</script>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f1e9;
      --panel: #fffdfa;
      --ink: #172033;
      --muted: #647083;
      --line: #d8d0c2;
      --accent: #0f766e;
      --accent-dark: #134e4a;
      --accent-soft: #dff4ef;
      --danger: #be123c;
      --code: #f6f0e7;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif;
      background:
        radial-gradient(circle at 10% 0%, rgba(15, 118, 110, 0.12), transparent 30%),
        radial-gradient(circle at 90% 10%, rgba(217, 119, 6, 0.12), transparent 30%),
        linear-gradient(180deg, #fbf7ef 0%, var(--bg) 100%);
      color: var(--ink);
    }
    main { max-width: 1680px; margin: 0 auto; padding: 34px 22px 72px; }
    header.hero,
    section.panel {
      background: rgba(255, 253, 250, 0.96);
      border: 1px solid var(--line);
      border-radius: 24px;
      box-shadow: 0 18px 48px rgba(23, 32, 51, 0.08);
      padding: 28px;
      margin: 18px 0;
    }
    header.hero { background: linear-gradient(135deg, rgba(15, 118, 110, 0.14), rgba(255,253,250,0.96)); }
    .eyebrow {
      display: inline-flex;
      gap: 8px;
      align-items: center;
      padding: 6px 10px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent-dark);
      font-weight: 700;
      font-size: 0.9rem;
    }
    h1 { margin: 14px 0 10px; font-size: clamp(2.2rem, 4.8vw, 4.8rem); line-height: 0.96; letter-spacing: -0.055em; }
    h2 { margin: 0 0 14px; font-size: clamp(1.45rem, 2.6vw, 2.35rem); letter-spacing: -0.025em; }
    h3 { margin: 0 0 8px; font-size: 1.12rem; letter-spacing: -0.012em; }
    p { margin: 0; }
    code {
      font-family: "SFMono-Regular", "Menlo", "Consolas", monospace;
      font-size: 0.88em;
      background: var(--code);
      border: 1px solid rgba(216, 208, 194, 0.9);
      border-radius: 7px;
      padding: 0.08rem 0.35rem;
    }
    .hero p { color: var(--muted); font-size: 1.08rem; max-width: 1040px; line-height: 1.55; }
    .meta-row { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 18px; }
    .meta-pill {
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.74);
      border-radius: 999px;
      padding: 8px 12px;
      color: var(--muted);
      font-size: 0.92rem;
    }
    .flow-stack { display: grid; gap: 22px; }
    .flow-box { overflow-x: auto; background: linear-gradient(180deg, rgba(15,118,110,0.045), rgba(255,255,255,0.92)); border: 1px solid var(--line); border-radius: 18px; padding: 22px; }
    pre.mermaid { min-width: 1180px; margin: 0; font-size: 21px; line-height: 1.45; }
    .flow-box svg { width: 100% !important; height: auto !important; min-width: 1120px; }
    .source-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(310px, 1fr)); gap: 8px 14px; padding-left: 1.1rem; margin: 0; color: var(--muted); line-height: 1.45; }
    .invariant-list { display: grid; gap: 10px; margin: 0; padding-left: 1.25rem; line-height: 1.55; }
    .logic-grid,
    .note-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 14px; }
    .logic-card,
    .note-card { border: 1px solid var(--line); border-radius: 18px; background: white; padding: 16px; min-height: 168px; }
    .logic-card p,
    .note-card p { color: var(--muted); line-height: 1.5; }
    .node-card-top { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 12px; color: var(--muted); font-family: "SFMono-Regular", "Menlo", "Consolas", monospace; font-size: 0.78rem; }
    .logic-card.boundary { border-top: 5px solid #2563eb; }
    .logic-card.restore { border-top: 5px solid #0284c7; }
    .logic-card.normalize { border-top: 5px solid #334155; }
    .logic-card.load { border-top: 5px solid #334155; }
    .logic-card.classify { border-top: 5px solid #d97706; }
    .logic-card.preserve { border-top: 5px solid #047857; }
    .logic-card.inject { border-top: 5px solid #4f46e5; }
    .logic-card.govern,
    .logic-card.emit { border-top: 5px solid var(--accent); }
    .logic-card.harvest { border-top: 5px solid #9333ea; }
    .logic-card.sidechannel { border-top: 5px solid #475569; }
    .logic-card.save { border-top: 5px solid #0891b2; }
    dl { margin: 0; display: grid; gap: 8px; }
    dt { font-weight: 800; color: var(--accent-dark); }
    dd { margin: 0; color: var(--muted); line-height: 1.5; }
    .badge { display: inline-block; border-radius: 999px; background: var(--accent-soft); color: var(--accent-dark); font-size: 0.78rem; font-weight: 700; padding: 4px 8px; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.045em; }
    table { width: 100%; border-collapse: collapse; background: white; border: 1px solid var(--line); border-radius: 14px; overflow: hidden; font-size: 0.96rem; }
    th, td { border: 1px solid var(--line); padding: 11px 12px; vertical-align: top; text-align: left; line-height: 1.45; }
    th { background: var(--accent-soft); color: var(--accent-dark); font-weight: 800; }
    .callout { border-left: 5px solid var(--danger); background: #fff1f2; border-radius: 16px; padding: 16px 18px; line-height: 1.58; color: #7f1d1d; }
    .callout strong { color: #881337; }
    @media (max-width: 900px) {
      main { padding: 18px 12px 48px; }
      header.hero, section.panel { padding: 18px; border-radius: 18px; }
      h1 { font-size: 2.4rem; }
      pre.mermaid { min-width: 980px; }
      .flow-box svg { min-width: 980px; }
    }
  </style>
</head>
<body>
  <main>
    <header class="hero">
      <span class="eyebrow">small skeleton review · client SSE request / response governance split</span>
      <h1>V3 Req04 / Resp03 Tool Governance Review</h1>
      <p>
        请求生命周期从 Client SSE Request Start 开始：server accept → request normalization → tool output pair normalization → continuation owner check → Req04 restore → current-turn merge/governance。响应侧单独是 Resp03 response governance + Resp04 continuation save。
        每个节点都写清楚“干什么”和“逻辑”，HTML 由架构渲染器生成。
      </p>
      <div class="meta-row">
        <span class="meta-pill">Canonical Markdown source: <code>${escapeHtml(V3_REQ04_TOOL_GOVERNANCE_REVIEW_PATH)}</code></span>
        <span class="meta-pill">Request edge: <code>Client SSE → Server raw → ReqInbound02 → Tool output pair normalization → Req03 owner check → Req04 restore/govern → ReqExecution05</code></span>
        <span class="meta-pill">Response edge: <code>Provider raw → ProviderRespCompat02 → RespInbound02 → Resp03 text harvest/tool repair → finish_reason tool_call|stop hooks → Resp04 continuation save endpoint → RespOutbound05 → json2sse</code></span>
      </div>
    </header>

    <section class="panel">
      <h2>Main Rule</h2>
      ${renderInvariantList()}
    </section>

    <section class="panel">
      <h2>Separated skeleton diagrams</h2>
      <div class="flow-stack">
        <section>
          <h3>Request Tool Governance Flow</h3>
          <div class="flow-box"><pre class="mermaid">${escapeHtml(requestMermaid)}</pre></div>
        </section>
        <section>
          <h3>Response Tool Governance Flow</h3>
          <div class="flow-box"><pre class="mermaid">${escapeHtml(responseMermaid)}</pre></div>
        </section>
      </div>
    </section>

    ${renderNodeLogicCards('Request node logic', REQUEST_NODES)}
    ${renderNodeLogicCards('Response node logic', RESPONSE_NODES)}

    <section class="panel">
      <h2>Audit notes</h2>
      ${renderNoteCards()}
    </section>

    <section class="panel">
      <h2>Resource Matrix</h2>
      ${renderTable(['Resource', 'Owner', 'Rule'], RESOURCE_ROWS)}
    </section>

    <section class="panel">
      <h2>Forbidden action focus</h2>
      <div class="callout">
        <strong>Do not repair tool continuity by deleting request truth or by moving governance to the wrong side.</strong>
        Request-side current tool output pair normalization belongs before/inside Req04 and must preserve client/model truth. Restored context is canonical and is not read again as raw history. Response-side tool/servertool/stopless governance belongs to Resp03, then Resp04 saves continuation truth as the Chat Process endpoint; outbound and json2sse happen after that.
        Provider malformed fields are fixed at ReqOutbound/provider codec; debug/control facts stay side-channel only.
      </div>
    </section>

    <section class="panel">
      <h2>Review Checklist</h2>
      ${renderTable(['Check', 'Expected', 'Risk locked'], CHECKLIST_ROWS)}
    </section>

    <section class="panel">
      <h2>Required Red Fixtures</h2>
      ${renderTable(['Fixture', 'What it proves'], RED_FIXTURE_ROWS)}
    </section>

    <section class="panel">
      <h2>Canonical sources</h2>
      ${renderSourceList()}
    </section>
  </main>
</body>
</html>
`;
}

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';

export const V3_MAINLINE_CALL_MAP_PATH = 'docs/architecture/v3-mainline-call-map.yml';
export const V3_CALLER_FLOW_PATH = 'docs/architecture/wiki/v3-mainline-caller-flow.md';
export const V3_CALLER_FLOW_HTML_PATH = 'docs/architecture/wiki/html/v3-mainline-caller-flow.html';
export const V3_ARCHITECTURE_AUDIT_LOCKS_PATH = 'docs/architecture/v3-architecture-audit-locks.yml';
export const V3_RESOURCE_OPERATION_MAP_PATH = 'docs/architecture/v3-resource-operation-map.yml';

const RESPONSE_DIRECT_TO_CLIENT_TARGETS = new Set([
  'V3ServerRespOutbound06ClientFrame',
  'V3Server16HttpFrame',
  'V3Resp15ClientPayload',
]);
const RESPONSE_DIRECT_ALLOWED_PREDECESSORS = new Set([
  'V3DirectResp15ClientPayloadReady',
  'V3HubRespOutbound05ClientSemantic',
  'V3Resp15ClientPayload',
]);
const RESPONSE_BYPASS_SOURCE_PATTERN = /(?:V3ProviderRespInbound01Raw|ProviderRespCompat02ProviderCompat|V3HubRespInbound02Normalized|V3HubRespChatProcess03Governed|V3HubRespContinuation04Committed|ProviderRespCompat02|RespInbound02|RespChatProcess03|RespContinuation04)/;
const V3_DIRECT_HOOKS_PATH = 'v3/crates/routecodex-v3-runtime/src/hooks.rs';

export function loadV3MainlineCallMap(root, relPath = V3_MAINLINE_CALL_MAP_PATH) {
  const text = fs.readFileSync(path.join(root, relPath), 'utf8');
  return YAML.parse(text) ?? {};
}

export function loadV3ArchitectureAuditLocks(root, relPath = V3_ARCHITECTURE_AUDIT_LOCKS_PATH) {
  const fullPath = path.join(root, relPath);
  if (!fs.existsSync(fullPath)) return {};
  const text = fs.readFileSync(fullPath, 'utf8');
  return YAML.parse(text) ?? {};
}

export function loadV3ResourceOperationMap(root, relPath = V3_RESOURCE_OPERATION_MAP_PATH) {
  const fullPath = path.join(root, relPath);
  if (!fs.existsSync(fullPath)) return {};
  const text = fs.readFileSync(fullPath, 'utf8');
  return YAML.parse(text) ?? {};
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function chainFingerprint(chain) {
  const payload = {
    chain_id: chain?.chain_id,
    owner_feature_id: chain?.owner_feature_id,
    edges: (chain?.edges ?? []).map((edge) => ({
      step_id: edge?.step_id,
      from_node: edge?.from_node,
      to_node: edge?.to_node,
      owner_feature_id: edge?.owner_feature_id,
      caller_symbol: edge?.caller_symbol,
      caller_file: edge?.caller_file,
      callee_symbol: edge?.callee_symbol,
      callee_file: edge?.callee_file,
      resource_flow: edge?.resource_flow ?? null,
    })),
  };
  return `sha256:${crypto.createHash('sha256').update(stableJson(payload)).digest('hex')}`;
}

function stripRoot(relPath) {
  return String(relPath ?? '')
    .replace(/^v3\/crates\//, '')
    .replace(/^sharedmodule\/llmswitch-core\//, 'llmswitch-core/');
}

export function moduleForFile(file) {
  const value = String(file ?? '');
  if (!value) return 'binding-pending';
  if (value.startsWith('v3/crates/routecodex-v3-runtime/src/hub_v1/')) return 'v3-runtime::hub_v1';
  if (value.startsWith('v3/crates/routecodex-v3-runtime/')) return 'v3-runtime';
  if (value.startsWith('v3/crates/routecodex-v3-server/')) return 'v3-server';
  if (value.startsWith('v3/crates/routecodex-v3-config/')) return 'v3-config';
  if (value.startsWith('v3/crates/routecodex-v3-lifecycle/')) return 'v3-lifecycle';
  if (value.startsWith('v3/crates/routecodex-v3-provider-responses/')) return 'v3-provider-responses';
  if (value.startsWith('v3/crates/routecodex-v3-virtual-router/')) return 'v3-virtual-router';
  if (value.startsWith('v3/crates/routecodex-v3-target/')) return 'v3-target';
  if (value.startsWith('v3/crates/routecodex-v3-cli/')) return 'v3-cli';
  if (value.startsWith('v3/crates/routecodex-v3-debug/')) return 'v3-debug';
  if (value.startsWith('v3/crates/routecodex-v3-error/')) return 'v3-error';
  if (value.startsWith('v3/crates/')) return value.split('/').slice(2, 3)[0] ?? 'v3-crate';
  if (value.startsWith('docs/architecture/manifests/')) return 'docs::manifest';
  if (value.startsWith('docs/')) return 'docs';
  if (value.startsWith('scripts/')) return 'scripts';
  if (value.startsWith('llmswitch-core/') || value.startsWith('sharedmodule/')) return 'llmswitch-core';
  return value.split('/').slice(0, 2).join('/') || 'unknown';
}

function sanitizeId(value) {
  return String(value ?? 'x').replace(/[^A-Za-z0-9_]/g, '_').replace(/^([0-9])/, '_$1');
}

function mermaidText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\|/g, '&#124;')
    .replace(/\n/g, '<br/>');
}

function tableText(value) {
  return String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\n/g, '<br/>');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripTrailingWhitespace(value) {
  return String(value ?? '').replace(/[ \t]+$/gmu, '');
}

const MAIN_SKELETON_NOTES = new Map([
  ['v3.config.compile', {
    title: '01 配置编译',
    note: '把 config.v3.toml 变成可执行 Manifest；runtime 只消费编译结果。',
  }],
  ['v3.entry_protocol_endpoint_binding.mainline', {
    title: '02 入口绑定',
    note: '把 endpoint 绑定到协议、执行模式和 owner；未登记入口不能执行。',
  }],
  ['v3.server.startup', {
    title: '03 Server 接入',
    note: 'HTTP listener 只做入口分发和最终 frame；不拥有 Hub 语义。',
  }],
  ['v3.virtual_router.target_selection', {
    title: '04 Virtual Router / Target',
    note: '只做分类、候选池、provider/model/auth 选择；不修 request/response payload。',
  }],
  ['v3.responses_direct.required_mainline', {
    title: '05A Responses Direct',
    note: '同协议直通生命周期；Direct 也必须有自己的响应投影节点，禁止 raw 直投 client。',
  }],
  ['v3.hub_pipeline.v1.request', {
    title: '05B Hub Relay 请求链',
    note: 'Client raw → Chat Process 治理 → provider semantic → provider wire。',
  }],
  ['v3.servertool_hook_skeleton_lifecycle', {
    title: '06 Stopless / Servertool',
    note: 'Req04 restore/请求治理 + Resp03 响应治理 + Resp04 save；continuation 必须 save/restore 成对。',
  }],
  ['v3.hub_pipeline.v1.response', {
    title: '07 Hub Relay 响应链',
    note: 'Provider raw → RespInbound → RespChatProcess → continuation save → client projection。',
  }],
  ['v3.req04.tool_governance_restore', {
    title: '06 Req04 Tool Governance / Restore',
    note: '请求侧 Chat Process：恢复 continuation，治理工具列表/工具结果，注入必要 servertool/stopless 请求控制。',
  }],
  ['v3.resp03.tool_servertool_governance', {
    title: '07 Resp03 Tool / Servertool Governance',
    note: '响应侧 Chat Process：收割工具调用、处理 servertool/stopless/reasoningStop；唯一可治理响应语义的位置。',
  }],
  ['v3.resp04.continuation_save', {
    title: '08 Resp04 Continuation Save',
    note: '只提交/保存 Resp03 已治理结果；禁止重新解释响应、补工具、修 history。',
  }],
  ['v3.debug_error_foundation.mainline', {
    title: 'E Error handler / Health owner',
    note: 'Error handler / provider health 是资源与 owner；side-channel 只是控制事实传输机制，不是资源。',
  }],
]);

const CONTRACT_NODE_NOTES = new Map([
  ['V3Config01FileSource', ['配置文件', 'authoring 输入，只表达意图']],
  ['V3Config02AuthoringParsed', ['配置已解析', 'TOML/authoring 解析后的结构']],
  ['V3Config03SchemaValidated', ['Schema 已验证', 'unknown 字段、类型、权限先拦截']],
  ['V3Config04ResourceRegistryBuilt', ['资源注册表', '资源/owner/关系编译完成']],
  ['V3Config05ManifestPublished', ['Manifest 已发布', 'runtime 唯一可消费的配置真源']],
  ['V3EntryBind01EndpointPatternDeclared', ['入口声明', 'endpoint pattern 在 manifest 中登记']],
  ['V3EntryBind02ProtocolResolved', ['协议已解析', 'endpoint → entry protocol / execution mode']],
  ['V3EntryBind03ServerEnablementChecked', ['Server 放行检查', 'server dispatch 前确认入口启用']],
  ['V3EntryBind04ExecutionBindingProjected', ['执行绑定', '进入唯一 runtime/handler 入口']],
  ['V3Server03HttpRequestRaw', ['HTTP 原始请求', 'server 捕获当前请求；不做 Hub 语义治理']],
  ['V3Req04StandardizedResponses', ['Responses 标准化请求', '入口协议非破坏性归一化']],
  ['V3Router05RequestClassified', ['VR 路由分类', '按事实分类 thinking/coding/tools/longcontext；只选路不修 payload']],
  ['V3Router06RoutePoolResolved', ['VR 路由池解析', '根据 priority/default/pool policy 得到候选池']],
  ['V3Router07OpaqueTargetHitOnce', ['VR 命中目标', '只产生 target plan；禁止 provider 特例和 payload 修补']],
  ['V3Target08KindClassified', ['Target 类型', 'provider/model/auth 目标类型判定；进入 Target Interpreter']],
  ['V3Target09CandidateSetExpanded', ['候选展开', '从 target 展开具体 provider 候选']],
  ['V3Target10ConcreteProviderSelected', ['Provider 已选定', '唯一 provider/model/auth 进入 runtime']],
  ['V3ResponsesDirect11Policy', ['Direct 策略', 'Direct-only 生命周期策略节点']],
  ['V3Provider12ResponsesWirePayload', ['Provider wire payload', '发给上游的 Responses 请求体；不得含内部 metadata']],
  ['V3Transport13ResponsesHttpRequest', ['HTTP transport 请求', '认证/header/body 已组成，准备发送上游']],
  ['V3Transport13ResponsesRequest', ['Responses transport 请求', 'provider transport 输入']],
  ['V3ProviderResp14Raw', ['Provider 原始响应', '上游原始 JSON/SSE 响应']],
  ['V3DirectResp14ProviderProjectionPrepared', ['Direct 响应准备', 'Direct 专属投影准备节点；阻断 raw→client 直跳']],
  ['V3DirectResp15ClientPayloadReady', ['Direct client payload ready', 'Direct 专属 client payload 已就绪']],
  ['V3Resp15ClientPayload', ['Client payload', '对客户端可见的协议 payload']],
  ['V3Server16HttpFrame', ['HTTP frame', 'server 只发送最终 HTTP/SSE frame']],
  ['V3HubReqInbound01ClientRaw', ['Hub 请求入口 raw', 'Client raw 进入 Hub 的唯一入口']],
  ['V3HubReqInbound02Normalized', ['ReqInbound 归一化', '只做入口协议解析/非破坏性归一化']],
  ['V3HubReqContinuation03Classified', ['Continuation 分类', '只判定 scope/owner/entry；不恢复错误路径']],
  ['V3HubReqChatProcess04Governed', ['Req Chat Process', '请求侧工具/history/stopless/continuation restore 唯一治理点']],
  ['V3HubReqExecution05Planned', ['执行计划', '决定 relay/direct/工具复入等执行形态']],
  ['V3HubReqTarget06Resolved', ['Target 已解析', '目标 provider/model/auth 已绑定']],
  ['V3HubReqOutbound07ProviderSemantic', ['Provider semantic', 'Hub 语义 envelope；还不是 provider wire']],
  ['ProviderReqCompat06ProviderCompat', ['Provider request compat', 'provider 差异兼容层，只做 provider 协议差异']],
  ['V3ProviderReqOutbound08WirePayload', ['Provider request wire', '最终 provider 请求体']],
  ['V3ProviderReqOutbound09TransportRequest', ['Provider transport request', '准备发给上游']],
  ['V3ProviderRespInbound01Raw', ['Provider response raw', 'provider 响应进入 Hub 的唯一入口']],
  ['ProviderRespCompat02ProviderCompat', ['Provider response compat', 'provider 原始响应兼容解析']],
  ['V3HubRespInbound02Normalized', ['RespInbound 归一化', '只解析 provider raw，不做工具治理']],
  ['V3HubRespChatProcess03Governed', ['Resp Chat Process', '响应侧工具收割、servertool、stopless、reasoning harvest 唯一治理点']],
  ['V3HubRespContinuation04Committed', ['Continuation save', '响应侧 continuation 真相保存点；之后到下轮 restore 是不可变区']],
  ['V3HubRespOutbound05ClientSemantic', ['Client semantic', '按入口协议投影客户端语义']],
  ['V3ServerRespOutbound06ClientFrame', ['Server client frame', 'server 发送最终 client frame']],
  ['V3StoplessReq01RuntimeControlLoaded', ['Stopless 状态加载', '从 runtime control side-channel 读取当前 session 状态']],
  ['V3StoplessReq02NoopCliConsumed', ['消费 no-op CLI', '只移除 RouteCodex 自己注入的 stopless no-op 对']],
  ['V3StoplessReq03GuidanceToolInjected', ['注入 stop schema', '追加 exactly-one reasoningStop 和当前轮 guidance']],
  ['V3StoplessResp01ReasoningStopInspected', ['检查 reasoningStop', '判断模型是否显式选择停止 schema']],
  ['V3StoplessResp02RuntimeControlUpdated', ['更新 stopless 状态', '三轮 guard / pass-through 状态迁移']],
  ['V3StoplessResp03NoopCliOrTerminalProjected', ['投影 no-op 或终态', '对 client 透明投影，不污染 provider payload']],
  ['V3ProviderHealthStateMutated', ['Provider health 更新', 'provider-runtime health owner 写入；Error chain 可触发，VR/Target 只读可用性']],

  ['V3Error01SourceRaised', ['Error source', '错误唯一入口；记录 source/stage/code，不在 Server/provider 本地分叉']],
  ['V3Error02Classified', ['Error classified', '统一分类 provider/runtime/direct/executor 错误']],
  ['V3Error03TargetLocalAction', ['Target-local action', '决定重试/切换/health-affecting action']],
  ['V3Error04TargetExhaustionDecision', ['Target exhaustion', '判断候选/default pool 是否耗尽']],
  ['V3Error05ExecutionDecision', ['Execution decision', '输出 continue/reroute/project error 的执行决策']],
  ['V3Error06ClientProjected', ['Client error projection', '唯一客户端错误投影；禁止包装成成功']],
  ['V3DebugTraceContextStarted', ['Debug trace context', 'debug 诊断资源起点；不进入 normal payload']],
  ['V3DebugRawCaptureStored', ['Debug raw capture', '保存 raw 证据；不能作为业务 truth 重放']],
  ['V3DebugEventLedgerRecorded', ['Debug event ledger', '记录节点事件侧证据']],
  ['V3DebugSnapshotSessionRegistered', ['Debug snapshot session', 'snapshot 诊断会话；不得恢复业务语义']],
  ['V3DryRunFixture', ['Dry-run fixture', '无网络验证 fixture 输入']],
  ['V3DryRunNoNetworkTerminalEffect', ['Dry-run terminal effect', 'dry-run 终态效果，不发送 provider']],
  ['V3ProviderAvailabilityProjected', ['Provider availability', 'provider health 的可用性投影；由 target/router 读取']],
  ['V3RemoteContinuationCommitInput', ['Remote continuation 输入', 'remote/direct continuation 待提交信息']],
  ['V3RemoteContinuationLocator', ['Remote continuation locator', '按 protocol/owner/session/port 隔离的 continuation key']],
  ['V3LocalContResp01ChatProcessGoverned', ['本地 continuation save 起点', 'RespChatProcess 后的本地 continuation 真相']],
  ['V3LocalContReq04RestoredGoverned', ['本地 continuation restore 终点', '下一轮 ReqChatProcess 入口恢复']],
]);

const EDGE_STEP_NOTES = new Map([
  ['v3-rd-13', '解析 provider raw 后进入 Direct 专属投影准备'],
  ['v3-rd-14', 'Direct 投影准备完成，形成 client payload ready'],
  ['v3-rd-15', 'Direct ready payload 才能转成客户端 payload'],
  ['v3-rci-03', 'remote continuation 响应同样先进入 Direct 投影准备'],
  ['v3-rci-04', '先提交 continuation，再准备 client payload'],
  ['v3-rci-05', 'Resp04 之后只能走 Direct ready 节点，禁止直投'],
  ['v3-hub-resp-03', '响应侧工具/stopless/reasoning 治理唯一入口'],
  ['v3-hub-resp-04', 'Chat Process 完成后保存 continuation'],
  ['v3-de-12', 'Error03 action 写入 health cooldown/disable'],
  ['v3-de-13', 'provider health 投影成 target/router 可读 availability'],
  ['v3-de-14', 'provider send/transport failure 记录 provider failure'],
  ['v3-de-15', 'provider raw received 记录 provider success'],
  ['v3-servertool-stopless-req-03', '只消费 RouteCodex 注入的 no-op CLI 对'],
  ['v3-servertool-stopless-req-04', '注入 stop schema 和当前轮 guidance'],
  ['v3-servertool-stopless-resp-01', '检查模型是否调用 stop schema'],
  ['v3-servertool-stopless-resp-02', '更新三轮 stopless control 状态'],
  ['v3-servertool-stopless-resp-04', '进入 Resp04 continuation save；之后不可变'],
]);

function splitWords(value) {
  return String(value ?? '')
    .replace(/^V3/u, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9]+)/g, '$1 $2')
    .replace(/([0-9]+)([A-Za-z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function contractNodeNote(nodeName) {
  const known = CONTRACT_NODE_NOTES.get(String(nodeName ?? ''));
  if (known) return { title: known[0], note: known[1], annotated: true };
  return {
    title: splitWords(nodeName) || '<missing node>',
    note: '未写专用注释：按 contract 名称审计',
    annotated: false,
  };
}

function contractNodeHtmlLabel(nodeName) {
  const info = contractNodeNote(nodeName);
  return `<b>${escapeHtml(info.title)}</b><br/>${escapeHtml(info.note)}<br/><small>${escapeHtml(nodeName)}</small>`;
}

function chainReadableLabel(chain) {
  const summary = chainSummary(chain);
  const note = MAIN_SKELETON_NOTES.get(summary.chain_id) ?? {
    title: splitWords(summary.chain_id),
    note: `${summary.first_node} → ${summary.last_node}`,
  };
  return { ...summary, ...note };
}

function resourceSetForChain(chain) {
  const out = new Set();
  for (const edge of chain?.edges ?? []) {
    const flow = edge?.resource_flow ?? {};
    for (const key of ['consumes', 'produces', 'side_channel_reads', 'side_channel_writes']) {
      for (const item of flow[key] ?? []) out.add(item);
    }
  }
  return out;
}

function resourceFlowHtml(edge) {
  const flow = edge?.resource_flow ?? {};
  const rows = [
    ['consumes', flow.consumes ?? []],
    ['produces', flow.produces ?? []],
    ['control reads', flow.side_channel_reads ?? []],
    ['control writes', flow.side_channel_writes ?? []],
  ].filter(([, values]) => values.length > 0);
  if (!rows.length) return '<span class="status missing">missing</span>';
  return rows.map(([label, values]) => `<div class="resource-row"><strong>${escapeHtml(label)}:</strong> ${values.map((value) => `<code>${escapeHtml(value)}</code>`).join(' ')}</div>`).join('');
}

function lockStateForChain(chain, locks) {
  const chainId = chain?.chain_id ?? '<missing-chain>';
  const itemId = `chain:${chainId}`;
  const locked = (locks?.locked_items ?? []).find((item) => item?.item_id === itemId);
  const fingerprint = chainFingerprint(chain);
  if (!locked) {
    return {
      item_id: itemId,
      status: 'pending_manual_review',
      label: 'pending review',
      fingerprint,
      className: 'pending_review',
    };
  }
  const matches = locked.fingerprint === fingerprint;
  return {
    item_id: itemId,
    status: matches ? 'audited_locked' : 'locked_changed',
    label: matches ? 'locked by Jason' : 'locked item changed',
    fingerprint,
    locked_fingerprint: locked.fingerprint,
    className: matches ? 'audited_locked' : 'locked_changed',
    reviewed_by: locked.reviewed_by,
    locked_at: locked.locked_at,
  };
}

function edgeReadableLabel(edge) {
  const step = String(edge?.step_id ?? '<missing-step>');
  const note = EDGE_STEP_NOTES.get(step);
  if (note) return `${escapeHtml(step)}<br/>${escapeHtml(note)}`;
  const modules = `${moduleForFile(edge?.caller_file)} → ${moduleForFile(edge?.callee_file)}`;
  return `${escapeHtml(step)}<br/>${escapeHtml(modules)}`;
}

function edgeStatus(edge) {
  if (edge?.binding_pending === true) return 'binding_pending';
  return String(edge?.status ?? '').trim() || 'unknown';
}

function edgeReviewKind(edge) {
  const status = edgeStatus(edge).replace('-', '_');
  const bindingKind = String(edge?.binding_kind ?? '');
  const edgeKind = String(edge?.edge_kind ?? '');
  const files = `${edge?.caller_file ?? ''} ${edge?.callee_file ?? ''}`;
  if (status === 'binding_pending') {
    return { key: 'binding_pending', label: 'binding_pending', note: 'map owner exists but runtime/source binding is not proven' };
  }
  if (edgeKind === 'aggregate_entry_edge') {
    return { key: 'aggregate-only', label: 'aggregate-only', note: 'wrapper edge only; not a semantic adjacent pipeline transition' };
  }
  if (bindingKind === 'h1_typed_test' || bindingKind === 'typed_runtime_node') {
    return { key: 'typed-test-only', label: 'typed-test-only', note: 'typed skeleton/builder contract; does not prove live runtime closure' };
  }
  if (/tests\.rs|\/tests\//u.test(files) || /_test|test_|characterization|fixture|probe/u.test(bindingKind)) {
    return { key: 'test-bound', label: 'test-bound', note: 'test/characterization evidence over declared owner path' };
  }
  if (/v3\/crates\//u.test(files) && status === 'anchored') {
    return { key: 'live-bound', label: 'live-bound source', note: 'real runtime/source symbols are bound; live replay is still separate evidence' };
  }
  return { key: status || 'unknown', label: status || 'unknown', note: 'map status from edge record' };
}

function callerKey(edge, side) {
  const symbol = side === 'caller' ? edge?.caller_symbol : edge?.callee_symbol;
  const file = side === 'caller' ? edge?.caller_file : edge?.callee_file;
  return `${file ?? '<missing-file>'}::${symbol ?? '<missing-symbol>'}`;
}

function endpointNodeLabel(edge, side) {
  const symbol = side === 'caller' ? edge?.caller_symbol : edge?.callee_symbol;
  const file = side === 'caller' ? edge?.caller_file : edge?.callee_file;
  const module = moduleForFile(file);
  return `${module}<br/>${mermaidText(symbol || '<missing symbol>')}<br/><small>${mermaidText(stripRoot(file || '<missing file>'))}</small>`;
}

function chainEdges(parsed) {
  const out = [];
  for (const chain of parsed?.chains ?? []) {
    for (const edge of chain?.edges ?? []) out.push({ chain, edge });
  }
  return out;
}

function detectMissingEdges(parsed) {
  const missing = [];
  for (const { chain, edge } of chainEdges(parsed)) {
    for (const field of ['from_node', 'to_node', 'caller_symbol', 'caller_file', 'callee_symbol', 'callee_file', 'owner_feature_id']) {
      if (typeof edge?.[field] !== 'string' || !edge[field].trim()) {
        missing.push({ chain_id: chain?.chain_id, step_id: edge?.step_id, reason: `missing ${field}` });
      }
    }
  }
  return missing;
}

function detectForbiddenDirectProjectionEdges(parsed) {
  const forbidden = [];
  for (const { chain, edge } of chainEdges(parsed)) {
    const from = String(edge?.from_node ?? '');
    const to = String(edge?.to_node ?? '');
    const caller = `${edge?.caller_symbol ?? ''} ${edge?.caller_file ?? ''}`;
    const callee = `${edge?.callee_symbol ?? ''} ${edge?.callee_file ?? ''}`;
    const targetIsClient = RESPONSE_DIRECT_TO_CLIENT_TARGETS.has(to);
    const allowed = RESPONSE_DIRECT_ALLOWED_PREDECESSORS.has(from);
    const bypassByNode = targetIsClient && !allowed && RESPONSE_BYPASS_SOURCE_PATTERN.test(from);
    const bypassBySymbol = targetIsClient && !allowed && /project|projection|client|sse/i.test(`${caller} ${callee}`) && /ProviderResp|RespInbound|RespChatProcess|RespContinuation|provider response/i.test(`${from} ${caller} ${callee}`);
    if (bypassByNode || bypassBySymbol) {
      forbidden.push({
        chain_id: chain?.chain_id,
        step_id: edge?.step_id,
        from_node: from,
        to_node: to,
        caller_symbol: edge?.caller_symbol,
        callee_symbol: edge?.callee_symbol,
      });
    }
  }
  return forbidden;
}

function detectInvalidAggregateEntryEdges(parsed) {
  const invalid = [];
  for (const { chain, edge } of chainEdges(parsed)) {
    const from = String(edge?.from_node ?? '');
    const to = String(edge?.to_node ?? '');
    const isAggregateShape = from === 'V3HubReqInbound01ClientRaw' && to === 'V3ServerRespOutbound06ClientFrame';
    if (isAggregateShape && edge?.edge_kind !== 'aggregate_entry_edge') {
      invalid.push({ chain_id: chain?.chain_id, step_id: edge?.step_id, from_node: from, to_node: to, edge_kind: edge?.edge_kind ?? '<missing>' });
    }
  }
  return invalid;
}

function detectBindingPendingEdges(parsed) {
  return chainEdges(parsed)
    .filter(({ edge }) => edgeStatus(edge).replace('-', '_') === 'binding_pending')
    .map(({ chain, edge }) => ({ chain_id: chain?.chain_id, step_id: edge?.step_id, from_node: edge?.from_node, to_node: edge?.to_node }));
}

export function auditV3CallerFlowSourceText(source, source_path = V3_DIRECT_HOOKS_PATH) {
  const forbiddenRegisteredHooks = [];
  const registeredHookPattern = /V3RegisteredHook\s*\{[\s\S]*?input_node:\s*"V3ProviderResp14Raw"[\s\S]*?output_node:\s*"V3Resp15ClientPayload"[\s\S]*?\}/g;
  for (const match of source.matchAll(registeredHookPattern)) {
    forbiddenRegisteredHooks.push({
      source_path,
      input_node: 'V3ProviderResp14Raw',
      output_node: 'V3Resp15ClientPayload',
      reason: 'registered hook maps provider raw directly to client payload',
    });
  }
  return { forbiddenRegisteredHooks };
}

export function auditV3CallerFlowSource(root) {
  const sourcePath = path.join(root, V3_DIRECT_HOOKS_PATH);
  if (!fs.existsSync(sourcePath)) return { forbiddenRegisteredHooks: [] };
  return auditV3CallerFlowSourceText(fs.readFileSync(sourcePath, 'utf8'), V3_DIRECT_HOOKS_PATH);
}


export function auditV3ReviewSurfaceHtmlText(html, source_path = V3_CALLER_FLOW_HTML_PATH) {
  const requiredMarkers = [
    'Request skeleton / 请求主骨架',
    'Response skeleton / 响应主骨架',
    'Error resources / 错误处理资源',
    'V3HubReqInbound01ClientRaw',
    'V3HubReqChatProcess04Governed',
    'ProviderReqCompat06ProviderCompat',
    'V3ProviderReqOutbound08WirePayload',
    'V3ProviderRespInbound01Raw',
    'ProviderRespCompat02ProviderCompat',
    'V3HubRespChatProcess03Governed',
    'V3HubRespContinuation04Committed',
    'V3Error01SourceRaised',
    'V3Error06ClientProjected',
    'v3.provider.health_state',
    'v3.error.client_projection',
    'typed-test-only',
    'live-bound',
    'aggregate-only',
    'binding_pending',
    'runtime gap',
  ];
  const failures = [];
  for (const marker of requiredMarkers) {
    if (!String(html ?? '').includes(marker)) failures.push(`${source_path}: missing review marker ${marker}`);
  }
  const requestSection = String(html ?? '').split('Response skeleton / 响应主骨架')[0] ?? '';
  if (!requestSection.includes('v3.hub_pipeline.v1.request')) failures.push(`${source_path}: request skeleton must be generated from v3.hub_pipeline.v1.request`);
  if (!requestSection.includes('ProviderReqCompat06ProviderCompat')) failures.push(`${source_path}: request skeleton must show provider request compat before wire payload`);
  if (!requestSection.includes('V3Router05RequestClassified') || !requestSection.includes('V3Target10ConcreteProviderSelected')) failures.push(`${source_path}: request skeleton must explicitly show VR/Target selection expansion`);
  const responsePart = String(html ?? '').split('Response skeleton / 响应主骨架')[1] ?? '';
  const responseSection = responsePart.split('Read format / 阅读格式')[0] ?? responsePart;
  if (!responseSection.includes('v3.hub_pipeline.v1.response')) failures.push(`${source_path}: response skeleton must be generated from v3.hub_pipeline.v1.response`);
  if (!responseSection.includes('ProviderRespCompat02ProviderCompat')) failures.push(`${source_path}: response skeleton must show provider response compat before RespInbound`);
  if (responseSection.includes('V3DirectResp14ProviderProjectionPrepared')) failures.push(`${source_path}: response skeleton must not mix Direct projection nodes into Relay response skeleton`);
  return { failures };
}

export function auditV3CallerFlow(parsed) {
  return {
    missing: detectMissingEdges(parsed),
    bindingPending: detectBindingPendingEdges(parsed),
    forbiddenDirectProjection: detectForbiddenDirectProjectionEdges(parsed),
    invalidAggregateEntry: detectInvalidAggregateEntryEdges(parsed),
  };
}

export function auditV3ArchitectureLocks(parsed, locks, previousLocks = null) {
  const failures = [];
  const warnings = [];
  const chainsById = new Map((parsed?.chains ?? []).map((chain) => [chain?.chain_id, chain]));
  const lockedItems = Array.isArray(locks?.locked_items) ? locks.locked_items : [];
  const authorizations = Array.isArray(locks?.manual_authorizations) ? locks.manual_authorizations : [];
  const authorizationById = new Map(authorizations.map((item) => [item?.authorization_id, item]));

  if (locks?.schema_version !== 1) {
    failures.push(`${V3_ARCHITECTURE_AUDIT_LOCKS_PATH}: schema_version must be 1`);
  }
  if (!Array.isArray(locks?.locked_items)) {
    failures.push(`${V3_ARCHITECTURE_AUDIT_LOCKS_PATH}: locked_items must be an array`);
  }
  if (!Array.isArray(locks?.manual_authorizations)) {
    failures.push(`${V3_ARCHITECTURE_AUDIT_LOCKS_PATH}: manual_authorizations must be an array`);
  }

  const seen = new Set();
  for (const item of lockedItems) {
    const itemId = String(item?.item_id ?? '');
    const chainId = String(item?.chain_id ?? '');
    if (!itemId || !chainId) {
      failures.push('locked audit item missing item_id or chain_id');
      continue;
    }
    if (seen.has(itemId)) failures.push(`duplicate locked audit item: ${itemId}`);
    seen.add(itemId);
    if (itemId !== `chain:${chainId}`) failures.push(`${itemId}: item_id must be chain:${chainId}`);
    if (item?.status !== 'audited_locked') failures.push(`${itemId}: status must be audited_locked`);
    if (item?.reviewed_by !== 'Jason') failures.push(`${itemId}: reviewed_by must be Jason`);
    const chain = chainsById.get(chainId);
    if (!chain) {
      failures.push(`${itemId}: chain_id not found in ${V3_MAINLINE_CALL_MAP_PATH}`);
      continue;
    }
    const currentFingerprint = chainFingerprint(chain);
    if (item?.fingerprint !== currentFingerprint) {
      failures.push(`${itemId}: audited locked fingerprint changed; needs Jason manual authorization and refreshed lock (${item?.fingerprint ?? '<missing>'} != ${currentFingerprint})`);
    }
    if (!item?.locked_at) failures.push(`${itemId}: locked_at is required`);
  }

  if (previousLocks) {
    const previousItems = new Map((previousLocks?.locked_items ?? []).map((item) => [item?.item_id, item]));
    for (const item of lockedItems) {
      const previous = previousItems.get(item?.item_id);
      if (!previous) continue;
      if (previous.fingerprint === item.fingerprint) continue;
      const authId = item.last_manual_authorization_id;
      const auth = authorizationById.get(authId);
      if (!auth) {
        failures.push(`${item.item_id}: locked fingerprint changed without last_manual_authorization_id`);
        continue;
      }
      if (auth.approved_by !== 'Jason') failures.push(`${item.item_id}: authorization ${authId} must be approved_by Jason`);
      if (auth.item_id !== item.item_id) failures.push(`${item.item_id}: authorization ${authId} item_id mismatch`);
      if (auth.fingerprint_before !== previous.fingerprint) failures.push(`${item.item_id}: authorization ${authId} fingerprint_before mismatch`);
      if (auth.fingerprint_after !== item.fingerprint) failures.push(`${item.item_id}: authorization ${authId} fingerprint_after mismatch`);
    }
  }

  for (const chain of parsed?.chains ?? []) {
    if (!seen.has(`chain:${chain?.chain_id}`)) warnings.push(`pending manual audit: ${chain?.chain_id}`);
  }

  return { failures, warnings };
}

function renderAuditList(title, rows, fields) {
  const lines = [`### ${title}`, ''];
  if (!rows.length) {
    lines.push('- none', '');
    return lines.join('\n');
  }
  lines.push(`| ${fields.join(' | ')} |`, `| ${fields.map(() => '---').join(' | ')} |`);
  for (const row of rows) {
    lines.push(`| ${fields.map((field) => tableText(row[field] ?? '')).join(' | ')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderModuleOverview(parsed) {
  const counts = new Map();
  const chainIds = new Map();
  for (const { chain, edge } of chainEdges(parsed)) {
    const from = moduleForFile(edge?.caller_file);
    const to = moduleForFile(edge?.callee_file);
    const key = `${from}=>${to}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const set = chainIds.get(key) ?? new Set();
    set.add(chain?.chain_id ?? '<missing-chain>');
    chainIds.set(key, set);
  }
  const modules = Array.from(new Set([...Array.from(counts.keys()).flatMap((key) => key.split('=>'))])).sort();
  const lines = ['## Module caller overview', '', '```mermaid', 'flowchart TD'];
  for (const module of modules) {
    lines.push(`  ${sanitizeId('module_' + module)}["${mermaidText(module)}"]`);
  }
  for (const [key, count] of Array.from(counts.entries()).sort()) {
    const [from, to] = key.split('=>');
    const chainCount = chainIds.get(key)?.size ?? 0;
    lines.push(`  ${sanitizeId('module_' + from)} -->|${count} edges / ${chainCount} paths| ${sanitizeId('module_' + to)}`);
  }
  lines.push('```', '');
  lines.push('| From module | To module | Edges | Functional paths |');
  lines.push('| --- | --- | ---: | --- |');
  for (const [key, count] of Array.from(counts.entries()).sort()) {
    const [from, to] = key.split('=>');
    const chains = Array.from(chainIds.get(key) ?? []).sort().map((v) => `\`${v}\``).join('<br/>');
    lines.push(`| ${tableText(from)} | ${tableText(to)} | ${count} | ${chains} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function renderChain(chain, index) {
  const edges = chain?.edges ?? [];
  const chainId = chain?.chain_id ?? `chain_${index}`;
  const prefix = sanitizeId(`c_${index}_${chainId}`);
  const nodeIds = new Map();
  const nodeInfo = new Map();
  const moduleNodes = new Map();

  function getNode(edge, side) {
    const key = callerKey(edge, side);
    if (!nodeIds.has(key)) {
      const id = `${prefix}_${nodeIds.size}`;
      nodeIds.set(key, id);
      const file = side === 'caller' ? edge?.caller_file : edge?.callee_file;
      const module = moduleForFile(file);
      nodeInfo.set(id, { key, module, label: endpointNodeLabel(edge, side) });
      const arr = moduleNodes.get(module) ?? [];
      arr.push(id);
      moduleNodes.set(module, arr);
    }
    return nodeIds.get(key);
  }

  const edgeLines = [];
  for (const edge of edges) {
    const from = getNode(edge, 'caller');
    const to = getNode(edge, 'callee');
    const label = `${mermaidText(edge?.step_id ?? '<missing-step>')}<br/>${mermaidText(edge?.from_node ?? '?')} → ${mermaidText(edge?.to_node ?? '?')}`;
    edgeLines.push(`  ${from} -->|${label}| ${to}`);
  }

  const lines = [
    `## ${tableText(chainId)}`,
    '',
    chain?.summary ? `${chain.summary}` : '',
    '',
    `Owner feature: \`${chain?.owner_feature_id ?? '<missing>'}\``,
  ];
  if (chain?.manifest) lines.push(`Manifest: \`${chain.manifest}\``);
  lines.push('', '```mermaid', 'flowchart TD');
  for (const [module, ids] of Array.from(moduleNodes.entries()).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  subgraph ${sanitizeId(prefix + '_m_' + module)}["${mermaidText(module)}"]`);
    for (const id of ids) {
      lines.push(`    ${id}["${nodeInfo.get(id).label}"]`);
    }
    lines.push('  end');
  }
  lines.push(...edgeLines, '```', '');
  lines.push('| Step | Node edge | Status | Caller | Callee | Owner |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const edge of edges) {
    const caller = `${edge?.caller_symbol ?? '<missing>'}<br/><small>${stripRoot(edge?.caller_file ?? '<missing>')}</small>`;
    const callee = `${edge?.callee_symbol ?? '<missing>'}<br/><small>${stripRoot(edge?.callee_file ?? '<missing>')}</small>`;
    lines.push(`| \`${tableText(edge?.step_id ?? '')}\` | \`${tableText(edge?.from_node ?? '')}\` → \`${tableText(edge?.to_node ?? '')}\` | ${tableText(edgeStatus(edge))} | ${tableText(caller)} | ${tableText(callee)} | \`${tableText(edge?.owner_feature_id ?? '')}\` |`);
  }
  lines.push('');
  return lines.filter((line, i, arr) => !(line === '' && arr[i - 1] === '')).join('\n');
}

export function renderV3MainlineCallerFlowMarkdown(root, relPath = V3_MAINLINE_CALL_MAP_PATH) {
  const parsed = loadV3MainlineCallMap(root, relPath);
  const audit = auditV3CallerFlow(parsed);
  const sourceAudit = auditV3CallerFlowSource(root);
  const chains = parsed?.chains ?? [];
  const edgeCount = chains.reduce((sum, chain) => sum + (chain?.edges?.length ?? 0), 0);
  const lines = [
    '<!-- AUTO-GENERATED: do not edit by hand. Rebuild with `npm run render:v3-mainline-caller-flow`. -->',
    '',
    '# V3 Mainline Caller Flow',
    '',
    `Source: \`${relPath}\``,
    '',
    `Generated view: ${chains.length} functional paths, ${edgeCount} caller edges.`,
    '',
    'This page renders the V3 mainline edge truth as top-down caller graphs. Each functional path is grouped by implementation module and each edge shows both the function call and the contract-node transition.',
    '',
    'Review rule: a provider/runtime response must not jump directly to client/server projection. It must pass through the response chain (`ProviderRespCompat02ProviderCompat -> V3HubRespInbound02Normalized -> V3HubRespChatProcess03Governed -> V3HubRespContinuation04Committed -> V3HubRespOutbound05ClientSemantic -> V3ServerRespOutbound06ClientFrame`) unless it is an explicitly separate direct lifecycle with its own declared nodes.',
    '',
    renderModuleOverview(parsed),
    '## Auto audit /补救清单',
    '',
    renderAuditList('Forbidden direct response projection edges', audit.forbiddenDirectProjection, ['chain_id', 'step_id', 'from_node', 'to_node', 'caller_symbol', 'callee_symbol']),
    renderAuditList('Forbidden source registered direct response edges', sourceAudit.forbiddenRegisteredHooks, ['source_path', 'input_node', 'output_node', 'reason']),
    renderAuditList('Binding-pending edges', audit.bindingPending, ['chain_id', 'step_id', 'from_node', 'to_node']),
    renderAuditList('Missing caller/callee fields', audit.missing, ['chain_id', 'step_id', 'reason']),
    '## Functional caller paths',
    '',
  ];
  chains.forEach((chain, index) => lines.push(renderChain(chain, index)));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

function chainSummary(chain) {
  const edges = chain?.edges ?? [];
  const first = edges[0];
  const last = edges.at(-1);
  const modules = Array.from(new Set(edges.flatMap((edge) => [
    moduleForFile(edge?.caller_file),
    moduleForFile(edge?.callee_file),
  ]))).sort();
  const pending = edges.filter((edge) => edgeStatus(edge).replace('-', '_') === 'binding_pending').length;
  return {
    chain_id: chain?.chain_id ?? '<missing-chain>',
    owner_feature_id: chain?.owner_feature_id ?? '<missing-owner>',
    edge_count: edges.length,
    first_node: first?.from_node ?? '<missing-start>',
    last_node: last?.to_node ?? '<missing-end>',
    modules,
    pending,
  };
}

function chainCategory(chainId) {
  if (/config|entry_protocol|models|server\.startup|server\.managed_lifecycle/u.test(chainId)) return 'Foundation / entry';
  if (/responses_direct|responses\.websocket|responses\.inbound_websocket|remote_continuation|remote_locator|remote_contract/u.test(chainId)) return 'Responses direct';
  if (/hub_pipeline|relay|protocol\.|protocol_conversion|anthropic_relay|openai_chat_relay|gemini_relay/u.test(chainId)) return 'Hub relay / protocol';
  if (/servertool|stopless|tool_servertool|normalization_tool/u.test(chainId)) return 'Stopless / servertool';
  if (/debug|error|live_provider_compat/u.test(chainId)) return 'Debug / error / compat';
  return 'Other branches';
}

function selectedMainSkeletonChains(chains) {
  const selected = [
    'v3.config.compile',
    'v3.entry_protocol_endpoint_binding.mainline',
    'v3.server.startup',
    'v3.responses_direct.required_mainline',
    'v3.hub_pipeline.v1.request',
    'v3.hub_pipeline.v1.response',
    'v3.servertool_hook_skeleton_lifecycle',
    'v3.debug_error_foundation.mainline',
  ];
  const byId = new Map(chains.map((chain) => [chain?.chain_id, chain]));
  return selected.map((id) => byId.get(id)).filter(Boolean);
}

function renderSkeletonNodeLine(id, chain) {
  const summary = chainReadableLabel(chain);
  const label = [
    `<b>${escapeHtml(summary.title)}</b>`,
    `${escapeHtml(summary.note)}`,
    `<small>${escapeHtml(summary.chain_id)}</small>`,
    `${summary.edge_count} edges · ${escapeHtml(summary.owner_feature_id)}`,
  ].join('<br/>');
  return `  ${id}["${label}"]`;
}

function chainById(chains, chainId) {
  return (chains ?? []).find((chain) => chain?.chain_id === chainId) ?? null;
}

function renderPrimaryChainMermaid(chain, titlePrefix = '') {
  if (!chain) {
    return ['flowchart TD', '  missing["Missing chain in v3-mainline-call-map.yml"]'].join('\n');
  }
  return renderContractMermaidForChain(chain, {
    className: 'primary',
    titlePrefix,
  });
}

function renderRequestSkeletonMermaid(chains) {
  const chain = chainById(chains, 'v3.hub_pipeline.v1.request');
  const directChain = chainById(chains, 'v3.responses_direct.required_mainline');
  if (!chain) return renderPrimaryChainMermaid(null, 'Request mainline');
  const vrEdges = (directChain?.edges ?? []).filter((edge) => [
    'v3-rd-03',
    'v3-rd-04',
    'v3-rd-05',
    'v3-rd-06',
    'v3-rd-07',
    'v3-rd-08',
  ].includes(edge?.step_id));
  const edges = chain.edges ?? [];
  const nodeIds = new Map();
  const getNode = (nodeName) => {
    const key = String(nodeName ?? '<missing-node>');
    if (!nodeIds.has(key)) nodeIds.set(key, `rq_${nodeIds.size}`);
    return nodeIds.get(key);
  };
  for (const edge of edges) {
    getNode(edge?.from_node);
    getNode(edge?.to_node);
  }
  for (const edge of vrEdges) {
    getNode(edge?.from_node);
    getNode(edge?.to_node);
  }
  const lines = [
    '%%{init: {"flowchart": {"htmlLabels": true, "curve": "basis", "rankSpacing": 86, "nodeSpacing": 46}, "themeVariables": {"fontSize": "18px"}} }%%',
    'flowchart TD',
    '  title_note["<b>Request mainline</b><br/><small>generated from v3.hub_pipeline.v1.request edges + explicit VR/Target expansion</small>"]',
  ];
  for (const [nodeName, id] of nodeIds.entries()) {
    lines.push(`  ${id}["${contractNodeHtmlLabel(nodeName)}"]`);
  }
  if (nodeIds.size) lines.push(`  title_note --> ${Array.from(nodeIds.values())[0]}`);
  for (const edge of edges) {
    if (edge?.step_id === 'v3-hub-req-05') continue;
    lines.push(`  ${getNode(edge?.from_node)} -->|${edgeReadableLabel(edge)}| ${getNode(edge?.to_node)}`);
    if (edge?.step_id === 'v3-hub-req-04' && vrEdges.length) {
      lines.push(`  ${getNode(edge?.to_node)} -->|expand route facts to VR| ${getNode(vrEdges[0].from_node)}`);
      for (const vrEdge of vrEdges) {
        lines.push(`  ${getNode(vrEdge?.from_node)} -->|${edgeReadableLabel(vrEdge)}| ${getNode(vrEdge?.to_node)}`);
      }
      lines.push(`  ${getNode(vrEdges.at(-1).to_node)} -->|resolved target returns to Hub ReqTarget06| ${getNode('V3HubReqTarget06Resolved')}`);
    }
  }
  const requestNodeIds = Array.from(new Set(edges.flatMap((edge) => [getNode(edge?.from_node), getNode(edge?.to_node)])));
  const vrNodeIds = Array.from(new Set(vrEdges.flatMap((edge) => [getNode(edge?.from_node), getNode(edge?.to_node)])));
  lines.push('  classDef node fill:#f8fafc,stroke:#334155,stroke-width:1.5px,color:#0f172a;');
  lines.push('  classDef vr fill:#fef3c7,stroke:#d97706,stroke-width:2px,color:#78350f;');
  if (requestNodeIds.length) lines.push(`  class ${requestNodeIds.join(',')} node;`);
  if (vrNodeIds.length) lines.push(`  class ${vrNodeIds.join(',')} vr;`);
  return lines.join('\n');
}

function renderResponseSkeletonMermaid(chains) {
  return renderPrimaryChainMermaid(chainById(chains, 'v3.hub_pipeline.v1.response'), 'Response mainline');
}

function resourceRegistryItems(resourceMap) {
  if (Array.isArray(resourceMap?.resources)) return resourceMap.resources;
  if (Array.isArray(resourceMap?.resource_registry)) return resourceMap.resource_registry;
  return [];
}

function resourceById(resourceMap) {
  return new Map(resourceRegistryItems(resourceMap).map((resource) => [resource?.resource_id, resource]));
}

function nodePrimaryResource(edge, nodeName) {
  const flow = edge?.resource_flow ?? {};
  const toNode = String(edge?.to_node ?? '');
  const fromNode = String(edge?.from_node ?? '');
  if (String(nodeName) === toNode) return (flow.produces ?? [])[0] ?? (flow.side_channel_writes ?? [])[0] ?? null;
  if (String(nodeName) === fromNode) return (flow.consumes ?? [])[0] ?? (flow.side_channel_reads ?? [])[0] ?? null;
  return null;
}


function errorGraphNodeNote(nodeName) {
  if (nodeName === 'V3Transport13ResponsesHttpRequest') {
    return {
      title: 'Provider send failure observation',
      note: 'provider transport/send 阶段失败时记录 health failure；不是 Error01 来源节点',
    };
  }
  if (nodeName === 'V3ProviderResp14Raw') {
    return {
      title: 'Provider success observation',
      note: '收到 provider raw 响应后记录 health success；这是健康恢复信号，不是错误',
    };
  }
  return contractNodeNote(nodeName);
}

function renderErrorResourceMermaid(parsed, resourceMap) {
  const chain = chainById(parsed?.chains ?? [], 'v3.debug_error_foundation.mainline');
  if (!chain) return ['flowchart TD', '  missing["Missing v3.debug_error_foundation.mainline"]'].join('\n');
  const errorEdges = (chain.edges ?? []).filter((edge) => /V3Error0|V3ProviderHealthStateMutated|V3ProviderAvailabilityProjected|V3Transport13ResponsesHttpRequest|V3ProviderResp14Raw/.test(`${edge?.from_node ?? ''} ${edge?.to_node ?? ''}`));
  const nodeIds = new Map();
  const resourceIds = resourceById(resourceMap);
  const resourceForNode = new Map();
  const getNode = (nodeName) => {
    const key = String(nodeName ?? '<missing-node>');
    if (!nodeIds.has(key)) nodeIds.set(key, `er_${nodeIds.size}`);
    return nodeIds.get(key);
  };
  for (const edge of errorEdges) {
    for (const node of [edge?.from_node, edge?.to_node]) {
      const resourceId = nodePrimaryResource(edge, node);
      if (resourceId && !resourceForNode.has(node)) resourceForNode.set(node, resourceId);
    }
  }
  const lines = [
    '%%{init: {"flowchart": {"htmlLabels": true, "curve": "basis", "rankSpacing": 90, "nodeSpacing": 48}, "themeVariables": {"fontSize": "18px"}} }%%',
    'flowchart TD',
  ];
  for (const edge of errorEdges) {
    getNode(edge?.from_node);
    getNode(edge?.to_node);
  }
  for (const [nodeName, id] of nodeIds.entries()) {
    const info = errorGraphNodeNote(nodeName);
    const resourceId = resourceForNode.get(nodeName);
    const resource = resourceIds.get(resourceId);
    const resourceText = resourceId ? `<br/><small>resource: ${escapeHtml(resourceId)}</small><br/><small>owner: ${escapeHtml(resource?.owner_crate ?? 'map missing')} / ${escapeHtml(resource?.owner_node ?? nodeName)}</small>` : '';
    lines.push(`  ${id}["<b>${escapeHtml(info.title)}</b><br/>${escapeHtml(info.note)}<br/><small>${escapeHtml(nodeName)}</small>${resourceText}"]`);
  }
  for (const edge of errorEdges) {
    const from = getNode(edge?.from_node);
    const to = getNode(edge?.to_node);
    const resources = [
      ...(edge?.resource_flow?.consumes ?? []),
      ...(edge?.resource_flow?.produces ?? []),
      ...(edge?.resource_flow?.side_channel_reads ?? []),
      ...(edge?.resource_flow?.side_channel_writes ?? []),
    ];
    const uniqueResources = Array.from(new Set(resources)).slice(0, 3).map((value) => mermaidText(value)).join('<br/>');
    lines.push(`  ${from} -->|${edgeReadableLabel(edge)}${uniqueResources ? `<br/><small>${uniqueResources}</small>` : ''}| ${to}`);
  }
  lines.push('  classDef error fill:#fff1f2,stroke:#be123c,stroke-width:2px,color:#7f1d1d;');
  lines.push('  classDef health fill:#ecfdf5,stroke:#047857,stroke-width:2px,color:#064e3b;');
  const errorNodes = [];
  const healthNodes = [];
  for (const [nodeName, id] of nodeIds.entries()) {
    if (/ProviderHealth|ProviderAvailability/.test(nodeName)) healthNodes.push(id);
    else errorNodes.push(id);
  }
  if (errorNodes.length) lines.push(`  class ${errorNodes.join(',')} error;`);
  if (healthNodes.length) lines.push(`  class ${healthNodes.join(',')} health;`);
  return lines.join('\n');
}

function renderErrorResourceSectionHtml(parsed, resourceMap) {
  const wanted = [
    'v3.error.source',
    'v3.error.classified',
    'v3.error.action_plan',
    'v3.error.exhaustion_decision',
    'v3.error.execution_decision',
    'v3.error.client_projection',
    'v3.provider.health_state',
    'v3.provider.availability_projection',
    'v3.debug.trace_context',
    'v3.debug.event_ledger',
    'v3.debug.raw_capture',
  ];
  const byId = resourceById(resourceMap);
  const rows = wanted.map((id) => {
    const resource = byId.get(id) ?? {};
    return [
      `<code>${escapeHtml(id)}</code>`,
      escapeHtml(resource.resource_kind ?? '<missing>'),
      `<code>${escapeHtml(resource.owner_crate ?? '<missing>')}</code><br/><small>${escapeHtml(resource.owner_node ?? '')}</small>`,
      escapeHtml((resource.identity ?? []).join(' · ')),
      resource.may_enter_provider_body === false && resource.may_enter_client_body === false ? 'isolated' : `provider=${resource.may_enter_provider_body}; client=${resource.may_enter_client_body}`,
    ];
  });
  return `
    <section class="skeleton error-resource-section">
      <h2>Error resources / 错误处理资源</h2>
      <p>错误链是独立资源链：错误进入 <code>V3Error01SourceRaised</code> 后逐节点分类、策略、执行决策、客户端投影。右侧两个 provider 节点不是错误来源：<code>V3Transport13ResponsesHttpRequest</code> 表示 provider send/transport 失败时写 health failure，<code>V3ProviderResp14Raw</code> 表示收到 raw 响应后写 health success；它们只服务 provider health/availability。</p>
      <div class="diagram-shell">
        <pre class="mermaid">${escapeHtml(renderErrorResourceMermaid(parsed, resourceMap))}</pre>
      </div>
      ${htmlTable(['Resource', 'Kind', 'Owner', 'Identity', 'Payload isolation'], rows)}
    </section>
  `;
}

function renderContractMermaidForChain(chain, options = {}) {
  const edges = chain?.edges ?? [];
  const nodeIds = new Map();
  const pendingNodeIds = new Set();
  const getNode = (nodeName) => {
    const key = String(nodeName ?? '<missing-node>');
    if (!nodeIds.has(key)) nodeIds.set(key, `n_${sanitizeId(chain?.chain_id ?? 'chain')}_${nodeIds.size}`);
    return nodeIds.get(key);
  };
  const lines = [
    '%%{init: {"flowchart": {"htmlLabels": true, "curve": "basis", "rankSpacing": 82, "nodeSpacing": 46}, "themeVariables": {"fontSize": "18px"}} }%%',
    'flowchart TD',
  ];
  if (options?.titlePrefix) {
    lines.push(`  title_note["<b>${escapeHtml(options.titlePrefix)}</b><br/><small>generated from ${escapeHtml(chain?.chain_id ?? '<missing-chain>')} edges</small>"]`);
  }
  for (const edge of edges) {
    const fromId = getNode(edge?.from_node);
    const toId = getNode(edge?.to_node);
    if (edgeStatus(edge).replace('-', '_') === 'binding_pending') {
      pendingNodeIds.add(fromId);
      pendingNodeIds.add(toId);
    }
  }
  for (const [nodeName, id] of nodeIds.entries()) {
    lines.push(`  ${id}["${contractNodeHtmlLabel(nodeName)}"]`);
  }
  if (options?.titlePrefix && nodeIds.size) {
    lines.push(`  title_note --> ${Array.from(nodeIds.values())[0]}`);
  }
  for (const edge of edges) {
    const fromId = getNode(edge?.from_node);
    const toId = getNode(edge?.to_node);
    lines.push(`  ${fromId} -->|${edgeReadableLabel(edge)}| ${toId}`);
  }
  lines.push('  classDef node fill:#f8fafc,stroke:#334155,stroke-width:1.5px,color:#0f172a;');
  lines.push('  classDef pending fill:#fff7ed,stroke:#ea580c,stroke-width:2px,color:#7c2d12;');
  if (nodeIds.size) lines.push(`  class ${Array.from(nodeIds.values()).join(',')} node;`);
  if (pendingNodeIds.size) lines.push(`  class ${Array.from(pendingNodeIds).join(',')} pending;`);
  return lines.join('\n');
}

function htmlTable(headers, rows) {
  return [
    '<table>',
    `<thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>`,
    '<tbody>',
    ...rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`),
    '</tbody>',
    '</table>',
  ].join('\n');
}


function renderSideChannelExplanationHtml() {
  return `
    <section class="side-channel-panel">
      <h2>Side-channel meaning / side-channel 含义</h2>
      <div class="format-grid">
        <div class="format-card">
          <h3>它不是资源</h3>
          <p><code>side-channel</code> 是控制事实的传输方式，不是资源名、不是 payload 字段、也不是第二套 request/response。</p>
        </div>
        <div class="format-card">
          <h3>真正资源/owner</h3>
          <p>这里的资源是 <code>Error handler</code>、<code>provider health state</code>、<code>debug/error envelope</code> 等明确 owner。HTML 的 Error resources 区块单独展示这些 owner/resource。</p>
        </div>
        <div class="format-card">
          <h3>允许做法</h3>
          <p>主链节点可以把错误、health、debug 事实写给 Error handler / health owner；这些事实只影响错误投影、健康状态、路由可用性。</p>
        </div>
        <div class="format-card">
          <h3>禁止做法</h3>
          <p>不得把 debug/error/metadata/control 字段塞进 provider request body 或 client response body；不得用 side-channel 重建业务 payload。</p>
        </div>
      </div>
    </section>
  `;
}

function renderFormatHtml() {
  return `
    <section class="format-panel">
      <h2>Read format / 阅读格式</h2>
      <div class="format-grid">
        <div class="format-card">
          <h3>图节点</h3>
          <p><strong>人读标题</strong> → 一句话职责 → <code>contract node id</code>。审计时先看职责是否在正确层，再看 raw node id。</p>
        </div>
        <div class="format-card">
          <h3>图边</h3>
          <p><code>step_id</code> → 语义动作。高风险边会写专用注释；普通边显示 caller module → callee module。</p>
        </div>
        <div class="format-card">
          <h3>表格</h3>
          <p>表格保留真实 <code>caller_symbol</code> / <code>callee_symbol</code> / source file，用来回源代码验证，不让图承担所有细节。</p>
        </div>
      </div>
    </section>
  `;
}

function renderAuditHtml(parsed, sourceAudit) {
  const audit = auditV3CallerFlow(parsed);
  const chains = parsed?.chains ?? [];
  const allEdges = chains.flatMap((chain) => (chain?.edges ?? []).map((edge) => ({ chain, edge })));
  const kindCounts = new Map();
  for (const { edge } of allEdges) {
    const kind = edgeReviewKind(edge);
    kindCounts.set(kind.key, (kindCounts.get(kind.key) ?? 0) + 1);
  }
  const rows = [
    ['Forbidden direct response projection edges', audit.forbiddenDirectProjection.length === 0 ? 'none' : String(audit.forbiddenDirectProjection.length)],
    ['Forbidden source registered direct response edges', sourceAudit.forbiddenRegisteredHooks.length === 0 ? 'none' : String(sourceAudit.forbiddenRegisteredHooks.length)],
    ['Invalid aggregate wrapper edges', audit.invalidAggregateEntry.length === 0 ? 'none' : String(audit.invalidAggregateEntry.length)],
    ['Missing caller/callee fields', audit.missing.length === 0 ? 'none' : String(audit.missing.length)],
    ['Binding-pending edges', String(audit.bindingPending.length)],
    ['typed-test-only edges', String(kindCounts.get('typed-test-only') ?? 0)],
    ['live-bound source edges', String(kindCounts.get('live-bound') ?? 0)],
    ['aggregate-only wrapper edges', String(kindCounts.get('aggregate-only') ?? 0)],
  ];
  const pendingRows = audit.bindingPending.map((edge) => [
    `<code>${escapeHtml(edge.chain_id)}</code>`,
    `<code>${escapeHtml(edge.step_id)}</code>`,
    `<code>${escapeHtml(edge.from_node)}</code>`,
    `<code>${escapeHtml(edge.to_node)}</code>`,
  ]);
  const invalidAggregateRows = audit.invalidAggregateEntry.map((edge) => [
    `<code>${escapeHtml(edge.chain_id)}</code>`,
    `<code>${escapeHtml(edge.step_id)}</code>`,
    `<code>${escapeHtml(edge.from_node)}</code> → <code>${escapeHtml(edge.to_node)}</code>`,
    `<code>${escapeHtml(edge.edge_kind)}</code>`,
  ]);
  const runtimeGapRows = allEdges
    .filter(({ edge }) => ['binding_pending', 'typed-test-only', 'aggregate-only'].includes(edgeReviewKind(edge).key))
    .map(({ chain, edge }) => {
      const kind = edgeReviewKind(edge);
      return [
        `<code>${escapeHtml(chain?.chain_id ?? '')}</code>`,
        `<code>${escapeHtml(edge?.step_id ?? '')}</code>`,
        `<span class="status ${escapeHtml(kind.key)}">${escapeHtml(kind.label)}</span>`,
        escapeHtml(kind.note),
      ];
    });
  return `
    <section class="audit-panel">
      <h2>Auto audit / 补救清单</h2>
      ${htmlTable(['Check', 'Result'], rows.map(([name, value]) => [escapeHtml(name), `<strong>${escapeHtml(value)}</strong>`]))}
      <h3>Review status legend</h3>
      <div class="format-grid">
        <div class="format-card"><h3>typed-test-only</h3><p>Typed skeleton/builder edge from test-owned contract evidence; it proves node topology, not live runtime closure.</p></div>
        <div class="format-card"><h3>live-bound</h3><p>Real source symbols are bound in Rust runtime/source files; live replay remains a separate required proof.</p></div>
        <div class="format-card"><h3>aggregate-only</h3><p>Wrapper/entry edge only. It must not be read as an adjacent semantic pipeline transition.</p></div>
        <div class="format-card"><h3>binding_pending</h3><p>Map owner is declared but caller/callee or source evidence is not yet strong enough to claim closure.</p></div>
        <div class="format-card"><h3>runtime gap</h3><p>Any typed-test-only, aggregate-only, or binding_pending edge is a visible runtime gap until a runtime worker binds and verifies the adjacent owner path.</p></div>
      </div>
      ${invalidAggregateRows.length ? `
        <h3>Invalid aggregate wrappers</h3>
        ${htmlTable(['chain_id', 'step_id', 'edge', 'edge_kind'], invalidAggregateRows)}
      ` : ''}
      ${pendingRows.length ? `
        <h3>Binding pending</h3>
        ${htmlTable(['chain_id', 'step_id', 'from_node', 'to_node'], pendingRows)}
      ` : ''}
      <h3>Runtime gap inventory</h3>
      ${htmlTable(['chain_id', 'step_id', 'review class', 'why it is not runtime/live closure'], runtimeGapRows)}
    </section>
  `;
}

function renderManualAuditItems(chains, locks) {
  const rows = chains.map((chain) => {
    const s = chainReadableLabel(chain);
    const lock = lockStateForChain(chain, locks);
    const resources = resourceSetForChain(chain);
    return [
      `<a href="#chain-${sanitizeId(s.chain_id)}"><code>${escapeHtml(s.chain_id)}</code></a><br/>${escapeHtml(s.title)}`,
      `<span class="status ${escapeHtml(lock.className)}">${escapeHtml(lock.label)}</span>`,
      String(s.edge_count),
      String(resources.size),
      `<code>${escapeHtml(s.owner_feature_id)}</code>`,
      `<code>${escapeHtml(lock.fingerprint.slice(0, 19))}…</code>`,
    ];
  });
  return `
    <section class="manual-audit">
      <h2>Manual audit items / 手工审计项</h2>
      <p>未审核项可以继续按普通架构 gate 使用；Jason 在 HTML 中审核通过后，把该 chain 写入 <code>${escapeHtml(V3_ARCHITECTURE_AUDIT_LOCKS_PATH)}</code> 的 <code>locked_items</code>，之后改动必须有 Jason 手工授权记录。</p>
      ${htmlTable(['Audit item', 'State', 'Edges', 'Resources', 'Owner', 'Current fingerprint'], rows)}
    </section>
  `;
}

function renderBranchIndex(chains, locks) {
  const groups = new Map();
  for (const chain of chains) {
    const id = chain?.chain_id ?? '<missing-chain>';
    const group = chainCategory(id);
    const list = groups.get(group) ?? [];
    list.push(chain);
    groups.set(group, list);
  }
  const groupHtml = Array.from(groups.entries()).map(([group, groupChains]) => `
    <section class="branch-group">
      <h3>${escapeHtml(group)}</h3>
      <div class="branch-grid">
        ${groupChains.map((chain) => {
          const s = chainReadableLabel(chain);
          const lock = lockStateForChain(chain, locks);
          const href = `#chain-${sanitizeId(s.chain_id)}`;
          return `<a class="branch-card" href="${href}">
            <span class="chain-id">${escapeHtml(s.title)}</span>
            <span>${escapeHtml(s.note)}</span>
            <span><code>${escapeHtml(s.chain_id)}</code></span>
            <span>${s.edge_count} edges · ${resourceSetForChain(chain).size} resources · ${escapeHtml(s.modules.join(', '))}</span>
            <span class="status ${escapeHtml(lock.className)}">${escapeHtml(lock.label)}</span>
          </a>`;
        }).join('\n')}
      </div>
    </section>
  `).join('\n');
  return `<section><h2>Branch index / 分支索引</h2>${groupHtml}</section>`;
}

function renderBranchDetails(chain, index, locks) {
  const s = chainReadableLabel(chain);
  const lock = lockStateForChain(chain, locks);
  const open = selectedMainSkeletonChains([chain]).length > 0 || index < 2;
  const edgeRows = (chain?.edges ?? []).map((edge) => [
    `<code>${escapeHtml(edge?.step_id ?? '')}</code>`,
    `<code>${escapeHtml(edge?.from_node ?? '')}</code><br/>→ <code>${escapeHtml(edge?.to_node ?? '')}</code>`,
    `<span class="status ${edgeStatus(edge).replace(/[^a-z0-9_-]/giu, '_')}">${escapeHtml(edgeStatus(edge))}</span>`,
    `<span class="status ${escapeHtml(edgeReviewKind(edge).key)}" title="${escapeHtml(edgeReviewKind(edge).note)}">${escapeHtml(edgeReviewKind(edge).label)}</span>`,
    resourceFlowHtml(edge),
    `<code>${escapeHtml(edge?.caller_symbol ?? '<missing>')}</code><br/><small>${escapeHtml(stripRoot(edge?.caller_file ?? '<missing>'))}</small>`,
    `<code>${escapeHtml(edge?.callee_symbol ?? '<missing>')}</code><br/><small>${escapeHtml(stripRoot(edge?.callee_file ?? '<missing>'))}</small>`,
  ]);
  return `
    <details class="branch-detail" id="chain-${sanitizeId(s.chain_id)}" ${open ? 'open' : ''}>
      <summary>
        <span class="summary-main">${escapeHtml(s.title)}</span>
        <span class="summary-sub">${escapeHtml(s.note)}</span>
        <span class="summary-sub">${s.edge_count} edges · <code>${escapeHtml(s.chain_id)}</code> · ${escapeHtml(s.first_node)} → ${escapeHtml(s.last_node)}</span>
      </summary>
      <div class="branch-body">
        ${chain?.summary ? `<p class="chain-summary">${escapeHtml(chain.summary)}</p>` : ''}
        <div class="branch-meta">
          <span>owner: <code>${escapeHtml(s.owner_feature_id)}</code></span>
          <span>audit: <span class="status ${escapeHtml(lock.className)}">${escapeHtml(lock.label)}</span></span>
          <span>modules: <code>${escapeHtml(s.modules.join(' · '))}</code></span>
          <span>resources: <code>${resourceSetForChain(chain).size}</code></span>
          ${chain?.manifest ? `<span>manifest: <code>${escapeHtml(chain.manifest)}</code></span>` : ''}
          ${s.pending ? `<span class="pending-pill">${s.pending} binding pending</span>` : ''}
        </div>
        <div class="diagram-shell">
          <pre class="mermaid">${escapeHtml(renderContractMermaidForChain(chain))}</pre>
        </div>
        ${htmlTable(['Step', 'Node edge', 'Status', 'Review class', 'Resources', 'Caller', 'Callee'], edgeRows)}
      </div>
    </details>
  `;
}

export function renderV3MainlineCallerFlowHtml(root, relPath = V3_MAINLINE_CALL_MAP_PATH) {
  const parsed = loadV3MainlineCallMap(root, relPath);
  const sourceAudit = auditV3CallerFlowSource(root);
  const locks = loadV3ArchitectureAuditLocks(root);
  const resourceMap = loadV3ResourceOperationMap(root);
  const chains = parsed?.chains ?? [];
  const edgeCount = chains.reduce((sum, chain) => sum + (chain?.edges?.length ?? 0), 0);
  return stripTrailingWhitespace(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>V3 Mainline Caller Flow</title>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
  <script>
    mermaid.initialize({
      startOnLoad: true,
      theme: 'default',
      securityLevel: 'loose',
      flowchart: { htmlLabels: true, useMaxWidth: false, curve: 'basis', rankSpacing: 90, nodeSpacing: 52 },
      themeVariables: { fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif', fontSize: '18px' }
    });
  </script>
  <style>
    :root {
      color-scheme: light;
      --bg: #eef2f1;
      --panel: #ffffff;
      --ink: #0f172a;
      --muted: #475569;
      --line: #cbd5e1;
      --accent: #0f766e;
      --accent-soft: #ccfbf1;
      --warn: #ea580c;
      --code: #f1f5f9;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    main {
      width: min(1880px, calc(100vw - 40px));
      margin: 0 auto;
      padding: 28px 0 72px;
    }
    header.hero, section, .branch-detail {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 18px;
      box-shadow: 0 12px 34px rgba(15, 23, 42, 0.08);
      margin: 0 0 20px;
    }
    header.hero {
      padding: 24px 28px;
      display: grid;
      gap: 8px;
    }
    h1 {
      margin: 0;
      font-size: clamp(34px, 4vw, 58px);
      line-height: 1.02;
      letter-spacing: -0.04em;
    }
    h2 {
      margin: 0 0 18px;
      font-size: clamp(26px, 2.4vw, 38px);
      line-height: 1.12;
      letter-spacing: -0.02em;
    }
    h3 {
      margin: 18px 0 12px;
      font-size: 22px;
    }
    p {
      font-size: 18px;
      line-height: 1.55;
      margin: 0 0 12px;
      color: var(--muted);
    }
    section {
      padding: 24px;
    }
    code {
      font-family: "SFMono-Regular", Menlo, Consolas, monospace;
      background: var(--code);
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0.08rem 0.35rem;
      white-space: nowrap;
    }
    .hero-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      color: var(--muted);
      font-size: 16px;
    }
    .diagram-shell {
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 16px;
      background: linear-gradient(180deg, #f8fafc 0%, #ffffff 100%);
      padding: 18px;
      margin: 14px 0 18px;
    }
    .diagram-shell .mermaid {
      min-width: 920px;
      width: max-content;
      margin: 0 auto;
      background: transparent;
      font-size: 18px;
    }
    .diagram-shell svg {
      max-width: none !important;
      height: auto !important;
    }
    .skeleton .diagram-shell .mermaid {
      min-width: 1180px;
    }
    .format-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 14px;
    }
    .format-card {
      padding: 16px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: #f8fafc;
    }
    .format-card h3 {
      margin-top: 0;
      color: var(--accent);
    }
    .branch-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
      gap: 12px;
    }
    .branch-card {
      display: grid;
      gap: 7px;
      text-decoration: none;
      color: var(--ink);
      padding: 14px;
      border: 1px solid var(--line);
      border-radius: 14px;
      background: #f8fafc;
    }
    .branch-card:hover {
      border-color: var(--accent);
      background: #f0fdfa;
    }
    .chain-id {
      font-weight: 800;
      color: var(--accent);
      word-break: break-word;
    }
    details.branch-detail {
      overflow: hidden;
    }
    details.branch-detail > summary {
      cursor: pointer;
      list-style: none;
      padding: 18px 22px;
      display: grid;
      gap: 6px;
      border-bottom: 1px solid transparent;
    }
    details.branch-detail > summary::-webkit-details-marker { display: none; }
    details.branch-detail[open] > summary {
      border-bottom-color: var(--line);
      background: #f8fafc;
    }
    .summary-main {
      font-size: 24px;
      font-weight: 850;
      color: var(--accent);
      word-break: break-word;
    }
    .summary-sub {
      font-size: 16px;
      color: var(--muted);
      word-break: break-word;
    }
    .branch-body {
      padding: 20px 22px 24px;
    }
    .branch-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: center;
      margin: 6px 0 14px;
      color: var(--muted);
      font-size: 15px;
    }
    .pending-pill {
      color: #7c2d12;
      background: #ffedd5;
      border: 1px solid #fdba74;
      border-radius: 999px;
      padding: 4px 10px;
      font-weight: 700;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: white;
      border: 1px solid var(--line);
      font-size: 15px;
    }
    th, td {
      border: 1px solid var(--line);
      padding: 10px 12px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: var(--accent-soft);
      font-weight: 800;
    }
    small {
      color: var(--muted);
      font-size: 12px;
    }
    .status {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 999px;
      background: #e2e8f0;
      font-weight: 750;
    }
    .status.binding_pending {
      background: #ffedd5;
      color: #7c2d12;
    }
    .status.typed-test-only {
      background: #ede9fe;
      color: #5b21b6;
    }
    .status.live-bound {
      background: #dcfce7;
      color: #166534;
    }
    .status.aggregate-only {
      background: #fef3c7;
      color: #92400e;
    }
    .status.test-bound {
      background: #e0e7ff;
      color: #3730a3;
    }
    .status.pending_review {
      background: #e0f2fe;
      color: #075985;
    }
    .status.audited_locked {
      background: #dcfce7;
      color: #166534;
    }
    .status.locked_changed, .status.missing {
      background: #fee2e2;
      color: #991b1b;
    }
    .resource-row {
      margin: 0 0 6px;
      line-height: 1.55;
    }
    .resource-row code {
      display: inline-block;
      margin: 2px 2px 2px 0;
    }
    @media (max-width: 900px) {
      main { width: calc(100vw - 18px); padding-top: 10px; }
      header.hero, section { padding: 16px; }
      .branch-grid { grid-template-columns: 1fr; }
      table { font-size: 13px; }
    }
  </style>
</head>
<body>
  <main>
    <header class="hero">
      <h1>V3 Mainline Caller Flow</h1>
      <div class="hero-meta">
        <span>Canonical Markdown source: <code>${escapeHtml(V3_CALLER_FLOW_PATH)}</code></span>
        <span>Edge source: <code>${escapeHtml(relPath)}</code></span>
        <span>${chains.length} functional paths</span>
        <span>${edgeCount} caller edges</span>
      </div>
    </header>

    <section class="skeleton">
      <h2>Request skeleton / 请求主骨架</h2>
      <p>请求主骨架只显示 Hub Relay 的真实 edge：<code>inbound → continuation classify → Chat Process → execution/target → outbound → compat → provider wire/transport</code>。VR/Target 属于 request chain 的 execution/target 阶段，provider outbound 必须经过 compat。</p>
      <div class="diagram-shell">
        <pre class="mermaid">${escapeHtml(renderRequestSkeletonMermaid(chains))}</pre>
      </div>
    </section>

    <section class="skeleton">
      <h2>Response skeleton / 响应主骨架</h2>
      <p>响应主骨架只显示 provider 回来后的真实 Relay edge：<code>provider raw → response compat → RespInbound → Resp03 Chat Process → Resp04 continuation save → RespOutbound → Server frame</code>。响应治理只能在 Resp03；Resp04 只保存 continuation。</p>
      <div class="diagram-shell">
        <pre class="mermaid">${escapeHtml(renderResponseSkeletonMermaid(chains))}</pre>
      </div>
    </section>

    ${renderFormatHtml()}

    ${renderSideChannelExplanationHtml()}

    ${renderErrorResourceSectionHtml(parsed, resourceMap)}

    ${renderAuditHtml(parsed, sourceAudit)}

    ${renderManualAuditItems(chains, locks)}

    ${renderBranchIndex(chains, locks)}

    <section>
      <h2>Standalone branch diagrams / 分支独立图</h2>
      <p>每个分支图都由该 chain 的 <code>from_node -> to_node</code> edge 自动生成，默认 top-down；表格保留 caller/callee/source 文件用于审计。</p>
    </section>
    ${chains.map((chain, index) => renderBranchDetails(chain, index, locks)).join('\n')}
  </main>
</body>
</html>
`);
}

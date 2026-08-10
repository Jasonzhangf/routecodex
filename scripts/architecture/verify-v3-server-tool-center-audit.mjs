#!/usr/bin/env node
// Gate: V3 servertool center 控制面写入必须携带 written_by/reason/request_id 审计轨迹。
// 锁住目标 3：控制面写入有记录（谁写的、为什么写、何时写、关联哪个请求）。
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];

const common = fs.readFileSync(
  path.join(root, 'v3/crates/routecodex-v3-runtime/src/hub_v1/common.rs'),
  'utf8',
);
const hubV1 = fs.readFileSync(
  path.join(root, 'v3/crates/routecodex-v3-runtime/src/hub_v1.rs'),
  'utf8',
);
const manifest = fs.readFileSync(
  path.join(root, 'docs/architecture/metadata-center-manifest.yml'),
  'utf8',
);
const packageJson = fs.readFileSync(path.join(root, 'package.json'), 'utf8');

// 1) 审计类型与环形缓冲必须存在（可查“谁写的、为什么写”）。
const auditTypePatterns = [
  ['V3ServerToolCenterWriteAuditEntry', 'pub struct V3ServerToolCenterWriteAuditEntry'],
  ['V3ServerToolCenterWriteOrigin', 'pub struct V3ServerToolCenterWriteOrigin'],
  ['V3ServerToolCenterWriteAction', 'pub enum V3ServerToolCenterWriteAction'],
  ['audit 环形缓冲字段', 'audit: Arc<Mutex<VecDeque<V3ServerToolCenterWriteAuditEntry>>>'],
  ['audit_trail 读取入口', 'pub fn audit_trail('],
  ['written_by 字段', 'pub written_by: V3ServerToolCenterWriteOrigin'],
  ['reason 字段', 'pub reason: Option<String>'],
  ['request_id 字段', 'pub request_id: Option<String>'],
  ['写入时间戳字段', 'pub at_unix_ms: u64'],
];
for (const [label, pattern] of auditTypePatterns) {
  if (!common.includes(pattern)) {
    failures.push(`common.rs 缺少审计能力「${label}」：未找到 ${pattern}`);
  }
}

// 2) 四个写方法签名必须强制携带 written_by / reason / request_id（编译期强制 + 静态锁）。
function findMethodSignature(source, method) {
  const anchor = source.indexOf(`pub fn ${method}(`);
  if (anchor === -1) {
    const genericAnchor = source.indexOf(`pub fn ${method}<`);
    if (genericAnchor === -1) {
      return null;
    }
    return source.slice(genericAnchor, source.indexOf('{', genericAnchor));
  }
  return source.slice(anchor, source.indexOf('{', anchor));
}

for (const method of ['register', 'store', 'clear', 'transition']) {
  const signature = findMethodSignature(common, method);
  if (signature === null) {
    failures.push(`common.rs 未找到写方法 pub fn ${method}(`);
    continue;
  }
  if (!signature.includes('written_by: V3ServerToolCenterWriteOrigin')) {
    failures.push(`写方法 ${method} 签名未携带 written_by`);
  }
  for (const required of ['reason: Option<&str>', 'request_id: Option<&str>']) {
    if (!signature.includes(required)) {
      failures.push(`写方法 ${method} 签名未携带 ${required}`);
    }
  }
}

// 3) 每次写入必须追加记录（register/store/clear/transition 各至少一处审计动作）。
for (const action of ['Register', 'Store', 'Transition', 'Clear']) {
  if (!common.includes(`V3ServerToolCenterWriteAction::${action}`)) {
    failures.push(`common.rs 未记录审计动作 V3ServerToolCenterWriteAction::${action}`);
  }
}

// 4) hub_v1 必须重导出审计类型，保证调用点可引用。
for (const typeName of [
  'V3ServerToolCenterWriteOrigin',
  'V3ServerToolCenterWriteAuditEntry',
  'V3ServerToolCenterWriteAction',
]) {
  if (!hubV1.includes(typeName)) {
    failures.push(`hub_v1.rs 未 re-export ${typeName}`);
  }
}

// 5) 控制面写 helper 与调用点必须实际传参（静态抽查 relay/direct/hop 三侧）。
//    写 helper 定义侧检查签名携带 written_by；调用点侧检查 origin 字面量存在。
const writeCallSites = [
  ['hub_v1/responses_relay_runtime.rs', 'literal'],
  ['kernel/direct_stopless.rs', 'literal'],
  ['hub_v1/web_search_hop.rs', 'literal'],
  ['kernel/direct_state.rs', 'signature'],
];
for (const [relPath, mode] of writeCallSites) {
  const source = fs.readFileSync(
    path.join(root, `v3/crates/routecodex-v3-runtime/src/${relPath}`),
    'utf8',
  );
  const hasOrigin =
    mode === 'literal'
      ? source.includes('V3ServerToolCenterWriteOrigin {')
      : source.includes('written_by: V3ServerToolCenterWriteOrigin');
  if (!hasOrigin) {
    failures.push(
      `${relPath} 未发现${
        mode === 'literal' ? '任何带 written_by 的控制面写入调用' : '携带 written_by 的写 helper 签名'
      }`,
    );
  }
}

// 6) manifest 的 required_gates 必须声明本 gate（设计契约与门禁对齐，不再孤儿）。
if (!manifest.includes('verify:v3-server-tool-center-audit')) {
  failures.push(
    'metadata-center-manifest.yml 的 required_gates 未声明 verify:v3-server-tool-center-audit',
  );
}
if (!packageJson.includes('verify:v3-server-tool-center-audit')) {
  failures.push('package.json 未注册 verify:v3-server-tool-center-audit');
}

if (failures.length > 0) {
  console.error(`[verify:v3-server-tool-center-audit] FAIL (${failures.length})`);
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}
console.log('[verify:v3-server-tool-center-audit] ok (write audit enforced)');

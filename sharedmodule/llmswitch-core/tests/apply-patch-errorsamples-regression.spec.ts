import { validateToolCall } from '../src/tools/tool-registry.js';

describe('apply_patch errorsamples regression', () => {
  it('normalizes GNU diff format with *** a/ prefix (not Apply-Patch header)', () => {
    // Sample from errorsample: chat_process.req.stage2.semantic_map.apply_patch-20260316-225648-746Z
    const patch = `*** Begin Patch
*** a/DELIVERY.md
+++ b/DELIVERY.md
@@ -116,3 +116,49 @@
+## [2026-03-17 05:58] - 修复 session 处理逻辑
*** End Patch`;

    const res = validateToolCall('apply_patch', patch);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Begin Patch');
    expect(normalized.patch).toContain('*** Update File: DELIVERY.md');
  });

  it('handles mixed Apply-Patch and GNU diff formats', () => {
    // Model might output a mix of formats
    const patch = `*** Begin Patch
*** Update File: src/cli/commands/launcher-kernel.ts
--- a/src/cli/commands/launcher-kernel.ts
+++ b/src/cli/commands/launcher-kernel.ts
@@ -85,10 +85,11 @@
 const raw =
   env.ROUTECODEX_CLIENT_EXIT_GRACE_PERIOD_MS
   ?? env.RCC_CLIENT_EXIT_GRACE_PERIOD_MS
   ?? '5000';
-  const parsed = Number(raw);
+  const parsed = Number(raw);
+  if (!Number.isFinite(parsed) || parsed <= 0) {
+    return 5000;
+  }
*** End Patch`;

    const res = validateToolCall('apply_patch', patch);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Update File: src/cli/commands/launcher-kernel.ts');
    expect(normalized.patch).not.toContain('--- a/');
    expect(normalized.patch).not.toContain('+++ b/');
  });

  it('handles markdown-style headers in patch content', () => {
    // Model might include markdown headers in patch content
    const patch = `*** Begin Patch
*** Update File: README.md
@@ -1,5 +1,10 @@
 # Project README
 
+## Version History
+
+**版本**: v0.1.2
+**更新日期**: 2026-03-17
+
 This is a sample project.
*** End Patch`;

    const res = validateToolCall('apply_patch', patch);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Update File: README.md');
    expect(normalized.patch).toContain('+## Version History');
  });

  it('handles escaped newlines in patch content', () => {
    // Model might output escaped newlines
    const patch = `*** Begin Patch
*** Update File: src/config.ts
@@ -10,5 +10,8 @@
 export const config = {
-  debug: false,
+  debug: true,
+  features: [\n    'feature1',\n    'feature2'\n  ]
 };
*** End Patch`;

    const res = validateToolCall('apply_patch', patch);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Update File: src/config.ts');
  });

  it('handles trailing whitespace in patch lines', () => {
    // Model might include trailing whitespace
    const patch = `*** Begin Patch
*** Update File: src/utils.ts  
@@ -1,3 +1,4 @@  
 export function util() {  
   return 'test';  
+  console.log('debug');  
 }  
*** End Patch`;

    const res = validateToolCall('apply_patch', patch);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Update File: src/utils.ts');
  });
});

  // 新样本：2026-03-17 07:18 UTC
  it('handles JavaScript comment markers without prefix', () => {
    // Sample: chat_process.req.stage2.semantic_map.apply_patch-20260316-231839-688Z
    // Error: Unexpected line found in update hunk: '/**'
    const patch = `*** Begin Patch
*** Update File: src/utils.ts
@@ -1,5 +1,8 @@
 export function util() {
+  /**
+   * Added comment
+   */
   return 'test';
 }
*** End Patch`;

    const res = validateToolCall('apply_patch', patch);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Update File: src/utils.ts');
  });

  it('handles markdown bold markers without prefix', () => {
    // Sample: chat_process.req.stage2.semantic_map.apply_patch-20260316-231839-688Z
    // Error: Unexpected line found in update hunk: '**版本**: v0.1.2'
    const patch = `*** Begin Patch
*** Update File: CHANGELOG.md
@@ -1,3 +1,6 @@
 # Changelog
 
+**版本**: v0.1.2
+**日期**: 2026-03-17
+
 ## v0.1.0
*** End Patch`;

    const res = validateToolCall('apply_patch', patch);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Update File: CHANGELOG.md');
  });

  it('handles Chinese markdown headers without prefix', () => {
    // Sample: chat_process.req.stage2.semantic_map.apply_patch-20260316-231839-688Z
    // Error: Expected update hunk to start with @@, got: '## [2026-03-17 05:58] - 修复 session 处理逻辑'
    const patch = `*** Begin Patch
*** Update File: DELIVERY.md
@@ -1,3 +1,7 @@
 # Delivery Log
 
+## [2026-03-17 05:58] - 修复 session 处理逻辑
+
+- Fixed session handling
+
 Previous delivery...
*** End Patch`;

    const res = validateToolCall('apply_patch', patch);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Update File: DELIVERY.md');
  });
});

  // 2026-03-17 07:45: 修复 --- a/file 格式识别
  it('handles GNU diff format starting with --- a/file (no *** a/ prefix)', () => {
    // Sample: chat_process.req.stage2.semantic_map.apply_patch-20260316-234014-208Z
    // Error: invalid hunk at line 2, '--- a/src/agents/chat-codex/chat-codex-module.ts' is not a valid hunk header
    const patch = `*** Begin Patch
--- a/src/agents/chat-codex/chat-codex-module.ts
+++ b/src/agents/chat-codex/chat-codex-module.ts
@@ -1,5 +1,8 @@
 export class ChatCodexModule {
   private config: Config;
+  private logger: Logger;
+
+  constructor(config: Config, logger: Logger) {
+    this.config = config;
 }
*** End Patch`;

    const res = validateToolCall('apply_patch', patch);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Update File: src/agents/chat-codex/chat-codex-module.ts');
  });

  it('handles *** Begin Patch wrapped content with --- a/file inside', () => {
    // Model might wrap GNU diff inside *** Begin Patch markers
    const patch = `*** Begin Patch
*** a/DELIVERY.md
+++ b/DELIVERY.md
@@ -116,3 +116,49 @@
+## [2026-03-17 05:58] - 修复 session 处理逻辑
*** End Patch`;

    const res = validateToolCall('apply_patch', patch);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Begin Patch');
    expect(normalized.patch).toContain('*** Update File: DELIVERY.md');
  });

  it('handles mixed GNU diff and apply_patch formats with missing prefixes', () => {
    // Complex case: GNU diff headers mixed with apply_patch markers
    const patch = `*** Begin Patch
*** Update File: src/cli/commands/launcher-kernel.ts
--- a/src/cli/commands/launcher-kernel.ts
+++ b/src/cli/commands/launcher-kernel.ts
@@ -84,10 +84,11 @@
 function resolveExitGracePeriodMs(env: NodeJS.ProcessEnv): number {
   const raw =
     env.ROUTECODEX_CLIENT_EXIT_GRACE_PERIOD_MS
     ?? env.RCC_CLIENT_EXIT_GRACE_PERIOD_MS
-    ?? '';
+    ?? '5000';
   const parsed = Number(raw);
-  if (!Number.isFinite(parsed) || parsed <= 0) {
-    return 0;
+  if (!Number.isFinite(parsed) || parsed <= 0) {
+    return 5000;
   }
   return Math.floor(parsed);
 }
*** End Patch`;

    const res = validateToolCall('apply_patch', patch);
    expect(res.ok).toBe(true);
    const normalized = JSON.parse(res.normalizedArgs as string);
    expect(normalized.patch).toContain('*** Update File: src/cli/commands/launcher-kernel.ts');
    // Should not contain GNU diff headers after normalization
    expect(normalized.patch).not.toContain('--- a/');
    expect(normalized.patch).not.toContain('+++ b/');
  });
});

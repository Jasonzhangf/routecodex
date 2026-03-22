import { validateToolCall } from '../src/tools/tool-registry.js';

const parsePatch = (input: string): string => {
  const res = validateToolCall('apply_patch', input);
  expect(res.ok).toBe(true);
  const normalized = JSON.parse(String(res.normalizedArgs || '{}')) as { patch?: string };
  expect(typeof normalized.patch).toBe('string');
  return String(normalized.patch || '');
};

describe('apply_patch errorsamples regression', () => {
  it('strips leading apply_patch command wrapper before Begin Patch', () => {
    const patch = `apply_patch *** Begin Patch
*** Update File: src/a.ts
@@ -1 +1 @@
-old
+new
*** End Patch`;

    const normalized = parsePatch(patch);
    expect(normalized).toMatch(/^\*\*\* Begin Patch/);
    expect(normalized).toContain('*** Update File: src/a.ts');
    expect(normalized).not.toContain('apply_patch *** Begin Patch');
  });

  it('extracts nested result.command wrapper payload into canonical patch', () => {
    const wrapped = JSON.stringify({
      ok: true,
      result: {
        command: `apply_patch *** Begin Patch
*** Add File: src/wrapped.ts
console.log("wrapped");
*** End Patch`
      }
    });

    const normalized = parsePatch(wrapped);
    expect(normalized).toContain('*** Begin Patch');
    expect(normalized).toContain('*** Add File: src/wrapped.ts');
    expect(normalized).toContain('+console.log("wrapped");');
  });

  it('normalizes *** a/ wrapped GNU diff samples into Update File patches', () => {
    const patch = `*** Begin Patch
*** a/DELIVERY.md
+++ b/DELIVERY.md
@@ -116,3 +116,49 @@
+## [2026-03-17 05:58] - 修复 session 处理逻辑
*** End Patch`;

    const normalized = parsePatch(patch);
    expect(normalized).toContain('*** Begin Patch');
    expect(normalized).toContain('*** Update File: DELIVERY.md');
    expect(normalized).not.toContain('*** a/DELIVERY.md');
  });

  it('strips mixed GNU headers from Update File blocks', () => {
    const patch = `*** Begin Patch
*** Update File: src/cli/commands/launcher-kernel.ts
diff --git a/src/cli/commands/launcher-kernel.ts b/src/cli/commands/launcher-kernel.ts
index 1111111..2222222 100644
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

    const normalized = parsePatch(patch);
    expect(normalized).toContain('*** Update File: src/cli/commands/launcher-kernel.ts');
    expect(normalized).toContain('@@ -84,10 +84,11 @@');
    expect(normalized).not.toContain('diff --git');
    expect(normalized).not.toContain('index 1111111..2222222 100644');
    expect(normalized).not.toContain('--- a/src/cli/commands/launcher-kernel.ts');
    expect(normalized).not.toContain('+++ b/src/cli/commands/launcher-kernel.ts');
  });

  it('promotes naked continuation lines after + lines inside update hunks', () => {
    const patch = `*** Begin Patch
*** Update File: CHANGELOG.md
@@ -1,3 +1,7 @@
 # Changelog
 
+## Version History
**版本**: v0.1.2
**日期**: 2026-03-17
+
 ## v0.1.0
*** End Patch`;

    const normalized = parsePatch(patch);
    expect(normalized).toContain('+## Version History');
    expect(normalized).toContain('+**版本**: v0.1.2');
    expect(normalized).toContain('+**日期**: 2026-03-17');
  });

  it('normalizes wrapped --- a/file unified diff samples', () => {
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

    const normalized = parsePatch(patch);
    expect(normalized).toContain('*** Update File: src/agents/chat-codex/chat-codex-module.ts');
    expect(normalized).not.toContain('--- a/src/agents/chat-codex/chat-codex-module.ts');
  });

  it('converts rename metadata inside Update File blocks into Move to', () => {
    const patch = `*** Begin Patch
*** Update File: src/old-name.ts
diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 100%
rename from src/old-name.ts
rename to src/new-name.ts
*** End Patch`;

    const normalized = parsePatch(patch);
    expect(normalized).toContain('*** Update File: src/old-name.ts');
    expect(normalized).toContain('*** Move to: src/new-name.ts');
    expect(normalized).not.toContain('rename from');
    expect(normalized).not.toContain('rename to');
  });

  it('normalizes Begin Patch payloads that only contain legacy --- a/file header', () => {
    const patch = `*** Begin Patch
--- a/apps/mobile-app/src/services/mobileWebdavSync.ts
@@ -1 +1 @@
-old
+new
*** End Patch`;

    const normalized = parsePatch(patch);
    expect(normalized).toContain('*** Update File: apps/mobile-app/src/services/mobileWebdavSync.ts');
    expect(normalized).not.toContain('--- a/apps/mobile-app/src/services/mobileWebdavSync.ts');
    expect(normalized).toContain('@@ -1 +1 @@');
  });

  it('promotes unprefixed function signature lines inside update hunks', () => {
    const patch = `*** Begin Patch
*** Update File: apps/mobile-app/src/services/mobileWebdavSync.ts
@@
-export async function runShell(
+export async function runShell(
}): Promise<{ ok: boolean; data?: any; error?: string; rawOutput?: string }> {
*** End Patch`;

    const normalized = parsePatch(patch);
    expect(normalized).toContain('+}): Promise<{ ok: boolean; data?: any; error?: string; rawOutput?: string }> {');
  });
});

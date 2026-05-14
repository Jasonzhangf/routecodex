// Tool registry and validator (apply_patch only)

import { parseToolArgsJson } from './args-json.js';
import { normalizeApplyPatchText, looksLikePatch } from './patch-text/normalize.js';

const toJson = (value: unknown): string => {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
};

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function normalizeApplyPatchArgsWithNative(rawArgs: string): string | undefined {
  try {
    const { invokeStringCapability } = await import('../../router/virtual-router/engine-selection/native-compat-action-semantics.js');
    const fixed = invokeStringCapability('fixApplyPatchToolCalls', [rawArgs]);
    return typeof fixed === 'string' ? fixed : undefined;
  } catch {
    return undefined;
  }
}

function unwrapSingleQuotedShellBody(raw: string): string | undefined {
  const trimmed = raw.trim();
  const match = trimmed.match(/^(bash|zsh|sh)\s+-l?c\s+'([\s\S]*)'$/);
  return match?.[2];
}

function extractCanonicalApplyPatchHeredoc(raw: string): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const candidate = unwrapSingleQuotedShellBody(trimmed) ?? trimmed;
  const normalized = candidate.replace(/\r\n/g, '\n').trim();
  if (!normalized.includes('apply_patch <<')) return undefined;
  const match = normalized.match(
    /^(?:(?:cd\s+([^\n;&|]+?)\s*&&\s*)?)apply_patch\s+<<['"]?([A-Za-z0-9_:-]+)['"]?\n([\s\S]*?)\n\2$/
  );
  if (!match?.[3]) return undefined;
  const before = normalized.slice(0, match.index ?? 0).trim();
  if (before) return undefined;
  const patchText = match[3].trim();
  return patchText || undefined;
}

function looksLikeNonCanonicalShellApplyPatchAttempt(rawArgs: string): boolean {
  if (typeof rawArgs !== 'string') return false;
  const trimmed = rawArgs.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return false;
  const normalized = trimmed.replace(/\\r\\n/g, '\n');
  const lower = normalized.toLowerCase();
  if (
    lower.startsWith('bash -lc ') ||
    lower.startsWith('bash -c ') ||
    lower.startsWith('zsh -lc ') ||
    lower.startsWith('zsh -c ') ||
    lower.startsWith('sh -lc ') ||
    lower.startsWith('sh -c ')
  ) {
    return normalized.includes('apply_patch <<') && !/^((bash|zsh|sh)\s+-l?c\s+["']?(cd [^&\n]+ && )?apply_patch <<)/.test(trimmed);
  }
  const idx = normalized.indexOf('apply_patch <<');
  return idx > 0 && normalized.slice(0, idx).trim().length > 0;
}

// Step 3: 收缩为仅保留真正非法的硬拒绝
// 移除了两条冲突规则:
//   - Update File 后 --- 分隔符 → 交给 normalize (Step 1)
//   - Update File 无 @@ 且非 Move to → 交给 normalize (Step 1/2)
function detectInvalidPatchReason(normalizedPatch: string | undefined): string | undefined {
  const patch = typeof normalizedPatch === 'string' ? normalizedPatch : '';
  if (!patch.trim()) return 'missing_changes';
  if (/^\*\*\* Add File:\s*\/dev\/null\s*$/m.test(patch)
    || /^\*\*\* Update File:\s*\/dev\/null\s*$/m.test(patch)
    || /^\*\*\* Delete File:\s*\/dev\/null\s*$/m.test(patch)) {
    return 'invalid_patch_path';
  }
  if (/^\*\*\* Add File:/m.test(patch) && !/^\+(?!\+\+)(?:.|$)/m.test(patch)) {
    return 'empty_add_file_block';
  }
  // empty_update_hunk: @@ 存在但后跟非 patch 行
  if (/^\@\@/m.test(patch) && !/^[ +-]/m.test(patch)) {
    return 'empty_update_hunk';
  }
  return undefined;
}

function hasUnsafeMixedSyntaxInsideAddFile(normalizedPatch: string | undefined): boolean {
  const patch = typeof normalizedPatch === 'string' ? normalizedPatch : '';
  if (!patch) return false;
  const lines = patch.split('\n');
  let inAddSection = false;
  for (const line of lines) {
    if (line.startsWith('*** Add File:')) { inAddSection = true; continue; }
    if (line.startsWith('*** Update File:') || line.startsWith('*** Delete File:') || line.startsWith('*** End Patch')) { inAddSection = false; continue; }
    if (!inAddSection) continue;
    if (/^\+\@\@(?:\s|$)/.test(line)) return true;
    if (/^\+(?:diff --git |index |--- |\+\+\+ )/.test(line)) return true;
  }
  return false;
}

const makeMessage = (reason: string | undefined): string => {
  if (reason === 'missing_changes') return '结构完整但无内容';
  if (reason === 'empty_add_file_block') return 'Add File 不能为空文件；请提供至少一行以 + 开头的内容';
  if (reason === 'empty_update_hunk') return 'Update File 的 @@ hunk 不能为空；请在 @@ 后提供至少一行以空格/+/-开头的内容';
  if (reason === 'invalid_patch_path') return '文件路径非法：请使用精确路径，禁止 /dev/null 作为 Add/Update/Delete File 路径';
  return '补丁格式不合法：Update File 必须包含 @@ hunk，且不要猜测文件名/参数；若要整文件重写，请显式 Delete File + Add File（每行加 +）';
};

export function validateApplyPatchArgs(argsString: string, rawArgs: unknown): { ok: boolean; reason?: string; message?: string; normalizedArgs?: string } {
  // ---- 路径 A: heredoc 提取 (Step 0) ----
  const canonicalShellPatch = extractCanonicalApplyPatchHeredoc(
    typeof argsString === 'string' && argsString.trim().length > 0 ? argsString : String(rawArgs ?? '')
  );
  if (canonicalShellPatch) {
    const normalizedPatch = normalizeApplyPatchText(canonicalShellPatch);
    const structuralReason = detectInvalidPatchReason(normalizedPatch);
    if (!looksLikePatch(normalizedPatch) || structuralReason) {
      const reason = structuralReason ?? (normalizedPatch ? undefined : 'missing_changes');
      return { ok: false, reason: reason ?? 'unsupported_patch_format', message: makeMessage(reason) };
    }
    return { ok: true, normalizedArgs: toJson({ patch: normalizedPatch, input: normalizedPatch }) };
  }

  // ---- 路径 B/C: native normalize + extract ----
  if (looksLikeNonCanonicalShellApplyPatchAttempt(argsString)) {
    return { ok: false, reason: 'missing_changes', message: makeMessage('missing_changes') };
  }

  let normalizedPatch: string | undefined;
  try {
    const nativeNormalizedArgs = normalizeApplyPatchArgsWithNative(
      typeof argsString === 'string' && argsString.trim().length > 0 ? argsString : String(rawArgs ?? '')
    );
    if (nativeNormalizedArgs) {
      const parsed = JSON.parse(nativeNormalizedArgs) as Record<string, unknown>;
      normalizedPatch = readString(parsed.patch) ?? readString(parsed.input) ?? readString(parsed.raw);
    }
  } catch { /* fall through */ }

  if (!normalizedPatch || !looksLikePatch(normalizedPatch)) {
    // 尝试直接 normalize（非 JSON patch text）
    const direct = normalizeApplyPatchText(typeof argsString === 'string' ? argsString : '');
    if (direct && looksLikePatch(direct)) {
      normalizedPatch = direct;
    } else {
      return { ok: false, reason: 'missing_changes', message: makeMessage('missing_changes') };
    }
  }

  if (normalizedPatch) {
    normalizedPatch = normalizeApplyPatchText(normalizedPatch);
  }

  const structuralReason = detectInvalidPatchReason(normalizedPatch);
  if (!normalizedPatch || !looksLikePatch(normalizedPatch) || structuralReason) {
    return { ok: false, reason: structuralReason ?? 'unsupported_patch_format', message: makeMessage(structuralReason) };
  }

  if (hasUnsafeMixedSyntaxInsideAddFile(normalizedPatch)) {
    return { ok: false, reason: 'unsupported_patch_format', message: '补丁格式不合法：Add File 块中混入了 diff/hunk 头；这会写坏文件。请改成纯 Add File 内容，或改成正确的 unified diff 后重试' };
  }

  return { ok: true, normalizedArgs: toJson({ patch: normalizedPatch, input: normalizedPatch }) };
}

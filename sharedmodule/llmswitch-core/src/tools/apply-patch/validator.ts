import { normalizeApplyPatchArgs } from './args-normalizer/index.js';
import { normalizeApplyPatchText, looksLikePatch } from './patch-text/normalize.js';

export { looksLikePatch, normalizeApplyPatchText };

const toJson = (value: unknown): string => {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
};

export type ApplyPatchValidationResult = {
  ok: boolean;
  reason?: string;
  message?: string;
  normalizedArgs?: string;
};

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function looksLikeNonCanonicalShellApplyPatchAttempt(rawArgs: string): boolean {
  if (typeof rawArgs !== 'string') {
    return false;
  }
  const trimmed = rawArgs.trim();
  if (!trimmed) {
    return false;
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return false;
  }
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
  if (idx <= 0) {
    return false;
  }
  const prefix = normalized.slice(0, idx).trim();
  return prefix.length > 0;
}

function detectInvalidPatchReason(normalizedPatch: string | undefined): string | undefined {
  const patch = typeof normalizedPatch === 'string' ? normalizedPatch : '';
  if (!patch.trim()) {
    return 'missing_changes';
  }
  if (/^\*\*\* Add File:\s*\/dev\/null\s*$/m.test(patch)
    || /^\*\*\* Update File:\s*\/dev\/null\s*$/m.test(patch)
    || /^\*\*\* Delete File:\s*\/dev\/null\s*$/m.test(patch)) {
    return 'invalid_patch_path';
  }
  if (/^\*\*\* Add File:/m.test(patch) && !/^\+(?!\+\+)(?:.|$)/m.test(patch)) {
    return 'empty_add_file_block';
  }
  if (/^\*\*\* Update File:/m.test(patch) && /^\s*---\s*$/m.test(patch)) {
    return 'unsupported_patch_format';
  }
  if (/^\*\*\* Update File:/m.test(patch) && !/^\@\@/m.test(patch) && !/^\*\*\* Move to:/m.test(patch)) {
    return 'unsupported_patch_format';
  }
  if (/^\@\@/m.test(patch) && !/^[ +-]/m.test(patch)) {
    return 'empty_update_hunk';
  }
  return undefined;
}

function inferFailureReasonFromPatch(normalizedPatch: string | undefined): string {
  return detectInvalidPatchReason(normalizedPatch) ?? 'unsupported_patch_format';
}

function hasUnsafeMixedSyntaxInsideAddFile(normalizedPatch: string | undefined): boolean {
  const patch = typeof normalizedPatch === 'string' ? normalizedPatch : '';
  if (!patch) {
    return false;
  }
  const lines = patch.split('\n');
  let inAddSection = false;
  for (const line of lines) {
    if (line.startsWith('*** Add File:')) {
      inAddSection = true;
      continue;
    }
    if (line.startsWith('*** Update File:') || line.startsWith('*** Delete File:') || line.startsWith('*** End Patch')) {
      inAddSection = false;
      continue;
    }
    if (!inAddSection) {
      continue;
    }
    if (/^\+\@\@(?:\s|$)/.test(line)) {
      return true;
    }
    if (/^\+(?:diff --git |index |--- |\+\+\+ )/.test(line)) {
      return true;
    }
  }
  return false;
}

export function validateApplyPatchArgs(argsString: string, rawArgs: unknown): ApplyPatchValidationResult {
  if (looksLikeNonCanonicalShellApplyPatchAttempt(argsString)) {
    return { ok: false, reason: 'missing_changes', message: '结构完整但无内容' };
  }

  let normalizedPatch: string | undefined;

  // 直接使用 normalizeApplyPatchArgs
  const normalized = normalizeApplyPatchArgs(argsString, rawArgs);
  if (normalized.ok === false) {
    const reason = normalized.reason;
    let message: string | undefined;
    if (reason === 'missing_changes') {
      message = '结构完整但无内容';
    } else if (reason === 'empty_add_file_block') {
      message = 'Add File 不能为空文件；请提供至少一行以 + 开头的内容';
    } else if (reason === 'empty_update_hunk') {
      message = 'Update File 的 @@ hunk 不能为空；请在 @@ 后提供至少一行以空格/+/-开头的内容';
    } else if (reason === 'invalid_patch_path') {
      message = '文件路径非法：请使用精确路径，禁止 /dev/null 作为 Add/Update/Delete File 路径';
    } else if (reason === 'unsupported_patch_format') {
      message = '补丁格式不合法：Update File 必须包含 @@ hunk，且不要猜测文件名/参数；若要整文件重写，请显式 Delete File + Add File（每行加 +）';
    }
    return { ok: false, reason, message };
  }
  normalizedPatch = normalized.patchText;

  if (normalizedPatch) {
    normalizedPatch = normalizeApplyPatchText(normalizedPatch);
  }

  const structuralReason = detectInvalidPatchReason(normalizedPatch);
  const shouldReject =
    !normalizedPatch ||
    !looksLikePatch(normalizedPatch) ||
    structuralReason !== undefined;

  if (shouldReject) {
    const reason = structuralReason ?? inferFailureReasonFromPatch(normalizedPatch);
    let message: string | undefined;
    if (reason === 'missing_changes') {
      message = '结构完整但无内容';
    } else if (reason === 'empty_add_file_block') {
      message = 'Add File 不能为空文件；请提供至少一行以 + 开头的内容';
    } else if (reason === 'empty_update_hunk') {
      message = 'Update File 的 @@ hunk 不能为空；请在 @@ 后提供至少一行以空格/+/-开头的内容';
    } else if (reason === 'invalid_patch_path') {
      message = '文件路径非法：请使用精确路径，禁止 /dev/null 作为 Add/Update/Delete File 路径';
    } else if (reason === 'unsupported_patch_format') {
      message = '补丁格式不合法：Update File 必须包含 @@ hunk，且不要猜测文件名/参数；若要整文件重写，请显式 Delete File + Add File（每行加 +）';
    }
    return { ok: false, reason, message };
  }

  if (hasUnsafeMixedSyntaxInsideAddFile(normalizedPatch)) {
    return {
      ok: false,
      reason: 'unsupported_patch_format',
      message: '补丁格式不合法：Add File 块中混入了 diff/hunk 头；这会写坏文件。请改成纯 Add File 内容，或改成正确的 unified diff 后重试'
    };
  }

  return {
    ok: true,
    normalizedArgs: toJson({ patch: normalizedPatch, input: normalizedPatch })
  };
}

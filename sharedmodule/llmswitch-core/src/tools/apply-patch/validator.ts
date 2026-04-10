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

export function validateApplyPatchArgs(argsString: string, rawArgs: unknown): ApplyPatchValidationResult {
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

  return {
    ok: true,
    normalizedArgs: toJson({ patch: normalized.patchText, input: normalized.patchText })
  };
}

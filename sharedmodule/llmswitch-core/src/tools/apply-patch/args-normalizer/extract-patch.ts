import { normalizeApplyPatchText, looksLikePatch } from '../patch-text/normalize.js';
import type { ApplyPatchExtraction } from './types.js';

type PatchSection = 'add' | 'update' | 'delete' | null;
const ADD_RE = /^\*\*\* Add File:\s*(.+)$/;
const UPDATE_RE = /^\*\*\* Update File:\s*(.+)$/;
const DELETE_RE = /^\*\*\* Delete File:\s*(.+)$/;

const validateNormalizedPatchStructure = (patchText: string): string | null => {
  const lines = String(patchText || '').split('\n');
  let section: PatchSection = null;
  let hasAnySection = false;
  let addHasContent = false;
  let updateHasHunk = false;
  let updateHasMove = false;
  let updateCurrentHunkHasBody = false;

  const finalizeSection = (): string | null => {
    if (section === 'add' && !addHasContent) return 'empty_add_file_block';
    if (section === 'update') {
      if (!updateHasHunk && !updateHasMove) return 'unsupported_patch_format';
      if (updateHasHunk && !updateCurrentHunkHasBody) return 'empty_update_hunk';
    }
    return null;
  };

  for (const line of lines) {
    if (line.startsWith('*** Begin Patch')) continue;
    if (line.startsWith('*** End Patch')) {
      const issue = finalizeSection();
      if (issue) return issue;
      section = null;
      continue;
    }

    const addMatch = line.match(ADD_RE);
    const updateMatch = line.match(UPDATE_RE);
    const deleteMatch = line.match(DELETE_RE);
    const nextSection = addMatch ? 'add' : updateMatch ? 'update' : deleteMatch ? 'delete' : null;
    if (nextSection) {
      const issue = finalizeSection();
      if (issue) return issue;
      const sectionPath = String((addMatch || updateMatch || deleteMatch)?.[1] || '').trim();
      if (!sectionPath || sectionPath === '/dev/null') return 'invalid_patch_path';
      section = nextSection;
      hasAnySection = true;
      addHasContent = false;
      updateHasHunk = false;
      updateHasMove = false;
      updateCurrentHunkHasBody = false;
      continue;
    }

    if (section === 'add') {
      if (line.startsWith('+')) addHasContent = true;
      continue;
    }
    if (section !== 'update') continue;
    if (line.startsWith('*** Move to: ')) {
      updateHasMove = true;
      continue;
    }
    if (line.startsWith('@@')) {
      if (updateHasHunk && !updateCurrentHunkHasBody) return 'empty_update_hunk';
      updateHasHunk = true;
      updateCurrentHunkHasBody = false;
      continue;
    }
    if (/^[ +-]/.test(line)) updateCurrentHunkHasBody = true;
  }

  const issue = finalizeSection();
  if (issue) return issue;
  return hasAnySection ? null : 'unsupported_patch_format';
};

export function extractNormalizedPatch(value: string | undefined | null): ApplyPatchExtraction {
  if (!value) return {};
  const normalized = normalizeApplyPatchText(value);
  if (!looksLikePatch(value) && !looksLikePatch(normalized)) return {};
  if (!/^(?:\s*)\*\*\*\s*Begin Patch\b/m.test(normalized)) return { failureReason: 'unsupported_patch_format' };
  const structureIssue = validateNormalizedPatchStructure(normalized);
  return structureIssue ? { failureReason: structureIssue } : { patchText: normalized };
}

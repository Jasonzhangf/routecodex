export function formatUpdateSummary(summary: { added: string[]; removed: string[]; kept: string[]; completedWithTemplates: string[] }, opts?: { verbose?: boolean }): string {
  const lines: string[] = [];
  const v = !!opts?.verbose;
  const add = summary.added.length ? `+ Added (${summary.added.length}): ${summary.added.join(', ')}` : '+ Added (0)';
  const rem = summary.removed.length ? `- Removed (${summary.removed.length}): ${summary.removed.join(', ')}` : '- Removed (0)';
  const kep = v && summary.kept.length ? `= Kept   (${summary.kept.length}): ${summary.kept.join(', ')}` : `= Kept   (${summary.kept.length})`;
  const tpl = summary.completedWithTemplates.length ? `* Completed with templates (${summary.completedWithTemplates.length}): ${summary.completedWithTemplates.join(', ')}` : '* Completed with templates (0)';
  lines.push(add, rem, kep, tpl);
  return lines.join('\n');
}


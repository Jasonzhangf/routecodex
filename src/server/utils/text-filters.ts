export function stripThinkingTags(text: string): string {
  try {
    if (typeof text !== 'string' || text.length === 0) {return String(text ?? '');}
    let out = String(text);
    // Remove paired <think ...> ... </think>
    out = out.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '');
    // Remove stray single tags <think ...> or </think>
    out = out.replace(/<\/?think\b[^>]*>/gi, '');
    return out;
  } catch {
    return text;
  }
}


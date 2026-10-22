// Responses Direct single-owner boundary helpers for
// verify-v3-module-boundaries.mjs.
//
// These helpers close over the gate context (failures) and provide the same
// comment/string masking and structural function-body extraction used by the
// provider-action gate, so the Responses Direct boundary check binds executable
// Rust edges rather than file-wide substrings.

export function attachModuleBoundaryHelpers({ failures }) {
  const simpleSymbol = (symbol) => String(symbol || '').split('::').at(-1);
  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function maskCommentsAndStrings(source) {
    const output = [...source];
    const mask = (index) => {
      if (output[index] !== '\n' && output[index] !== '\r') output[index] = ' ';
    };
    let index = 0;
    while (index < source.length) {
      if (source.startsWith('//', index)) {
        while (index < source.length && source[index] !== '\n') {
          mask(index);
          index += 1;
        }
        continue;
      }
      if (source.startsWith('/*', index)) {
        let depth = 0;
        while (index < source.length) {
          if (source.startsWith('/*', index)) {
            mask(index);
            mask(index + 1);
            depth += 1;
            index += 2;
            continue;
          }
          if (source.startsWith('*/', index)) {
            mask(index);
            mask(index + 1);
            depth -= 1;
            index += 2;
            if (depth === 0) break;
            continue;
          }
          mask(index);
          index += 1;
        }
        continue;
      }
      const rawMatch = /^(?:br|r)(#*)"/u.exec(source.slice(index));
      if (rawMatch) {
        const terminator = `"${rawMatch[1]}`;
        const start = index;
        index += rawMatch[0].length;
        const end = source.indexOf(terminator, index);
        index = end < 0 ? source.length : end + terminator.length;
        for (let cursor = start; cursor < index; cursor += 1) mask(cursor);
        continue;
      }
      if (source[index] === '"' || source[index] === '`') {
        const quote = source[index];
        mask(index);
        index += 1;
        while (index < source.length) {
          if (source[index] === '\\') {
            mask(index);
            if (index + 1 < source.length) mask(index + 1);
            index += 2;
            continue;
          }
          const done = source[index] === quote;
          mask(index);
          index += 1;
          if (done) break;
        }
        continue;
      }
      if (source[index] === "'") {
        let closing = index + 1;
        if (source[closing] === '\\') closing += 2;
        else closing += 1;
        if (source[closing] === "'") {
          for (let cursor = index; cursor <= closing; cursor += 1) mask(cursor);
          index = closing + 1;
          continue;
        }
      }
      index += 1;
    }
    return output.join('');
  }

  function findFunctionBody(source, symbol, rel) {
    const code = maskCommentsAndStrings(source);
    const name = simpleSymbol(symbol);
    const definition = new RegExp(`\\b(?:function|fn)\\s+${escapeRegExp(name)}\\b`, 'u');
    const match = definition.exec(code);
    if (!match) {
      failures.push(`${rel}: declared symbol not found: ${symbol}`);
      return '';
    }
    const parametersStart = code.indexOf('(', match.index + match[0].length);
    if (parametersStart < 0) {
      failures.push(`${rel}: cannot locate parameter list for ${symbol}`);
      return '';
    }
    let parenDepth = 0;
    let bodyStart = -1;
    for (let index = parametersStart; index < code.length; index += 1) {
      const char = code[index];
      if (char === '(') parenDepth += 1;
      else if (char === ')') parenDepth -= 1;
      else if (char === '{' && parenDepth === 0) {
        bodyStart = index;
        break;
      }
    }
    if (bodyStart < 0) {
      failures.push(`${rel}: cannot locate function body for ${symbol}`);
      return '';
    }
    let braceDepth = 0;
    for (let index = bodyStart; index < code.length; index += 1) {
      const char = code[index];
      if (char === '{') braceDepth += 1;
      else if (char === '}') {
        braceDepth -= 1;
        if (braceDepth === 0) return code.slice(bodyStart, index + 1);
      }
    }
    failures.push(`${rel}: unterminated function body for ${symbol}`);
    return '';
  }

  function assertCallerBodyInvokesCallee(edge) {
    const callerBody = findFunctionBody(edge.callerSource, edge.caller_symbol, edge.caller_file);
    const calleeBody = findFunctionBody(edge.calleeSource, edge.callee_symbol, edge.callee_file);
    if (!callerBody || !calleeBody) return;
    const calleeName = simpleSymbol(edge.callee_symbol);
    const callPattern = edge.call_witness ?? new RegExp(
      `(?:\\.|::|\\b)${escapeRegExp(calleeName)}\\s*(?:::<[^>{}]*>)?\\s*\\(`,
      'u',
    );
    if (!callPattern.test(callerBody)) {
      failures.push(
        `${edge.step_id}: ${edge.caller_symbol} in ${edge.caller_file} does not call ${edge.callee_symbol}`,
      );
    }
  }

  function findImplBlocks(source, implTypeRegex) {
    const code = maskCommentsAndStrings(source);
    const blocks = [];
    const implPattern = new RegExp(
      `\\bimpl\\b[^{]*?\\b${implTypeRegex}\\b[^{]*?\\bfor\\b\\s+([A-Za-z_][\\w:]*)`,
      'gu',
    );
    let match;
    while ((match = implPattern.exec(code)) !== null) {
      const headerEnd = match.index + match[0].length;
      const bodyStart = code.indexOf('{', headerEnd);
      if (bodyStart < 0) continue;
      let braceDepth = 0;
      for (let index = bodyStart; index < code.length; index += 1) {
        const char = code[index];
        if (char === '{') braceDepth += 1;
        else if (char === '}') {
          braceDepth -= 1;
          if (braceDepth === 0) {
            blocks.push({
              body: code.slice(bodyStart, index + 1),
              maskedBody: code.slice(bodyStart, index + 1),
              offset: match.index,
            });
            break;
          }
        }
      }
    }
    return blocks;
  }

  return {
    maskCommentsAndStrings,
    findFunctionBody,
    assertCallerBodyInvokesCallee,
    findImplBlocks,
  };
}

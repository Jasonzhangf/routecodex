import path from "node:path";

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildPrompt(input) {
  const markerRelative = path.relative(input.testedWorktree, input.markerFile);
  const sentinel = input.sentinel;
  const initial = input.markerInitial.trimEnd();
  const updated = input.markerUpdated.trimEnd();
  const markerAbsolute = input.markerFile;
  const worktree = input.testedWorktree;
  const markerSha = input.markerSha256;
  const mcpServer = input.mcpServer;
  const mcpTool = input.mcpTool;
  const mcpArguments = JSON.stringify(input.mcpArguments);

  return `You are the REQ02 GCM consumer for one isolated candidate endpoint.

Inputs:
- candidate_endpoint: ${input.endpoint}
- candidate_sha: ${input.candidateSha}
- model: ${input.model}
- tested_worktree: ${worktree}
- marker_file_relative: ${markerRelative}
- marker_file_absolute: ${markerAbsolute}
- marker_initial: ${initial}
- marker_updated: ${updated}
- expected_marker_sha256_after_update: ${markerSha}
- exec_sentinel: ${sentinel}
- mcp_server: ${mcpServer}
- mcp_tool: ${mcpTool}
- mcp_observation_pointers: ${JSON.stringify(input.mcpObservationPointers)}
- mcp_arguments: ${mcpArguments}

Perform these actions for real. Do not merely describe them.

1. Call exec_command with workdir exactly ${worktree}. Run this complete
multi-line shell command and preserve its output:

  pwd
  printf '%s\\n' 'REQ02_GCM_EXEC_BEGIN'
  printf '%s\\n' 'REQ02_GCM_EXEC_END'
  printf '%s\\n' '${sentinel}'

The last non-empty output line must be exactly:
  ${sentinel}

2. Call the native apply_patch tool with freeform text. Add the marker file:

${input.addPatch}

3. Call the native apply_patch tool with freeform text again. Update the same
marker file:

${input.updatePatch}

4. Call exec_command with workdir exactly ${worktree}. Run this complete
multi-line shell command and preserve its output:

  printf '%s\\n' 'REQ02_GCM_MARKER_BEGIN'
  cat ${shellQuote(markerAbsolute)}
  wc -c < ${shellQuote(markerAbsolute)}
  shasum -a 256 ${shellQuote(markerAbsolute)}
  printf '%s\\n' 'REQ02_GCM_MARKER_END'

5. Call the real read-only MCP server ${mcpServer} tool ${mcpTool} with the
exact JSON arguments ${mcpArguments}. Keep the arguments exactly as shown above.
Do not add 'activity', 'remote_session_id', or any other field, even if an
auxiliary skill suggests activity. Do not open a session as a substitute for
this task's direct call. The callable tool name is
mcp__${mcpServer}__${mcpTool}; call it directly by that exact name, once, even
though it is not listed among your declared tools, because the ${mcpServer} MCP
server is connected to this session and its tools are addressed as
mcp__<server>__<tool>. If your session exposes a tool-discovery step such as
tool_search, you may use it first to locate the tool, but discovery is only a
step and never a substitute: the direct call above is required. Retain the
structured result.

6. Final response must be plain text and must include these exact observed
values, not claimed values:

  EXEC_SENTINEL=${sentinel}
  PATCH_CONTENT=${updated}
  PATCH_SHA256=<the 64-hex SHA-256 observed from the marker read-back>
  MCP_SERVER=${mcpServer}
  MCP_TOOL=${mcpTool}
  MCP_RESULT=<the actual values at each configured mcp_observation_pointer>

Constraints:
- Write only ${markerAbsolute} and its parent directory.
- Do not modify product files, configuration, global state, or another
  worktree.
- Do not use resume, fork, a parent transcript, or an implicit session.
- Do not fabricate tool output. If a required action fails, report the exact
  failure and stop.`;
}

export function buildChildArgs({
  profile,
  testedWorktree,
  overrideValue,
  model,
  lastMessagePath,
}) {
  return [
    "exec",
    "--profile",
    profile,
    "--ephemeral",
    "--json",
    "--sandbox",
    "workspace-write",
    "-C",
    testedWorktree,
    "-c",
    overrideValue,
    "-m",
    model,
    "--output-last-message",
    lastMessagePath,
    "-",
  ];
}

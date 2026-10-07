import { isDeepStrictEqual } from "node:util";
import { sha256Text } from "./gcm-consumer-utils.mjs";

export const PATCH_TOOL_NAME = "apply_patch";

export function parseJsonl(buffer) {
  const events = [];
  const parseErrors = [];
  const text = buffer.toString("utf8");
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      parseErrors.push({ line: index + 1, error: error.message });
    }
  }
  return { events, parseErrors };
}

export function itemEvents(events) {
  return events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event?.item);
}

function completedItem(entry) {
  return entry.event.type === "item.completed" && entry.event.item?.status === "completed";
}

function findCommandItem(entries, predicate) {
  return entries.find((entry) => {
    if (!completedItem(entry) || entry.event.item?.type !== "command_execution") {
      return false;
    }
    return predicate(entry.event.item, entry.index);
  });
}

function findFileChangeItem(entries, predicate) {
  return entries.find((entry) => {
    if (!completedItem(entry) || entry.event.item?.type !== "file_change") {
      return false;
    }
    return predicate(entry.event.item, entry.index);
  });
}

export function validateExec(entries, testedWorktree, sentinel) {
  const expectedOutput = `${testedWorktree}
REQ02_GCM_EXEC_BEGIN
REQ02_GCM_EXEC_END
${sentinel}
`;
  const found = findCommandItem(entries, (item) => {
    const command = item.command || "";
    const output = item.aggregated_output || "";
    return (
      item.exit_code === 0 &&
      command.includes(sentinel) &&
      command.includes("\n") &&
      output === expectedOutput
    );
  });
  if (!found) {
    return {
      ok: false,
      reason: "no completed exec_command receipt with the exact cwd/BEGIN/END/sentinel output sequence",
    };
  }
  const item = found.event.item;
  return {
    ok: true,
    item_id: item.id,
    command: item.command,
    output: item.aggregated_output,
    exit_code: item.exit_code,
  };
}

export function validatePatch(
  entries,
  markerRelative,
  markerAbsolute,
  markerInitial,
  markerUpdated,
  markerSha256,
  markerByteLength,
) {
  const hasOnlyChange = (item, expectedPath, expectedKind) =>
    Array.isArray(item.changes) &&
    item.changes.length === 1 &&
    (item.changes[0]?.path === expectedPath || item.changes[0]?.path === markerAbsolute) &&
    item.changes[0]?.kind === expectedKind;
  const add = findFileChangeItem(
    entries,
    (item) => hasOnlyChange(item, markerRelative, "add"),
  );
  const update = findFileChangeItem(
    entries,
    (item, index) =>
      index > (add?.index ?? -1) && hasOnlyChange(item, markerRelative, "update"),
  );
  if (!add || !update || update.index <= add.index) {
    return {
      ok: false,
      reason: "missing ordered completed native file_change Add then Update receipts",
    };
  }

  const readback = findCommandItem(
    entries,
    (item, index) => {
      if (
        index <= update.index ||
        item.exit_code !== 0 ||
        !(item.command || "").includes("wc -c") ||
        !(item.command || "").includes("shasum -a 256")
      ) {
        return false;
      }
      const lines = (item.aggregated_output || "").trimEnd().split(/\r?\n/);
      const begin = lines.indexOf("REQ02_GCM_MARKER_BEGIN");
      const end = lines.indexOf("REQ02_GCM_MARKER_END", begin + 1);
      if (begin < 0 || end !== begin + 4 || lines.length !== end + 1) {
        return false;
      }
      return (
        lines[begin + 1] === markerUpdated &&
        lines[begin + 2].trim() === String(markerByteLength) &&
        lines[begin + 3].trim().startsWith(markerSha256)
      );
    },
  );
  if (!readback) {
    return {
      ok: false,
      reason: "missing completed marker read-back with bytes, content, and SHA-256",
    };
  }

  return {
    ok: true,
    add_item_id: add.event.item.id,
    update_item_id: update.event.item.id,
    add_changes: add.event.item.changes,
    update_changes: update.event.item.changes,
    readback_item_id: readback.event.item.id,
    readback_command: readback.event.item.command,
    readback_output: readback.event.item.aggregated_output,
  };
}

export function collectStructuredObservations(value, pointers) {
  return pointers.flatMap(location => {
    let observed = value;
    for (const token of location.slice(1).split("/")) {
      const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
      if (observed === null || typeof observed !== "object" ||
          !Object.prototype.hasOwnProperty.call(observed, key)) return [];
      observed = observed[key];
    }
    if (observed === undefined || typeof observed === "object") return [];
    return [{ location, type: typeof observed, value: observed,
      text: typeof observed === "string" ? observed : JSON.stringify(observed) }];
  });
}

export function validateMcp(entries, expectedServer, expectedTool, expectedArguments, observationPointers) {
  const found = entries.find(
    (entry) =>
      entry.event.type === "item.completed" &&
      entry.event.item?.type === "mcp_tool_call" &&
      entry.event.item?.status === "completed" &&
      entry.event.item?.server === expectedServer &&
      entry.event.item?.tool === expectedTool &&
      isDeepStrictEqual(entry.event.item?.arguments, expectedArguments) &&
      !entry.event.item?.error &&
      entry.event.item?.result &&
      typeof entry.event.item.result.structured_content === "object" &&
      entry.event.item.result.structured_content !== null &&
      collectStructuredObservations(entry.event.item.result.structured_content, observationPointers).length === observationPointers.length,
  );
  if (!found) {
    return {
      ok: false,
      reason: `no completed structured ${expectedServer}.${expectedTool} call with the exact explicit arguments`,
    };
  }
  return {
    ok: true,
    item_id: found.event.item.id,
    server: found.event.item.server,
    tool: found.event.item.tool,
    arguments: found.event.item.arguments,
    structured_content: found.event.item.result.structured_content,
    structured_observations: collectStructuredObservations(
      found.event.item.result.structured_content,
      observationPointers,
    ),
  };
}

export function validateModelConsumption(events, sentinel, markerUpdated, markerSha256, mcp, mcpServer, mcpTool) {
  const messages = events
    .filter((event) => event?.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => event.item?.text || "");
  const text = messages.at(-1) || "";
  const observations = mcp.structured_observations || [];
  const consumedObservations = observations.filter((observation) =>
    text.includes(observation.text),
  );
  const ok =
    text.includes(sentinel) &&
    text.includes(markerUpdated) &&
    text.includes(markerSha256) &&
    text.includes(mcpServer) &&
    text.includes(mcpTool) &&
    observations.length > 0 &&
    consumedObservations.length === observations.length;
  return {
    ok,
    reason: ok
      ? null
      : "final agent message did not contain the observed exec, patch, and MCP values",
    message_count: messages.length,
    text_sha256: sha256Text(text),
    structured_observation_count: observations.length,
    structured_observations_consumed: consumedObservations.length,
  };
}

export function validateTerminal(events, exitCode) {
  const turnCompleted = events.some((event) => event?.type === "turn.completed");
  return {
    ok: exitCode === 0 && turnCompleted,
    turn_completed: turnCompleted,
    child_exit_code: exitCode,
  };
}

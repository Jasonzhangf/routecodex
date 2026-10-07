const PROFILE = "gcm";
const MODELS = new Set(["gpt-5.5", "gpt-5.6"]);
const SCHEMA = "req02-gcm-consumer-summary-v1";
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

const USAGE = `REQ02 GCM consumer harness

Usage:
  node tests/blackbox/req02-tools/run-gcm-consumer.mjs [options]

Required:
  --endpoint <url>          Isolated candidate base URL, for example
                            http://127.0.0.1:5555/v1
  --candidate-sha <sha>     Full 40-hex candidate commit SHA
  --binary <path>           Absolute candidate binary path
  --binary-sha256 <sha>     Full 64-hex SHA-256 of that binary
  --model <model>           gpt-5.5 or gpt-5.6
  --tested-worktree <path>  Absolute clean/tested worktree whose HEAD is
                            the candidate SHA
  --evidence-dir <path>     Absolute evidence output directory
  --mcp-server <name>       Exact MCP server name (recommended: mcpx)
  --mcp-tool <name>         Exact MCP tool name (recommended: runtime_read)
  --mcp-arguments <json>    Exact JSON object arguments (recommended:
                            '{"view":"capabilities"}')
  --mcp-observation-pointers <json>
                            JSON pointer array of result values the model must
                            consume, for example ["/data/runtime/version"]

Optional:
  --codex-bin <path>        Codex CLI executable (default: codex)
  --timeout-ms <ms>         Child timeout (default: ${DEFAULT_TIMEOUT_MS})
  -h, --help                Print this help and exit

The harness refuses port 4444. It reads the active $CODEX_HOME/gcm.config.toml
and the base config, resolves the actual provider id, and passes a child CLI
override for model_providers.<provider-id>.base_url. It never edits the global
config and never prints auth/token values.
`;

export { DEFAULT_TIMEOUT_MS, MODELS, PROFILE, SCHEMA, USAGE };

export function printUsage(stream = process.stdout) {
  stream.write(USAGE);
}

export function parseArgs(argv) {
  const options = {
    codexBin: "codex",
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  const errors = [];
  const valueOptions = new Map([
    ["--endpoint", "endpoint"],
    ["--candidate-sha", "candidateSha"],
    ["--binary", "binary"],
    ["--binary-sha256", "binarySha256"],
    ["--model", "model"],
    ["--tested-worktree", "testedWorktree"],
    ["--evidence-dir", "evidenceDir"],
    ["--mcp-server", "mcpServer"],
    ["--mcp-tool", "mcpTool"],
    ["--mcp-arguments", "mcpArguments"],
    ["--mcp-observation-pointers", "mcpObservationPointers"],
    ["--codex-bin", "codexBin"],
    ["--timeout-ms", "timeoutMs"],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      return { help: true, options, errors };
    }
    if (!arg.startsWith("--")) {
      errors.push(`unexpected positional argument: ${arg}`);
      continue;
    }

    let name = arg;
    let value;
    const equalsAt = arg.indexOf("=");
    if (equalsAt >= 0) {
      name = arg.slice(0, equalsAt);
      value = arg.slice(equalsAt + 1);
    }
    const target = valueOptions.get(name);
    if (!target) {
      errors.push(`unknown option: ${name}`);
      continue;
    }
    if (value === undefined) {
      index += 1;
      value = argv[index];
    }
    if (value === undefined || value === "") {
      errors.push(`missing value for ${name}`);
      continue;
    }
    options[target] = value;
  }

  const required = [
    ["endpoint", "--endpoint"],
    ["candidateSha", "--candidate-sha"],
    ["binary", "--binary"],
    ["binarySha256", "--binary-sha256"],
    ["model", "--model"],
    ["testedWorktree", "--tested-worktree"],
    ["evidenceDir", "--evidence-dir"],
    ["mcpServer", "--mcp-server"],
    ["mcpTool", "--mcp-tool"],
    ["mcpArguments", "--mcp-arguments"],
    ["mcpObservationPointers", "--mcp-observation-pointers"],
  ];
  for (const [key, flag] of required) {
    if (!options[key]) {
      errors.push(`missing required option: ${flag}`);
    }
  }

  const timeoutMs = Number(options.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    errors.push("--timeout-ms must be a positive integer");
  } else {
    options.timeoutMs = timeoutMs;
  }

  if (options.mcpArguments) {
    try {
      const parsed = JSON.parse(options.mcpArguments);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        errors.push("--mcp-arguments must be a JSON object");
      } else {
        options.mcpArguments = parsed;
      }
    } catch (error) {
      errors.push(`--mcp-arguments is not valid JSON: ${error.message}`);
    }
  }

  if (options.mcpObservationPointers) {
    try {
      const pointers = JSON.parse(options.mcpObservationPointers);
      if (!Array.isArray(pointers) || pointers.length === 0 ||
          pointers.some(pointer => typeof pointer !== "string" || !pointer.startsWith("/"))) {
        errors.push("--mcp-observation-pointers must be a non-empty JSON pointer array");
      } else {
        options.mcpObservationPointers = pointers;
      }
    } catch (error) {
      errors.push(`--mcp-observation-pointers is not valid JSON: ${error.message}`);
    }
  }
  return { help: false, options, errors };
}

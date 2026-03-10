fn normalize_tool_declaration(decl: &Map<String, Value>) -> Option<Value> {
    let raw_name = read_trimmed_string(decl.get("name"))?;
    let name = normalize_tool_name_alias(&raw_name)
        .trim()
        .to_ascii_lowercase();
    if name.is_empty() {
        return None;
    }
    if name == "view_image" {
        return None;
    }

    let params = decl
        .get("parameters")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();
    let props = params
        .get("properties")
        .and_then(|v| v.as_object())
        .cloned()
        .unwrap_or_default();

    let mut next = decl.clone();
    next.insert("name".to_string(), Value::String(name.clone()));

    if name == "exec_command" {
        let command = props.get("command");
        let cmd = props.get("cmd");
        let mut next_props = Map::new();
        next_props.insert(
            "command".to_string(),
            json!({
                "type": "STRING",
                "description": pick_description(command.and_then(|v| v.get("description")).or_else(|| cmd.and_then(|v| v.get("description"))), "Shell command to execute."),
            }),
        );
        next_props.insert(
            "workdir".to_string(),
            json!({ "type": "STRING", "description": "Working directory." }),
        );
        next.insert(
            "description".to_string(),
            Value::String(
                "Run a shell command. Provide `cmd` (string) (alias: `command`) and optional `workdir` (string)."
                    .to_string(),
            ),
        );
        next.insert(
            "parameters".to_string(),
            json!({ "type": "OBJECT", "properties": next_props }),
        );
        return Some(Value::Object(next));
    }

    if name == "write_stdin" {
        let mut next_props = Map::new();
        let keys = [
            "session_id",
            "chars",
            "max_output_tokens",
            "yield_time_ms",
            "text",
        ];
        for key in keys {
            let fallback =
                if key == "session_id" || key.ends_with("_tokens") || key.ends_with("_ms") {
                    "NUMBER"
                } else {
                    "STRING"
                };
            next_props.insert(key.to_string(), make_typed_prop(props.get(key), fallback));
        }
        next.insert(
            "description".to_string(),
            Value::String(
                "Write to an existing exec session. Provide `session_id` (number) and optional `chars` (string)."
                    .to_string(),
            ),
        );
        next.insert(
            "parameters".to_string(),
            json!({ "type": "OBJECT", "properties": next_props }),
        );
        return Some(Value::Object(next));
    }

    if name == "apply_patch" {
        let mut next_props = Map::new();
        let keys = ["patch", "input", "instructions", "text"];
        for key in keys {
            let mut prop = Map::new();
            prop.insert("type".to_string(), Value::String("STRING".to_string()));
            if let Some(desc) =
                read_trimmed_string(props.get(key).and_then(|v| v.get("description")))
            {
                prop.insert("description".to_string(), Value::String(desc));
            }
            next_props.insert(key.to_string(), Value::Object(prop));
        }
        next.insert(
            "description".to_string(),
            Value::String(
                "Edit files by providing patch text in `patch` (string). Supports \"*** Begin Patch\" / \"*** End Patch\" or GNU unified diff. `input`/`instructions`/`text` are accepted as aliases.".to_string(),
            ),
        );
        next.insert(
            "parameters".to_string(),
            json!({ "type": "OBJECT", "properties": next_props }),
        );
        return Some(Value::Object(next));
    }

    if name == "list_mcp_resources" {
        next.insert(
            "description".to_string(),
            Value::String(
                "Lists resources provided by MCP servers. Resources allow servers to share data that provides context to language models, such as files, database schemas, or application-specific information. Prefer resources over web search when possible.".to_string(),
            ),
        );
        next.insert(
            "parameters".to_string(),
            json!({
                "type": "OBJECT",
                "properties": {
                    "server": { "type": "STRING", "minLength": 1 },
                    "filter": { "type": "STRING" },
                    "root": { "type": "STRING" }
                }
            }),
        );
        return Some(Value::Object(next));
    }

    if name == "list_mcp_resource_templates" {
        next.insert(
            "description".to_string(),
            Value::String(
                "Lists resource templates provided by MCP servers. Parameterized resource templates allow servers to share data that takes parameters and provides context to language models, such as files, database schemas, or application-specific information. Prefer resource templates over web search when possible.".to_string(),
            ),
        );
        next.insert(
            "parameters".to_string(),
            json!({
                "type": "OBJECT",
                "properties": {
                    "cursor": { "type": "STRING" },
                    "server": { "type": "STRING", "minLength": 1 }
                }
            }),
        );
        return Some(Value::Object(next));
    }

    if name == "read_mcp_resource" {
        next.insert(
            "description".to_string(),
            Value::String(
                "Read a specific resource from an MCP server given the server name and resource URI.".to_string(),
            ),
        );
        next.insert(
            "parameters".to_string(),
            json!({
                "type": "OBJECT",
                "properties": {
                    "server": {
                        "type": "STRING",
                        "description": "MCP server name exactly as configured. Must match the 'server' field returned by list_mcp_resources."
                    },
                    "uri": {
                        "type": "STRING",
                        "description": "Resource URI to read. Must be one of the URIs returned by list_mcp_resources."
                    }
                },
                "required": ["server", "uri"]
            }),
        );
        return Some(Value::Object(next));
    }

    if name == "update_plan" {
        next.insert(
            "description".to_string(),
            Value::String(
                "Updates the task plan.\nProvide an optional explanation and a list of plan items, each with a step and status.\nAt most one step can be in_progress at a time.\n".to_string(),
            ),
        );
        next.insert(
            "parameters".to_string(),
            json!({
                "type": "OBJECT",
                "properties": {
                    "explanation": { "type": "STRING" },
                    "plan": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "status": { "type": "STRING", "description": "One of: pending, in_progress, completed" },
                                "step": { "type": "STRING" }
                            },
                            "required": ["step", "status"]
                        },
                        "description": "The list of steps"
                    }
                },
                "required": ["plan"]
            }),
        );
        return Some(Value::Object(next));
    }

    if name == "request_user_input" {
        next.insert(
            "description".to_string(),
            Value::String(
                "Request user input for one to three short questions and wait for the response."
                    .to_string(),
            ),
        );
        next.insert(
            "parameters".to_string(),
            json!({
                "type": "OBJECT",
                "properties": {
                    "questions": {
                        "type": "ARRAY",
                        "items": {
                            "type": "OBJECT",
                            "properties": {
                                "header": {
                                    "type": "STRING",
                                    "description": "Short header label shown in the UI (12 or fewer chars)."
                                },
                                "id": {
                                    "type": "STRING",
                                    "description": "Stable identifier for mapping answers (snake_case)."
                                },
                                "options": {
                                    "type": "ARRAY",
                                    "items": {
                                        "type": "OBJECT",
                                        "properties": {
                                            "description": {
                                                "type": "STRING",
                                                "description": "One short sentence explaining impact/tradeoff if selected."
                                            },
                                            "label": {
                                                "type": "STRING",
                                                "description": "User-facing label (1-5 words)."
                                            }
                                        },
                                        "required": ["label", "description"]
                                    },
                                    "description": "Optional 2-3 mutually exclusive choices. Put the recommended option first and suffix its label with \"(Recommended)\". Only include \"Other\" option if we want to include a free form option. If the question is free form in nature, please do not have any option."
                                },
                                "question": {
                                    "type": "STRING",
                                    "description": "Single-sentence prompt shown to the user."
                                }
                            },
                            "required": ["id", "header", "question"]
                        },
                        "description": "Questions to show the user. Prefer 1 and do not exceed 3"
                    }
                },
                "required": ["questions"]
            }),
        );
        return Some(Value::Object(next));
    }

    if name == "mcp__context7__query_docs" {
        next.insert(
            "description".to_string(),
            Value::String(
                "Retrieves and queries up-to-date documentation and code examples from Context7 for any programming library or framework.\n\nYou must call 'resolve-library-id' first to obtain the exact Context7-compatible library ID required to use this tool, UNLESS the user explicitly provides a library ID in the format '/org/project' or '/org/project/version' in their query.\n\nIMPORTANT: Do not call this tool more than 3 times per question. If you cannot find what you need after 3 calls, use the best information you have.".to_string(),
            ),
        );
        next.insert(
            "parameters".to_string(),
            json!({
                "type": "OBJECT",
                "properties": {
                    "libraryId": {
                        "type": "STRING",
                        "description": "Exact Context7-compatible library ID (e.g., '/mongodb/docs', '/vercel/next.js', '/supabase/supabase', '/vercel/next.js/v14.3.0-canary.87') retrieved from 'resolve-library-id' or directly from user query in the format '/org/project' or '/org/project/version'."
                    },
                    "query": {
                        "type": "STRING",
                        "description": "The question or task you need help with. Be specific and include relevant details. Good: 'How to set up authentication with JWT in Express.js' or 'React useEffect cleanup function examples'. Bad: 'auth' or 'hooks'. IMPORTANT: Do not include any sensitive or confidential information such as API keys, passwords, credentials, or personal data in your query."
                    }
                },
                "required": ["libraryId", "query"]
            }),
        );
        return Some(Value::Object(next));
    }

    if name == "mcp__context7__resolve_library_id" {
        next.insert(
            "description".to_string(),
            Value::String(
                "Resolves a package/product name to a Context7-compatible library ID and returns matching libraries.\n\nYou MUST call this function before 'query-docs' to obtain a valid Context7-compatible library ID UNLESS the user explicitly provides a library ID in the format '/org/project' or '/org/project/version' in their query.\n\nSelection Process:\n1. Analyze the query to understand what library/package the user is looking for\n2. Return the most relevant match based on:\n- Name similarity to the query (exact matches prioritized)\n- Description relevance to the query's intent\n- Documentation coverage (prioritize libraries with higher Code Snippet counts)\n- Source reputation (consider libraries with High or Medium reputation more authoritative)\n- Benchmark Score: Quality indicator (100 is the highest score)\n\nResponse Format:\n- Return the selected library ID in a clearly marked section\n- Provide a brief explanation for why this library was chosen\n- If multiple good matches exist, acknowledge this but proceed with the most relevant one\n- If no good matches exist, clearly state this and suggest query refinements\n\nFor ambiguous queries, request clarification before proceeding with a best-guess match.\n\nIMPORTANT: Do not call this tool more than 3 times per question. If you cannot find what you need after 3 calls, use the best result you have.".to_string(),
            ),
        );
        next.insert(
            "parameters".to_string(),
            json!({
                "type": "OBJECT",
                "properties": {
                    "libraryName": {
                        "type": "STRING",
                        "description": "Library name to search for and retrieve a Context7-compatible library ID."
                    },
                    "query": {
                        "type": "STRING",
                        "description": "The user's original question or task. This is used to rank library results by relevance to what the user is trying to accomplish. IMPORTANT: Do not include any sensitive or confidential information such as API keys, passwords, credentials, or personal data in your query."
                    }
                },
                "required": ["query", "libraryName"]
            }),
        );
        return Some(Value::Object(next));
    }

    if name == "mcp__mcp_server_time__convert_time" {
        next.insert(
            "description".to_string(),
            Value::String("Convert time between timezones".to_string()),
        );
        next.insert(
            "parameters".to_string(),
            json!({
                "type": "OBJECT",
                "properties": {
                    "source_timezone": {
                        "type": "STRING",
                        "description": "Source IANA timezone name (e.g., 'America/New_York', 'Europe/London'). Use 'Asia/Shanghai' as local timezone if no source timezone provided by the user."
                    },
                    "target_timezone": {
                        "type": "STRING",
                        "description": "Target IANA timezone name (e.g., 'Asia/Tokyo', 'America/San_Francisco'). Use 'Asia/Shanghai' as local timezone if no target timezone provided by the user."
                    },
                    "time": { "type": "STRING", "description": "Time to convert in 24-hour format (HH:MM)" }
                },
                "required": ["source_timezone", "time", "target_timezone"]
            }),
        );
        return Some(Value::Object(next));
    }

    if name == "mcp__mcp_server_time__get_current_time" {
        next.insert(
            "description".to_string(),
            Value::String("Get current time in a specific timezones".to_string()),
        );
        next.insert(
            "parameters".to_string(),
            json!({
                "type": "OBJECT",
                "properties": {
                    "timezone": {
                        "type": "STRING",
                        "description": "IANA timezone name (e.g., 'America/New_York', 'Europe/London'). Use 'Asia/Shanghai' as local timezone if no timezone provided by the user."
                    }
                },
                "required": ["timezone"]
            }),
        );
        return Some(Value::Object(next));
    }

    next.insert(
        "parameters".to_string(),
        normalize_schema_types(&Value::Object(params)),
    );
    Some(Value::Object(next))
}

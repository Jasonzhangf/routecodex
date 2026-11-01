use provider_compat_core::namespace_tools::{NamespaceToolIdentityRegistry, ToolKind};
use serde_json::{json, Value};

#[test]
fn preserves_exact_identity_components_without_reparsing_wire_names() {
    struct Case {
        tool: Value,
        namespace_segments: Vec<&'static str>,
        leaf_name: &'static str,
        kind: ToolKind,
        client_path: &'static str,
        actual_wire_name: &'static str,
    }

    let cases = vec![
        Case {
            tool: json!({
                "type": "namespace",
                "name": "alpha",
                "tools": [{
                    "type": "function",
                    "name": "leaf.with.dot",
                    "parameters": {"type": "object"}
                }]
            }),
            namespace_segments: vec!["alpha"],
            leaf_name: "leaf.with.dot",
            kind: ToolKind::Function,
            client_path: "alpha.leaf.with.dot",
            actual_wire_name: "alpha__leaf.with.dot",
        },
        Case {
            tool: json!({
                "type": "namespace",
                "name": "alpha",
                "tools": [{
                    "type": "function",
                    "name": "leaf__part",
                    "parameters": {"type": "object"}
                }]
            }),
            namespace_segments: vec!["alpha"],
            leaf_name: "leaf__part",
            kind: ToolKind::Function,
            client_path: "alpha.leaf__part",
            actual_wire_name: "alpha__leaf__part",
        },
        Case {
            tool: json!({
                "type": "namespace",
                "name": "alpha",
                "tools": [{
                    "type": "function",
                    "name": "_leaf",
                    "parameters": {"type": "object"}
                }]
            }),
            namespace_segments: vec!["alpha"],
            leaf_name: "_leaf",
            kind: ToolKind::Function,
            client_path: "alpha._leaf",
            actual_wire_name: "alpha___leaf",
        },
        Case {
            tool: json!({
                "type": "namespace",
                "name": "mcp__codex_app",
                "tools": [{
                    "type": "namespace",
                    "name": "workspace",
                    "tools": [{
                        "type": "function",
                        "name": "read",
                        "parameters": {"type": "object"}
                    }]
                }]
            }),
            namespace_segments: vec!["mcp__codex_app", "workspace"],
            leaf_name: "read",
            kind: ToolKind::Function,
            client_path: "mcp__codex_app.workspace.read",
            actual_wire_name: "mcp__codex_app__workspace__read",
        },
    ];

    for case in cases {
        let registry = NamespaceToolIdentityRegistry::from_tools(&[case.tool]).unwrap();
        let identity = registry
            .identity_for_client_path(case.client_path)
            .unwrap_or_else(|| panic!("missing client identity for {}", case.client_path));

        assert_eq!(
            identity.namespace_segments,
            case.namespace_segments
                .iter()
                .map(|segment| segment.to_string())
                .collect::<Vec<_>>(),
            "namespace components changed for {}",
            case.client_path
        );
        assert_eq!(identity.leaf_name, case.leaf_name, "{}", case.client_path);
        assert_eq!(identity.kind, case.kind, "{}", case.client_path);
        assert_eq!(
            identity.actual_wire_name, case.actual_wire_name,
            "{}",
            case.client_path
        );
        assert_eq!(identity.client_path(), case.client_path);
        assert!(identity.is_namespaced());

        let wire_identity = registry
            .identity_for_wire_name(case.actual_wire_name)
            .unwrap_or_else(|| panic!("missing wire identity for {}", case.actual_wire_name));
        assert_eq!(wire_identity, identity);

        let inverse = registry.restore_identities();
        assert_eq!(
            inverse.get(case.actual_wire_name),
            Some(&(
                case.namespace_segments.join("."),
                case.leaf_name.to_string()
            )),
            "{}",
            case.client_path
        );
    }
}

#[test]
fn preserves_kind_collisions_and_schema_refresh_without_wire_guessing() {
    let registry = NamespaceToolIdentityRegistry::from_tools(&[json!({
        "type": "namespace",
        "name": "alpha",
        "tools": [
            {"type": "function", "name": "exec", "parameters": {"type": "object"}},
            {"type": "custom", "name": "exec", "format": {"type": "text"}}
        ]
    })])
    .expect("function and custom identities must be collected before target projection");

    assert_eq!(registry.identities().count(), 2);
    let mut same_client_path = registry
        .identities()
        .filter(|identity| identity.client_path() == "alpha.exec")
        .collect::<Vec<_>>();
    same_client_path.sort_by_key(|identity| match identity.kind {
        ToolKind::Function => 0,
        ToolKind::Custom => 1,
    });
    assert_eq!(
        same_client_path.len(),
        2,
        "function and custom identities must remain independently queryable"
    );
    assert_eq!(same_client_path[0].kind, ToolKind::Function);
    assert_eq!(same_client_path[1].kind, ToolKind::Custom);
    assert_eq!(same_client_path[0].leaf_name, "exec");
    assert_eq!(same_client_path[1].leaf_name, "exec");
    assert_eq!(same_client_path[0].actual_wire_name, "alpha__exec");
    assert_eq!(same_client_path[1].actual_wire_name, "alpha__exec");

    assert!(registry.is_ambiguous_wire_name("alpha__exec"));
    assert!(registry.identity_for_wire_name("alpha__exec").is_none());
    assert!(!registry.restore_identities().contains_key("alpha__exec"));

    let registry = NamespaceToolIdentityRegistry::from_tools(&[
        json!({
            "type": "function",
            "name": "alpha__same",
            "parameters": {"type": "object"}
        }),
        json!({
            "type": "namespace",
            "name": "alpha",
            "tools": [{
                "type": "function",
                "name": "same",
                "parameters": {"type": "object"}
            }]
        }),
    ])
    .unwrap();

    assert_eq!(registry.identities().count(), 2);
    assert!(registry.declared_wire_names().contains("alpha__same"));
    let flat = registry.identity_for_client_path("alpha__same").unwrap();
    assert!(flat.namespace_segments.is_empty());
    assert_eq!(flat.actual_wire_name, "alpha__same");
    let namespaced = registry.identity_for_client_path("alpha.same").unwrap();
    assert_eq!(namespaced.namespace_segments, vec!["alpha".to_string()]);
    assert_eq!(namespaced.actual_wire_name, "alpha__same");

    let mut refreshed = NamespaceToolIdentityRegistry::default();
    refreshed
        .merge_tools(&[json!({
            "type": "namespace",
            "name": "alpha",
            "tools": [{
                "type": "function",
                "name": "same",
                "description": "old schema",
                "parameters": {"type": "object", "properties": {"old": {"type": "string"}}}
            }]
        })])
        .unwrap();
    refreshed
        .merge_tools(&[json!({
            "type": "namespace",
            "name": "alpha",
            "tools": [{
                "type": "function",
                "name": "same",
                "description": "current schema",
                "parameters": {"type": "object", "properties": {"current": {"type": "string"}}}
            }]
        })])
        .unwrap();

    assert_eq!(refreshed.identities().count(), 1);
    assert!(!refreshed.is_ambiguous_wire_name("alpha__same"));
    assert_eq!(
        refreshed
            .identity_for_wire_name("alpha__same")
            .unwrap()
            .leaf_name,
        "same"
    );
    assert_eq!(refreshed.restore_identities().len(), 1);
}

#[test]
fn does_not_infer_undeclared_or_flat_names_and_merges_request_discovery() {
    let mut registry = NamespaceToolIdentityRegistry::from_tools(&[json!({
        "type": "function",
        "name": "mcp__codex_app__list_threads",
        "parameters": {"type": "object"}
    })])
    .unwrap();

    assert!(registry
        .identity_for_wire_name("mcp__codex_app__list_threads")
        .is_none());
    assert!(registry.restore_identities().is_empty());
    assert!(registry
        .identity_for_client_path("mcp__codex_app__list_threads")
        .is_some());
    assert!(registry
        .identity_for_wire_name("undeclared__leaf")
        .is_none());

    registry
        .merge_tools(&[json!({
            "type": "namespace",
            "name": "discovered",
            "tools": [{
                "type": "custom",
                "name": "leaf",
                "format": {"type": "text"}
            }]
        })])
        .unwrap();

    assert_eq!(
        registry
            .identity_for_wire_name("discovered__leaf")
            .unwrap()
            .kind,
        ToolKind::Custom
    );
    assert_eq!(
        registry.restore_identities().get("discovered__leaf"),
        Some(&("discovered".to_string(), "leaf".to_string()))
    );

    registry
        .merge_tools(&[json!({
            "type": "function",
            "name": "discovered__unknown",
            "parameters": {"type": "object"}
        })])
        .unwrap();
    assert!(registry
        .identity_for_wire_name("discovered__unknown")
        .is_none());
    assert!(!registry
        .restore_identities()
        .contains_key("discovered__unknown"));
}

#[test]
fn responses_history_associates_only_unique_same_kind_leaf() {
    let registry = NamespaceToolIdentityRegistry::from_tools(&[
        json!({
            "type": "namespace",
            "name": "functions",
            "tools": [{
                "type": "function",
                "name": "exec_command",
                "parameters": {"type": "object"}
            }]
        }),
        json!({
            "type": "namespace",
            "name": "customs",
            "tools": [{
                "type": "custom",
                "name": "exec_command",
                "format": {"type": "text"}
            }]
        }),
    ])
    .unwrap();
    let mut body = json!({
        "input": [
            {
                "type": "function_call",
                "call_id": "call_function",
                "name": "exec_command",
                "arguments": "{ \"cmd\" : \"pwd\" }"
            },
            {
                "type": "custom_tool_call",
                "call_id": "call_custom",
                "name": "exec_command",
                "input": "pwd"
            }
        ],
        "messages": [{
            "role": "assistant",
            "tool_calls": [{
                "id": "call_message",
                "type": "function",
                "function": {
                    "name": "exec_command",
                    "arguments": "{ \"cmd\" : \"pwd\" }"
                }
            }]
        }],
        "tool_choice": {
            "type": "function",
            "name": "exec_command"
        }
    });

    registry.project_responses_history_references(&mut body);

    assert_eq!(body["input"][0]["name"], "functions__exec_command");
    assert_eq!(body["input"][0]["call_id"], "call_function");
    assert_eq!(body["input"][0]["arguments"], "{ \"cmd\" : \"pwd\" }");
    assert_eq!(body["input"][1]["name"], "customs__exec_command");
    assert_eq!(body["input"][1]["call_id"], "call_custom");
    assert_eq!(body["input"][1]["input"], "pwd");
    assert_eq!(
        body["messages"][0]["tool_calls"][0]["function"]["name"],
        "functions__exec_command"
    );
    assert_eq!(
        body["messages"][0]["tool_calls"][0]["function"]["arguments"],
        "{ \"cmd\" : \"pwd\" }"
    );
    assert_eq!(
        body["tool_choice"]["name"], "exec_command",
        "forced choice must remain exact-only"
    );
}

#[test]
fn responses_history_unique_leaf_association_respects_plain_kind_and_ambiguity() {
    let plain = NamespaceToolIdentityRegistry::from_tools(&[
        json!({
            "type": "function",
            "name": "exec_command",
            "parameters": {"type": "object"}
        }),
        json!({
            "type": "namespace",
            "name": "functions",
            "tools": [{
                "type": "function",
                "name": "exec_command",
                "parameters": {"type": "object"}
            }]
        }),
    ])
    .unwrap();
    let mut prefixless = json!({
        "messages": [{
            "role": "assistant",
            "tool_calls": [{
                "id": "call_plain",
                "type": "function",
                "function": {"name": "exec_command", "arguments": "{}"}
            }]
        }]
    });
    plain.project_responses_history_references(&mut prefixless);
    assert_eq!(
        prefixless["messages"][0]["tool_calls"][0]["function"]["name"], "exec_command",
        "a same-kind plain declaration owns its bare name"
    );

    let ambiguous = NamespaceToolIdentityRegistry::from_tools(&[
        json!({
            "type": "namespace",
            "name": "alpha",
            "tools": [{
                "type": "function",
                "name": "exec_command",
                "parameters": {"type": "object"}
            }]
        }),
        json!({
            "type": "namespace",
            "name": "beta",
            "tools": [{
                "type": "function",
                "name": "exec_command",
                "parameters": {"type": "object"}
            }]
        }),
    ])
    .unwrap();
    let mut ambiguous_body = json!({
        "messages": [{
            "role": "assistant",
            "tool_calls": [{
                "id": "call_ambiguous",
                "type": "function",
                "function": {"name": "exec_command", "arguments": "{}"}
            }]
        }]
    });
    ambiguous.project_responses_history_references(&mut ambiguous_body);
    assert_eq!(
        ambiguous_body["messages"][0]["tool_calls"][0]["function"]["name"], "exec_command",
        "multiple namespace leaves must remain unbound"
    );

    let custom = NamespaceToolIdentityRegistry::from_tools(&[json!({
        "type": "namespace",
        "name": "customs",
        "tools": [{
            "type": "custom",
            "name": "exec_command",
            "format": {"type": "text"}
        }]
    })])
    .unwrap();
    let mut wrong_kind = json!({
        "input": [{
            "type": "function_call",
            "call_id": "call_function",
            "name": "exec_command",
            "arguments": "{}"
        }]
    });
    custom.project_responses_history_references(&mut wrong_kind);
    assert_eq!(wrong_kind["input"][0]["name"], "exec_command");

    let mut wrong_namespace = json!({
        "input": [{
            "type": "function_call",
            "namespace": "unrelated",
            "call_id": "call_exact",
            "name": "exec_command",
            "arguments": "{}"
        }]
    });
    custom.project_responses_history_references(&mut wrong_namespace);
    assert_eq!(wrong_namespace["input"][0]["name"], "exec_command");
    assert_eq!(wrong_namespace["input"][0]["namespace"], "unrelated");
}

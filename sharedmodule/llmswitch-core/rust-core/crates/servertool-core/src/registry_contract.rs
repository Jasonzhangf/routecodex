// feature_id: hub.servertool_registry_contract
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolRegistryLookupActionInput {
    pub name: String,
    pub builtin_entry_present: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolRegistryLookupAction {
    ReturnBuiltin,
    ReturnNone,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolRegistryLookupActionPlan {
    pub action: ServertoolRegistryLookupAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolRegistryAutoHookDescriptorInput {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolRegistryAutoHookDescriptorPlan {
    pub id: String,
    pub phase: String,
    pub priority: i64,
    pub order: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolRegistryProjectionRecordInput {
    pub name: String,
    pub trigger: String,
    pub source_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolRegistryProjectionInput {
    pub registered_names: Vec<String>,
    pub registered_records: Vec<ServertoolRegistryProjectionRecordInput>,
    pub auto_handler_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolRegistryProjectionRecordPlan {
    pub name: String,
    pub trigger: String,
    pub source_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolRegistryProjectionPlan {
    pub registered_names: Vec<String>,
    pub registered_records: Vec<ServertoolRegistryProjectionRecordPlan>,
    pub auto_handler_names: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolRegistrySourceKind {
    Builtin,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolRegistrySourceRecordInput {
    pub name: String,
    pub trigger: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolRegistrySourceProjectionInput {
    #[serde(default)]
    pub builtin_names: Vec<String>,
    #[serde(default)]
    pub builtin_auto_handler_names: Vec<String>,
    #[serde(default)]
    pub builtin_records: Vec<ServertoolRegistrySourceRecordInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolRegistrySourceRefPlan {
    pub name: String,
    pub source: ServertoolRegistrySourceKind,
    pub source_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolRegistrySourceRecordRefPlan {
    pub name: String,
    pub trigger: String,
    pub source: ServertoolRegistrySourceKind,
    pub source_index: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolRegistrySourceProjectionPlan {
    pub registered_names: Vec<String>,
    pub auto_handler_refs: Vec<ServertoolRegistrySourceRefPlan>,
    pub registered_record_refs: Vec<ServertoolRegistrySourceRecordRefPlan>,
}

fn normalize_name(name: &str) -> Option<String> {
    let trimmed = name.trim().to_lowercase();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

pub fn plan_servertool_registry_lookup_action(
    input: ServertoolRegistryLookupActionInput,
) -> ServertoolRegistryLookupActionPlan {
    let canonical_name = normalize_name(&input.name);
    if canonical_name.is_none() {
        return ServertoolRegistryLookupActionPlan {
            action: ServertoolRegistryLookupAction::ReturnNone,
            canonical_name: None,
        };
    }
    if input.builtin_entry_present {
        return ServertoolRegistryLookupActionPlan {
            action: ServertoolRegistryLookupAction::ReturnBuiltin,
            canonical_name,
        };
    }
    ServertoolRegistryLookupActionPlan {
        action: ServertoolRegistryLookupAction::ReturnNone,
        canonical_name,
    }
}

fn normalize_auto_hook_phase(phase: Option<&str>) -> String {
    match phase
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty())
        .as_deref()
    {
        Some("pre") => "pre".to_string(),
        Some("post") => "post".to_string(),
        _ => "default".to_string(),
    }
}

pub fn plan_servertool_registry_auto_hook_descriptors(
    input: Vec<ServertoolRegistryAutoHookDescriptorInput>,
) -> Result<Vec<ServertoolRegistryAutoHookDescriptorPlan>, String> {
    let mut seen_ids = std::collections::HashSet::new();
    let mut output = Vec::with_capacity(input.len());

    for hook in input {
        let canonical_id = normalize_name(&hook.id)
            .ok_or_else(|| "invalid auto hook descriptor id".to_string())?;
        if !seen_ids.insert(canonical_id.clone()) {
            return Err(format!("duplicate auto hook descriptor id: {canonical_id}"));
        }
        output.push(ServertoolRegistryAutoHookDescriptorPlan {
            id: canonical_id,
            phase: normalize_auto_hook_phase(hook.phase.as_deref()),
            priority: hook.priority.unwrap_or(100),
            order: hook.order.unwrap_or(0),
        });
    }

    Ok(output)
}

pub fn plan_servertool_registry_projection(
    input: ServertoolRegistryProjectionInput,
) -> Result<ServertoolRegistryProjectionPlan, String> {
    let mut registered_name_set = std::collections::BTreeSet::new();
    for name in input.registered_names {
        let canonical =
            normalize_name(&name).ok_or_else(|| "invalid registered handler name".to_string())?;
        registered_name_set.insert(canonical);
    }

    let mut auto_handler_names = Vec::with_capacity(input.auto_handler_names.len());
    let mut seen_auto_names = std::collections::HashSet::new();
    for name in input.auto_handler_names {
        let canonical =
            normalize_name(&name).ok_or_else(|| "invalid auto handler name".to_string())?;
        if !seen_auto_names.insert(canonical.clone()) {
            return Err(format!("duplicate auto handler name: {canonical}"));
        }
        auto_handler_names.push(canonical);
    }

    let mut tool_call_records = Vec::new();
    let mut auto_records = Vec::new();
    for record in input.registered_records {
        let canonical = normalize_name(&record.name)
            .ok_or_else(|| "invalid registered record name".to_string())?;
        let plan = ServertoolRegistryProjectionRecordPlan {
            name: canonical,
            trigger: match record.trigger.trim() {
                "tool_call" => "tool_call".to_string(),
                "auto" => "auto".to_string(),
                other => return Err(format!("invalid registered record trigger: {other}")),
            },
            source_index: record.source_index,
        };
        if plan.trigger == "tool_call" {
            tool_call_records.push(plan);
        } else {
            auto_records.push(plan);
        }
    }

    let mut registered_records = tool_call_records;
    registered_records.extend(auto_records);

    Ok(ServertoolRegistryProjectionPlan {
        registered_names: registered_name_set.into_iter().collect(),
        registered_records,
        auto_handler_names,
    })
}

fn push_source_refs(
    output: &mut Vec<ServertoolRegistrySourceRefPlan>,
    seen: &mut std::collections::HashSet<String>,
    names: Vec<String>,
    source: ServertoolRegistrySourceKind,
    label: &str,
) -> Result<(), String> {
    for (source_index, name) in names.into_iter().enumerate() {
        let canonical =
            normalize_name(&name).ok_or_else(|| format!("invalid {label} handler name"))?;
        if !seen.insert(canonical.clone()) {
            return Err(format!("duplicate auto handler name: {canonical}"));
        }
        output.push(ServertoolRegistrySourceRefPlan {
            name: canonical,
            source: source.clone(),
            source_index,
        });
    }
    Ok(())
}

fn source_record_plan(
    record: ServertoolRegistrySourceRecordInput,
    source: ServertoolRegistrySourceKind,
    source_index: usize,
) -> Result<ServertoolRegistrySourceRecordRefPlan, String> {
    let canonical =
        normalize_name(&record.name).ok_or_else(|| "invalid registered record name".to_string())?;
    let trigger = match record.trigger.trim() {
        "tool_call" => "tool_call".to_string(),
        "auto" => "auto".to_string(),
        other => return Err(format!("invalid registered record trigger: {other}")),
    };
    Ok(ServertoolRegistrySourceRecordRefPlan {
        name: canonical,
        trigger,
        source,
        source_index,
    })
}

pub fn plan_servertool_registry_source_projection(
    input: ServertoolRegistrySourceProjectionInput,
) -> Result<ServertoolRegistrySourceProjectionPlan, String> {
    let mut registered_name_set = std::collections::BTreeSet::new();
    for name in input.builtin_names {
        let canonical =
            normalize_name(&name).ok_or_else(|| "invalid registered handler name".to_string())?;
        registered_name_set.insert(canonical);
    }

    let mut auto_handler_refs = Vec::new();
    let mut seen_auto_names = std::collections::HashSet::new();
    push_source_refs(
        &mut auto_handler_refs,
        &mut seen_auto_names,
        input.builtin_auto_handler_names,
        ServertoolRegistrySourceKind::Builtin,
        "builtin auto",
    )?;

    let mut tool_call_records = Vec::new();
    let mut auto_records = Vec::new();
    for (source_index, record) in input.builtin_records.into_iter().enumerate() {
        let plan = source_record_plan(record, ServertoolRegistrySourceKind::Builtin, source_index)?;
        if plan.trigger == "tool_call" {
            tool_call_records.push(plan);
        } else {
            auto_records.push(plan);
        }
    }
    let mut registered_record_refs = tool_call_records;
    registered_record_refs.extend(auto_records);

    Ok(ServertoolRegistrySourceProjectionPlan {
        registered_names: registered_name_set.into_iter().collect(),
        auto_handler_refs,
        registered_record_refs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lookup_action_prefers_builtin_and_never_returns_adhoc() {
        let builtin = plan_servertool_registry_lookup_action(ServertoolRegistryLookupActionInput {
            name: "stop_message_auto".to_string(),
            builtin_entry_present: true,
        });
        assert_eq!(
            builtin.action,
            ServertoolRegistryLookupAction::ReturnBuiltin
        );

        let retired_adhoc = plan_servertool_registry_lookup_action(ServertoolRegistryLookupActionInput {
            name: "custom_tool".to_string(),
            builtin_entry_present: false,
        });
        assert_eq!(retired_adhoc.action, ServertoolRegistryLookupAction::ReturnNone);

        let none = plan_servertool_registry_lookup_action(ServertoolRegistryLookupActionInput {
            name: "".to_string(),
            builtin_entry_present: false,
        });
        assert_eq!(none.action, ServertoolRegistryLookupAction::ReturnNone);
    }

    #[test]
    fn auto_hook_descriptors_normalize_defaults_and_fail_on_duplicates() {
        let plan = plan_servertool_registry_auto_hook_descriptors(vec![
            ServertoolRegistryAutoHookDescriptorInput {
                id: " stop_message_auto ".to_string(),
                phase: Some("post".to_string()),
                priority: Some(999),
                order: Some(7),
            },
            ServertoolRegistryAutoHookDescriptorInput {
                id: "vision_auto".to_string(),
                phase: Some("invalid".to_string()),
                priority: None,
                order: None,
            },
        ])
        .expect("auto hook descriptors plan");
        assert_eq!(
            plan,
            vec![
                ServertoolRegistryAutoHookDescriptorPlan {
                    id: "stop_message_auto".to_string(),
                    phase: "post".to_string(),
                    priority: 999,
                    order: 7,
                },
                ServertoolRegistryAutoHookDescriptorPlan {
                    id: "vision_auto".to_string(),
                    phase: "default".to_string(),
                    priority: 100,
                    order: 0,
                }
            ]
        );

        let duplicate = plan_servertool_registry_auto_hook_descriptors(vec![
            ServertoolRegistryAutoHookDescriptorInput {
                id: "vision_auto".to_string(),
                phase: None,
                priority: None,
                order: None,
            },
            ServertoolRegistryAutoHookDescriptorInput {
                id: " vision_auto ".to_string(),
                phase: Some("pre".to_string()),
                priority: Some(5),
                order: Some(1),
            },
        ]);
        assert_eq!(
            duplicate.expect_err("duplicate id must fail"),
            "duplicate auto hook descriptor id: vision_auto"
        );
    }

    #[test]
    fn registry_projection_normalizes_names_groups_records_and_rejects_duplicate_auto_handlers() {
        let plan = plan_servertool_registry_projection(ServertoolRegistryProjectionInput {
            registered_names: vec![
                " stop_message_auto ".to_string(),
                "vision_auto".to_string(),
                "stop_message_auto".to_string(),
            ],
            registered_records: vec![
                ServertoolRegistryProjectionRecordInput {
                    name: "vision_auto".to_string(),
                    trigger: "auto".to_string(),
                    source_index: 0,
                },
                ServertoolRegistryProjectionRecordInput {
                    name: " custom_tool ".to_string(),
                    trigger: "tool_call".to_string(),
                    source_index: 1,
                },
                ServertoolRegistryProjectionRecordInput {
                    name: "stop_message_auto".to_string(),
                    trigger: "auto".to_string(),
                    source_index: 2,
                },
            ],
            auto_handler_names: vec!["vision_auto".to_string(), " stop_message_auto ".to_string()],
        })
        .expect("registry projection plan");
        assert_eq!(
            plan.registered_names,
            vec!["stop_message_auto".to_string(), "vision_auto".to_string()]
        );
        assert_eq!(
            plan.registered_records,
            vec![
                ServertoolRegistryProjectionRecordPlan {
                    name: "custom_tool".to_string(),
                    trigger: "tool_call".to_string(),
                    source_index: 1,
                },
                ServertoolRegistryProjectionRecordPlan {
                    name: "vision_auto".to_string(),
                    trigger: "auto".to_string(),
                    source_index: 0,
                },
                ServertoolRegistryProjectionRecordPlan {
                    name: "stop_message_auto".to_string(),
                    trigger: "auto".to_string(),
                    source_index: 2,
                },
            ]
        );
        assert_eq!(
            plan.auto_handler_names,
            vec!["vision_auto".to_string(), "stop_message_auto".to_string()]
        );

        let duplicate_auto =
            plan_servertool_registry_projection(ServertoolRegistryProjectionInput {
                registered_names: vec![],
                registered_records: vec![],
                auto_handler_names: vec!["vision_auto".to_string(), " vision_auto ".to_string()],
            });
        assert_eq!(
            duplicate_auto.expect_err("duplicate auto handler must fail"),
            "duplicate auto handler name: vision_auto"
        );
    }

    #[test]
    fn registry_source_projection_keeps_builtin_source_refs_and_groups_records() {
        let plan =
            plan_servertool_registry_source_projection(ServertoolRegistrySourceProjectionInput {
                builtin_names: vec![" stop_message_auto ".to_string()],
                builtin_auto_handler_names: vec!["stop_message_auto".to_string()],
                builtin_records: vec![ServertoolRegistrySourceRecordInput {
                    name: "stop_message_auto".to_string(),
                    trigger: "auto".to_string(),
                }],
            })
            .expect("source projection plan");

        assert_eq!(
            plan.registered_names,
            vec!["stop_message_auto".to_string()]
        );
        assert_eq!(
            plan.auto_handler_refs,
            vec![ServertoolRegistrySourceRefPlan {
                name: "stop_message_auto".to_string(),
                source: ServertoolRegistrySourceKind::Builtin,
                source_index: 0,
            }]
        );
        assert_eq!(
            plan.registered_record_refs,
            vec![ServertoolRegistrySourceRecordRefPlan {
                name: "stop_message_auto".to_string(),
                trigger: "auto".to_string(),
                source: ServertoolRegistrySourceKind::Builtin,
                source_index: 0,
            }]
        );

        let duplicate_auto =
            plan_servertool_registry_source_projection(ServertoolRegistrySourceProjectionInput {
                builtin_names: vec![],
                builtin_auto_handler_names: vec!["alpha".to_string(), " alpha ".to_string()],
                builtin_records: vec![],
            });
        assert_eq!(
            duplicate_auto.expect_err("duplicate source auto handler must fail"),
            "duplicate auto handler name: alpha"
        );
    }
}

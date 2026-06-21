// feature_id: hub.servertool_registry_contract
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolRegistryRegistrationActionInput {
    pub name: String,
    pub has_handler: bool,
    pub builtin_name_matched: bool,
    pub builtin_entry_present: bool,
    pub registration_allowed_by_config: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolRegistryRegistrationAction {
    IgnoreInvalid,
    IgnoreBuiltinOverride,
    IgnoreDisabled,
    RegisterAdhoc,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolRegistryRegistrationActionPlan {
    pub action: ServertoolRegistryRegistrationAction,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub canonical_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolRegistryLookupActionInput {
    pub name: String,
    pub builtin_entry_present: bool,
    pub ad_hoc_entry_present: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ServertoolRegistryLookupAction {
    ReturnBuiltin,
    ReturnAdhoc,
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
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServertoolRegistryProjectionPlan {
    pub registered_names: Vec<String>,
    pub registered_records: Vec<ServertoolRegistryProjectionRecordPlan>,
    pub auto_handler_names: Vec<String>,
}

fn normalize_name(name: &str) -> Option<String> {
    let trimmed = name.trim().to_lowercase();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

pub fn plan_servertool_registry_registration_action(
    input: ServertoolRegistryRegistrationActionInput,
) -> ServertoolRegistryRegistrationActionPlan {
    let canonical_name = normalize_name(&input.name);
    if canonical_name.is_none() || !input.has_handler {
        return ServertoolRegistryRegistrationActionPlan {
            action: ServertoolRegistryRegistrationAction::IgnoreInvalid,
            canonical_name: None,
        };
    }
    if input.builtin_entry_present {
        return ServertoolRegistryRegistrationActionPlan {
            action: ServertoolRegistryRegistrationAction::IgnoreBuiltinOverride,
            canonical_name,
        };
    }
    if input.builtin_name_matched && !input.registration_allowed_by_config {
        return ServertoolRegistryRegistrationActionPlan {
            action: ServertoolRegistryRegistrationAction::IgnoreDisabled,
            canonical_name,
        };
    }
    ServertoolRegistryRegistrationActionPlan {
        action: ServertoolRegistryRegistrationAction::RegisterAdhoc,
        canonical_name,
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
    if input.ad_hoc_entry_present {
        return ServertoolRegistryLookupActionPlan {
            action: ServertoolRegistryLookupAction::ReturnAdhoc,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registration_action_handles_invalid_builtin_override_disabled_and_adhoc() {
        let invalid = plan_servertool_registry_registration_action(
            ServertoolRegistryRegistrationActionInput {
                name: " ".to_string(),
                has_handler: false,
                builtin_name_matched: false,
                builtin_entry_present: false,
                registration_allowed_by_config: true,
            },
        );
        assert_eq!(
            invalid.action,
            ServertoolRegistryRegistrationAction::IgnoreInvalid
        );

        let builtin = plan_servertool_registry_registration_action(
            ServertoolRegistryRegistrationActionInput {
                name: "stop_message_auto".to_string(),
                has_handler: true,
                builtin_name_matched: true,
                builtin_entry_present: true,
                registration_allowed_by_config: true,
            },
        );
        assert_eq!(
            builtin.action,
            ServertoolRegistryRegistrationAction::IgnoreBuiltinOverride
        );

        let disabled = plan_servertool_registry_registration_action(
            ServertoolRegistryRegistrationActionInput {
                name: "stop_message_auto".to_string(),
                has_handler: true,
                builtin_name_matched: true,
                builtin_entry_present: false,
                registration_allowed_by_config: false,
            },
        );
        assert_eq!(
            disabled.action,
            ServertoolRegistryRegistrationAction::IgnoreDisabled
        );

        let adhoc = plan_servertool_registry_registration_action(
            ServertoolRegistryRegistrationActionInput {
                name: " custom_tool ".to_string(),
                has_handler: true,
                builtin_name_matched: false,
                builtin_entry_present: false,
                registration_allowed_by_config: true,
            },
        );
        assert_eq!(
            adhoc.action,
            ServertoolRegistryRegistrationAction::RegisterAdhoc
        );
        assert_eq!(adhoc.canonical_name.as_deref(), Some("custom_tool"));
    }

    #[test]
    fn lookup_action_prefers_builtin_then_adhoc_then_none() {
        let builtin = plan_servertool_registry_lookup_action(ServertoolRegistryLookupActionInput {
            name: "stop_message_auto".to_string(),
            builtin_entry_present: true,
            ad_hoc_entry_present: true,
        });
        assert_eq!(builtin.action, ServertoolRegistryLookupAction::ReturnBuiltin);

        let adhoc = plan_servertool_registry_lookup_action(ServertoolRegistryLookupActionInput {
            name: "custom_tool".to_string(),
            builtin_entry_present: false,
            ad_hoc_entry_present: true,
        });
        assert_eq!(adhoc.action, ServertoolRegistryLookupAction::ReturnAdhoc);

        let none = plan_servertool_registry_lookup_action(ServertoolRegistryLookupActionInput {
            name: "".to_string(),
            builtin_entry_present: false,
            ad_hoc_entry_present: false,
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
                },
                ServertoolRegistryProjectionRecordInput {
                    name: " custom_tool ".to_string(),
                    trigger: "tool_call".to_string(),
                },
                ServertoolRegistryProjectionRecordInput {
                    name: "stop_message_auto".to_string(),
                    trigger: "auto".to_string(),
                },
            ],
            auto_handler_names: vec![
                "vision_auto".to_string(),
                " stop_message_auto ".to_string(),
            ],
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
                },
                ServertoolRegistryProjectionRecordPlan {
                    name: "vision_auto".to_string(),
                    trigger: "auto".to_string(),
                },
                ServertoolRegistryProjectionRecordPlan {
                    name: "stop_message_auto".to_string(),
                    trigger: "auto".to_string(),
                },
            ]
        );
        assert_eq!(
            plan.auto_handler_names,
            vec!["vision_auto".to_string(), "stop_message_auto".to_string()]
        );

        let duplicate_auto = plan_servertool_registry_projection(ServertoolRegistryProjectionInput {
            registered_names: vec![],
            registered_records: vec![],
            auto_handler_names: vec![
                "vision_auto".to_string(),
                " vision_auto ".to_string(),
            ],
        });
        assert_eq!(
            duplicate_auto.expect_err("duplicate auto handler must fail"),
            "duplicate auto handler name: vision_auto"
        );
    }
}

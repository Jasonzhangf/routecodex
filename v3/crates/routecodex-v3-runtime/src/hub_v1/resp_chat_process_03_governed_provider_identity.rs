const V3_PROVIDER_MODEL_IDENTITY_INSTRUCTION_MARKERS: [&str; 2] =
    ["your model name is", "if the user asks what model you are"];

fn is_v3_provider_model_identity_instruction(value: &Value) -> bool {
    let Some(text) = value.as_str() else {
        return false;
    };
    let text = text.to_ascii_lowercase();
    V3_PROVIDER_MODEL_IDENTITY_INSTRUCTION_MARKERS
        .iter()
        .all(|marker| text.contains(marker))
}

pub(crate) fn scrub_v3_provider_model_identity_instruction(
    instructions: &mut Option<Value>,
) -> bool {
    if instructions
        .as_ref()
        .is_some_and(is_v3_provider_model_identity_instruction)
    {
        *instructions = None;
        true
    } else {
        false
    }
}

fn scrub_v3_provider_model_identity_instruction_from_object(
    object: &mut serde_json::Map<String, Value>,
) -> bool {
    let Some(instructions) = object.remove("instructions") else {
        return false;
    };
    let mut instructions = Some(instructions);
    let changed = scrub_v3_provider_model_identity_instruction(&mut instructions);
    if let Some(instructions) = instructions {
        object.insert("instructions".to_owned(), instructions);
    }
    changed
}

pub(crate) fn scrub_v3_provider_model_identity_instructions(payload: &mut Value) -> bool {
    let Some(object) = payload.as_object_mut() else {
        return false;
    };
    let mut changed = scrub_v3_provider_model_identity_instruction_from_object(object);
    if let Some(response) = object.get_mut("response").and_then(Value::as_object_mut) {
        changed |= scrub_v3_provider_model_identity_instruction_from_object(response);
    }
    changed
}

pub(crate) fn scrub_v3_provider_model_identity_instructions_from_typed_sse(
    semantic: &mut V3ResponsesSseSemanticObject,
) -> Result<(), V3ResponsesSseTreeError> {
    if let Some(response) = semantic.response.as_mut() {
        scrub_v3_provider_model_identity_instruction(&mut response.instructions);
    }
    Ok(())
}

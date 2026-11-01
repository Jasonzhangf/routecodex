use super::*;

#[test]
fn named_unpaired_tool_output_without_call_id_is_not_rejected() {
    // Live P0 shape (bug f29d7db): a standalone Codex notification output carries
    // name+namespace but no call_id. codex-rs models.rs
    // named_unpaired_function_call_output_round_trips_without_call_id documents it
    // as a valid client item that must survive unchanged.
    let payload = serde_json::json!({
        "input": [
            {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "continue"}]},
            {
                "type": "function_call_output",
                "id": "fco_01a0c969-72fc-7530-9f23-0181a8b116e3",
                "name": "send_message_to_thread",
                "namespace": "codex_tui",
                "output": "<codex_delegation>cross-thread notification</codex_delegation>"
            }
        ]
    });

    let ids = find_responses_tool_output_ids(&payload)
        .expect("named unpaired tool output is a valid client semantic");
    assert!(
        ids.consumed_ids.is_empty(),
        "named unpaired output has no call identity to consume: {:?}",
        ids.consumed_ids
    );
}

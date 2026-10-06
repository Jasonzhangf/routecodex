# REQ02 profile worker R2 result

## Scope

Only this worktree's `docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml`
and this result document were written. No product Rust, gate code, design files, or other
worktrees were touched. The worktree is
`/Volumes/Intel/playground/routecodex/dagpipe-req02-profile-20261002`.

## Bindings actually added this run

All bindings below are `client_request_to_chat` direction bindings with
`operator@version`, `shape`, `semantics`, `transform_id`, and `failure_class`.
The source paths are taken from the raw source inventory used by the profile
verifier; destinations reuse existing canonical fields consumed by the field
library, not a new `chat.extension`.

- `anthropic:request_fields:request.tool_choice` -> `chat.tool_choice`
  - `routecodex.v3.field.tool_choice_shape_branch@1`, `shape: enum(leaf,object)`,
    `semantics: enum(tool_choice_shape_branch)`,
    `transform_id: v3.anthropic_tool_choice_to_chat_tool_choice.v1`
- `anthropic:request_fields:request.tools` -> `chat.tools`
  - `routecodex.v3.field.tool_declaration_transform@1`, `shape: array`,
    `semantics: enum(tool_declaration_transform)`,
    `transform_id: v3.anthropic_tools_to_chat_tools.v1`
- `gemini:request_fields:request.contents` -> `chat.messages`
  - `routecodex.v3.field.array_container_shape@1`, `shape: array`,
    `semantics: enum(array_container_shape)`,
    `transform_id: v3.gemini_contents_to_chat_messages.v1`
- `gemini:request_fields:request.systemInstruction` -> `chat.system.instructions`
  - `routecodex.v3.field.array_container_shape@1`, `shape: object`,
    `semantics: enum(array_container_shape)`,
    `transform_id: v3.gemini_system_instruction_to_chat_system.v1`
- `gemini:request_fields:request.tools` -> `chat.tools`
  - `routecodex.v3.field.tool_declaration_transform@1`, `shape: array`,
    `semantics: enum(tool_declaration_transform)`,
    `transform_id: v3.gemini_tools_to_chat_tools.v1`
- `gemini:request_fields:request.toolConfig` -> `chat.tool_choice`
  - `routecodex.v3.field.array_container_shape@1`, `shape: object`,
    `semantics: enum(array_container_shape)`,
    `transform_id: v3.gemini_tool_config_to_chat_tool_choice.v1`
- `gemini:request_fields:request.generationConfig` -> `chat.generation_config`
  - `routecodex.v3.field.array_container_shape@1`, `shape: object`,
    `semantics: enum(array_container_shape)`,
    `transform_id: v3.gemini_generation_config_to_chat_generation_config.v1`
- `gemini:content_part_fields:request.contents[].role` -> `chat.messages[].role`
  - `routecodex.v3.field.role_value_map@1`, `shape: array_item`,
    `semantics: enum(role_value_map)`,
    `transform_id: v3.gemini_role_to_chat_role.v1`
- `gemini:content_part_fields:request.contents[].parts[].inlineData.data` -> `chat.messages[].content[].media.inline_data`
  - `routecodex.v3.field.array_container_shape@1`, `shape: array_item`,
    `semantics: enum(array_container_shape)`,
    `transform_id: v3.gemini_inline_data_to_chat_media_inline_data.v1`
- `gemini:content_part_fields:request.contents[].parts[].inlineData.mimeType` -> `chat.messages[].content[].media.mime_type`
  - `routecodex.v3.field.array_container_shape@1`, `shape: array_item`,
    `semantics: enum(array_container_shape)`,
    `transform_id: v3.gemini_inline_mime_type_to_chat_media_mime_type.v1`

Existing candidate bindings for OpenAI `request.messages`, OpenAI `request.tools`,
and Anthropic `request.messages` were retained from the pre-existing 38-line
typed-schema candidate and not duplicated.

## Sources

- Immutable reference rows: `768a9565c` manifest `direction_bindings` and
  transform IDs for the same protocol/path rows.
- Raw source inventory: current `docs/architecture/reviews/v3-protocol-semantic-field-matrix.yml`
  source-inventory path lists used by `verify-v3-operation-runner-dagpipe.mjs`.
- Field library consumption destinations: existing canonical paths
  `chat.messages`, `chat.messages[].role`, `chat.messages[].content[].media.inline_data`,
  `chat.messages[].content[].media.mime_type`, `chat.system.instructions`,
  `chat.tools`, `chat.tool_choice`, and `chat.generation_config`.

## Verification

- `npm run verify:v3-operation-runner-dagpipe`
  - Result: FAIL (exit 1), recorded once.
  - Failures match the already-known gate contract gaps, not new profile content:
    - `transform_id: optional(string)` is still treated as required for many
      uncovered leaf/container rows.
    - direction binding validation still requires other directions once a
      `direction_bindings` block exists, or checks the request profile against
      the wrong direction.
    - source-inventory validation rejects parent rows that are absent as rows in
      the semantic-matrix inventory (`anthropic:request_fields:request.tool_choice`,
      `anthropic:request_fields:request.tools`, `gemini:request_fields:request.systemInstruction`).
- `npm run test:v3-operation-runner-red-fixtures`
  - Result: FAIL (exit 1), recorded once.
  - `valid-candidate` failed because the underlying `verify:v3-operation-runner-dagpipe`
    gate fails; the expected red fixtures reported `failed as expected`.
- `git diff --check`
  - Result: PASS (no whitespace errors).

## Remaining dependency

The schema/gate owner still needs to implement the contract already identified by
the parent orchestration: optional `transform_id`, direction-scoped binding
validation, and source-inventory acceptance for parent structure rows. This run
does not claim PASS for that gate and does not work around it.

## Diff paths

- `docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml`
- `docs/goals/req02-profile-result-20261003.md`

# Anthropic Remote Image Payload Copy Budget Test Design

## Lifecycle

1. Anthropic provider runtime receives one provider-wire body.
2. Remote URL image blocks are detected without mutation.
3. The runtime fetches each selected image and creates a base64 source block.
4. Only the ancestor path of each rewritten source is copied: top-level body, messages array, containing message, content array, image block, and source object.
5. Unchanged messages, content blocks, tools, metadata, and extension values retain their existing references and exact semantics.

## Owner And Resource

- `feature_id`: `provider.anthropic_remote_image_payload_copy_budget`.
- Resource: `provider.anthropic_remote_image_wire_projection`.
- Owner: `src/providers/core/runtime/vercel-ai-sdk/anthropic-sdk-remote-image.ts`.
- Mainline topology: internal Provider Runtime wire projection; no new numbered Hub/VR node.

## White-Box Positive

- A rewritten remote image produces the existing Anthropic base64 source fields.
- The caller-owned body and original remote source remain unchanged.
- Only rewritten ancestor paths receive new objects/arrays.
- Unaffected messages, blocks, tools, metadata, and extensions preserve exact references.
- A payload with no remote image URL returns the original body reference with zero rewrites.

## White-Box Negative

- `structuredClone`, `JSON.parse(JSON.stringify(...))`, and a full-body `deepCloneRecord` helper are forbidden.
- Fetch failure must not partially mutate the caller body.
- Remote-image policy, retry classification, media validation, byte limits, and error projection must not change.

## Module Black-Box

- Focused copy-budget Jest proves identity and provider-wire semantics.
- Existing Anthropic transport tests prove fetch/media/error/policy behavior remains unchanged.

## Project Black-Box

- Provider configuration, Hub Pipeline, Virtual Router, retry policy, MetadataCenter, response semantics, and client/provider payload fields outside the selected image source are unchanged.

## Known Gap

- Base64 materialization necessarily allocates the fetched image string and rewritten source path. Live RSS improvement remains unclaimed until the parent goal's authorized installed-runtime replay.

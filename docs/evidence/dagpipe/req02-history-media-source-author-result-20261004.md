# REQ02 history/media source associations — author dependency evidence

Candidate tree: req02-main322-20261004, base 73083890f6bb86635a50526f263b98349b338efd plus this task's uncommitted candidate. This receipt proves prerequisite implementation and public normalization behavior only. Full projection, production caller cutover, two-model tool E2E, install/restart, independent implementation review and Git delivery remain incomplete.

## Completed source changes

- Composed the completed GCM concrete history producer. Existing history fold/remap uses actual message/part/call destinations. The moved producer implementations exist only in field_operator_history.rs.
- Store each original history item's data-plane representation before collecting history-fold comparison extras. Typed references retain paths/identity; original values remain in the canonical extension. Thus role/type/media representation and absent fields remain inspectable without adding raw control mirrors or changing fold equivalence.
- Responses object-shaped image_url/url now maps to the actual canonical image_url object. Scalar shapes map to image_url.url. Both use concrete emitted indices.
- Anthropic base64 media now follows the registered canonical media.inline_data / file.file_data / media.mime_type shapes. MIME absence/null is preserved, and normalization no longer synthesizes application/octet-stream or encodes missing MIME as a data URI. URL sources retain the existing image_url/file_url shape. Exact producer associations identify the current canonical fields.
- All opaque part-sibling paths use the shared structural field_path helper for literal dots/brackets.
- Shared source_value reads nested representation through the nearest typed opaque reference and never replays a removed nearer record through an ancestor. Shared direct_child_key uses the same structural parser.

## Author verification

- Producer public suites: .execution/history-producer-parent-public-r1.log/.exit — 25 passed / 0 failed, exit 0.
- Producer runner: .execution/history-producer-parent-runner-r1.log/.exit — 83 passed / 0 failed, exit 0.
- Media/source public red: .execution/media-source-parent-red-r2.log/.exit — 0 passed / 3 failed, exit 101. Confirms missing native source shape, Responses object association and missing/lossy Anthropic media representation.
- First affected runner: 82 passed / 1 failed. Sole failure expected the old empty source-reference list, while the required original input/instruction references now exist; original failure preserved. Updated only that provenance assertion, preserving payload assertions.
- Final runner: .execution/media-source-parent-runner-r2.log/.exit — 86 passed / 0 failed, exit 0.
- Nine affected public SDK suites: .execution/media-source-parent-public-r2.log/.exit — 32 passed / 0 failed, exit 0. Includes mixed history folding and repeated results, instruction index shifts, current-turn media, tool namespace presence and new media/source tests.
- file-size ratchet and git diff --check: exit 0.
- The pre-media operation-runner gate passed; a new full architecture result must be bound to the final media/source input. No independent review claim.

## Remaining dependency

Native multi-part instructions currently join text into one canonical string. That representation cannot identify independently mutated source parts; source shape references alone do not repair the missing current-value association. A lossless per-part normalization/inverse contract is required before native instruction inverse can be accepted. Do not guess splitting or replay original text as success.

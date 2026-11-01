# Whole-review corrections

This delta fixes three test-infrastructure defects from the P1 whole review.
Runtime Rust, operators, production configuration and services are unchanged.
The original installed 0.90.4886 48-case baseline remains immutable.

- Complete-transport assertions now use the recorded HTTP completion receipt.
  Matching JSON followed by reset and matching SSE terminal followed by timeout
  fail; valid complete transport passes. Red/green public-helper evidence is
  under transport/.
- Multi-turn expectations preserve first-turn status, semantic terminal and
  forbidden content. Later turns declare the same applicable transport contract.
  An invalid first turn cannot execute echo or send its follow-up. Public case
  controls and the author test log are under turns/.
- [Media history](media-history/README.md) checks the complete independent
  six-message history, assistant order, tool IDs and media association.

Combined author check: 159 passed, zero failed, zero skipped, all nine discovered
test files. Raw log and exact exit are in affected-live/suite.log and suite.exit.

| Affected installed HTTP replay | Outcome | Actual behavior |
| --- | --- | --- |
| chat-to-chat-json | Pass | One provider POST, complete client JSON |
| chat-to-chat-sse | Pass | One provider POST, complete client SSE |
| provider-error-exhaustion | Pass | One scripted 429, zero client body bytes and closed connection |
| tool-followup-responses-to-chat | Strict mismatch retained | First turn passes, declared echo executes once, actual call ID/output reaches second POST; second-turn wire/client projection mismatches remain |

All four replay cleanup receipts are complete: owned child exit observed, both
listeners closed, mock closed, generated state removed. The media replay has its
own complete cleanup receipt.

These replays used installed rccv3 0.90.4887, SHA256
5c1672a562c32c4c996b2ce6c83f552e8e271c4266256a34a0f4fc2a5847a563.
Source base f7fc9e17b identifies the candidate source, not that installed
binary's build provenance. No new aggregate 48-case pass count is claimed.
The retained tool mismatch remains input for P2 operator/config work.

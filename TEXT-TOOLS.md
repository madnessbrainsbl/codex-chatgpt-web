# ChatGPT local tools (local patch for 6.1.13)

`toolTransport: "text"`, `useSavedChats: false`, and `mode: "browser-only"` enable a
connector-free transport. ChatGPT returns one fenced JSON envelope. The adapter
validates its exact tool name and JSON argument schema, then emits ordinary Codex
function/custom-tool events. Only Codex executes tools, using its normal sandbox
and approval policy. The installed ChatGPT MCP connector is not selected.
If auto tool choice receives non-JSON prose, the adapter finishes with a clear
notice that no local tool ran instead of dropping the stream; required tool calls
and structured-output requests remain strict. It does not spend quota on an automatic retry.

Text tool rounds retain one owned Temporary Chat per native chat/model/compaction
epoch. Continuations send the new messages and actual tool results; unchanged
system instructions and tool schemas are not resent. Changed schemas and policies
are sent again. If the canonical prefix changes, the complete current context is
sent rather than guessing a delta. Compaction starts a new epoch: the readable
checkpoint replaces covered older user messages and images in the browser payload,
while the latest pre-checkpoint request, developer instructions and all subsequent
messages/images remain. The native history on disk is unchanged. This prevents
repeated compaction against an irreducible floor of already-summarized attachments.
Native usage tracks the retained browser transcript: initial payload and one
platform reserve, then each continuation payload and previous reply. It does not
reset to the size of the latest tool result or resend the initial schema catalog.
The launcher helper reports its selected lease after preparing the prompt; usage
is recomputed on either event so direct and helper execution agree.

Saved project chats are opt-in per local workspace through private `config.json`:
`savedChatProjects: [{ "root": "<absolute workspace path>", "url": "https://chatgpt.com/g/g-p-<project-id>-<name>/project" }]`.
Bindings use the verified native working directory, with the closest containing
root winning. They override Temporary Chat only for that workspace; other tasks
keep `useSavedChats`. Project chats are saved in ChatGPT history. A fresh epoch
starts inside the same project and receives the explicit Codex checkpoint; it
does not depend on project memory reproducing the previous transcript. Existing
conversation ownership and delta continuation still apply. Invalid URLs and
redirects to another surface fail before the prompt is sent. Create the project
in ChatGPT first; this version binds an existing project and does not create one.

The browser copy of each tool result is capped at 12,000 text characters, keeping
the beginning and end and an explicit omission notice. Image parts, error status,
native tool results and native history are preserved. Read a narrower file range
when omitted evidence matters. This reduces context growth; it does not disable
necessary compaction or increase the model's context window.

Validated on 2026-10-24 at 18:53 local time, installed primary PID 74156:
`probe-retention.ts` received a tool request, supplied the pure diagnostic result,
and recovered the remembered random marker in the same Temporary Chat. The last
browser message contained only the continuation, and cumulative input usage was
10,515 tokens. A read-only replay of the actual HH compacted history, excluding
the external tool catalog, fell from 91,098 to 45,981 tokens (10 old images to 0).
Native history was not rewritten. Direct/helper timing, schema/policy updates,
active images and terminal replay are covered by focused tests. No HH cycle ran.

Remote-compaction correction: disabling JSON tool replies for a compaction request
also accidentally disabled checkpoint-covered history normalization. A real HH
history replay produced a 131,099-token compaction payload with ten old images;
normalizing that same input retained its checkpoint and newer evidence in 63,099
tokens with no old image uploads. Carry the text-transport flag into compilation
and usage on compaction turns too; only the JSON response contract stays disabled.
The regression first failed with context_length_exceeded, then passed the real
multipart preflight, plain-summary, usage, immutable-history and replay assertions.
History without a readable covering checkpoint is preserved rather than dropped.

Primary runtime PID 61780 was activated with this correction. A synthetic
135,035-token source compacted through the installed primary into a 31,799-token
payload and preserved two random facts. A following native-format request
recovered both facts and completed in 9,648 input tokens. The first diagnostic's
literal-marker assertion had to account for standard Markdown underscore escapes;
the model continuation recovered the original identifiers exactly.
Scope checks: 72 tests / 698 assertions passed across text transport, prompt,
usage and server-compaction suites. A separate legacy named-pipe MCP handoff test
hung and its own test process was stopped; no active application task was stopped.
The separate native CLI automatic-compaction diagnostic did not produce a terminal
result before its execution session disappeared; automatic triggering is not
verified by that run. On the following check, primary PID 10132 loaded the same
installed CLI hash and reported healthy text transport with saved chats disabled.

Model verification correction, 2026-10-25: the pre-send verification previously
allowed no time for the slider announcement to settle, and family confirmation
accepted only English effort names. Verification now waits up to five seconds
without accepting a different family or effort, and recognizes exact Russian
effort labels too. Unit and DOM regressions failed before the change and passed
after it. A local service drain now reports `bridge_service_restarting` instead
of `server_is_overloaded`; restarting the launcher still interrupts availability.
The 100-test scope run passed 99 tests immediately; its one Chrome-startup failure
passed separately on retry. TypeScript and diff checks passed.
Both runtime bundles were installed and activated as primary PID 35156. The live
GPT-6 High check compacted a 135,051-token synthetic source using 31,748 input
tokens, excluded ten covered images, preserved both random facts, and recovered
both in the following completed request (9,671 input tokens). Final primary
health was OK, accepted turns, and kept text transport and saved chats disabled.

Uploads still consume the account's file-upload allowance. A visible English or Russian upload-limit status
is now reported immediately as `upload_quota_exceeded` with its displayed reset
time, even when ChatGPT rejects files before a network upload begins. The terminal
error is replayed on reconnect without starting another browser attempt. This
does not remove the account limit.
Validated on 2026-10-24: two DOM regressions first reproduced the unrecognized
quota status, then passed; the real quota banner was classified as HTTP 429 with
its reset time. Adapter replay produced one browser attempt across two requests.
After installing and activating the fix (PID 56684), the primary listener completed
a 112,103-token, two-part request with one synthetic image and returned
`PRIMARY_IMAGE_CONTEXT_OK`. This proves that control request, not a full HH run.
Exactly one tool request is accepted per model response. Native code-mode tools
can still perform their own supported grouped operations.

The complete tool catalog is included in multipart planning and reported input
usage. Codex therefore receives the same context estimate as the browser
preflight and can trigger native automatic compaction at its configured limit.
Verified with an ephemeral native Codex run using a test-only 35,000-token
threshold: a large synthetic tool result triggered `context compacted`, and the
next command and final answer succeeded without a manual `/compact`.
After activation, the installed primary listener also completed a synthetic
108,167-token request in two parts and reported the same full input-token count.

Malformed envelopes and unknown tools fail closed. Completed native request
rounds reuse the existing response journal and stable call IDs on reconnect;
there is no automatic replay of a rejected JSON response as a new browser send.
The transport itself never executes strings as commands. Native freeform-tool
validation remains the responsibility of Codex.

Verification: targeted parser/prompt/bridge tests and TypeScript checks; actual
ephemeral Codex CLI runs with GPT-6 Sol (Web), including Get-Location, a sandbox
denial, and apply_patch followed by shell verification of TEXT_TOOL_PATCH_OK.
These are bounded checks, not proof of every model, large-context workflow,
subagent, or media tool. Temporary Chat is not anonymity or zero server retention.

Run scripts with the bundled Bun 1.4.0. `scripts/install-text-tools.ts` backs up
config and both runtime CLI/helper/manifest sets before atomically installing the
patch. `scripts/activate-text-tools.ts` drains new requests while existing streams
finish, then asks the launcher to apply its existing setup/restart transaction.
It verifies that the process ID changed and resumes acceptance if activation fails;
it never cancels active requests. Polling for idle without draining can starve
while unrelated Codex tasks continue submitting requests.
Activation status is in `~/.codex-chatgpt-web/runtime/text-tools-activation.json`.

Deployment correction, 2026-10-24 19:13 local: the browser runs the sibling
`app/browser-helper.cjs`, not the worker code bundled inside cli.js. Earlier local
installs replaced only cli.js, leaving the UI upload-limit fix inactive in the real
helper. The installer now builds, backs up, updates and verifies both artifacts in
both runtime trees, including manifest identities and rollback. Primary PID 25740
uses the corrected helper (SHA256 6795962cd0b24c358663b0ef190f8e76ce96a23d42b34fa2aeca86ceeba2b57b).
An actual 10-image synthetic request returned upload_quota_exceeded in 8,561 ms
with the displayed 21:11 reset time; its identical replay returned in 3 ms without
another browser upload. A separate one-image control completed, so the banner is
not evidence that every smaller upload is blocked. The account quota is unchanged.

Rollback: after finishing active Web tasks, restore config.json and the two
CLI/helper/manifest sets from the installer-reported backup directory to their original
locations (0 = installed version, 1 = launcher resources/runtime), then restart
the launcher. Never place backup files inside the manifest-checked runtime trees.
An official app update can replace this local patch.

Q&A latency correction, 2026-10-25: an explicit tool_choice=none request with
no advertised tools and exactly one user message now uses ordinary Markdown
instead of the JSON tool envelope. Stable text can stream before completion.
Tool-enabled requests, history continuations and compaction retain validated
transport; strict JSON output remains buffered until validation succeeds.
An unlocked family/effort that already matches live DOM evidence skips redundant
re-selection. Changed, uncertain and usage-tracked selections keep the full path;
pre-Send checks still run.

The installed primary was activated as PID 81472, preserving Full mode, text
transport and Temporary Chat. Same-prompt Instant controls: before 12.95/12.80 s;
after cold start 14.70 s and repeat 11.70 s. On the installed primary, a synthetic
20-paragraph answer began streaming at 11.22 s, completed at 24.14 s, and arrived
in 19 chunks. These bounded controls do not establish a universal speedup.
No empty-tab prewarming or diagnostic-removal change was made. Upstream latest
was already 6.1.13; this remains a local patch that an official update can replace.

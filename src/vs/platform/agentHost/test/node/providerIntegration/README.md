# Agent Host provider integration tests

These tests exercise a bundled provider process against a synthetic local model service. Most start a real Agent Host server; focused provider-boundary tests can drive the SDK directly when AHP is not part of the contract. They are useful when provider lifecycle, filesystem behavior, or SDK wire compatibility matters but realistic model behavior does not.

These are distinct from `../e2e/`, whose prioritized cross-provider suites replay model traffic captured from real CAPI interactions and assert AHP snapshots and real tool behavior. Provider integration tests do not contribute to the E2E coverage report.

Every real provider process must use a temporary home through `createIsolatedProviderEnvironment` or the required `homeDir` option of `startRealServer`. This keeps provider configuration, logs, and sessions out of the developer's real home directory.

Run one suite with:

```bash
./scripts/test-integration.sh --run src/vs/platform/agentHost/test/node/providerIntegration/copilotMockLlm.integrationTest.ts
```

## Windows native Computer Use regression tests

`copilotComputerUse.integrationTest.ts` checks SDK registration without controlling
the desktop. `copilotComputerUseWindows.integrationTest.ts` is a separate,
**opt-in native GUI suite**. It is skipped unless the platform is Windows and
`VSCODE_COMPUTER_USE_NATIVE_TEST=1`. Do not enable it in unattended/default CI.

Run it only when ready to allow native interaction with disposable browser
fixtures, in an active, unlocked Windows desktop session. Do not interact with
the desktop during a run. Locked/disconnected sessions, session 0, services, WSL,
and secure desktops are not supported; the tests do not bypass native safety
checks. Chromium must already be installed for the root `@playwright/test`
dependency. The optional Edge cases use an already installed Microsoft Edge.
The suite does not download browsers or install dependencies.

From the repository root in PowerShell, after the needed source output has been
compiled, use the repository's **Node runner** for this suite. The example uses
the already downloaded Electron in **Node mode** to meet the runner's Node
version requirement without installing anything. Do not use the usual
`test-integration.bat` entrypoint here: its Electron renderer cannot safely load
Playwright's Node VM dependency.

```powershell
$env:VSCODE_COMPUTER_USE_NATIVE_TEST = '1'
$env:VSCODE_COMPUTER_USE_PLUGIN_PATH = 'C:\path\to\computer-use\dist\plugin\win32-x64'
$env:ELECTRON_RUN_AS_NODE = '1'
$env:VSCODE_DEV = '1'
& '.\.build\electron\Code - OSS.exe' .\test\unit\node\index.js --run src\vs\platform\agentHost\test\node\providerIntegration\copilotComputerUseWindows.integrationTest.ts | Out-Host
```

An existing standalone Node matching `remote\.npmrc` can instead run
`node .\test\unit\node\index.js --run` with the same test path.
The `Out-Host` pipeline makes PowerShell wait for the GUI-subsystem executable
even though it is running in Node mode.

Use `win32-arm64` for an ARM64 host. Omit `VSCODE_COMPUTER_USE_PLUGIN_PATH` to use
the plugin bundled with the pinned platform runtime. Resolution uses
`resolveCopilotComputerUsePlugin`; an invalid explicit override fails instead of
silently selecting a different helper. Keep the plugin manifests and both native
executables together.

Additional environment variables:

| Variable | Meaning |
|----------|---------|
| `VSCODE_COMPUTER_USE_NATIVE_EDGE_TEST=1` | Add the same independent scenarios using the installed Edge channel, serially after Chromium. |
| `VSCODE_COMPUTER_USE_NATIVE_GREP` | Optional regular expression against `<channel> <case>`, for example `chromium (select-all\|scroll\|capture)`. Unmatched cases are skipped. |
| `VSCODE_COMPUTER_USE_NATIVE_OUTPUT_DIR` | Optional evidence directory (absolute or relative to the repository root). Each scenario creates its own uniquely named subdirectory. |

For example, add Edge and retain fixture-only diagnostics:

```powershell
$env:VSCODE_COMPUTER_USE_NATIVE_EDGE_TEST = '1'
$env:VSCODE_COMPUTER_USE_NATIVE_OUTPUT_DIR = '.build\windows-native-results'
$env:ELECTRON_RUN_AS_NODE = '1'
$env:VSCODE_DEV = '1'
& '.\.build\electron\Code - OSS.exe' .\test\unit\node\index.js --run src\vs\platform\agentHost\test\node\providerIntegration\copilotComputerUseWindows.integrationTest.ts | Out-Host
```

Each case is independent, so a failed text assertion does not prevent keyboard,
scroll, or capture diagnosis. The Node runner does not forward `--grep` to its
inner Mocha instance; use `VSCODE_COMPUTER_USE_NATIVE_GREP` instead. Remove the
opt-in after testing:

```powershell
Remove-Item Env:VSCODE_COMPUTER_USE_NATIVE_TEST
Remove-Item Env:ELECTRON_RUN_AS_NODE
Remove-Item Env:VSCODE_DEV
```

### What the suite verifies

Every scenario creates a fresh browser process/profile, two distinct windows in
that process, and a fresh SDK session/home beneath `.build`. Pages are synthetic,
network requests are blocked, and service workers/downloads are disabled. Only
the guard is explicitly brought forward; the target is never manually activated
to make an action pass. Guard input, selection, input-event counters, and DOM
focus are checked before and after native calls, including foreground fallback.
Playwright's default focus emulation is explicitly disabled so these checks
observe real Windows focus instead of reporting every page as focused.
The guard is created in the target's browser context. Edge retains the Windows
OS environment needed for known-folder resolution, while its browser profile is
explicitly isolated. The SDK/helper use the separate temporary home and preserve
inherited runtime policy settings.

The scenarios independently verify:

- A native input click followed by `type_text` changes the target DOM value.
- Native `ctrl+a` selects independently seeded text from a collapsed selection.
- Typing and `ctrl+a` with an omitted element index still target the selected
  window, including an authorized foreground fallback.
- Native scroll with positive `dy` moves the target scroll area's DOM `scrollTop`.
- Native button click executes its handler and changes a status element.
- Native image capture decodes as JPEG/PNG and contains the nonce-specific target
  marker, rather than the guard, a stale fixture, or another window.
- Declining initial application consent returns an explicit refusal, captures no
  image, and leaves both windows untouched.

All application discovery is transient: exact UUID fixture titles (with the
browser's known title suffix, if present) must each match exactly one JSONL row.
Unrelated application listings are never logged or saved. Every other native
call explicitly includes the selected fixture's `app` and opaque integer
`window` from discovery. Native Chromium captions can end in
` - Google Chrome for Testing`; Edge may add ` - Profile 1 - Microsoft\u200b Edge`
or ` - Work - Microsoft\u200b Edge`
(where `\u200b` denotes U+200B).
Only exact known caption forms are accepted, never substring matches for actions.
Element lookup uses the first exact AX role **and automation ID**, not a label;
Chromium can expose duplicate legacy UIA aliases and separate static labels.

There are no model requests or real credentials. The SDK uses empty mode, the
pinned platform `index.js`, the resolved built-in plugin, a non-listening
loopback model endpoint, an isolated environment, and a deny-only permission
handler. `GH_TOKEN`/`GITHUB_TOKEN` are absent and `AUTO_APPROVAL` is disabled.
Elicitation accepts only the exact released/source application-consent messages
for the active fixture operation and session, with the `computer-use` source
and an offered session-local `allow` choice. The exact Windows foreground
fallback prompt may receive `allow_foreground` for an active fixture action.
Unexpected prompts are declined; there are no persistent/`always` grants.

Success is determined by independent DOM observations, not `isError=false`,
`done`, or `DispatchedUnverified` responses. Native actions and test cases are
not retried, and native refusals stop subsequent fixture actions. Only read-only
DOM observations are polled. This intentionally
detects the older helper's background text, Ctrl+A, and scroll regressions
instead of accepting an unverified dispatch.

Evidence, when requested, consists only of target/guard DOM and foreground
observations, exact fixture titles, fixture-scoped native text results and
consent decisions, and a native image after its target marker has been verified.
Media payloads and application
listings are not printed. A snapshot whose fixture identity cannot be verified
is omitted from saved text. Without an evidence directory, no evidence is kept.
Session disconnect, runtime stop, browser close, and removal of the owned home
are awaited through nested cleanup, including setup failures. Native RPCs and
DOM observations have bounded waits; each case has a four-minute outer timeout.

## Windows live-video regression tests

[`copilotComputerUseVideo.integrationTest.ts`](./copilotComputerUseVideo.integrationTest.ts)
contains an **opt-in native-boundary end-to-end suite** and separately gated
[authenticated SDK/AHP checks](#authenticated-sdkahp-video-routing).
The direct-MCP suite requires Windows and **both**
`VSCODE_COMPUTER_USE_NATIVE_TEST=1` and
`VSCODE_COMPUTER_USE_NATIVE_VIDEO_TEST=1`. The older
`VSCODE_COMPUTER_USE_VIDEO_TEST` flag only adds idle-resource/Stop checks to the
SDK registration test; it does **not** enable this live capture suite.

**Do not run the live suite until the Windows capture/authorization/IPC backend
and the Media Foundation encoder have been built together into the selected
plugin.** Merely finding an executable or a matching version is not evidence
that video is ready. This suite fails rather than silently skipping an
unsupported backend, missing AVC decoder, policy refusal or capture failure.
As with the input suite, it needs an active, unlocked desktop and exclusive use
of the desktop for the duration of the run. It never locks, disconnects or
changes the resolution of the real desktop, and never installs recovery tools.

### Boundary and lifecycle activation

The exercised path is:

```text
installed MCP SDK Client + StdioClientTransport
  -> real computer-use-mcp.exe
  -> real authenticated native helper IPC / target authorization
  -> persistent Windows window capture + real H.264 encoding
  -> resources/read batches
  -> real browser VideoDecoder / EncodedVideoChunk
  -> decoded target-only pixels
```

There is no mocked capture, encoder or WebCodecs implementation, and no fake or
real model request. The installed MCP SDK handles JSON-RPC, initialization,
elicitation and request timeouts; the test does not implement its own RPC
framing. The isolated native peer sends the real `notifications/copilot`
notifications with `params: { type }`, using `assistant.turn_start`,
`assistant.turn_end`, `user.abort` and `assistant.abort`. Each lifecycle
notification is followed by `Client.ping()` as a main-thread ordering barrier:
native video resource reads are serviced on an independent thread.

The pinned Copilot SDK's `session.rpc.mcp.apps.callTool()` is not used as a
substitute for an assistant lifecycle, and SDK 1.0.13 has no public MCP
lifecycle-notification API. A turn-start notification alone does not authorize
video: a successful, application-consented native `get_window_state` for the
exact target establishes its control lease and video authorization.

**The direct-MCP suite is not AHP, Copilot runtime lifecycle forwarding, or
Sessions viewer integration coverage.** That suite does not create a Copilot SDK session, exercise
`mcp.apps` visibility enforcement, route a native abort through host chat
cancellation, or import the higher-layer Sessions video parser. App-only Stop
metadata is checked at the native MCP boundary; the separate SDK registration
test checks model-tool visibility. The raw elicitation adapter binds the
existing consent validator to one owned stdio peer; this is not a test of
SDK-provided source/session attribution. Replacement means a new native
stdio/control session, not an AHP session switch in a shared host.

The authenticated AHP cases below separately check real SDK/native routing and
host cancellation. Actual Sessions viewer visibility/unmount behavior and
runtime policy revocation still need their own host/client validation. The
direct suite uses safe target closure and native lifecycle/session teardown
instead of machine-wide access revocation.

### Running safely

Use the existing Node runner and already installed dependencies, as in the input
suite above. Playwright, `@modelcontextprotocol/sdk` and the Windows process-tree
helper are loaded only inside an explicitly enabled fixture. No browser or
package is downloaded. The current development combination is runtime
`1.0.84-4`, SDK `1.0.13` and source helper `0.1.89`; the source helper must also
contain the completed live-video backend, not just the prior input fixes.

After backend readiness is explicitly confirmed, run from the repository root:

```powershell
$env:VSCODE_COMPUTER_USE_NATIVE_TEST = '1'
$env:VSCODE_COMPUTER_USE_NATIVE_VIDEO_TEST = '1'
$env:VSCODE_COMPUTER_USE_PLUGIN_PATH = (Resolve-Path '..\computer-use\dist\plugin\win32-x64').Path
$env:ELECTRON_RUN_AS_NODE = '1'
$env:VSCODE_DEV = '1'
try {
    & '.\.build\electron\Code - OSS.exe' .\test\unit\node\index.js --run src\vs\platform\agentHost\test\node\providerIntegration\copilotComputerUseVideo.integrationTest.ts | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Native video regression tests failed' }
} finally {
    Remove-Item Env:VSCODE_COMPUTER_USE_NATIVE_TEST
    Remove-Item Env:VSCODE_COMPUTER_USE_NATIVE_VIDEO_TEST
    Remove-Item Env:ELECTRON_RUN_AS_NODE
    Remove-Item Env:VSCODE_DEV
}
```

For a non-sibling checkout, set the override to the corresponding absolute
plugin path.
Omit the override to test the pinned runtime's complete bundled plugin. Do not
use `scripts\test-integration.bat`: its Electron renderer cannot safely load
Playwright's VM dependency. Existing compiled test output is required; reuse an
existing watcher or focused transpilation rather than starting another watcher
or a broad build just for these tests.

| Variable | Meaning |
|----------|---------|
| `VSCODE_COMPUTER_USE_NATIVE_EDGE_TEST=1` | Add the same ten scenarios for installed Edge, after Chromium. |
| `VSCODE_COMPUTER_USE_VIDEO_GREP` | Regex against `<channel> <case>`. The Node runner does not forward Mocha `--grep`. |
| `VSCODE_COMPUTER_USE_VIDEO_OUTPUT_DIR` | Optional fixture-only metadata evidence root; no encoded media, decoded screenshots or app listings are saved. |

For example, with Edge enabled, `VSCODE_COMPUTER_USE_VIDEO_GREP='^msedge '`
runs only Edge when the installed Chromium cannot decode AVC.
`VSCODE_COMPUTER_USE_VIDEO_GREP='chromium (resize|hidden-viewer)'` selects just
the resize and viewer-expiry cases. Unsupported AVC is a failure, not a mocked
decoder or an automatic success/skip. Remove `DEBUG`/`PWDEBUG` before a live run:
protocol tracing can include encoded bytes. External native test-service
endpoints and native test bypasses are rejected.

The pure
[`copilotComputerUseVideoTestUtils.test.ts`](./copilotComputerUseVideoTestUtils.test.ts)
tests can run without desktop access. They check opt-in gating, wire validation,
the exact byte/frame limits, diagnostic redaction and the extracted input
fixture's title/consent contracts. Their synthetic NALs validate **wire shape
only**, not encoding or decoding. To run these checks and verify the live suite
stays skipped, explicitly disable both opt-ins:

```powershell
$env:VSCODE_COMPUTER_USE_NATIVE_TEST = '0'
$env:VSCODE_COMPUTER_USE_NATIVE_VIDEO_TEST = '0'
$env:VSCODE_COMPUTER_USE_VIDEO_AHP_TEST = '0'
$env:ELECTRON_RUN_AS_NODE = '1'
$env:VSCODE_DEV = '1'
& '.\.build\electron\Code - OSS.exe' .\test\unit\node\index.js --run src\vs\platform\agentHost\test\node\providerIntegration\copilotComputerUseVideoTestUtils.test.ts --run src\vs\platform\agentHost\test\node\providerIntegration\copilotComputerUseVideo.integrationTest.ts | Out-Host
```

This safe command does not create browser/native processes, profiles, a local
server, application listings or capture streams. Default opt-out skips are not
evidence that any live scenario passed.

### Scenarios and measurable assertions

Each of the ten cases gets a fresh browser process/profile, unique
`vscode-native-<UUID> target/guard` titles, two distinct windows in the same
browser context, and an isolated native home. It reuses the input suite's exact
caption matching and session-local consent rules. Browser OS environment is
retained for Edge's known-folder lookup; its profile is disposable. Native
environment uses `createIsolatedProviderEnvironment` and
`createCopilotCliEnvironment`, removes GitHub tokens, disables auto-approval,
preserves runtime policy settings and binds native storage to the owned home.

Only the guard is explicitly foregrounded, and Playwright's focus emulation is
disabled. Its input, selection, input-event counters and real DOM focus must
remain unchanged. The target animates six nonce-specific color patterns. The
guard has a different marker and hosts the decoder on a trustworthy loopback
origin; all non-fixture page requests, service workers and downloads are blocked.
Colors and canvas dimensions are measurement probes, not workbench styling.

The cases check:

1. **Idle and query rejection:** reads before consent contain no frames and
   grant no application access. `resources/list` advertises the resource,
   `stop_computer_use` has empty arguments and `_meta.ui.visibility: ['app']`,
   and window/app selectors, duplicate fields and invalid cursors return MCP
   `InvalidParams`. A selector is also rejected during active capture.
2. **Encoded cadence and isolation:** version 1, exact authorized target,
   bounded dimensions (at most 1280 x 720), canonical base64 avcC with SPS/PPS,
   four-byte-length AVCC access units, truthful IDR/keyframe flags, increasing
   integer sequences/microsecond timestamps, positive durations, and at most
   **60 frames / 1 MiB of encoded bytes including avcC** per batch.
   Real WebCodecs output must contain the target marker and never the guard's.
   At least **12 decoded frames, three distinct animation phases, one second
   of media time and 3 decoded FPS** are required within a 12-second observation
   window. Other live cases require at least six decoded frames with the same
   phase/span/cadence checks. The requested 30 FPS is not treated as an exact
   software/virtualized-host delivery guarantee.
3. **Resize:** an independently observed target viewport resize creates a
   different stream, changed decoded dimensions, fresh configuration and a
   decodable keyframe.
4. **Viewer expiry:** the harness hides its decoder region, refuses reads while
   hidden and sends no resource reads for **3.6 seconds**. Resuming under the
   same active lease must produce a fresh stream/keyframe without another
   target-authorizing tool call. This tests the native TTL, not the Sessions
   widget's visibility implementation.
5. **App Stop:** an empty-argument native Stop clears frames/config, latches
   `stopped`, and emits exactly one real `notifications/copilot` `user.abort`.
6. **Turn end:** clears data; a new turn-start alone remains idle. A new
   successful target perception is required to obtain a fresh stream.
7. **User abort:** revokes data; restarting a turn cannot reuse authorization.
8. **Assistant abort:** independently checks the same revocation invariant.
9. **Target closure:** the first read after closing the owned target contains
   no frames/config and cannot redirect to the still-open guard.
10. **Session replacement:** closes and verifies termination of the old native
    process tree, then verifies a fresh native session has neither video nor
    application approval until it obtains new fixture consent/authorization.

Unexpected native `isError` results and prompts terminate the scenario; no
uncertain native action is retried. No persistent/`always` grants are accepted,
and video-only scenarios do not approve foreground fallback. Each case has a
90-second scenario deadline within a four-minute outer timeout; browser setup,
RPCs, observations and cleanup have bounded waits. A timed-out fixture cannot
start a replacement native session during cleanup.

Cleanup is awaited on success and failure: close the MCP/native process tree,
close every browser decoder/output frame, close the owned browser and its
descendants, close the loopback server, then remove the owned profiles/homes.
PID-scoped forced cleanup is a reported failure, never a silent success.
Optional `video-summary.json` evidence contains only exact fixture identities,
consent/read/abort counts and scalar stream/decoder measurements. Native stderr,
raw RPC payloads, encoded media and unrelated application listings are not
printed or persisted.

### Authenticated SDK/AHP video routing

The same integration test file also contains **two additional cases per
browser**, implemented by
[`copilotComputerUseVideoAhpTestPeer.ts`](./copilotComputerUseVideoAhpTestPeer.ts).
They require all three opt-ins:

- `VSCODE_COMPUTER_USE_NATIVE_TEST=1`
- `VSCODE_COMPUTER_USE_NATIVE_VIDEO_TEST=1`
- `VSCODE_COMPUTER_USE_VIDEO_AHP_TEST=1`

**Keep these cases disabled until the integrated Windows backend is built and
live execution is explicitly authorized.** Static compilation and default
skips do not establish that real SDK/native routing passed.

These cases reuse `startRealServer({ mockLlm: true, ... })`,
`createProviderSession` and `TestProtocolClient`; they do not substitute a
`ScriptedMockAgent`, fake an SDK event, call `AgentService` directly, or inject
native lifecycle notifications. The real Copilot runtime/SDK runs against the
existing loopback fake model service. That helper redirects both GitHub token
and CAPI/model endpoints to loopback and supplies synthetic credentials.
`GH_TOKEN`/`GITHUB_TOKEN` are removed, including Windows casing variants.
The host/native home, user-data directory and workspace are all disposable;
the workspace is outside the source repository so the model cannot pick up
the developer's project instructions by ancestor discovery.

The tested boundary is:

```text
real authenticated AHP WebSocket client
  -> real Agent Host / exact-chat mcp:// routing
  -> real Copilot SDK session.rpc.mcp.apps
  -> real native MCP/helper, window authorization and encoded video
  -> authenticated AHP resources/read response
  -> the same real browser WebCodecs and nonce-pixel verifier
```

`startRealServer` now accepts an optional `connectionToken`. When supplied, it
uses the production `--connection-token` option instead of
`--without-connection-token`. The optional fourth argument to
`TestProtocolClient` is `{ connectionToken }`, which uses the production
connection-token query parameter. Existing callers retain their tokenless
test behavior. Each routing case verifies that WebSocket clients with a missing
token or an incorrect nonempty token are rejected with HTTP 403 before using its
randomly generated valid token.
This real host-transport authentication is distinct from the fake GitHub
credentials used only with the local model service.

Each case creates two independent chats in **one real Copilot AHP session**.
The default chat is the guard; a newly created peer chat owns Computer Use.
Two deterministic local content streams keep both real SDK turns active.
Receiving nonce-specific `chat/delta` heartbeats, rather than merely dispatching
`chat/turnStarted`, establishes that each SDK turn has actually started.

All computer-use calls go through public AHP:

- `createChat({ channel: sessionUri, chat: peerChatUri })`
- `tools/call({ channel: buildMcpChannel(peerChatUri, 'computer-use'), name, arguments })`
- `resources/read({ channel: buildMcpChannel(peerChatUri, 'computer-use'), uri })`
- `chat/inputCompleted` for the exact fixture's session-local `allow` answer
- `chat/turnCancelled` for the exact peer chat and turn, with the issuing
  client's sequence number and locally measured duration

The AHP elicitation projection exposes the input purpose, message, questions
and owning chat, but **not** the original SDK `elicitationSource`/session ID.
The test does not fabricate those missing fields. It accepts only the
elicitation-purpose, single `choice` question with an offered `allow`, the
exact fixture application message, the expected peer-chat channel and one
in-flight fixture-bound `get_window_state`. Unexpected questions and tool
permissions are declined. The direct-MCP/SDK source-attribution tests remain
separate.

Both cases authorize only the disposable target and decode at least 12 real
frames obtained **through AHP**, with the same nonce, bounds, timestamps,
phase/span and cadence assertions as the native suite. Reading the guard
chat's native video channel must remain idle with no frames, decoder
configuration, target identity or stream identity, demonstrating that a sibling
chat cannot inherit the target's authorization or metadata.

The cancellation variants are deliberately distinct:

1. **`authenticated-ahp-video-and-exact-chat-stop`** calls the real app-only
   `stop_computer_use` through AHP, verifies native media is stopped, then
   dispatches ordinary host cancellation for the originating peer chat.
2. **`authenticated-ahp-host-cancellation-revokes-video`** cancels the peer
   through ordinary AHP **without calling native Stop first**. It requires
   the real host/SDK lifecycle to clear native frames, decoder configuration
   and target/stream identity within five seconds. Polling keeps the viewer
   lease alive during this check, so a hidden-viewer timeout cannot substitute
   for cancellation.

Both verify the cancellation acknowledgement's exact chat, turn, client ID,
client sequence and absence of rejection. The guard must produce **three more
SDK heartbeat markers after that acknowledgement**, remain active in its AHP
snapshot and receive no cancellation. The target snapshot must record its
specific turn as cancelled. This catches wrong-chat cancellation rather than
accepting a stale `activeTurn` flag as proof.

Native Stop and host cancellation are not conflated: the current SDK `abort`
handler does not itself emit an AHP `chat/turnCancelled`. The caller must use
the normal host action as a separate operation. Also, the current Copilot AHP
adapter returns an empty `resources/list`; these tests use the known native
video URI and the real `resources/read` path, not an invented inventory API.
These are transport/SDK/native tests, **not** an end-to-end test of the Sessions
widget, its shared parser or its actual button binding.

After backend-ready authorization, select only the routing cases:

```powershell
$env:VSCODE_COMPUTER_USE_NATIVE_TEST = '1'
$env:VSCODE_COMPUTER_USE_NATIVE_VIDEO_TEST = '1'
$env:VSCODE_COMPUTER_USE_VIDEO_AHP_TEST = '1'
$env:VSCODE_COMPUTER_USE_VIDEO_GREP = 'authenticated-ahp'
$env:VSCODE_COMPUTER_USE_PLUGIN_PATH = (Resolve-Path '..\computer-use\dist\plugin\win32-x64').Path
$env:ELECTRON_RUN_AS_NODE = '1'
$env:VSCODE_DEV = '1'
try {
    & '.\.build\electron\Code - OSS.exe' .\test\unit\node\index.js --run src\vs\platform\agentHost\test\node\providerIntegration\copilotComputerUseVideo.integrationTest.ts | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Authenticated AHP video regression tests failed' }
} finally {
    Remove-Item Env:VSCODE_COMPUTER_USE_NATIVE_TEST
    Remove-Item Env:VSCODE_COMPUTER_USE_NATIVE_VIDEO_TEST
    Remove-Item Env:VSCODE_COMPUTER_USE_VIDEO_AHP_TEST
    Remove-Item Env:VSCODE_COMPUTER_USE_VIDEO_GREP
    Remove-Item Env:ELECTRON_RUN_AS_NODE
    Remove-Item Env:VSCODE_DEV
}
```

Use the existing Edge flag and regex filter to choose either browser. The
source bundle resolves to the same Windows override documented above.

Provider startup has a 60-second deadline, followed by the existing bounded
scenario and cleanup budgets. The local streams have finite 500 ms chunks;
cleanup truncates their registered arrays so outstanding fake responses finish
within a chunk instead of leaving a long delay timer behind. Mock-server close
is idempotent and explicitly awaited, including the host's automatic exit
cleanup. The owned session, authenticated client, host/SDK/native process tree,
browser and temporary workspace are closed on success and failure.

AHP transcript snapshots are cleared after requests rather than serialized,
and native results/listings are not logged. Optional evidence records the
`authenticated-agent-host` boundary, decoded-frame measurements, fake model
POST count, exact cancelled chat/turn and whether the sibling continued. It
does not save connection tokens, request bodies, native text, app listings or
encoded media.

### Stop during in-flight native typing

The separate `Copilot Computer Use Windows Stop During Input` suite adds
`stop-interrupts-native-typing` for each selected browser. In addition to the
two native/video gates, it requires
**`VSCODE_COMPUTER_USE_NATIVE_TYPING_STOP_TEST=1`**. Existing video commands do
not implicitly opt in to native text input. Keep it disabled until the desktop
slot is explicitly delegated.

This is a real **native MCP boundary** interruption test, alongside (not a
substitute for) the separate SDK/AHP routing cases. It uses the existing fresh
browser process/profile and exact UUID target/guard binding. Only this scenario
adds an empty, labelled text input to its own target page. Native
`get_window_state` supplies its exact AX role/automation ID, and a native click
must focus it; the observer never seeds text or synthesizes input events.
The AX lookup helper is shared with the original input suite without changing
its existing scenarios.

The test:

1. Starts and decodes a real target video stream, then submits one native
   `type_text` containing **4096 generated ASCII characters**, with no control
   keys, file paths or user content.
2. Waits for **at least 32 characters**, a matching incomplete prefix and
   actual DOM input events, while requiring that the native RPC is still
   pending. An immediate refusal, bulk completion or missing input fails; the
   input is never retried.
3. Requires a native video resource read to finish within **1.5 seconds** while
   typing remains in flight, exercising the independent viewer pipe.
4. Sends empty-argument `stop_computer_use` concurrently with the pending
   native input. Its acknowledgement must arrive within **five seconds**.
   The acknowledgement timestamp is captured before waiting for the separate
   `user.abort` notification.
5. Requires the first post-acknowledgement value to remain a partial prefix,
   then checks unchanged text length/prefix, input-event count and selection
   for a **two-second quiet window**. The window is not restarted on changes.
   Input-event timestamps on the Windows millisecond clock also catch writes
   between acknowledgement and the first DOM sample.
6. Checks guard value, selection and input-event counts during typing. Only
   fixture-bound native foreground fallback may be consented; actual guard
   focus must be restored at acknowledgement and stay restored. The native
   input must settle, video must remain stopped, and exactly one native
   `user.abort` must be received.

An explicit stopped/cancelled native refusal is expected for interrupted
input; unrelated native errors or lost RPC responses still fail the case.
An unverified-dispatch result is not treated as success by itself: the
independent DOM observations must prove interruption and quiescence.
Cleanup attempts Stop if an input was started but the scenario failed before
sending it, removes the owned observer/control, then uses the normal
PID-scoped native/browser cleanup.

Optional evidence contains only lengths, event counts, timing, result flags
and consent counts under `typingInterruption`; it never includes the generated
text, native snapshot text or media. The restored video batch redaction schema
and encoded-video assertions are unchanged.

After desktop-slot authorization, use the existing Node runner with:

```powershell
$env:VSCODE_COMPUTER_USE_NATIVE_TEST = '1'
$env:VSCODE_COMPUTER_USE_NATIVE_VIDEO_TEST = '1'
$env:VSCODE_COMPUTER_USE_NATIVE_TYPING_STOP_TEST = '1'
$env:VSCODE_COMPUTER_USE_VIDEO_GREP = 'stop-interrupts-native-typing'
$env:VSCODE_COMPUTER_USE_PLUGIN_PATH = (Resolve-Path '..\computer-use\dist\plugin\win32-x64').Path
$env:ELECTRON_RUN_AS_NODE = '1'
$env:VSCODE_DEV = '1'
try {
    & '.\.build\electron\Code - OSS.exe' .\test\unit\node\index.js --run src\vs\platform\agentHost\test\node\providerIntegration\copilotComputerUseVideo.integrationTest.ts | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Native typing Stop regression failed' }
} finally {
    Remove-Item Env:VSCODE_COMPUTER_USE_NATIVE_TEST
    Remove-Item Env:VSCODE_COMPUTER_USE_NATIVE_VIDEO_TEST
    Remove-Item Env:VSCODE_COMPUTER_USE_NATIVE_TYPING_STOP_TEST
    Remove-Item Env:VSCODE_COMPUTER_USE_VIDEO_GREP
    Remove-Item Env:ELECTRON_RUN_AS_NODE
    Remove-Item Env:VSCODE_DEV
}
```

`VSCODE_COMPUTER_USE_NATIVE_EDGE_TEST=1` and the existing regex select Edge.
The pure
[`copilotComputerUseTypingTestUtils.test.ts`](./copilotComputerUseTypingTestUtils.test.ts)
tests exercise opt-in, partial-input, acknowledgement and quiet-window
assertions without launching a browser or native process.

### Non-GUI authenticated idle AHP regressions

[`copilotComputerUseVideoAhpIdle.integrationTest.ts`](./copilotComputerUseVideoAhpIdle.integrationTest.ts)
persists the two previously passing headless checks as focused regression tests:

- `authenticated-idle-resource-and-exact-chat-cancellation`
- `authenticated-idle-app-stop-and-exact-chat-cancellation`

Both reuse `AgentHostVideoPeer`, the real authenticated Agent Host/Copilot SDK,
the native MCP resource, and the existing local fake model service. They do not
create browser windows, discover applications, authorize a desktop target,
capture/decode video, or type text. They require zero application grants and
zero authorizations while checking idle resource routing, native idle Stop
(second case), exact-chat cancellation acknowledgement/state and continued
sibling SDK output. They are not replacements for the pending encoded-video
or in-flight typing cases.

These two cases run once, not once per browser. Their separate, Windows-only
opt-in is `VSCODE_COMPUTER_USE_VIDEO_AHP_IDLE_TEST=1`; it does not enable any GUI
suite. `VSCODE_COMPUTER_USE_VIDEO_AHP_IDLE_GREP` optionally selects a test by its
name. The ordinary Node runner does not forward Mocha `--grep`.

After the selected plugin has been staged and the test/helper outputs refreshed,
run both cases from the repository root:

```powershell
$env:VSCODE_COMPUTER_USE_VIDEO_AHP_IDLE_TEST = '1'
$env:VSCODE_COMPUTER_USE_NATIVE_TEST = '0'
$env:VSCODE_COMPUTER_USE_NATIVE_VIDEO_TEST = '0'
$env:VSCODE_COMPUTER_USE_NATIVE_TYPING_STOP_TEST = '0'
$env:VSCODE_COMPUTER_USE_VIDEO_AHP_TEST = '0'
$env:VSCODE_COMPUTER_USE_PLUGIN_PATH = 'C:\path\to\computer-use\dist\plugin\win32-x64'
$env:ELECTRON_RUN_AS_NODE = '1'
$env:VSCODE_DEV = '1'
try {
    & '.\.build\electron\Code - OSS.exe' .\test\unit\node\index.js --run src\vs\platform\agentHost\test\node\providerIntegration\copilotComputerUseVideoAhpIdle.integrationTest.ts | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'Idle authenticated AHP regressions failed' }
} finally {
    Remove-Item Env:VSCODE_COMPUTER_USE_VIDEO_AHP_IDLE_TEST
    Remove-Item Env:ELECTRON_RUN_AS_NODE
    Remove-Item Env:VSCODE_DEV
}
```

To run one case, additionally set either exact filter before the command:

```powershell
$env:VSCODE_COMPUTER_USE_VIDEO_AHP_IDLE_GREP = '^authenticated-idle-resource-and-exact-chat-cancellation$'
# Or:
$env:VSCODE_COMPUTER_USE_VIDEO_AHP_IDLE_GREP = '^authenticated-idle-app-stop-and-exact-chat-cancellation$'
```

Leave the filter unset to run both. The native bundle is still executed for
MCP routing, so do not run these cases while another process is replacing that
bundle. A connected desktop is not needed.

### Local validation status (Windows x64, 2026-09-14)

The parent reported all ten Chromium video cases, all ten Edge video cases and
all sixteen existing Windows input cases passing before the follow-up desktop
handoff.

The follow-up run could not reach the new input or encoded-AHP assertions:
both Chromium typing attempts failed in native discovery, before application
consent or input, with zero application rows. A read-only Windows check showed
session 2 in `WTSDisconnected` state (4), with `OpenInputDesktop` denied
(`ERROR_ACCESS_DENIED`, 5). The same state persisted after the headless checks.
No desktop switching, unlocking or recovery workaround was attempted. Browser
DOM focus alone is not proof that the Windows input desktop is accessible.

Two separate **headless diagnostics using the real authenticated host and SDK**
passed against the local fake model and are now persisted in the non-GUI idle
regression suite above:

- Idle native MCP resource routing and ordinary exact-chat cancellation.
- Native app Stop on the idle resource, followed by exact-chat cancellation.

Both verified missing/wrong-token rejection, used four captured local model
POSTs, granted no application access, and observed continued sibling SDK
heartbeat output after cancellation. These checks did **not** authorize a
window, capture/encode/decode video, or type text, and therefore do not count as
the new live video/interruption cases passing.

Full authenticated-AHP encoded-video/cancellation and in-flight typing Stop
validation remains pending a connected, unlocked desktop. All owned process
trees and temporary host/browser/workspace directories were cleaned up.
Discovery evidence is metadata-only: row count and at most four fixture-UUID
title candidates, each capped at 256 characters; unrelated listings are omitted.

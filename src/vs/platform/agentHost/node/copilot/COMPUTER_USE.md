# macOS Computer Use

Local Copilot SDK sessions discover the native Computer Use plugin bundled with
the platform-specific Copilot runtime. No user MCP configuration or separate
agent loop is required. The tools become available through the existing chat
tool pipeline, with native macOS and per-application consent on first use.

The SDK's `builtinPluginDirectories` contract registers the bundle before creating
sessions. The runtime owns the MCP transport, turn notifications, user-abort
handling, and managed permission enforcement. Agent Host uses its existing
elicitation UI, image results, and scoped customization enablement.

The macOS desktop Agent Host registers this plugin automatically. Standalone
macOS hosts require an explicit host-side opt-in; connecting a viewer never
enables desktop control. Ephemeral utility sessions keep Computer Use disabled.

## Working on the native helper

The native source lives in a separately licensed repository that is not part
of this source tree.
Build its macOS plugin using the instructions in that repository. The output
must contain the MCP executable, plugin manifests, and one complete native helper
application.

For an unbuilt VS Code checkout, point the local Agent Host at the build output:

```sh
VSCODE_COMPUTER_USE_PLUGIN_PATH=/absolute/path/to/computer-use/dist/plugin/darwin-arm64 ./scripts/code.sh
```

Use `darwin-x64` on Intel Macs. The override is ignored in packaged builds.
Invalid explicit overrides fail rather than silently running a different helper.
Restart the development window after changing the override or rebuilding.

For trusted local development, set
`COPILOT_COMPUTER_USE_AUTO_APPROVE=1` on the process that starts VS Code to
auto-accept only the Computer Use MCP's per-app and one-action foreground
prompts. This is false by default and is not a VS Code setting or enterprise
policy. It does not bypass helper-host consent, OS permissions, blocked targets,
managed policy, target/session validation, secure desktops, cancellation,
physical-input interruption, or uncertain-delivery retry rules.

macOS Accessibility and Screen Recording permissions belong to the helper app's
signed identity. Keep its development signing identity stable across rebuilds.
Neither building the helper nor registering its MCP tools grants those
permissions. Follow the native permission prompts when using a tool; do not
modify the TCC database or bypass a denied grant.

Use chat cancellation or the helper's Escape stop control to interrupt computer
use. Existing customization controls can disable the built-in server globally,
for a workspace, or for the current session.

## Exact-window input and foreground consent

The updated native helper validates keyboard recipients against the selected
window and control, rather than assuming that process-directed input reaches
the requested window. Actions remain background-first. If no safe background
candidate dispatched, the native server can ask through the existing elicitation
UI to bring that exact window forward for **one action**, then restore the prior
window. This approval is not cached on macOS and does not override app consent,
OS permissions, target validation, cancellation, or managed policy.
Foreground prompts require an active **Interactive** turn. Autopilot declines
elicitation prompts rather than granting foreground access automatically.

Declining the prompt does not authorize a foreground retry. Rejected, blocked,
interrupted, and uncertain-delivery outcomes are not retried automatically.
`DispatchedUnverified` means an action may already have changed the UI; inspect
the current state rather than blindly repeating it. Coordinate clicks remain
background-only.

These changes require the updated native bundle; registering an older released
helper does not add the new behavior.

## Live viewing and remote hosts

The Agents Window's **View Computer Use** action opens a player bound to the
selected host, session, and chat. Selecting another session never redirects an
existing player. The player is read-only: it shows only the application's window
that the native server has already authorized for that agent. Automatic opening
recognizes both the MCP contributor identity and validated `computer-use` server
metadata so provider variants do not lose the live viewer.

An updated native helper supplies H.264 video through the authenticated MCP
side channel, independently of model requests and chat history. Live viewing is
on-demand and has no audio. Pausing, hiding, or closing a viewer stops that
viewer's requests; a host-side turn recorder can continue requesting the same
bounded stream while a Computer Use operation is active.
**Stop Agent** is separate from playback: it stops that chat's native control
and requests normal chat cancellation. Failure to reach the host must not be
shown as a successful stop.
When a stream normally completes, the viewer drains its bounded decoder queue
and keeps the last received frame instead of replacing it with an idle
placeholder. The footer labels it as not live. A recoverable macOS target
transition also keeps that bitmap while the helper waits for the agent to
authorize another exact window; a changed target clears it before new footage
paints. A same-target stream or decoder-configuration change likewise keeps the
last bitmap until a replacement frame paints, with Buffering shown in the
top-left status. Only the local bitmap is retained; it is separate from any
host-side recording, and permission or terminal connection errors clear it.

**Follow Action** is a default-off, viewer-only 2x zoom that follows the agent's
reported action cursor or focused control. It does not move the host mouse or
change the application's zoom or focus. Panning honors reduced motion and freezes
when viewing is paused; turning the toggle off immediately restores the full
window. Hosts without per-frame tracking metadata keep showing the full window.
The updated native helper attaches optional normalized `focus: { x, y }` points
to video frames so tracking stays aligned with decoded footage.

The player has no permanent Agent Activity section. A transient thought bubble
appears only when the exact chat emits provider-shared `chat/reasoning` or a
specific user-visible activity summary. Partial reasoning is coalesced before
display, complete sentences can appear immediately, and the bubble fades after
inactivity; silence produces no placeholder. Hidden provider reasoning is never
used. The Accessible View reports the current visible bubble text. Selecting
another session does not redirect that state.
Selecting the Computer Use tab in the single-pane layout hides the docked
Changes/Files content; leaving the viewer restores the prior detail-panel
visibility rather than overwriting it.
Selecting Computer Use also collapses the sessions sidebar and reduces the chat
area to the layout's minimum width, using the existing layout controls. That
compact sidebar/chat composition remains when switching away. Manual resizing
or reopening the sidebar is respected until Computer Use is selected again.

Fullscreen retains the host identity and Stop Agent control. On macOS desktop,
content fullscreen expands in place without creating another Space or moving
away from the controlled application. Normal window fullscreen commands still
respect the user's native-fullscreen preference. The player's
Escape handling only exits fullscreen; when viewing on the computer that runs
the native agent, physical Escape also remains the helper's emergency stop.
Use the Exit Full Screen control to leave without invoking that host shortcut.

To opt in on a standalone macOS Agent Host, set
`VSCODE_AGENT_HOST_COMPUTER_USE=1` in that host's startup environment. For a
source build, also set `VSCODE_COMPUTER_USE_PLUGIN_PATH` on that host. The host
must have an interactive macOS desktop and its own explicit native app and OS
permissions. Each remote host owns its own helper, grants, and capture; no
viewer grants access to the viewer's local desktop.

The media resource `computer-use://video/live` returns versioned, bounded
batches of H.264 AVCC packets with microsecond timestamps, stream identity,
target identity, and decoder configuration. Viewers recover from target changes
or dropped packets at a keyframe rather than displaying stale deltas. Media
payloads are redacted from AHP transport logs. While live, reads start on a
50 ms cadence measured from the prior request start rather than its completion,
so transport latency is not added to every poll. The viewer uses a 200 ms
bounded playout delay to absorb ordinary remote jitter; a sufficiently long
network outage can still freeze the last frame until the next batch arrives.
After at least one frame has rendered, the viewer retries up to two consecutive
host read errors with a fresh cursor. A same-window reconnect keeps the last
frame visible until replacement footage paints; a changed app/window clears it
immediately. Further consecutive errors are terminal and remain visible to the
user.

## Recordings

The Agent Host starts one recorder for the exact chat and turn when its first
Computer Use tool call becomes ready. Recording does not require an open viewer.
It polls the existing media resource, stores the encoded AVCC access units
without screenshots or re-encoding, and finalizes after the logical turn ends.
Resumable provider errors do not split the recording.

Each recording retains the newest 30 minutes up to 500 MiB. Retention removes
whole keyframe-started segments so the remaining tail stays decodable. Exact
consecutive duplicate delta access units are coalesced by extending their
duration; keyframes and changed action-focus metadata are preserved. There is
no audio.

Version 1 manifests may also contain bounded, timestamped thought events for
provider-shared reasoning and user-visible chat activity. They are persisted
only while the existing recorder is active, capped at 4,096 events and 512
Unicode characters per event, trimmed with retained footage, and replayed at
their original timeline positions. Old manifests without thought events remain
valid. User messages, tool inputs/results, final assistant content, credentials,
paths, and hidden reasoning are never recorded as thought events.

Version 1 manifests may also contain up to 4,096 timestamped, categorized
successful GUI actions: click, text entry/edit, key press, scroll, drag,
secondary action, and application launch. The recorder derives categories from
the exact Computer Use tool identity and persists an event only after that tool
completes successfully. It never records tool arguments, typed text,
coordinates, observation calls, or failed/denied actions. Old manifests without
action events remain valid.

Recordings live under the owning session-data directory in a hashed chat
subdirectory. A completed host-owned local turn adds a video-preview card to
that chat after it becomes idle. The card title reuses the completed turn's
existing response summary rather than issuing another model request. It lazily
decodes one keyframe for its poster and contains only bounded metadata plus a
manifest content reference. Opening it fetches segment bytes one at a time
through the existing Agent Host resource transport. Recorded playback includes
an accessible timeline slider in the in-video control overlay. Its filled
segment marks elapsed footage. The overlay fades when pointer and keyboard
intent are absent, while hovering or focusing the timeline reveals it and lazily
decodes a frame preview from the nearest preceding keyframe. Dimmed timeline
ranges are derived from the existing duplicate-frame coalescing metadata and
identify periods where the captured image did not change. Colored action markers
identify recorded GUI activity; hovering or focusing one labels the action and
previews its frame, while activating it seeks to that timestamp. Dense action
bursts compact to a bounded marker set. The
client attaches the persisted recording notice to its source response so the
card appears before that response's existing footer instead of creating a
second footer. Restored cards remain clickable while their backing session data
exists.

### Bounded reads for mobile replay

Mobile clients can read recording manifests and selected segment bytes through
the `vscode/resourceReadRange` extension instead of requesting a complete file.
Hosts implementing it advertise this initialization metadata:

```json
{ "_meta": { "vscode.resourceReadRange": { "version": 1, "maxBytes": 1048576 } } }
```

The request contains `channel: "ahp-root://"`, a local `file://` `uri`, `offset`,
and `length`. `length` is at most 1 MiB; zero requests only version/size metadata
while still checking read access. Optional `expectedSize` and `expectedEtag`
pin subsequent reads to the same version. The response contains base64 `data`,
`encoding: "base64"`, `offset`, total `size`, `etag`, and `eof`.

Eligible files are regular local files of at most 16 MiB. The host uses bounded
descriptor reads from its registered file provider, checks size/etag before and
after reading, and reports changed or truncated resources as conflicts. The
etag reflects provider size/mtime, not a content hash; finalized recording files
must remain immutable. URI
schemes other than local files, remote authorities, queries, fragments, and
oversized/invalid ranges are rejected. The existing authenticated resource-read
boundary is unchanged. Transport logs redact file references, version tokens,
and binary range payloads.

This is a read-only data-plane extension. Editor-hosted listeners explicitly
enable it while keeping legacy management extensions such as shutdown disabled.
Standard AHP `resourceRead`, protocol negotiation, native capture, and the
recording file format are unchanged.

Mobile replay requires the advertised capability and never falls back to a
whole-file read or raises the mobile transport's existing message ceiling.

Deploy the rebuilt Agent Host from this checkout to the machine owning the
recordings, then restart that host when its active work can safely be interrupted
and reconnect the mobile client. An already running host does not acquire the
new method when JavaScript output is rebuilt. No native Computer Use helper
rebuild or additional permissions are required for this read API.

Removing a chat deletes only that chat's recording subtree. Archiving or
removing a session stops active recorders and deletes the session recording
tree; normal session-data deletion waits for recorder finalization before
removing the complete directory. Opening a card after its bytes were deleted
reports that explicitly instead of presenting an empty successful playback.

The player uses an adaptive media HUD rather than permanent control chrome.
While live, controls fade after 2.5 seconds without interaction and return on
pointer movement or keyboard focus. Clicking visible footage toggles viewing
between play and pause without stopping the agent; clicking the retained final
frame of a recording restarts playback. A compact status indicator
distinguishes connecting, buffering, reconnecting, live, paused, ended,
stopped, permission, and unavailable states. An in-flight read that exceeds
250 ms enters buffering without clearing the last frame; a successful live
response restores the live edge even when the authorized window is visually
static.

An agent action that closes or replaces its exact macOS window is reported as
dispatched but unverified and invalidates that window's retained perception.
The agent must list applications and perceive the replacement window before
acting again. The helper never guesses another window in the same application.

Annotate Frame freezes the displayed bitmap locally and suspends playback
without stopping the agent. The player offers three theme-aware highlighters,
pointer and keyboard drawing, reset, and an explicit return to video. Attaching
adds a resized PNG only to the exact captured chat; it never falls back to the
most recently focused chat. The attachment carries bounded implementation
metadata for live/recording source, application and window labels, Follow
Action state, and recording position when available. The annotation is
ephemeral until the user explicitly attaches it and is not written into the
host-side recording.

Native helpers without this resource cannot provide live video and should be
upgraded.

Native live capture currently requires macOS 12.3 or newer. If host URL
restrictions are configured, browser video is unavailable: a buffered frame
could contain a tab that was briefly blocked between policy checks. Native
application windows remain eligible under their normal permission checks.

## Packaging

macOS desktop and remote-server packaging retain the complete plugin from the
pinned Copilot platform package, outside ASAR where applicable. Other operating
systems exclude it. Remote registration remains opt-in. The native bundle
retains its upstream code signatures and entitlements;
VS Code must not re-sign the helper under a different identity.

The native source is not vendored into VS Code. Changes to binary distribution
or licensing require coordination with the upstream owners.

## Validation

The focused tests cover native bundle resolution, local-host restrictions,
development overrides, packaging/signature boundaries, automatic tool
availability, scoped disablement, host/chat routing, bounded video validation,
media-log redaction, rolling retention, duplicate-frame coalescing, durable
recording notices, lazy playback, and lifecycle cleanup. Provider-process
validation must isolate its Copilot home and avoid desktop capture or input
without user consent.

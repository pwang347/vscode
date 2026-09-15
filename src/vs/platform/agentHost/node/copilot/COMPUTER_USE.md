# Native Computer Use

Local Copilot SDK sessions discover the native Computer Use plugin bundled with
the platform-specific Copilot runtime. No user MCP configuration or separate
agent loop is required. The tools become available through the existing chat
tool pipeline, with platform permission checks and per-application consent.

The SDK's `builtinPluginDirectories` contract registers the bundle before creating
sessions. The runtime owns the MCP transport, turn notifications, user-abort
handling, and managed permission enforcement. Agent Host uses its existing
elicitation UI, image results, and scoped customization enablement.

The macOS and Windows desktop Agent Hosts register this plugin automatically.
Standalone hosts require an explicit host-side opt-in; connecting a viewer never
enables desktop control. Ephemeral utility sessions keep Computer Use disabled.

| Host | Native tools | Live window video |
|------|--------------|-------------------|
| macOS | Bundled helper, subject to native permissions | Updated helper on macOS 12.3 or newer |
| Windows | Bundled helper in an interactive desktop session; action support depends on the target application | Updated helper with Windows Graphics Capture and Media Foundation |
| Linux | Not registered | Not available |

## Working on the native helper

The native source lives in a separately licensed repository that is not part
of this source tree.
Build the plugin for the host platform using that repository's development
instructions. The output must contain `.plugin/plugin.json`, `.mcp.json`, and:

- macOS: `computer-use-mcp` and exactly one complete native helper `.app`.
- Windows: `computer-use-mcp.exe` and `CopilotComputerUse.exe`.

For an unbuilt VS Code checkout, point the local Agent Host at the build output:

### macOS

```sh
VSCODE_COMPUTER_USE_PLUGIN_PATH=/absolute/path/to/computer-use/dist/plugin/darwin-arm64 ./scripts/code.sh
```

Use `darwin-x64` on Intel Macs.

### Windows

```powershell
$env:VSCODE_COMPUTER_USE_PLUGIN_PATH = 'C:\path\to\computer-use\dist\plugin\win32-x64'
.\scripts\code.bat
```

Use the matching `win32-arm64` bundle on ARM64. Keep both executables and the
manifests together; pointing the override at an individual executable is not
supported. Paths containing spaces are supported.

### Permissions and lifecycle

The override is ignored in packaged builds.
Invalid explicit overrides fail rather than silently running a different helper.
Restart the development window after changing the override or rebuilding.

macOS Accessibility and Screen Recording permissions belong to the helper app's
signed identity. Keep its development signing identity stable across rebuilds.
Neither building the helper nor registering its MCP tools grants those
permissions. Follow the native permission prompts when using a tool; do not
modify the TCC database or bypass a denied grant.

Windows requires a logged-in, unlocked, interactive desktop in the helper's
Windows session. Running a host as a Windows service, in session 0, or in WSL
does not grant access to that desktop. Secure desktops, UAC, restricted windows,
and locked or disconnected sessions remain subject to the native safety checks.
Connecting a remote agent client does not unlock or reconnect a Windows desktop.
The native repository's `cargo task rdp --help` documents optional user-scoped
parking/recovery for RDP disconnects. It requires an explicit host-side decision
and elevation where indicated; do not install it or disconnect RDP automatically
as part of a viewer connection.

Use chat cancellation or the helper's Escape stop control to interrupt computer
use. Existing customization controls can disable the built-in server globally,
for a workspace, or for the current session.

## Exact-window input and foreground consent

The updated macOS native helper validates keyboard recipients against the selected
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

Windows uses its own UI Automation and window-scoped input implementation.
Validate the target application's actual state after an action: tool discovery,
a successful click, or a returned screenshot does not establish that text,
keyboard shortcuts, or scrolling work in the same application. Do not turn an
unverified action into an automatic foreground retry.

## Live viewing and remote hosts

The Agents Window's **View Computer Use** action opens a player bound to the
selected host, session, and chat. Selecting another session never redirects an
existing player. The player is read-only: it shows only the application's window
that the native server has already authorized for that agent.

An updated native helper supplies H.264 video through the authenticated MCP
side channel, independently of model requests and chat history. Viewing is
on-demand, without audio or recording. Pausing, hiding, or closing a viewer
stops requests; the native capture expires when no viewer is requesting frames.
**Stop Agent** is separate from playback: it stops that chat's native control
and requests normal chat cancellation. Failure to reach the host must not be
shown as a successful stop.

Fullscreen retains the host identity and Stop Agent control. On macOS desktop,
content fullscreen expands in place without creating another Space or moving
away from the controlled application. Normal window fullscreen commands still
respect the user's native-fullscreen preference. The player's
Escape handling only exits fullscreen; when viewing on the computer that runs
the native agent, physical Escape also remains the helper's emergency stop.
Use the Exit Full Screen control to leave without invoking that host shortcut.

To opt in on a standalone macOS or Windows Agent Host, set
`VSCODE_AGENT_HOST_COMPUTER_USE=1` in that host's startup environment. For a
source build, also set `VSCODE_COMPUTER_USE_PLUGIN_PATH` on that host. The host
must have an interactive desktop and its own explicit native app and OS
permissions. Each remote host owns its own helper, grants, and capture; no
viewer grants access to the viewer's local desktop.

For a Windows source host, an authenticated loopback listener can be started with:

```powershell
$env:VSCODE_DEV = '1'
$env:VSCODE_AGENT_HOST_COMPUTER_USE = '1'
$env:VSCODE_COMPUTER_USE_PLUGIN_PATH = 'C:\path\to\computer-use\dist\plugin\win32-x64'
node .\scripts\code-agent-host.js --host 127.0.0.1 --port 8081 --connection-token-file 'C:\private\agent-host-token'
```

Use the Node version required by `remote/.npmrc`, and start the host from the
unlocked Windows desktop, not from a service or a new SSH session. Build the
VS Code sources and the native bundle before starting it.

The token file must contain a cryptographically random private token using the
standalone host's accepted characters (`0-9`, `a-z`, `A-Z`, `_`, `-`). Keep it
outside the checkout and restrict access to the host user.
Connect through an authenticated VS Code tunnel or an SSH forward rather than
opening an unencrypted WebSocket listener to the network. Host-side Computer Use
opt-in and transport authentication are independent requirements.

The media resource `computer-use://video/live` returns versioned, bounded
batches of H.264 AVCC packets with microsecond timestamps, stream identity,
target identity, and decoder configuration. Viewers recover from target changes
or dropped packets at a keyframe rather than displaying stale deltas. Media
payloads are redacted from AHP transport logs. Native helpers without this
resource cannot provide live video and should be upgraded.

Native live capture requires macOS 12.3 or newer, or Windows 10 version 2004 or
newer with Windows Graphics Capture and Media Foundation available. If host URL
restrictions are configured, browser video is unavailable: a buffered frame
could contain a tab that was briefly blocked between policy checks. Native
application windows remain eligible under their normal permission checks.

### Windows-to-Mac streaming

The updated Windows native bundle supplies the same video contract as macOS.
A persistent Windows Graphics Capture session captures only the authorized
window. Media Foundation encodes H.264 on a dedicated worker, including on
virtualized hosts without a hardware encoder. The existing MCP resource and
authenticated Agent Host connection carry AVCC batches to the player's
WebCodecs decoder; no additional public video listener is needed.

Capture remains bound to the retained window, process, control session, and
helper generation. The separate native viewer pipe verifies the MCP process and
session credentials. A viewer cannot authorize another window or restart
stopped input. Stop uses an independent connection, cancels in-flight input,
and waits for native cleanup confirmation without stopping another owner.
Resize and idle-resume create fresh streams and keyframes. Encoded backlog is
capped at 1 MiB / 60 frames; capture expires after three seconds without reads.
Output is at most 1280 by 720 with a 30 FPS ceiling, not a guaranteed frame rate.

To try the Windows host from a Mac:

1. Start the source host above in its interactive Windows desktop.
2. Use an authenticated VS Code tunnel or an already configured SSH connection
   to forward the loopback port. For example, run
   `ssh -N -L 8081:127.0.0.1:8081 windows-user@windows-host` on the Mac.
   Forward to the existing desktop host; do not launch a second host over SSH.
3. In a matching Mac development client, enable `chat.remoteAgentHostsEnabled`
   and use **Sessions: Add Remote Agent Host...** with
   `ws://127.0.0.1:8081?tkn=<private-host-token>`. Treat this URL as a credential;
   do not put it in logs, screenshots, source control, or shared settings.
4. Select the Windows host, start a Copilot session, and explicitly consent to
   the intended Windows application. After a successful perception/action,
   open **View Computer Use** for that chat. The Mac's local desktop is not used.
5. Check live updates, resize, pause/resume, reconnect, fullscreen, and
   **Stop Agent**. Confirm Stop affects that chat only and that no further
   native input is delivered after the host acknowledges it.

The source override is required until the updated native helper is included in
the pinned runtime package. Older bundles must report unavailability rather than
substituting screenshot polling. Local Windows codec and authenticated-AHP
regressions do not by themselves certify Mac-device playback or WAN latency;
qualify those using a real Mac over the intended remote transport.

### Native Dev Tunnels with a source host

Running an installed `code-tunnel-insiders.exe tunnel` from a source checkout
does not run that checkout. The CLI downloads its own server; `--cli-data-dir`
changes its state/cache location, not the server implementation. A connected
tunnel therefore does not prove that source-only native tools are registered.

For the native **Connect to Remote Agent Host via Dev Tunnel** flow, build the
Rust CLI with `VSCODE_CLI_OVERRIDE_SERVER_PATH` set to the checkout's source
server launcher (`scripts\code-server.bat` on Windows). This is a **compile-time**
override, not a runtime switch for the installed CLI. The source launcher
restores development mode after the CLI sanitizes its child's environment,
allowing the native plugin override to take effect.

With the checkout and native bundle built, run that source CLI with:

```powershell
$env:VSCODE_SKIP_PRELAUNCH = '1'
$env:VSCODE_AGENT_HOST_COMPUTER_USE = '1'
$env:VSCODE_COMPUTER_USE_PLUGIN_PATH = 'C:\path\to\computer-use\dist\plugin\win32-x64'
$env:VSCODE_CLI_USE_FILE_KEYCHAIN = '1'
$state = 'C:\private\source-agent-host'
.\cli\target\debug\code.exe agent host --new-instance --foreground --host 127.0.0.1 --tunnel --name windows-source --cli-data-dir "$state\cli" --user-data-dir "$state\registry" --server-data-dir "$state\server"
```

The state directory must be private to the host user. Separate file-backed CLI
credentials keep an unbranded development CLI from replacing the installed
CLI's encrypted keychain entry. Complete the source CLI's own sign-in, and keep
the foreground process running. Use a distinct tunnel name and registry so the
client cannot select an older packaged instance by mistake; existing tunnels
and sessions need not be replaced.

On the Mac, connect to this new name through **Sessions: Connect to Remote Agent
Host via Dev Tunnel**. No manual port forward or pasted Agent Host token is
needed for this route. Start a new chat: SDK session initialization is deferred
until the first send, so an untouched draft can have no published MCP servers.
Verify the `computer-use` MCP server and native tools, not an assistant's
self-description or the unrelated integrated-browser tools.

## Packaging

macOS and Windows desktop and remote-server packaging retain the complete plugin
from the pinned Copilot platform package, outside ASAR where applicable. Other
operating systems exclude it. Remote registration remains opt-in. The macOS
native bundle retains its upstream code signatures and entitlements;
VS Code must not re-sign the helper under a different identity.

The native source is not vendored into VS Code. Changes to binary distribution
or licensing require coordination with the upstream owners.

## Validation

The focused tests cover native bundle resolution, local-host restrictions,
development overrides, packaging/signature boundaries, automatic tool
availability, scoped disablement, host/chat routing, bounded video validation,
and media-log redaction. Provider-process validation must isolate
its Copilot home and avoid desktop capture or input without user consent.

On Windows, run the real SDK registration test with:

```powershell
.\scripts\test-integration.bat --run src\vs\platform\agentHost\test\node\providerIntegration\copilotComputerUse.integrationTest.ts
```

This checks registration, tool availability, and scoped disablement without
capturing the desktop, sending input, or making model requests. It does not
establish native action or live-video parity. Keep `node_modules` aligned with
the lockfile before validating; an older installed runtime can contain a
different native helper. Interactive scenarios must use isolated test windows
and verify actual application state independently of native tool acknowledgements.

The opt-in [native Windows input and video suites](../../test/node/providerIntegration/README.md)
exercise real Chromium and Edge windows. Video cases cover actual H.264 decoding,
target-only pixels, resize, inactivity, turn/session revocation, and Stop. The
authenticated-AHP opt-in additionally exercises the real Agent Host and Copilot
runtime against deterministic local model traffic rather than a live provider.

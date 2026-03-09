# vs/mobile — Mobile App Layer

## Overview

The `vs/mobile` layer hosts the implementation of the **Mobile App**, a dedicated workbench experience optimized for mobile devices. This is a distinct top-level layer within the VS Code architecture, sitting alongside `vs/workbench` and `vs/sessions`.

The mobile app always connects to a remote VS Code server (via Tailscale networking) and provides a touch-optimized client for the full VS Code chat panel with file viewing and limited editor capabilities.

## Architecture

### Layering Rules

```
vs/base          ← Foundation utilities
vs/platform      ← Platform services
vs/editor        ← Text editor core
vs/workbench     ← Standard workbench
vs/sessions      ← Agentic window
vs/mobile        ← Mobile app (this layer)
```

**Key constraint:** `vs/mobile` may import from `vs/workbench`, `vs/sessions` (selectively), and all layers below. Neither `vs/workbench` nor `vs/sessions` may import from `vs/mobile`. This ensures the standard workbench and sessions window remain independent.

### Allowed Dependencies

| From `vs/mobile` | Can Import |
|-------------------|------------|
| `vs/base/**` | ✅ |
| `vs/platform/**` | ✅ |
| `vs/editor/**` | ✅ |
| `vs/workbench/**` | ✅ |
| `vs/mobile/**` | ✅ (internal) |

| From `vs/workbench` | Can Import |
|----------------------|------------|
| `vs/mobile/**` | ❌ **Forbidden** |

| From `vs/sessions` | Can Import |
|---------------------|------------|
| `vs/mobile/**` | ❌ **Forbidden** |

### Folder Structure

```
src/vs/mobile/
├── README.md                           ← This specification
├── LAYOUT.md                           ← Layout specification for the mobile workbench
├── mobile.common.main.ts               ← Common (browser) entry point
├── mobile.web.main.ts                  ← Web entry point (Capacitor WebView)
├── common/                             ← Shared types and context keys
│   └── contextkeys.ts                  ← Mobile context keys
├── browser/                            ← Core workbench implementation
│   ├── workbench.ts                    ← Main workbench layout (MobileWorkbench class)
│   ├── menus.ts                        ← Menu IDs for mobile menus
│   ├── navigation.ts                   ← Native shell navigation helpers
│   ├── mobile.html                     ← HTML shell for Capacitor WebView
│   ├── mobile.ts                       ← Workbench bootstrapper
│   ├── parts/                          ← Workbench part implementations
│   │   ├── parts.ts                    ← MobileParts / MobilePhase enums
│   │   ├── topBar.ts                   ← Top bar (hamburger + title)
│   │   ├── drawer.ts                   ← Side drawer (navigation, sessions)
│   │   ├── welcomePage.ts              ← Server selection page
│   │   └── workspacePicker.ts          ← Workspace selection page
│   └── media/                          ← Layout-specific styles
│       └── style.css
├── services/                           ← Service overrides
│   ├── connection/browser/
│   │   └── connectionService.ts        ← Remote server connection management
│   ├── haptics/browser/
│   │   └── hapticFeedbackService.ts    ← Haptic feedback via Capacitor
│   ├── quickinput/browser/
│   │   └── mobileQuickInputService.ts  ← Bottom-sheet quick pick
│   └── url/browser/
│       └── mobileUrlCallbackProvider.ts ← OAuth deep-link handling
├── contrib/                            ← Feature contributions
│   ├── connection/browser/             ← Server connection UI + actions
│   ├── externalOpener/browser/         ← In-app browser for external links
│   └── mobileLayout/browser/           ← Desktop chrome hiding
└── test/                               ← Unit tests
    └── browser/
```

## Key Design Decisions

- **Remote-only**: No local/on-device execution; always connects to a remote VS Code server
- **Tailscale networking**: Network-level auth via Tailscale VPN; VS Code server connection token for app-level auth
- **Stack navigation**: Single-column full-screen views with push/pop (not grid layout)
- **Chat-first**: Chat is the primary interaction surface, taking up the full screen
- **Limited editor**: Monaco in read-only mode by default; basic editing available but no IntelliSense
- **Dual usage**: Quick check-in (30s triage) AND extended remote sessions (traveling)

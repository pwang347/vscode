# Mobile Workbench Layout Specification

This document is the **authoritative specification** for the mobile workbench layout.

---

## 1. Overview

The Mobile Workbench (`MobileWorkbench` in `mobile/browser/workbench.ts`) provides a touch-optimized, single-column layout for mobile devices. Unlike the desktop workbench and sessions window:

- Uses **stack-based navigation** (push/pop), not a grid layout
- Has a **bottom navigation bar** (native mobile pattern)
- All views are **full-screen** — no side-by-side panels
- Optimized for **safe areas** (notch, home indicator, camera cutout)
- Supports both **portrait and landscape** orientations

---

## 2. Layout Structure

### 2.1 Visual Representation

```
┌──────────────────────────────┐
│      Connection Bar          │  ← Top: connection status, back button
├──────────────────────────────┤
│                              │
│                              │
│     Active View              │  ← Full screen: Chat / Files / Terminal
│     (stack-based navigation) │
│                              │
│                              │
├──────────────────────────────┤
│  💬 Chat  |  📁 Files  |  ⚡  │  ← Bottom navigation bar
└──────────────────────────────┘
```

### 2.2 Parts

| Part | Position | Default Visibility | Notes |
|------|----------|-------------------|-------|
| Connection Bar | Top, fixed | Always visible | Minimal: connection status, back button |
| Active View | Center, fills available space | Always visible | Stack-navigated full-screen views |
| Navigation Bar | Bottom, fixed | Always visible | 3 tabs: Chat, Files, Terminal |

#### Excluded Parts (from desktop/sessions workbench)

| Part | Reason |
|------|--------|
| Titlebar | Replaced by Connection Bar |
| Sidebar | Views are full-screen, navigated via bottom nav |
| Auxiliary Bar | Not applicable to mobile |
| Activity Bar | Replaced by bottom navigation |
| Status Bar | Reduced chrome |
| Panel | Terminal is a full-screen view instead |

### 2.3 Navigation Tabs

| Tab | Icon | View | Primary Action |
|-----|------|------|----------------|
| Chat | `comment-discussion` | Full-screen chat panel | Send messages, review responses |
| Files | `files` | File tree + file viewer | Browse, view, simple edit |
| Terminal | `terminal` | Full-screen terminal | Command execution |

---

## 3. Connection Bar

The connection bar is a minimal top bar that shows:

- **Back button**: When navigated into a sub-view (e.g., file viewer from file tree)
- **Connection status**: Green dot (connected), yellow (reconnecting), red (disconnected)
- **Server name**: Tailscale machine name (e.g., "my-dev-machine")
- **Landscape**: Shows more detail; portrait minimizes to icons

### 3.1 Safe Area

The connection bar respects `env(safe-area-inset-top)` for devices with notches.

---

## 4. Navigation Bar (Bottom)

The bottom navigation bar follows native mobile patterns:

- Fixed to bottom of viewport
- Respects `env(safe-area-inset-bottom)` for home indicator
- Haptic feedback (light impact) on tab switch
- Active tab indicated by filled icon + accent color
- Badge support (e.g., unread messages count on Chat tab)

---

## 5. View Stack

Each tab maintains its own navigation stack:

- **Chat tab**: Chat view → (push) File preview from chat reference
- **Files tab**: File tree → (push) File viewer → (push) Diff view
- **Terminal tab**: Terminal view (single level)

Back navigation: swipe from left edge or back button in connection bar.

---

## 6. Responsive Behavior

### Portrait (default)
- Single column, full width
- Connection bar: compact (icons + short server name)
- Navigation bar: icons + labels

### Landscape
- Same single column but wider
- Chat input area benefits from extra width
- Connection bar: expanded (full server info)
- Terminal: more columns visible

---

## 7. Keyboard Handling

- Chat input stays above virtual keyboard via `visualViewport` API
- Navigation bar hides when keyboard is open (more screen space for input)
- File viewer: keyboard doesn't auto-open in read-only mode

---

## Revision History

| Date | Change |
|------|--------|
| 2026-03-05 | Initial specification |

# Mobile Workbench Layout Specification

This document is the **authoritative specification** for the mobile workbench layout.

---

## 1. Overview

The Mobile Workbench (`MobileWorkbench` in `mobile/browser/workbench.ts`) provides a touch-optimized, chat-first layout for mobile devices. The app follows a three-phase flow:

1. **Welcome page** — connect to a VS Code server (with saved server configs)
2. **Workspace picker** — select a workspace on the connected server (with saved workspaces)
3. **Chat view** — full-screen chat with a left drawer for navigation

Key principles:
- **Chat-first** — the primary surface is a full-screen chat window
- **Drawer navigation** — a hamburger button (top-left) opens a side drawer for Files, Terminals, chat sessions, etc.
- **No bottom nav** — all navigation lives in the drawer
- Optimized for **safe areas** (notch, home indicator, camera cutout)
- Supports both **portrait and landscape** orientations

---

## 2. App Flow

### 2.1 Welcome Page (not connected)

Shown when no `remoteAuthority` is present. Full-screen page with:

```
┌──────────────────────────────┐
│                              │
│           VS Code            │
│                              │
│   ┌────────────────────────┐ │
│   │  my-dev-machine        │ │  ← Saved servers (tap to connect)
│   └────────────────────────┘ │
│   ┌────────────────────────┐ │
│   │  office-workstation    │ │
│   └────────────────────────┘ │
│                              │
│   [ + Connect to Server ]    │  ← Opens connection form
│                              │
└──────────────────────────────┘
```

### 2.2 Workspace Picker (connected, no workspace)

Shown when connected but no `folder` or `workspace` query param. Lists folders the server exposes:

```
┌──────────────────────────────┐
│  ← Back     my-dev-machine   │
├──────────────────────────────┤
│                              │
│   Select a Workspace         │
│                              │
│   ┌────────────────────────┐ │
│   │  ~/projects/vscode     │ │  ← Saved workspaces (tap to open)
│   └────────────────────────┘ │
│   ┌────────────────────────┐ │
│   │  ~/projects/myapp      │ │
│   └────────────────────────┘ │
│                              │
│   [ Open Folder... ]         │  ← Type a path manually
│                              │
└──────────────────────────────┘
```

### 2.3 Chat View (connected + workspace)

The main working surface: full-screen chat with a drawer button.

```
┌──────────────────────────────┐
│  ☰  New Chat                 │  ← Top bar: drawer toggle + title
├──────────────────────────────┤
│                              │
│                              │
│     Chat Messages            │  ← Full-screen chat widget
│                              │
│                              │
│                              │
├──────────────────────────────┤
│  [ Chat input ...         ]  │  ← Input stays above keyboard
└──────────────────────────────┘
```

---

## 3. Drawer

The drawer slides in from the left when the hamburger button (☰) is tapped. It overlays the chat view with a semi-transparent backdrop.

```
┌─────────────┬────────────────┐
│             │                │
│  New Chat   │   (dimmed      │
│  Files      │    chat view)  │
│  ─────────  │                │
│  Session 1  │                │
│  Session 2  │                │
│  Session 3  │                │
│             │                │
│  ─────────  │                │
│  🟢 server  │                │
│  📁 workspace│               │
└─────────────┴────────────────┘
```

### 3.1 Drawer Sections

| Section | Content |
|---------|---------|
| Actions | **New Chat**, **Files** — each pushes a full-screen view |
| Separator | Visual divider |
| Chat Sessions | Scrollable list of past sessions; tap to switch |
| Separator | Visual divider |
| Footer | Connection info (server name + status dot) and workspace path |

### 3.2 Drawer Behavior

- Width: 80% of screen, max 320px
- Dismisses on: tap backdrop, swipe left, or select an action
- Opening/closing animated (slide + fade backdrop)

---

## 4. Top Bar

Replaces the old Connection Bar. Simpler — just two elements:

| Element | Position | Action |
|---------|----------|--------|
| ☰ Hamburger button | Left | Opens drawer |
| Title | Center-left | Shows "New Chat" or current session name |

Height: 44px (portrait), 36px (landscape). Respects `env(safe-area-inset-top)`.

---

## 5. Keyboard Handling

- When keyboard opens, the main container resizes to `visualViewport.height`
- Chat input stays visible above the keyboard
- Drawer cannot be opened while keyboard is visible (prevents layout jank)

---

## 6. Responsive Behavior

### Portrait (default)
- Single column, full width
- Drawer width: 80% of screen

### Landscape
- Same layout, taller input area
- Drawer width: min(80%, 320px)
- Top bar: 36px height

---

## Revision History

| Date | Change |
|------|--------|
| 2026-03-06 | Remove Terminals tab; implement Files tab with file explorer view |
| 2026-03-06 | Redesign: welcome → workspace → chat-with-drawer flow |
| 2026-03-05 | Initial specification |

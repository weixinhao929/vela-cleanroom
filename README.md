# Vela (Focus Desk)

English | [简体中文](README.zh-CN.md)

A Windows desktop productivity app built on **Tauri 2 + React 19 + TypeScript**: a transparent, interactive widget canvas laid over the desktop keeps everyday tools permanently at hand — pomodoro, to-dos, deadlines, class timetable, habit tracking, system monitoring, media control, and more. Implemented as a clean-room project containing no third-party proprietary code.

- Product / installer name: `Vela`, version `0.1.0`
- Platform: Windows x64 (WebView2)
- License: MIT (see [LICENSE](./LICENSE))

---

## Features

### Widgets (34 registry types, registered in `src/widget/registry.tsx`)

The gallery groups widgets into four categories via the registry's `category` field (`CATEGORY_NAMES`):

| Category | Count | Widgets |
| --- | --- | --- |
| Focus | 8 | Today overview, to-do list (expands into the "All tasks" board immersive view), pomodoro, deadlines, focus stats (expandable immersive view), class timetable (Excel/CSV import, expandable immersive view), habit tracker, countdown |
| Tools | 10 | Clock (multi-timezone / analog dial / stopwatch), notes (Markdown / recycle bin / quick-note window integration; per-instance cap of 500 notes, recycle-bin auto-purge after 30 days), sketchpad, calendar (with ICS subscription), calculator (calculate / encode / hash tabs — encoding covers Base64, URL, etc.; text hashing via built-in MD5, file hashing via Rust streaming MD5/SHA-1/SHA-256/SHA-512), unit converter, color picker (screen picking / palette), stopwatch (lap timing, with mini tile), gallery (per-instance cap of 200 photos; beyond that the oldest is evicted and its disk copy cleaned up), misc (Dynamic Island only: one panel hosting multiple widgets) |
| System | 12 | Recycle Bin, system monitor, hardware monitor (CPU/GPU/disk/network curves), system status bar, shortcuts (OS file drag-in; drag-and-drop re-ordering with mutually exclusive slot swapping; `.lnk`/`.url` target auto-resolution with self-healing migration of stale entries; directory auto-organize monitoring (extension/keyword rules, optional organize notification); grid and scrolling-strip entries support right-click in-place edit/remove; name labels and the SHORTCUTS header can be hidden/compacted; dropping OS files onto the screen auto-reveals the drop card), desktop files (list / content-preview dual view: image thumbnails + first lines of text; batch selection and batch delete with progress/cancel; deletion is undoable (private backup restore, not recycle-bin dependent); display aliases; sort by type; tri-state hide extensions; inline subfolder navigation breadcrumbs), audio monitor (spectrum visualization), Now Playing (SMTC), Bluetooth devices, Notification Center, brightness control (experimental: WMI for built-in panels / DDC/CI for external), clipboard history. Both Audio Monitor and Now Playing expand into a "music immersive view" (lyrics / visualization / cover-art color extraction) |
| Online | 3 | Weather (Open-Meteo, optional IP auto-location), bookmarks, unified inbox (IMAP, expandable immersive view) |

> The 10 tool entries above include **Misc** (`misc`, addable only as a Dynamic Island tile, never shown in the canvas gallery); the registry actually holds 11 tool types — the extra one is **Pinned Image** (`pin`, `hidden`, created only by the screenshot "pin to desktop" flow, listed by no picker) — so the Dynamic Island type picker can list 33 types (everything except pinned images).

### Desktop Form Factor

- **Transparent widget layer**: frameless, bottom-most, click-through — only control areas capture the mouse (hit-testing on the Rust side); all other clicks pass straight through to the desktop.
- **Multi-monitor**: one `widget-<i>` window per physical display, layouts persisted per screen; display hot-plugging automatically syncs the window set.
- **Settings window**: a separate WebView (`#/settings`) with General / Style / Display / Animation / Connection / Dynamic Island / Taskbar / Update pages plus data management; changes sync to the desktop layer in real time.
- **Quick-note window**: summoned with the global hotkey `Ctrl+Alt+Q`, one-click write into notes.
- **Tray**: pomodoro controls, backup, new task, screenshot, show desktop, taskbar-appearance submenu, open settings.

### Dynamic Island (Dock)

A persistent glass strip hugging the screen edge: it condenses frequently used widgets into tiles — click one to expand in place, with zero desktop footprint. The code identifier remains `dock`; the UI copy uses "Dynamic Island" (灵动岛).

- **Three ways in**: ① drag a card from the canvas **into the island** — releasing defaults to "copy as tile" (the canvas card stays; the tile binds to that instance; config edits sync both ways), while holding `Alt` on release = "move" (the canvas instance goes to the recycle bin, undoable); ② the "+" in the edit-mode overlay → type picker (all 33 types listed by category; the search box ranks by name / description / pinyin initials / type id across five tiers); ③ "Add to Dynamic Island" in the widget gallery after picking a type (greyed out when that type is already on the island). **Any type can join the island** — the only difference is whether it has a "rich form".
- **Per-tile configuration**: right-click a tile (or long-press 600 ms and release) → "Configure / Remove from Dynamic Island (undoable) / Locate on canvas (selects and pulse-highlights) / More settings". "Configure" opens an in-place popover anchored above the tile and edits the bound instance's config (or the tile's private config when no instance is bound).
- **In-island ordering & removal**: dragging tiles re-orders them via FLIP (equal-height placeholders + insertion-point preview); moves of ≤20 px use the fast 350 ms track, multi-row moves the default 500 ms. Dragging out of the island = remove, with a "Removed from Dynamic Island · Undo" toast. Keyboard: `←/→` move focus among tiles and "+", `Home/End` first/last, `Ctrl+←/→` re-order, `Delete` remove (also undoable), `Enter` expand, `Esc` collapse.
- **Island position (F-4)**: in edit mode, drag the island itself — it slides along the current edge (dragging writes only transforms; a single write to disk on release), auto-snaps near left / center / right (32 px threshold), and free position is adjustable with an offset slider (0–100%). Moving the pointer into the opposite 25% screen-height band previews an edge flip (top ⇄ bottom). Position is stored as the "island-center fraction of screen width", so resolution or display changes never shift it; keyboard `Ctrl+Shift+←/→` jumps to adjacent snap points.
- **Expansion & full-island panel**: clicking a tile expands its immersive face; the **full-island panel** (`dock:panel`) shows every island widget at once, with **carousel / grid** views. Both share the same `expand-store` single-value mutual-exclusion framework as canvas-card immersive views — only one expanded face exists at any moment.
- **Mini forms**: 14 types have dedicated mini forms (clock, to-do, pomodoro ring, system monitor, calendar, weather, music, habit, countdown, notification stack, brightness, clipboard, stopwatch, misc), each lazily loaded as its own chunk; all other types degrade automatically to a generic "icon + name + one-line summary" tile — for six high-frequency types (today overview / deadlines / notes / recycle bin / shortcuts / desktop files) the summary is live data (unfinished count, item count, root folder name, etc.) that refreshes with its data source.
- **Takeover**: pomodoro alarm > brightness / volume / media track change (same tier, latest wins) > notification arrival — only one shows at a time and falls back after 6 s by default. Brightness / volume takeovers are OSD-style instant feedback triggered by in-app adjustments (the canvas brightness card's slider, wheel volume on the music card); all five categories have their own switch and an adjustable display duration (3–15 s); clicking a takeover bar lands on the corresponding tile (if that type isn't on the island, it simply falls back without auto-adding).
- **Appearance & behavior**: shape "capsule / edge notch"; density in three steps (36 / 42 / 48 px); hover behavior "none / slight peak raise / expand first tile"; click-blank / middle-click / wheel all configurable; auto-hide "never / hide while fullscreen apps run (consumes `presence:state`) / fade out after N minutes idle".
- **Show-hide & panel hotkeys**: `Ctrl+Alt+I` toggles the island on this screen, `Ctrl+Alt+O` opens the full-island panel; the CLI flags `--toggle-dock` / `--open-dock-panel` are equivalent. Both hotkeys are handled only by the primary-screen window (`widget-0`) — island config persists per screen with one entry each, fully independent.
- **Two settings entries**: ① the "Dynamic Island" button on the edit-mode toolbar (overlay quick items: enable / edge / position snap + offset / hover / takeover switches / tile chip ordering and "+"); ② the **Settings → Dynamic Island** page (`features/settings/pages/DockPage.tsx`, the full set). Both read and write the same config, persisted per screen immediately (localStorage `focus-desk.screen.<N>.dock.v1` authoritative + SQLite `widget:dock:<N>` mirror).
- **Data model**: `DockConfig` v2 (`version: 2`) — `edge` / `offset` / `snap` / `style` / `tiles` / `mouse` / `takeover` / `autoHide` / `panel` / `density`; legacy v1 payloads (`tiles` as a string array like `["clock","pomodoro","notifications"]`) migrate losslessly to v2 on read and are written back immediately.

### Global Shortcuts

The following are the **defaults** (12 configurable actions in total), editable under Settings → General → Shortcuts → "Global shortcuts" (click a combo chip, then press the new combo; at least one modifier required). Conflicts with other actions prompt "Conflicts with «…»" and refuse to save; combos already occupied by other apps report registration failure via toast. The config syncs to all windows along with settings and is atomically re-registered on the Rust side (`apply_shortcut_config`).

| Action id | Default | Function |
| --- | --- | --- |
| `toggle-pomodoro` | `Ctrl+Alt+Space` | Start / pause focus |
| `toggle-layer` | `Ctrl+Alt+D` | Show / hide the widget layer (~180 ms fade-out before hiding, fade-in on show; instant under reduce-motion) |
| `toggle-edit` | `Ctrl+Alt+E` | Toggle edit mode |
| `show-settings` | `Ctrl+Alt+S` | Open settings |
| `new-task` | `Ctrl+Alt+N` | New task |
| `quick-note` | `Ctrl+Alt+Q` | Global quick note |
| `toggle-palette` | `Ctrl+Alt+K` | Toggle the command palette (works over any foreground app; shows the layer first if hidden, restores z-order and foreground on close). `Ctrl+K` inside the palette toggles it too; searches apps (pinyin / frequency ranking), commands, and settings entries; input with path traces (`\`, `/` or a drive letter) debounce-searches files in frequently used folders (300 ms budgeted scan, Enter opens with the system default handler); falls back to a search engine when there are no local results (`Tab` switches engine) |
| `toggle-dock` | `Ctrl+Alt+I` | Show / hide the Dynamic Island (primary screen only; also collapses any expanded face when hiding) |
| `open-dock-panel` | `Ctrl+Alt+O` | Open the full-island panel (shows the layer first if hidden; no-op when the island is disabled) |
| `taskbar:toggle` | — (no default; recordable) | Taskbar customization master switch (broadcasts `tray:taskbar-enabled`; the settings window syncs its toggle state) |
| `taskbar:reset-state` | `Ctrl+Alt+Shift+F1` | Reset taskbar dynamic state (bypasses the idempotency cache, immediately re-evaluates and re-applies all monitor states) |
| `screenshot` | `Ctrl+Alt+X` | Screenshot (freeze-frame capture → overlay-window region select / annotate / pin to desktop, same as the tray "Screenshot") |

### CLI Control Surface / Single Instance

`tauri-plugin-single-instance` guarantees exactly one resident instance: launching `Vela.exe` again forwards the second instance's command-line arguments to the running one and exits immediately (no double tray / double desktop layer). This makes the app drivable from shortcuts or scripts (`src-tauri/src/cli.rs`):

```powershell
Vela.exe --toggle-layer          # Show / hide the widget layer (same as Ctrl+Alt+D)
Vela.exe --show-settings         # Summon the settings window
Vela.exe --toggle-pomodoro       # Start / pause focus (same as Ctrl+Alt+Space)
Vela.exe --new-task "buy coffee" # Create a task directly; without text, opens the new-task input
Vela.exe --toggle-palette        # Toggle the command palette globally (same as Ctrl+Alt+K)
Vela.exe --toggle-dock           # Show / hide the Dynamic Island (same as Ctrl+Alt+I, primary screen only)
Vela.exe --open-dock-panel       # Open the full-island panel (same as Ctrl+Alt+O, shows the layer first if hidden)
```

Multiple arguments may be combined and run in order; unrecognized ones are ignored. Except for `--toggle-layer` / `--show-settings`, which act on windows directly, every toggle goes through the **same** dispatch path as global shortcuts (`shortcuts::dispatch`). Each forward makes the first instance broadcast an `app:second-instance` event (payload: full argv) for E2E and observability.

### Appearance & More

- 2 built-in theme presets ("Default" / "Terminal", each with complete light & dark palettes; plus a "Custom" slot derived from a base + text color, not counted in the preset total) × light/dark/follow-system, driven by CSS variables; animation in three tiers (enhanced / standard / reduced) plus per-effect switches and idle card dimming (presence Idle ≥60 s uniformly lowers card opacity; any input restores it), honoring the OS "reduce motion" setting. Date/time pickers and dropdowns are custom-drawn controls (`DatePicker` / `WidgetSelect`, theme-aware); all dropdowns share the unified "glide" interaction paradigm (custom-drawn "Glide Select": the popover scales/fades in from the trigger corner, the highlight is a pill gliding between rows, labels blur-swap on value change, it flips upward when space is short, keyboard + typeahead — the timetable scheme switcher and edit dialogs already replaced native selects).
- **System monitor enhancements**: NIC selection (most active / all / aggregate / specific), bit-based speed with compact mode, NIC connection details (MAC/IP/gateway/link speed), local TCP connection list (with owning process), daily traffic history (SQLite persisted, one-year retention) + speed/daily-traffic threshold system notifications; taskbar network-speed bar (a separate small window docked left of the tray area).
- **Now Playing enhancements**: multi-session management (lock / blacklist / exclusive playback), transport capability bits (unsupported buttons greyed), shuffle/repeat, summon player window, per-app session volume (wheel-adjustable). A dedicated "Now Playing" section in the settings window (aligned with mainstream media-flyout apps): exclusive-playback entry, centered title & artist, progress-bar toggle, shuffle/repeat toggles, wheel-volume toggle (quick items also synced into the widget gear popover).
- **Wallpaper**: pick images in the style page's wallpaper section and set one as the desktop wallpaper (5 most recent kept); the current wallpaper is highlighted automatically.
- **Taskbar customization**: taskbar transparent / solid / blur / acrylic appearance, auto-switching by desktop state (desktop visible / window present / maximized / Start menu / search / Task View), per-monitor configuration; entries: Settings → Taskbar, tray "Taskbar appearance" submenu; `Ctrl+Alt+Shift+F1` resets dynamic state. Note: the injected velatap.dll keeps residing in explorer after the app exits (appearance is restored; the DLL only waits sparsely to reconnect — pinned by the XAML diagnostics mechanism and unable to unload itself); restarting explorer or the system removes it completely.
- **Screenshot suite**: started via `Ctrl+Alt+X` / tray "Screenshot" / command palette — freeze-frame capture → fullscreen overlay with region select and annotation; copy, save, or "pin to desktop" (creates a pinned-image card).
- **Fullscreen display window**: summoned from the command palette as a separate true-fullscreen window with three projection modes — large clock / countdown / pomodoro (`Esc` / double-click to exit).
- **Super panel**: long-press right-click (300–1000 ms, default 500 ms) on selected text pops up an action panel (copy- and paste-state actions, window-context commands); off by default, enable under Settings → General.
- **Focus automation**: pomodoro events + condition rules (rule editor under Settings → Pomodoro); a hit runs whitelisted actions (open app / notification / show-hide widget layer / go to desktop / Task View / lock screen).
- **Notifications & push**: system Toast listening archived into the Notification Center; in-app events can fire system Toasts directly (clickable with callback); a built-in local loopback HTTP push endpoint (`POST 127.0.0.1:47310/api/notify`, off by default, port configurable).
- **Updates & presets**: stable / insider update channels + GitHub Releases rollback list + local version history; hardened `.zip` style-preset import/export + an online preset gallery (GitHub manifest, SHA-256 verified downloads).
- Bilingual Chinese/English (`src/i18n.ts` dictionary-style translation, O(1) lookup).
- Lunar calendar / solar terms / holidays (built-in tables + holiday-cn online completion).

---

## Development

```bash
npm install          # Install dependencies
npm run dev          # Browser dev mode at http://localhost:1420
npm run tauri:dev    # Desktop dev mode (requires Rust stable + MSVC + WebView2)
```

In browser mode the SQLite/Tauri APIs are unavailable and the app automatically falls back to localStorage persistence; the core UI and state keep working as usual.

### Common Scripts

| Script | Purpose |
| --- | --- |
| `npm run check` | Full TypeScript type check (`tsc -b --noEmit`) |
| `npm run lint` | ESLint (zero-warning baseline) |
| `npm test` | Vitest unit tests (`src/**/*.test.ts(x)`, 133 files · 1254 cases, all green as measured on 2026-09-27; jsdom + Testing Library) |
| `npm run test:e2e` | WebDriver end-to-end (`e2e/`, requires tauri-driver + msedgedriver + a build; see `e2e/README.md`; not wired into CI) |
| `npm run format` | Prettier formatting |
| `npm run lint:anim` | Animation-convention static checks (will-change/transitions/fx gating + the strict layout-property animation gate: Tier-1 layout properties must carry a `/* layout-anim: ok <reason> */` waiver or switch to compositor animations; includes the [bare-ease] gate: bare cubic-beziers outside token definitions need an "ease: ok <reason>" waiver; bare durations/eases ratchet along the dur/ease/delay three-bucket baseline) |
| `npm run lint:tokens` | CSS token reference gate (a `var(--x)` referencing an undefined token exits non-zero, preventing `--panel`/`--surface`-style "fallback surviving" breakage) |
| `npm run lint:layout-anim` | Layout/repaint property animation audit (non-strict view: full counts + unwaived list) |
| `npm run lint:i18n` | i18n gates (`check-i18n.cjs` call-site strings + `check-i18n-attrs.cjs` attributes/object literals; missing keys exit non-zero) |
| `npm run gen:types` | Generate TS bindings from the Rust models (ts-rs → `src/types/bindings/`) |
| `npm run tauri:build` | Production packaging (NSIS + MSI) |

Rust-side tests: `cd src-tauri && cargo test` (measured in this workspace on 2026-09-27: main crate 360 passed + 8 `#[ignore]` on-machine diagnostic probes; also refreshes ts-rs bindings). The taskbar TAP DLL is a separate workspace member, tested with `cargo test -p velatap` (22 tests).

E2E (WebdriverIO + tauri-driver, packaging required first): see [e2e/README.md](e2e/README.md).


---

## Packaging

```bash
npm run tauri:build
```

Artifacts land in `src-tauri/target/release/bundle/`:

- `nsis/Vela_0.1.0_x64-setup.exe` (~7.4 MB, recommended)
- `msi/Vela_0.1.0_x64_en-US.msi` (~10.0 MB)

---

## Project Layout

```text
src/
  main.tsx             Entry point: style chunking, hydration orchestration, crash fallback
  app/App.tsx          Root component: dispatches by window type (desktop layer / settings / quick note)
  components/          Shared UI (context menu, command palette, toasts, dialogs, error boundary)
  features/
    pomodoro/          Pomodoro panel       analytics/   Focus-stats panel
    deadlines/         Deadlines panel      tasks/       Today-to-dos panel
    settings/          Settings window (pages + per-widget config forms + data management)
    snip/ super-panel/ fullscreen/       Screenshot overlay / Super panel / Fullscreen display (independent window forms)
    taskbar-net/       Taskbar network-speed bar view (separate taskbar-net.html Vite entry)
  widget/
    widget-store.ts    Layout store (multi-view / z-order / recycle bin + Dynamic Island DockConfig v2, dual-backend debounced persistence)
    WidgetCanvas.tsx   Desktop canvas (drag / resize / align / marquee / templates)
    WidgetCard.tsx     Instance shell (edit interactions + lazy loading + error boundary)
    registry.tsx       Widget registry (34 types, lazy-loaded; entries can carry a MiniComponent mini form and an ExpandedComponent immersive view)
    dock/              Dynamic Island containers (10 components: DockShell / DockTiles / DockTile / DockDropZone /
                       DockPanel / DockTakeover / DockShortcuts / DockConfigPanel / DockTypePicker /
                       DockTileConfigPopover + dock-logic.ts pure functions + 12 tests, 23 files total)
    widgets/           Individual widget implementations (41 non-test .tsx, incl. the MusicImmersive / TaskOverview immersive views)
      mini/            14 mini forms (Clock / Todo / Pomodoro / System / Calendar / Weather /
                       Music / Habit / Countdown / Notifications / Brightness / Clipboard /
                       Stopwatch / Misc, each its own chunk)
    bar-pos.ts         View-switcher bar / toolbar positions (persisted per screen region)
    timetable*.ts      Class-timetable parsing domain logic
  domain/              Domain layer: stats aggregation / pomodoro reducer / CSV / backup validation / zod schemas / error taxonomy
  store/               zustand stores (app/settings/habits)
  lib/                 Foundations: theme engine, cross-window sync, persistence adapters, networking, notifications…
  ports/               Hexagonal-architecture ports (persistence adapter interfaces)
  i18n.ts / i18n-lite.ts  zh/en translation dictionary and lightweight i18n runtime
  styles/              Design tokens & layered styles (25 CSS files chunked by window/feature)
src-tauri/src/
  lib.rs               App orchestration: single-instance plugin, multi-monitor windows, tray, plugin assembly
  cli.rs               Single-instance argv command surface (--toggle-layer / --show-settings / --toggle-pomodoro / --new-task / --toggle-palette / --toggle-dock / --open-dock-panel)
  commands.rs          Tauri command facade (frontend invoke entry points)
  repositories.rs      Row-level SQL repositories (8)   db.rs     connections & migrations (10 versions)
  models.rs            IPC wire-protocol models (ts-rs single source)
  monitor.rs gpu.rs    Hardware sampling               media.rs   SMTC media (event thread + cover color extraction)
  system.rs files.rs   System / file integration       excel.rs   xlsx parsing
  email.rs bluetooth.rs audio.rs           Email / Bluetooth / audio
  presence.rs game.rs  Presence (input idle + foreground fullscreen) / foreground-window probe
  palette.rs wallpaper.rs brightness.rs    Oklab color pipeline / wallpaper-follows-theme / brightness control
  backup.rs tray.rs shortcuts.rs windows.rs … Backup / tray / configurable shortcuts (12 actions) / windows
  snip.rs super_panel.rs push_server.rs win_context.rs …  Screenshot / Super panel / local HTTP push / window-context probe
docs/                  Split documentation (architecture/API/deployment/design/templates/release) + dated issue notes
e2e/                   WebdriverIO + tauri-driver end-to-end tests (separate package)
scripts/               i18n dictionary guards & animation-convention static check scripts
.github/workflows/     CI (type check / lint / unit tests / Rust tests)
```

---

## Architecture Highlights

For a summary of layering and mechanisms see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); for the full module-level reference (per-directory responsibilities, dependency graph, extension guide) see the root [ARCHITECTURE.md](ARCHITECTURE.md). Core principles:

- **Hexagonal architecture**: feature layers depend only on the `ports/` interfaces; localStorage (browser) and SQLite (desktop) are interchangeable.
- **Persist-first write path**: a write hits disk successfully before memory is updated, and failures surface immediately — no "UI says saved, restart rolls back".
- **Single source of truth**: IPC types are generated from the Rust models via ts-rs; zod schemas and TS types share one origin; theme tokens are written exclusively by the theme engine.
- **Cross-window consistency**: event broadcast + echo suppression + leaf-level/row-level three-way merge (the last exchanged snapshot serves as the common ancestor; concurrent conflicts are arbitrated by `(ts, json)` with both ends converging on the same winner; local values the peer doesn't have are replayed); backup restore follows a pause-confirm-resume protocol. Merge comparison uses **canonical serialization** (object keys sorted lexicographically, arrays order-preserved) — the same data held with different key orders across windows is no longer misdetected as a change (root-cause fix on 2026-09-19 for the "rapid toggling in settings causes an infinite flip-flop" sync storm, see `docs/issues-2026-09-19-settings-toggle-storm.md`); divergence replays back off exponentially (capped at 2 s) while preserving original edit timestamps, and late hydration writes are silenced from broadcast via `lib/sync-gate.ts`.
- **Built-in performance budget**: constraints like shared sampling broadcasts, rAF-throttled dragging, debounced batched IPC/writes, and zero side effects during render are codified in CI scripts and unit tests.

# Cinnamon Privacy Indicator — project spec

## 1. Overview
A Cinnamon panel applet that shows real-time camera and microphone activity —
a lit icon in the panel whenever either device is actively in use, the way
iOS/macOS show a green/orange dot and GNOME Shell/KDE Plasma show a built-in
privacy indicator. Cinnamon has no native equivalent; the closest existing
Cinnamon Spices applet ("Mic mute toggler") only shows mute state, not
active-use state, which is a different signal. Runs on Linux Mint 22.3
Cinnamon, targeting the PipeWire audio stack Mint ships by default.

## 2. Goals
- Show a panel icon that changes state the moment the camera is opened by
  any process, and reverts within a couple seconds of it closing
- Show a panel icon that changes state the moment the microphone starts
  actively capturing audio, distinct from the existing mute-state concept
- Clicking the icon shows which process(es) are responsible, not just that
  *something* is active
- Runs continuously as a background panel applet with negligible CPU/battery
  impact — this is a passive indicator, not a monitoring dashboard
- Stays lightweight enough to be left running indefinitely without needing
  to be disabled later — resource discipline is a first-class goal here,
  not a nice-to-have

## 3. Non-Goals
- **[never]** Cross-desktop support (GNOME/KDE) — GNOME Shell and KDE
  Plasma already have native indicators; this applet is Cinnamon/GJS-specific
  by nature of the applet framework and isn't portable without a rewrite
- **[never]** Acting as a security boundary — this is a convenience
  indicator built on userspace polling, not a trusted hardware signal;
  sufficiently privileged malware could evade it. The physical webcam LED
  remains the actual trust anchor
- **[v2]** Historical audit log of past camera/mic access while away from
  the machine — would need a persistent local log with timestamps and
  process names
- **[v2]** A "kill this process" action in the click popup, given
  `fuser -k` already covers this manually
- ~~**[rejected]** Screen-recording/screen-share detection alongside
  camera/mic~~ — **superseded, see §7.3.** First requested via Threads
  feedback (2026-10-01) and declined: the only mechanism found at the
  time was a per-app blocklist (TeamViewer's session-only
  `TeamViewer_Desktop` child process, VNC/RDP's established listening
  connections), which misses AnyDesk and all browser/native-app screen
  share (Zoom, Meet, Teams, Discord, OBS) — arguably the most common
  real case — so shipping partial coverage was judged worse than not
  shipping. Reopened the same day once a protocol-level mechanism (the
  X11 RECORD extension, watching the X requests that read screen pixels
  rather than recognizing specific apps) was found — see §7.3 for the
  implementation, measured cost, and what it still doesn't cover.

## 4. Design rationale and constraints
- **No native PipeWire bindings in Cinnamon applets** — Cinnamon applets
  are GJS (JavaScript over GObject Introspection); there's no ready GI
  binding for libpipewire's event API. The pragmatic approach is polling
  `pactl` and `fuser` on a timer rather than building a native PipeWire
  event listener, trading a small polling delay for a much smaller
  implementation.
- **Subprocess calls must be async** — Cinnamon's panel and the rest of
  the shell run on one GJS main loop. A blocking/synchronous subprocess
  call freezes the entire desktop shell, not just the applet. This is a
  hard constraint, not a style preference.
- **PipeWire confirmed as the audio backend** on this system, and mic
  detection talks to it directly via `pw-dump` rather than `pactl`. Live
  testing during implementation showed the PulseAudio compatibility shim
  (`pipewire-pulse`) doesn't reliably reflect actual capture state —
  `pactl list source-outputs` can list a client whether or not it's
  actively producing audio, where PipeWire's own per-node `state` field
  (`running` vs. `idle`/`suspended`) is the accurate signal. `pw-dump`
  emits the whole graph as JSON, so mic detection filters for
  `media.class: Stream/Input/Audio` nodes with `state: running`.
- **Graceful absence of hardware** — this machine (HP EliteDesk mini PC)
  has no built-in webcam. The applet must not error, spam warnings, or
  show a permanently-stuck state when `/dev/video*` doesn't exist at all;
  it should just never light the camera indicator.
- **Polling interval is a trade-off, not a fixed requirement** — tighter
  intervals feel more "live" but spawn more subprocesses. Default to 2
  seconds; make it configurable rather than debating the "right" number
  up front.
- **Resource usage has been a repeat failure mode for applets built here
  before** — previous Claude Code-built Cinnamon applets have spiked CPU
  usage badly enough that they've had to be disabled entirely. The most
  common root cause of runaway CPU in Cinnamon/GNOME Shell-style applets
  is failing to clear the polling timer's GLib source when the applet is
  disabled or removed from the panel, so a reload during development
  silently stacks a new timer on top of the old one instead of replacing
  it — CPU usage then climbs with every reload rather than staying flat.
  This applet must treat that as the default risk to design against, not
  an edge case.

### 4.1 Portability (for open-sourcing)

This was built against one specific machine/session (Linux Mint 22.3,
Cinnamon 6.6.9, X11, PipeWire) and tested almost entirely on it. Before
sharing this beyond that machine, worth being explicit about what's
actually solid vs. assumed:

- **Panel position is not applet state.** Which panel zone/slot the icon
  ends up in is pure Cinnamon `gsettings` (`enabled-applets`), set via
  the normal "Applets → + Add to panel" flow (or a manual `gsettings`
  edit, as was done here for a specific spot next to Expo). Nothing in
  `metadata.json`/`applet.js` assumes or depends on panel position.
- **Cinnamon version floor is now declared** — `metadata.json` sets
  `"cinnamon-version": ["4.0"]`, matching Cinnamon's own
  `js/ui/extension.js` `validateMetaData()` check (confirmed by reading
  that file locally: the field is optional for applets, but is enforced
  via `versionCheck()` whenever present, *before* `applet.js` is ever
  executed). Before this field existed, an incompatible old Cinnamon
  would have hit an unhandled JS error from the ES6 `class ... extends
  Applet.IconApplet` syntax instead of a clean, logged refusal. 4.0 is a
  reasoned estimate (the era Cinnamon's own UI modules moved to ES6
  classes) rather than something verified against Cinnamon's changelog —
  getting it slightly off just changes where the clean-refuse boundary
  sits, it doesn't reintroduce the silent-crash failure mode.
- **Mic detection depends on PipeWire (`pw-dump`) — now a visible
  failure instead of a silent one.** Systems still on plain PulseAudio
  (no PipeWire) don't have `pw-dump`. `runSubprocessAsync()` distinguishes
  "binary not found" (`GLib.SpawnError.NOENT`, confirmed identically in
  both PyGObject and live GJS via Looking Glass) from a one-off transient
  failure. On "not found", `_micDetectionAvailable` flips to `false`
  (once, logged via `global.logWarning` — visible in Looking Glass, not
  spammed every poll) and the click popup shows "Microphone: detection
  unavailable (pw-dump not found — requires PipeWire)" instead of
  indistinguishably looking like idle forever. This previously had a gap
  (now closed, see §8.1): if the camera was also never active, the panel
  icon never became visible at all, so the popup message was only
  reachable via Looking Glass. Idle now shows a distinct gray "!" icon
  (`icons/error.svg`) whenever mic detection is unavailable, specifically
  so this is discoverable by clicking, not just by digging into logs.
- **Camera-process attribution assumes direct V4L2 access.** `fuser` on
  `/dev/videoN` correctly reports the real consuming app's PID when the
  app opens the device directly, which is the normal case on X11 (this
  session's environment). Under a desktop portal flow (mainly a Wayland
  or Flatpak-sandboxed-app thing) the device may instead be held by a
  portal/PipeWire camera-provider process, so the popup would show that
  broker process's name instead of the real app. Not tested here (no
  Wayland session available), and there's no code-level mitigation for
  it — noting it as a known limitation rather than silently ignoring it.
- **`fuser` (psmisc) is assumed present** — near-universal on desktop
  Linux distros, unlike PipeWire, so treated as a much lower risk and
  not given the same "detect and surface" treatment as `pw-dump`.
- **Multi-webcam handling verified at the mechanism level, not on real
  dual-camera hardware** (this machine only has one physical webcam,
  exposing `/dev/video0` + `/dev/video1` as capture/metadata nodes of the
  same device). Confirmed directly, though, that `fuser`'s stdout
  contains *only* raw PIDs — verified by piping stdout and stderr to
  separate files while a process held the device — so passing N device
  paths and getting back a flat, unambiguous PID list (no risk of a
  device filename's digits, e.g. the `0` in `/dev/video0`, being
  misread as a PID) is a property of `fuser`'s documented stdout/stderr
  contract, not something that depends on device count.

### 4.2 Cinnamon Spices submission prep

Verified against the actual current requirements (CI validator source,
published code-review checklist, and a real example applet in
`linuxmint/cinnamon-spices-applets`, not from memory) ahead of a
possible submission there. Fixed in `applet.js`/`metadata.json`:

- `metadata.json`'s `"icon"` field is explicitly on validate-spice's
  forbidden-fields list (`icon`, `dangerous`, `last-edited`) — removed;
  the applet already sets its icon entirely at runtime via
  `set_applet_icon_path()` regardless, so this had zero functional
  effect. Added `"version"` (expected by the ecosystem's translation
  tooling; not validator-enforced but present on every real example
  checked).
- Bound the applet's own gettext domain (`Gettext.bindtextdomain` +
  a domain-scoped `_()`) instead of relying on Cinnamon's global one,
  which only covers Cinnamon's own strings — without this, per-applet
  `po/` translations would never have applied to ours.
- Two menu-item labels built PID suffixes via raw string concatenation
  (an untranslatable literal " (PID ...)"); converted to
  `_("%s (PID %s)").format(name, pid)`, matching the review checklist's
  explicit "printf-style format tokens, not concatenation" convention.
  Confirmed `String.prototype.format` is available in this environment
  (Cinnamon's own boot sequence initializes it) via a live Looking
  Glass check before relying on it.
- Poll timer callback (`_pollTick`) now returns `GLib.SOURCE_CONTINUE`
  instead of a bare `true` — the review checklist explicitly asks for
  the named constants over their boolean equivalents.
- `listVideoDevices()` and `resolveProcessName()` were synchronous
  (`Gio.File.enumerate_children`, `file.load_contents`) — justified at
  the time as negligible since `/dev`/`/proc` are in-memory pseudo-
  filesystems, but the review checklist says sync I/O is "avoided at
  all costs," full stop, no carve-out for pseudo-fs reads. Rewritten as
  `listVideoDevicesAsync()` (paged `enumerate_children_async` /
  `next_files_async`) and `resolveProcessNamesAsync()` (parallel
  `load_contents_async` calls fanned in via a remaining-count join,
  same pattern `_pollTick()` already used for camera/mic). Practical
  runtime behavior is unchanged — verified live (camera-only, mic-only,
  both-active, and the mic-unavailable error path all still resolve
  and render correctly) — this was a style/convention fix, not a bug
  fix.
- Gettext domain bound against `GLib.get_home_dir() + '/.local/share/
  locale'` (hardcoded) — flagged by the Spices repo's own automated
  "best-practices scanner" bot on the PR (`hardcoded_data_dir`) once
  submitted, because it doesn't respect an `XDG_DATA_HOME` override.
  Switched to `GLib.get_user_data_dir() + '/locale'`. Notable: the
  review doc's own quoted example boilerplate (§4.2 above) uses the
  hardcoded form — the scanner is stricter than the documented
  convention it's nominally checking. Verified `GLib.get_user_data_dir()`
  returns the expected `~/.local/share` both via PyGObject and live GJS
  before relying on it, and re-confirmed full live regression
  (camera/mic/both/error paths, timer non-stacking) after the change.

UUID resolved: renamed from `@vibhs` to `@cray2015` (matches the
GitHub account this is submitted from, and the noreply-email identity
already used for commits — planned as a consistent `@cray2015`
namespace across future applet submissions too, not just this one).

### 4.3 Cinnamon Spices submission status

Submitted. Fork: `cray2015/cinnamon-spices-applets`, branch
`add-cinnamon-privacy-indicator`. PR:
https://github.com/linuxmint/cinnamon-spices-applets/pull/9080
("cinnamon-privacy-indicator: add new applet showing camera/mic
activity"), 3 commits as of the gettext fix above.

Submission packaging lives only in the fork, not this repo — this repo
stays the flat, standalone-clone layout described in §12. The fork
adds `cinnamon-privacy-indicator@cray2015/info.json` (author: cray2015,
license: GPL-2.0-or-later), `.../screenshot.png` (real popup + icon,
captured live with actual camera+mic activity), `.../README.md`
(user-facing description for the Spices page — distinct purpose from
this repo's README, which is developer/install-focused), and
`.../files/cinnamon-privacy-indicator@cray2015/` holding the exact
same `applet.js`/`metadata.json`/`settings-schema.json`/`icons/` as
this repo (diff-verified byte-identical at each sync). `icon.png`
(96×96, derived from the both-active split design) is new — a static
package-catalog icon, separate from the runtime state SVGs, required
by `validate-spice` and not something this standalone repo needed
before.

`metadata.json` also gained `"author": "cray2015"` and `"website":
"https://github.com/linuxmint/cinnamon-spices-applets"` (pointed at
the Spices repo itself, not this standalone repo, per instruction) —
matching fields a real published applet (`Cinnamenu@json`) carries,
fetched and checked directly rather than guessed.

CI status at submission: `validate-spice` passes clean (run locally
against the staged fork directory before every push); the PR's
automated "Pattern Check" passes; "Validate spices" shows "skipping"
on the PR — confirmed expected, not a failure: the full validator only
runs on `pull_request` (same-repo), while a fork PR triggers
`pull_request_target`, which intentionally defers the full run to a
maintainer for security reasons. Awaiting human review from the
Cinnamon team.

## 5. Architecture
Cinnamon panel (loads `applet.js`) → polling timer (GLib async, ~2s
interval) → `Gio.Subprocess` spawns `pw-dump` (mic) and `fuser
/dev/videoN...` (camera, node paths enumerated from `/dev` rather than
shell-globbed) → output parser extracts active process names → applet
state machine (idle / camera / mic / both) → `St.Icon` panel display
updates → on click, popup menu lists the resolved process name(s) for
whichever device(s) are active.

Separately, a long-lived helper process (`screen_share_helper.py`,
spawned once at applet startup, not per-poll-tick) watches the X11
RECORD extension for the requests that read screen pixels (§7.3) from
any client, debounces sustained activity, resolves the responsible PID via the
X-Resource extension, and streams `READY`/`ACTIVE <pids>`/`IDLE` lines
back over its stdout pipe — read asynchronously the same way the rest
of the applet avoids blocking calls, just continuously rather than
request/response. This feeds a screen-share boolean that's orthogonal
to the camera/mic state machine: it draws as a ring around whichever
base icon is already showing, rather than being a fifth state. See
§7.3.

Diagram source: `docs/architecture.d2`. Render on demand with
`d2 docs/architecture.d2 docs/architecture.svg` — the `.d2` is the source
of truth; the rendered SVG is not committed.

## 6. Components
| Path | Role |
|---|---|
| `metadata.json` | Applet manifest — uuid, name, description, Cinnamon version compat (`cinnamon-version: ["4.0"]`) |
| `applet.js` | Main logic: polling loop, subprocess calls, state machine, icon rendering, click popup |
| `settings-schema.json` | Applet settings: poll interval |
| `icons/` | Panel icon assets: idle (never shown, see §8.1), camera-active, mic-active, both-active, `error` (shown persistently when mic detection is unavailable), and a `-share` ring variant of each of the first four (see §7.3/§8.1) |
| `screen_share_helper.py` | Long-lived X11 RECORD-extension listener for screen-share detection — see §7.3 |

## 7. Detection logic
### 7.1 Camera detection
Enumerate `/dev/video*` nodes directly (via `Gio.File` directory listing,
not a shell glob — `Gio.Subprocess` doesn't shell-expand argv), since a
single physical webcam often exposes more than one `/dev/videoN`. Run
plain `fuser <device paths...>` (no `-v`) against all of them at once.
`fuser` writes only raw PIDs to stdout and everything else (per-file
access-type letters, "not in use" messages) to stderr — confirmed via
`man fuser` and a live test piping stdout/stderr to separate files — so
capturing stdout alone with `Gio.SubprocessFlags.STDERR_SILENCE` gives an
unambiguous PID list with no risk of a device filename's own digits
(e.g. the `0` in `/dev/video0`) being misread as a PID, regardless of
how many devices are passed (see §4.1). Any PID returned means the
camera is in use by at least one process. Resolve PID → process name via
`/proc/<pid>/comm` rather than spawning a second `ps` call.

### 7.2 Microphone detection
Run `pw-dump` and parse the JSON output for nodes with
`media.class: "Stream/Input/Audio"` and `state: "running"` — the latter
distinguishes an app that's actively producing audio from one that's
merely connected but idle/corked, which `pactl list source-outputs`
can't reliably distinguish (see §4). Process name comes from each node's
`application.name` (falling back to `node.name`); `application.process.id`
gives the PID when the client sets it — some ALSA-plugin-bridged clients
don't, so the click popup omits the PID rather than showing a wrong one.

### 7.3 Screen-share detection
Unlike camera (v4l2 device node) and mic (PipeWire graph), X11 has no
broker for screen reads at all — any client can read any window,
including the root window (whole screen), with no permission check and
no OS-visible trace (no `/proc` entry, no syscall). This ruled out
every approach that works for camera/mic before implementation started
(see the superseded rejection note in §3) until a different mechanism
was found: the **RECORD extension**, designed for input-macro/screen-
recording tools (and, notoriously, the same primitive X11 keyloggers
use for keystrokes) — it lets one client ask the X server to replicate
a live copy of specific protocol requests issued by *any other*
client. Filtering it to the requests that read screen pixels turns
detection from "recognize known apps" into "catch the protocol-level
act of reading the screen."

**Signals counted as screen capture** — each verified against a real
capture tool on this machine, not just a synthetic generator:

| Request | Who uses it | Verified with |
|---|---|---|
| core `CopyArea` (62) whose source belongs to a different process than the copier (the root window counts: the X server owns it) | Chromium's WebRTC X11 capturer: from the root window for "Entire Screen", straight from the target window for "A Window" | Real Meet shares in Brave: ~57 calls/s from the root window; ~41 calls/s from the shared Nemo window |
| core `CopyArea` (62) from a pixmap the copier obtained via Composite `NameWindowPixmap` | Chromium's capturer when it uses Composite (per its source) | Not observed on a real share — Brave's window share copied the window directly |
| `XFixes GetCursorImage` | GPU-texture window capture that composites the cursor, e.g. OBS "Window Capture (Xcomposite)" | Real OBS window source: exactly 30/s (its output fps), zero while the source is hidden |
| core `GetImage` (73), MIT-SHM `ShmGetImage` | Screenshot tools, `ffmpeg -f x11grab`, Chromium's fallback when shared pixmaps are unavailable | Synthetic generator |

`CopyArea` is ordinary drawing traffic for most apps, which is why only
copies of *another process's* pixels count. An XID's high bits identify
the X client that created it; the helper maps that client to a PID via
X-Resource and compares processes, not connections, because one app
can hold several connections (Brave holds two). Verified for 45s of
normal desktop use: 185 `CopyArea` calls, none cross-process. The
helper also tracks pixmaps named via `NameWindowPixmap` (dropped on
`FreePixmap`), since the copier owns those and the cross-process rule
can't see them. `GetCursorImage` is not called by anything else
on a normal Cinnamon desktop — verified for 30s with the cursor
constantly changing shape (links, text fields, resize edges): OBS was
the only caller. Muffin tracks the cursor without it.

**Correction history — read before changing the signal list.** The
first version watched only `GetImage`/`ShmGetImage`, because a search
summary said Chromium's capturer "uses XShmGetImage". That is only its
fallback: `x_server_pixel_buffer.cc`'s `CaptureRect` uses `XCopyArea`
into a MIT-SHM pixmap whenever one could be created. The synthetic
tests used `GetImage` too, so they passed by construction, and a real
Meet share went undetected. A follow-up investigation then wrongly
blamed a GPU/DRM zero-copy capture path (straces of Brave's GPU process
showed only ordinary rendering ioctls). One 10-second RECORD histogram
of everything the real capture process sent found the real request
immediately. The next fix then repeated the mistake in miniature: it
accepted window-share copies only from `NameWindowPixmap` pixmaps,
because Chromium's source suggested so, and a real "A Window" share
went undetected — Brave copied straight from the target window. Lesson:
verify each signal against the real tool's unfiltered request stream;
source code tells you what's possible, not which path runs.

**Implementation** (`screen_share_helper.py`, run via `python3`, not
GJS — no GObject-Introspection binding for Xlib/RECORD/XRes exists, so
this can't be written in `applet.js` itself):
- Opens one RECORD context (`python3-xlib`'s `Xlib.ext.record`) with a
  separate range per opcode — `FreePixmap`, `CopyArea`, `GetImage`,
  `ShmGetImage`, `NameWindowPixmap`, `GetCursorImage` — never a span
  like 54–73, since the core opcodes in between are drawing requests
  (`PolyLine`, `PutImage`, …) that would flood the helper with every
  app's rendering. Extension *major* opcodes (MIT-SHM, Composite,
  XFIXES) are per-server and queried at runtime, never hardcoded.
- Debounces: a client is only considered "active" after
  `MIN_SUSTAINED_EVENTS` (3) matches within `SUSTAIN_WINDOW` (1.5s) —
  verified live that a single screenshot does not trigger this, while
  synthetic sustained capture at 10fps does, within about a second.
  `IDLE_GRACE` (2.5s) avoids flapping between individual frames.
- Resolves the responsible PID via the X-Resource extension
  (`res.query_client_ids` with `LocalClientPIDMask`) against the
  RECORD reply's `id_base` field — verified end-to-end with a real
  spawned process: the resolved PID matched the real PID exactly.
- Prints `READY` once listening, then `ACTIVE <pid>[,<pid>]` /`IDLE` on
  every state change, for `applet.js` to read asynchronously via
  `Gio.DataInputStream.read_line_async` over the subprocess's stdout
  pipe — a persistent spawn-once-and-stream-from process, not the
  spawn-wait-reap pattern `fuser`/`pw-dump` use, since RECORD's
  `record_enable_context` call blocks forever processing events.

**Measured compute cost** (see conversation/commit history for the
full methodology): idle cost is immeasurable; at a synthetic 60fps
capture rate (higher than most real tools run), the listener itself
costs under 1% of one core, and the *marginal* cost added to the X
server (isolated by comparing the same load with and without the
listener attached) was within measurement noise — under 0.5 percentage
points. Cost scales with capture frame rate, not resolution — RECORD
replicates only the request header (a few dozen bytes), never the
pixel payload, confirmed by comparing a 100×100 capture region against
a full 1920×1080 one and seeing no difference in the listener's own
cost. With real tools and the full signal list, the helper measured
1.4% of one core during a live Meet "Entire Screen" share and 0.9%
with an OBS window source active.

**Lifecycle/cleanup** (the project's single biggest documented risk,
see `CLAUDE.md`): a spawned OS process does not die just because its
parent does, so the helper calls `PR_SET_PDEATHSIG` on startup —
verified empirically by killing a real `cinnamon --replace` parent and
confirming the old helper no longer survives it (before this fix, it
did leak, and reload after reload stacked more of them — exactly the
failure mode this project's CLAUDE.md warns about). `applet.js` also
explicitly kills the helper in `on_applet_removed_from_panel`
(confirmed working when that hook fires). **Known gap, found during
this same testing, not assumed away:** removing only this one applet
from the panel while Cinnamon keeps running was observed, by reading
Cinnamon's own `appletManager.removeAppletFromPanels` source live via
Looking Glass, to not always route through that hook in this
environment — plausibly related to this specific Cinnamon build/dev
session rather than this applet's code, but not root-caused further.
PDEATHSIG bounds the consequence to "survives until the next Cinnamon
restart or logout," not an unbounded leak.

**Coverage, stated plainly:** verified on real tools for Chromium-based
browser "Entire Screen" share (Meet in Brave) and OBS window capture;
covers anything else that reads pixels through the requests above.
Known gaps:
- GPU-texture window capture with cursor capture turned off (e.g. OBS
  with "Capture Cursor" unchecked) sends no per-frame request at all.
- A Composite-based window capture set up before the helper started
  (e.g. across a Cinnamon reload) — its `NameWindowPixmap` was never
  seen. Doesn't affect Brave's window share, which copies the window
  directly.
- Browser **"Tab" sharing — a hard limit, not a missing signal.**
  Verified on a real Meet tab share: Brave sent no capture-related X
  requests and opened no "is sharing" window; the tab is captured from
  the browser's own rendering. Nothing outside the browser can observe
  it, on X11 or Wayland. The browser's own indicator (red dot on the
  tab, "Sharing this tab" bar) is the only one.
- A window share of a minimized window or one on another workspace —
  X11 has no pixels for it, so Chromium issues no copies (and the share
  shows a frozen frame); arguably correctly not flagged.
- Wayland — the mechanism doesn't exist there (logged once via
  `global.logWarning`, degrades silently; rest of the applet
  unaffected).

Deliberately has no settings-schema toggle — matches the camera/mic
pattern of auto-detect-and-silently-degrade rather than adding a knob
nothing required.

## 8. Panel UI & behavior
### 8.1 Icon states
Four internal activity states: idle, camera-only, mic-only, both-active
(distinct combined icon, not just two overlapping icons). Only the
three active states are ever shown in the panel — on idle the applet
hides its own panel actor entirely rather than showing a dimmed
placeholder, so it occupies no panel space until something is actually
active. This mirrors the macOS/iOS privacy dot behavior the project is
modeled on (§1) rather than the "always-visible, four rendered icon
states" framing this section originally described. `icons/idle.svg`
still exists and is assigned as the icon path for the idle state, but
is never actually shown — it's a harmless fallback, not a rendered
state.

One exception to "idle is always hidden": a fifth, non-activity display
key (`error`, `icons/error.svg` — a neutral gray/slate circle with a
white "!", deliberately not colored like any active-recording state so
it can't be mistaken for one) overrides the hidden idle icon whenever
`_micDetectionAvailable === false` (see §4.1, §7.2) — i.e. whenever a
detector is permanently broken on this system, not just quiet right
now. This is the applet's one persistent/error-driven icon; every other
state remains strictly activity-only.

The both-active icon is a single circle split top/bottom rather than two
overlapping glyphs crammed into one disc (the original design read as
cluttered): the top half is the camera-active green with a small camera
glyph, the bottom half is the mic-active orange with a small mic glyph.
`icons/camera-active.svg` and `icons/mic-active.svg` (the single-device
states) are unchanged.

Screen-share (§7.3) is drawn as a **red ring** around whichever of the
four base icons is already showing, not a fifth icon or a fifth STATE
value — `ICON_FILES_SCREEN_SHARE` maps each of idle/camera/mic/both to
a `*-share.svg` variant with the same inner glyph plus the ring. This
was chosen over three other mocked-up options (three-way pie split,
corner badge, separate second panel icon) specifically because it's the
only one that doesn't disturb the already-tuned camera/mic layout, and
confirmed legible at true ~22px panel scale via a rendered side-by-side
comparison before implementation.

One consequence: screen-share-alone (camera and mic both idle) is *not*
the hidden idle state anymore — it forces the icon visible, since
there's nothing to draw a ring around if it's hidden. In that case the
inner glyph falls back to `idle-share.svg` (the dim gray idle glyph,
otherwise never shown, plus the ring) rather than hiding. "Idle" was
redefined accordingly: all three signals quiet, not just camera/mic —
screen-share being active was never actually in tension with "hide
when truly idle," since by definition it isn't idle.

### 8.2 Click popup
Clicking the panel icon opens a small popup listing each active device
and its resolved process name(s), e.g. "Camera: firefox (PID 4821)".
When idle, clicking shows "No camera or microphone activity detected."
A "Screen capture:" section is added the same way when the ring is
showing, listing the resolved process name(s) from §7.3 (or "Unknown
process" if PID resolution failed for that client).

## 9. Milestones
- [x] M1 — Applet skeleton loads in Cinnamon (visible in panel, static icon, no detection logic yet)
- [x] M2 — Camera detection working; icon switches state within one poll interval of opening/closing a test capture
- [x] M3 — Microphone detection working; icon switches state within one poll interval of a test recording starting/stopping
- [x] M4 — Combined both-active state renders correctly when camera and mic are active simultaneously
- [x] M5 — Click popup resolves and displays correct process name(s)
- [x] M6 (backlog) — Poll interval configurable via applet settings UI (poll-interval only; icon-style knob from §6 wasn't wired up — not needed once custom SVGs were the settled approach)
- [x] M7 — Screen-share detection (§7.3): RECORD-based helper process, red ring overlay on all four base icons, PID resolution, measured compute cost, and verified process-lifecycle cleanup (with one documented residual gap — see §7.3)

## 10. Acceptance criteria
1. [x] With no camera or mic activity, panel icon shows idle state — verified via Looking Glass eval (`_state === 'idle'`) and a panel screenshot
2. [x] Opening a webcam test stream flips the icon to camera-active within the poll interval, and clicking it shows the correct process name — verified live with `vlc v4l2:///dev/video0`, resolved to `vlc (PID 84746)`
3. [x] Starting a microphone recording flips the icon to mic-active within the poll interval, and clicking it shows the correct process name — verified live with `arecord`; process name resolved, PID was null because that ALSA-plugin-bridged client doesn't set `application.process.id` (see §7.2) — a real browser client sets it and shows a PID
4. [x] Running both simultaneously shows the distinct both-active icon, not two indicators overlapping or one masking the other — verified live (vlc + arecord together) and visually via screenshot
5. [x] Stopping either activity reverts the icon to idle (or to the other single-active state) within one poll interval — verified for both camera-only and mic-only
6. [x] On a session with no camera hardware present at all, the applet loads without errors and the camera state simply never activates — verified live after the webcam was physically unplugged: `/dev/video*` gone, `listVideoDevices()` returns `[]` and short-circuits before ever spawning `fuser`, applet stayed at `state=idle`/hidden with no exceptions in the journal, timer unaffected
7. [x] Applet survives a Cinnamon restart (`cinnamon --replace` or Alt+F2, r) without needing reinstallation — files stayed in place across the restart used to load it
8. [x] Idle CPU usage stays negligible, and disabling/re-enabling the applet several times in a row does not cause CPU usage to climb — verified via Looking Glass: 4 disable/re-enable cycles left exactly 1 running instance with 1 timer source (no stacking), and `top` showed brief periodic spikes only, not sustained load
9. [x] A single one-off screenshot does not trigger the screen-share ring — verified live against the real running applet instance (Looking Glass state inspection) before and after
10. [x] Sustained synthetic screen capture (10fps) triggers the ring within ~1s, correctly resolves the real PID of the capturing process, and reverts to no-ring within the idle-grace window after capture stops — verified live, including the screen-share-alone case (camera/mic both idle, ring drawn around the dim idle glyph) with a real panel screenshot
11. [x] `cinnamon --replace` does not leak the helper process across repeated reloads — verified: without `PR_SET_PDEATHSIG` it did leak (reproduced and confirmed via `ps`/`pgrep`); with it, exactly one helper process survives each reload, parented to the current Cinnamon process
12. [ ] Removing only this applet from the panel (without restarting Cinnamon) reliably stops the helper immediately — **not yet achieved**; see the documented gap in §7.3. `on_applet_removed_from_panel`'s own cleanup call was confirmed correct in isolation (direct invocation via Looking Glass killed the process immediately), but the hook itself wasn't observed to fire for this specific removal path in this environment
13. [x] A real Google Meet "Entire Screen" share in Brave turns the ring on and resolves the process to `brave` — verified 2026-10-07 via Looking Glass state and a panel screenshot; ring cleared after the share stopped
14. [x] An OBS "Window Capture (Xcomposite)" source turns the ring on while visible (resolves to `obs`) and off when hidden — verified 2026-10-07
15. [x] Normal desktop use with the cursor constantly changing shape does not trigger the ring — verified 2026-10-07: OBS was the only `GetCursorImage` caller over 30s
16. [x] A Meet "A Window" share in Brave turns the ring on (resolves to `brave`) — verified 2026-10-07 via Looking Glass state and a panel screenshot, after the cross-process `CopyArea` rule replaced the `NameWindowPixmap`-only one
17. [x] A Meet "A Tab" share is confirmed undetectable from outside the browser (no X traffic, no sharing window) — documented as a hard limit in §7.3, not a bug

## 11. Open questions
- ~~**Does the installed `pactl` support `--format=json`?**~~ — resolved
  during implementation: `pactl -f json list source-outputs` does work
  (pactl 16.1 on this system), but mic detection ended up using `pw-dump`
  instead, not `pactl` at all — see §4 and §7.2 for why.
- **Icon assets: reuse existing system tray icon theme, or ship custom
  SVGs?** — reusing theme icons is less work and matches Mint's visual
  style automatically; custom SVGs give more control over the
  both-active combined state. Leaning toward theme icons for M1–M5,
  custom SVGs as a possible polish pass.
- **Multiple simultaneous processes on one device** — if two processes
  somehow hold the camera or mic at once, does the click popup list both?
  Likely yes since `fuser`/`pactl` already return multiple PIDs/clients
  when this happens; just needs to not assume a single result.

## 12. Files
- `PROJECT_SPEC.md` — this file
- `CLAUDE.md` — build/test commands and invariants
- `docs/architecture.d2` — architecture diagram source
- `metadata.json` — applet manifest
- `applet.js` — main applet logic
- `settings-schema.json` — applet settings schema
- `README.md` — setup and installation instructions (written during build)
- `LICENSE` — GPL-2.0-or-later full text
- `icons/` — panel icon assets (idle, camera-active, mic-active,
  both-active, error)

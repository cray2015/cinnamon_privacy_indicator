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
- **[unplanned]** Screen-recording/screen-share detection alongside
  camera/mic

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

## 5. Architecture
Cinnamon panel (loads `applet.js`) → polling timer (GLib async, ~2s
interval) → `Gio.Subprocess` spawns `pw-dump` (mic) and `fuser
/dev/videoN...` (camera, node paths enumerated from `/dev` rather than
shell-globbed) → output parser extracts active process names → applet
state machine (idle / camera / mic / both) → `St.Icon` panel display
updates → on click, popup menu lists the resolved process name(s) for
whichever device(s) are active.

Diagram source: `docs/architecture.d2`. Render on demand with
`d2 docs/architecture.d2 docs/architecture.svg` — the `.d2` is the source
of truth; the rendered SVG is not committed.

## 6. Components
| Path | Role |
|---|---|
| `metadata.json` | Applet manifest — uuid, name, description, Cinnamon version compat (`cinnamon-version: ["4.0"]`) |
| `applet.js` | Main logic: polling loop, subprocess calls, state machine, icon rendering, click popup |
| `settings-schema.json` | Applet settings: poll interval |
| `icons/` | Panel icon assets: idle (never shown, see §8.1), camera-active, mic-active, both-active, and `error` (shown persistently when mic detection is unavailable) |

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

### 8.2 Click popup
Clicking the panel icon opens a small popup listing each active device
and its resolved process name(s), e.g. "Camera: firefox (PID 4821)".
When idle, clicking shows "No camera or microphone activity detected."

## 9. Milestones
- [x] M1 — Applet skeleton loads in Cinnamon (visible in panel, static icon, no detection logic yet)
- [x] M2 — Camera detection working; icon switches state within one poll interval of opening/closing a test capture
- [x] M3 — Microphone detection working; icon switches state within one poll interval of a test recording starting/stopping
- [x] M4 — Combined both-active state renders correctly when camera and mic are active simultaneously
- [x] M5 — Click popup resolves and displays correct process name(s)
- [x] M6 (backlog) — Poll interval configurable via applet settings UI (poll-interval only; icon-style knob from §6 wasn't wired up — not needed once custom SVGs were the settled approach)

## 10. Acceptance criteria
1. [x] With no camera or mic activity, panel icon shows idle state — verified via Looking Glass eval (`_state === 'idle'`) and a panel screenshot
2. [x] Opening a webcam test stream flips the icon to camera-active within the poll interval, and clicking it shows the correct process name — verified live with `vlc v4l2:///dev/video0`, resolved to `vlc (PID 84746)`
3. [x] Starting a microphone recording flips the icon to mic-active within the poll interval, and clicking it shows the correct process name — verified live with `arecord`; process name resolved, PID was null because that ALSA-plugin-bridged client doesn't set `application.process.id` (see §7.2) — a real browser client sets it and shows a PID
4. [x] Running both simultaneously shows the distinct both-active icon, not two indicators overlapping or one masking the other — verified live (vlc + arecord together) and visually via screenshot
5. [x] Stopping either activity reverts the icon to idle (or to the other single-active state) within one poll interval — verified for both camera-only and mic-only
6. [x] On a session with no camera hardware present at all, the applet loads without errors and the camera state simply never activates — verified live after the webcam was physically unplugged: `/dev/video*` gone, `listVideoDevices()` returns `[]` and short-circuits before ever spawning `fuser`, applet stayed at `state=idle`/hidden with no exceptions in the journal, timer unaffected
7. [x] Applet survives a Cinnamon restart (`cinnamon --replace` or Alt+F2, r) without needing reinstallation — files stayed in place across the restart used to load it
8. [x] Idle CPU usage stays negligible, and disabling/re-enabling the applet several times in a row does not cause CPU usage to climb — verified via Looking Glass: 4 disable/re-enable cycles left exactly 1 running instance with 1 timer source (no stacking), and `top` showed brief periodic spikes only, not sustained load

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

# Cinnamon Privacy Indicator

A Cinnamon panel applet that lights up when the camera or microphone is
actively in use, and shows which process is responsible on click. See
`project_spec.md` for the full design rationale and `docs/architecture.d2`
for the architecture diagram.

**Requirements:** Cinnamon 4.0+ (declared in `metadata.json`; older
versions refuse to load with a clean error instead of crashing). Camera
detection needs `fuser` (psmisc, near-universal on desktop distros).
Microphone detection needs PipeWire (`pw-dump`) — on a PulseAudio-only
system without PipeWire, mic detection is unavailable; see §4.1 of
`project_spec.md` for how that's surfaced instead of silently doing
nothing. Only tested so far on Linux Mint 22.3 / Cinnamon 6.6.9 / X11 —
see §4.1 for other untested-but-plausible-risk areas (older Cinnamon,
Wayland/portal camera access, true dual-webcam hardware).

## Install

**1. Get the code.**

```bash
git clone <this-repository-url> cinnamon-privacy-indicator
cd cinnamon-privacy-indicator
```

(Or download and extract a release archive instead — either way you
need a local directory containing `metadata.json`, `applet.js`, etc.)

**2. Check dependencies.** Both are near-universal on a Cinnamon
desktop, but confirm before filing a "camera/mic detection doesn't
work" issue:

```bash
which fuser     # psmisc — needed for camera detection
which pw-dump   # PipeWire — needed for microphone detection
```

- `fuser` missing → install `psmisc` (`sudo apt install psmisc` on
  Debian/Ubuntu/Mint, or your distro's equivalent).
- `pw-dump` missing → your system isn't running PipeWire as its audio
  server (check `pactl info` for `Server Name: PulseAudio (on
  PipeWire ...)`). Camera detection still works fine without it —
  microphone detection just won't, and the applet tells you so instead
  of silently doing nothing (see **Requirements** above and §4.1 of
  `project_spec.md`).

**3. Copy into Cinnamon's applets directory.**

```bash
mkdir -p ~/.local/share/cinnamon/applets/cinnamon-privacy-indicator@vibhs
cp -r ./* ~/.local/share/cinnamon/applets/cinnamon-privacy-indicator@vibhs/
```

**4. Reload Cinnamon so it picks up the new applet** — see **Reload
after changes** below.

**5. Add it to a panel.** Right-click any panel → **Applets** → find
**Privacy Indicator** → **+ Add to panel**.

The applet has no permanent panel icon — it only appears while the
camera or microphone is actively in use (see §8.1 of `project_spec.md`),
or if microphone detection itself is unavailable (a gray "!" icon —
click it for details; see §4.1). When otherwise idle there's nothing to
click, so manage it (remove it, change its poll interval) from
**Applets** in that same panel-editing window instead of right-clicking
a live icon.

## Reload after changes

```bash
cinnamon --replace &
```

Equivalent to Alt+F2 → `r` → Enter.

## Verify

There's no automated test suite — this is a live-desktop-shell applet.
Check it manually against `project_spec.md` §10:

- No activity → no icon in the panel at all (hidden, not just dimmed).
- Open a webcam stream (`cheese`, or a browser tab requesting camera
  permission) → the green camera icon appears within ~2s; click shows
  the process name and PID.
- Start a recording (`arecord -d 10 /tmp/test.wav`, or a browser tab
  requesting mic permission) → the orange mic icon appears; click shows
  the process name.
- Run both at once → the red combined icon appears, not two overlapping
  icons.
- Stop either → the icon disappears again within ~2s.
- On a machine with no `/dev/video*` at all, the applet loads without
  errors and the camera state simply never activates.
- On a system without PipeWire (no `pw-dump`), the gray "!" icon
  appears even with nothing active, and clicking it shows "Microphone:
  detection unavailable (pw-dump not found — requires PipeWire)" — this
  is the one case where the icon is persistent rather than
  activity-only, precisely so a broken detector doesn't look identical
  to "all quiet" forever.
- Use **Looking Glass** (Menu → search "Looking Glass") to watch for
  exceptions while testing.
- Disable/re-enable the applet several times in a row (simulating dev
  reload cycles) and watch `top`/`htop` for the Cinnamon process — CPU
  should stay flat, not climb, confirming the poll timer isn't stacking.

## Settings

Right-click the applet → **Configure...** to change the poll interval
(default 2s, 1-30s range).

## License

GPL-2.0-or-later — see `LICENSE`. Matches Cinnamon's own license and
the convention for Cinnamon Spices applets; `applet.js` imports
Cinnamon's own GPL-licensed UI modules (`imports.ui.applet`, etc.)
directly.

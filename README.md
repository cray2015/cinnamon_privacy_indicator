# Cinnamon Privacy Indicator

A Cinnamon panel applet that lights up when the camera or microphone is
actively in use, and shows which process is responsible on click. A red
ring around the icon additionally indicates the screen is being
captured (screen share, recording, remote access) — see **Screen-share
detection** below for exactly what that does and doesn't catch. See
`project_spec.md` for the full design rationale and `docs/architecture.d2`
for the architecture diagram.

**Status:** the camera/mic feature set is submitted to [Cinnamon Spices](https://cinnamon-spices.linuxmint.com/applets)
— see [PR #9080](https://github.com/linuxmint/cinnamon-spices-applets/pull/9080),
awaiting review. Until it's merged, install manually using the steps
below; this repo itself is not affected by whether that PR is
accepted — it stays a normal standalone clone-and-copy install either
way (see `project_spec.md` §4.3 for how the two relate). Screen-share
detection (below) is **not** part of that PR — it ships only in this
standalone repo for now, since it adds a Python runtime dependency that
doesn't fit Cinnamon Spices' plain-JS packaging conventions; see
`project_spec.md` §7.3.

**Requirements:** Cinnamon 4.0+ (declared in `metadata.json`; older
versions refuse to load with a clean error instead of crashing). Camera
detection needs `fuser` (psmisc, near-universal on desktop distros).
Microphone detection needs PipeWire (`pw-dump`) — on a PulseAudio-only
system without PipeWire, mic detection is unavailable; see §4.1 of
`project_spec.md` for how that's surfaced instead of silently doing
nothing. Screen-share detection needs X11 (not Wayland) and
`python3-xlib` — see **Screen-share detection** below; it degrades
silently (no ring, ever) if either is missing, the rest of the applet
is unaffected either way. Only tested so far on Linux Mint 22.3 /
Cinnamon 6.6.9 / X11 — see §4.1 for other untested-but-plausible-risk
areas (older Cinnamon, Wayland/portal camera access, true dual-webcam
hardware).

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
which fuser                     # psmisc — needed for camera detection
which pw-dump                   # PipeWire — needed for microphone detection
python3 -c "import Xlib.ext.record, Xlib.ext.res"  # python3-xlib — needed for screen-share detection
```

- `fuser` missing → install `psmisc` (`sudo apt install psmisc` on
  Debian/Ubuntu/Mint, or your distro's equivalent).
- `pw-dump` missing → your system isn't running PipeWire as its audio
  server (check `pactl info` for `Server Name: PulseAudio (on
  PipeWire ...)`). Camera detection still works fine without it —
  microphone detection just won't, and the applet tells you so instead
  of silently doing nothing (see **Requirements** above and §4.1 of
  `project_spec.md`).
- `python3-xlib` missing or the import fails → install it
  (`sudo apt install python3-xlib` on Debian/Ubuntu/Mint, or `pip
  install python-xlib`). Camera and mic detection are completely
  unaffected — only the red screen-share ring never appears.

**3. Copy into Cinnamon's applets directory.**

```bash
mkdir -p ~/.local/share/cinnamon/applets/cinnamon-privacy-indicator@cray2015
cp -r ./* ~/.local/share/cinnamon/applets/cinnamon-privacy-indicator@cray2015/
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
- Start a **real** screen share or capture → a red ring appears around
  whatever the camera/mic icon already shows, including the dim idle
  glyph if neither is active. Test with real tools, not only a
  synthetic `GetImage` loop: each tool reads the screen differently,
  and a synthetic loop only exercises one of them. At minimum: a
  browser "Entire Screen" share (e.g. Google Meet), a browser "A
  Window" share, and an OBS window source with cursor capture on.
  Take a single one-off screenshot → no ring. Stop the capture → the
  ring disappears within a few seconds.
- Check `ps aux | grep screen_share_helper` before and after several
  `cinnamon --replace` reload cycles — exactly one helper process
  should exist, never more (confirms `PR_SET_PDEATHSIG` is working; see
  **Screen-share detection** above for the one case this doesn't cover).
- Use **Looking Glass** (Menu → search "Looking Glass") to watch for
  exceptions while testing.
- Disable/re-enable the applet several times in a row (simulating dev
  reload cycles) and watch `top`/`htop` for the Cinnamon process — CPU
  should stay flat, not climb, confirming the poll timer isn't stacking.

## Screen-share detection

X11 has no broker for screen reads the way v4l2 (camera) or PipeWire
(mic) are brokers for their devices — any app can read the screen
directly, with no permission check and no record of it anywhere in
`/proc`. The ring works by watching the X server's protocol traffic
itself (the `RECORD` extension) for the requests that read screen
pixels, not a list of known apps:

- `CopyArea` out of the root window or out of another window's pixmap
  — how Chromium-based browsers (Meet, Teams, Zoom in the browser) do
  "Entire Screen" and "A Window" shares.
- `GetCursorImage` polled every frame — how tools that read a window on
  the GPU (OBS "Window Capture (Xcomposite)") draw the cursor in.
- `GetImage`/`ShmGetImage` — screenshot tools, `ffmpeg -f x11grab`, and
  fallback paths.

Verified on real shares: Google Meet "Entire Screen" in Brave and an
OBS window source. See `project_spec.md` §7.3 for how each signal was
found and verified.

Not covered:
- OBS-style window capture with **"Capture Cursor" turned off** — no
  request is sent per frame at all.
- A window share that was already running before the applet started
  (e.g. across a Cinnamon reload) — restart the share to pick it up.
- A browser **"Tab"** share — captured inside the browser, never
  touching the X server.

What it deliberately does **not** flag:
- A single screenshot — the ring only lights up after several reads in
  quick succession (tuned to catch real capture within about a second
  while ignoring one-off screenshots; see the constants and rationale
  at the top of `screen_share_helper.py`).
- Anything on Wayland — the whole mechanism this relies on doesn't
  exist there (Wayland mediates screen capture through the compositor
  instead, which is a cleaner design but a different one).

**Known limitation:** the helper process is guaranteed to be cleaned up
whenever Cinnamon itself restarts or you log out (verified — it uses
`PR_SET_PDEATHSIG` so the kernel kills it the moment its parent
process exits, not just on a graceful shutdown). Removing *only this
applet* from the panel while leaving Cinnamon running is **not**
currently guaranteed to stop the helper immediately in every case —
testing found Cinnamon doesn't always invoke the applet's own cleanup
hook for that specific action in this environment. Worst case, a
removed instance's helper keeps running (consuming the same negligible
CPU a normal active ring would — see `project_spec.md` §7.3's measured
cost) until the next Cinnamon restart or logout, not indefinitely.

## Settings

Right-click the applet → **Configure...** to change the poll interval
(default 2s, 1-30s range). Screen-share detection has no separate
setting — it's automatic when available, silent when not (see above).

## License

GPL-2.0-or-later — see `LICENSE`. Matches Cinnamon's own license and
the convention for Cinnamon Spices applets; `applet.js` imports
Cinnamon's own GPL-licensed UI modules (`imports.ui.applet`, etc.)
directly.

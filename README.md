# Cinnamon Privacy Indicator

A Cinnamon panel applet that tells you when something is using your
camera, microphone or screen, like the privacy indicators in macOS and
iOS.

- **Panel icon:** green for the camera, orange for the microphone,
  split green/orange for both. It only appears while something is
  active. Click it to see which apps are responsible.
- **Screen-capture ring:** a red ring around the icon while an app
  captures your screen (screen sharing, recording, remote access).
- **Notifications:** names the app as soon as it starts using any of
  the three, even while your screen is locked.

**Status:** version 1.0 (camera and microphone only) is submitted to
[Cinnamon Spices](https://cinnamon-spices.linuxmint.com/applets)
([PR #9080](https://github.com/linuxmint/cinnamon-spices-applets/pull/9080)),
awaiting review. Screen-capture detection and notifications will follow
in the official Cinnamon Spices repo once the applet itself is approved
and merged. Until then, install from this repo.

## Requirements

- Cinnamon 4.0 or newer
- `fuser` (package `psmisc`) for the camera
- PipeWire (`pw-dump`) for the microphone
- An X11 session and `python3-xlib` for screen capture (doesn't work on Wayland)

Everything except Cinnamon is optional: a missing piece only disables
its own feature. Tested on Linux Mint 22.3, Cinnamon 6.6.9, X11.

## Install

```bash
git clone https://github.com/cray2015/cinnamon_privacy_indicator.git
cd cinnamon_privacy_indicator
sudo apt install psmisc python3-xlib   # if not already installed
mkdir -p ~/.local/share/cinnamon/applets/cinnamon-privacy-indicator@cray2015
cp -r ./* ~/.local/share/cinnamon/applets/cinnamon-privacy-indicator@cray2015/
```

Then reload Cinnamon (below), right-click a panel → **Applets** → find
**Privacy Indicator** → **+ Add to panel**.

The icon is hidden while nothing is active, so to configure or remove
the applet, use that same **Applets** window.

## Reload after changes

Press Alt+F2, type `r`, press Enter. Or in a terminal:

```bash
cinnamon --replace &
```

## Quick test

No terminal needed. The icon updates within about 2 seconds. Screen
capture has been tested with Chromium-based browsers (Brave, Chrome);
other browsers may work but are untested.

| Test | What to do | What you should see |
|---|---|---|
| Camera | Open [webcamtests.com](https://webcamtests.com), start the test and allow the camera | Green icon and a "Camera in use" notification |
| Microphone | Open [mictests.com](https://mictests.com), click **Test my mic** and allow the mic | Orange icon and a "Microphone in use" notification |
| Screen capture | Open the [WebRTC screen-sharing demo](https://webrtc.github.io/samples/src/content/getusermedia/getdisplaymedia/), click **Start** and choose **Entire screen** or **Window** (not a tab) | Red ring around the icon and a "Screen being captured" notification |

Close the tab or stop sharing, and the icon or ring disappears within a
few seconds.

## Settings

Right-click the icon → **Configure...** (or use the **Applets** window):

- **Polling interval** for camera and mic checks: default 2 seconds.
- **Notifications**: on by default.

## Notifications

- Shown when an app **starts** using the camera, microphone or screen
  capture, never when it stops.
- They stay in Cinnamon's notification list until you dismiss them,
  and still fire (with sound) while the screen is locked.
- Cinnamon's **Do not disturb** silences them.
- There's no cooldown: an app that pauses and resumes is reported
  again.
- Opening Cinnamon's **Sound** settings triggers a microphone
  notification. That's correct: its input level meter reads the mic.

## Troubleshooting

**Camera never shows.** Check `fuser` is installed, then run this while
the camera is on:

```bash
fuser /dev/video*
```

Expected: one or more process IDs. No output means no app has the
camera open.

**Microphone never shows, or there's a gray "!" icon.** The gray icon
means PipeWire wasn't found. Check:

```bash
pw-dump | grep -c Stream/Input/Audio
```

Expected while recording: `1` or more. `command not found` means your
system doesn't use PipeWire, so microphone detection can't work.

**Screen-capture ring never shows.** Run each of these:

```bash
echo $XDG_SESSION_TYPE                                    # expected: x11
python3 -c "import Xlib.ext.record, Xlib.ext.res; print('ok')"   # expected: ok
pgrep -af screen_share_helper                             # expected: exactly one line, python3 …/screen_share_helper.py
```

`wayland` means screen-capture detection isn't possible. An import
error means `python3-xlib` is missing. No helper line means it failed
to start: check `~/.xsession-errors` for a line mentioning
`cinnamon-privacy-indicator@cray2015`.

**No notifications.** Make sure they're switched on in **Configure...**
and that Do not disturb is off:

```bash
gsettings get org.cinnamon.desktop.notifications display-notifications   # expected: true
```

**Something else.** Reload Cinnamon (Alt+F2, `r`) and try again.
Developer-level checks are in `project_spec.md` §10.

## Screen-capture detection

X11 has no permission system for reading the screen, so the applet
watches the display server for the requests apps use to read screen
pixels. Tested with Google Meet in Brave ("Entire screen" and
"Window"), OBS, and screenshot-style capture.

Not detected:
- **Browser tab sharing.** The browser captures the tab internally,
  so nothing outside it can see this. Rely on the browser's own
  indicator.
- **OBS window capture with "Capture Cursor" turned off.**
- **Wayland sessions.**
- **A single screenshot.** This is intentional: only ongoing capture
  counts.

Details: `project_spec.md` §7.3.

## License

GPL-2.0-or-later, see `LICENSE`.

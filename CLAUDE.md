# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Build Commands
```bash
# install — symlink or copy applet into Cinnamon's applet directory
mkdir -p ~/.local/share/cinnamon/applets/cinnamon-privacy-indicator@cray2015
cp -r ./* ~/.local/share/cinnamon/applets/cinnamon-privacy-indicator@cray2015/
# Cinnamon applets are plain JS/JSON, no compile step — "build" is just
# placing files where Cinnamon's applet loader looks for them.

# reload — restart Cinnamon shell to pick up applet changes
cinnamon --replace &
# Expands to: relaunches the Cinnamon shell process in place, reloading all
# applets. Equivalent to Alt+F2 → type 'r' → Enter, done from a terminal.
```
No automated test suite — Cinnamon applets run inside a live desktop shell
and don't have a meaningful headless test target. Verification is manual
against `project_spec.md` §10's acceptance criteria, using real webcam/mic
activity (browser permission prompts, `cheese`, `arecord`) as test input.
Use Cinnamon's built-in JS console ("Looking Glass" — Menu → search
"Looking Glass", or `lg` command in the Cinnamon debug shell) to inspect
applet state and catch exceptions during development.

## Key Constraints
- **All subprocess calls must be async (`Gio.Subprocess`), never
  synchronous.** — A blocking call freezes the entire Cinnamon shell, not
  just this applet, since everything shares one GJS main loop. See
  `PROJECT_SPEC.md` §4.
- **Must not error or show a stuck state when `/dev/video*` doesn't
  exist.** — This machine has no built-in webcam; absence of the device
  node is an expected, common case, not a failure. See `PROJECT_SPEC.md`
  §4.
- **Resolve PIDs via `/proc/<pid>/comm`, not a second `ps` subprocess
  call.** — Avoids doubling the subprocess overhead of the polling loop.
  See `PROJECT_SPEC.md` §7.1.
- **Poll interval default is 2 seconds.** — Tighter intervals increase
  subprocess spawn frequency for marginal responsiveness gain; this is a
  deliberate trade-off, not an arbitrary placeholder. See
  `PROJECT_SPEC.md` §4.
- **Clear the polling timer's GLib source in `on_applet_removed_from_panel`
  before ever creating a new one; never let two poll cycles run
  concurrently.** — Leaked/stacked timers across reloads are the most
  common cause of Cinnamon applets silently climbing in CPU usage over a
  dev session, and are why previous applets built here have had to be
  disabled outright. Treat this as a correctness requirement, not
  polish. See `PROJECT_SPEC.md` §4.

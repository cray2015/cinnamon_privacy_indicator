#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 the cinnamon-privacy-indicator contributors
#
# Detects sustained screen-capture activity on X11 and prints state-change
# lines to stdout for applet.js to read asynchronously:
#   READY                 -- startup succeeded, now watching
#   ACTIVE <pid>[,<pid>]  -- one or more clients are actively reading the
#                            screen (sustained, not a one-off screenshot)
#   IDLE                  -- no client is currently reading the screen
#
# On startup failure (missing python3-xlib, or the X server lacks the
# RECORD/X-Resource extensions), prints one line to stderr and exits
# non-zero so the caller can distinguish "not supported here" from
# "supported, currently idle".
#
# Why this exists at all: X11 has no broker for screen reads the way
# v4l2 (camera) or PipeWire (mic) are brokers for their devices -- any
# client can read any window, including the root window (whole screen),
# with no permission check. The RECORD extension is the one mechanism
# that can observe this: a client can ask the X server to replicate a
# live copy of specific protocol requests made by *any other* client.
# Filtering it to the requests that read screen pixels turns "which
# known apps can we recognize" into "catch anything that reads the
# screen" -- see project_spec.md 7.3 for the full design rationale,
# including the measured CPU cost and the false-positive tradeoffs of
# the constants below.
#
# Signals counted as "reading the screen", each verified against a real
# capture tool on this machine (see project_spec.md 7.3):
#   - core GetImage / MIT-SHM ShmGetImage on any drawable.
#   - core CopyArea whose source belongs to a different process than the
#     one copying (the root window counts: the X server owns it). Apps
#     copy between their own windows/pixmaps constantly; copying another
#     app's window is reading its pixels. This is how Chromium's WebRTC
#     X11 capturer (x_server_pixel_buffer.cc) works: CopyArea into a
#     MIT-SHM pixmap, from the root window for "Entire Screen" and
#     straight from the target window for "A Window" (observed in Brave;
#     it did not use NameWindowPixmap). Watching only *GetImage misses
#     every Chromium share.
#   - core CopyArea from a pixmap obtained via Composite NameWindowPixmap
#     (the copier owns that pixmap, so the rule above can't see it). From
#     Chromium's source; not observed on a real share yet.
#   - XFixes GetCursorImage. Tools that read a window as a GPU texture
#     (OBS "Window Capture (Xcomposite)") send no pixel-reading request
#     per frame at all, but they poll the cursor image once per output
#     frame to draw it into the capture. Nothing else on a normal
#     desktop polls it (Cinnamon/Muffin never calls it).
import ctypes
import signal
import struct
import sys
import time
import threading

try:
    from Xlib import display
    from Xlib.ext import record, res
except ImportError:
    print("python3-xlib not available", file=sys.stderr)
    sys.exit(1)


def _die_with_parent():
    # applet.js kills us explicitly on a clean panel removal, but
    # `cinnamon --replace` (or a crash) tears down the parent process
    # without running that cleanup at all -- a plain child process does
    # NOT exit just because its parent did, so without this, the old
    # helper leaks and keeps running as every subsequent reload spawns
    # another one. This is the exact "stacked background process across
    # reloads" failure mode CLAUDE.md calls out for the poll timer; a
    # second OS process needs its own, OS-level version of the same
    # guarantee. PR_SET_PDEATHSIG asks the kernel to SIGTERM us the
    # moment our parent exits, cleanly or not -- verified empirically
    # (see project_spec.md 7.3) by killing a real `cinnamon --replace`
    # parent and confirming this process no longer survives it.
    try:
        libc = ctypes.CDLL("libc.so.6", use_errno=True)
        PR_SET_PDEATHSIG = 1
        libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM)
    except Exception:
        pass  # best-effort -- non-Linux or no libc.prctl; applet.js's
              # explicit force_exit() on clean removal still applies.

X_FreePixmap = 54           # core opcodes
X_CopyArea = 62
X_GetImage = 73
X_ShmGetImage = 4           # MIT-SHM minor opcode
X_CompositeNameWindowPixmap = 6   # Composite minor opcode
X_XFixesGetCursorImage = 4  # XFIXES minor opcode

# Tuning constants -- approximate thresholds, not exact science.
# A single screenshot is one GetImage call; real capture tools (screen
# share, recorders) call it repeatedly, several times a second. Requiring
# MIN_SUSTAINED_EVENTS within SUSTAIN_WINDOW filters out the former while
# catching the latter almost immediately. IDLE_GRACE avoids flapping
# between frames of a capture that isn't running at a perfectly steady
# rate. See project_spec.md 7.3 for how these were chosen.
SUSTAIN_WINDOW = 1.5
MIN_SUSTAINED_EVENTS = 3
IDLE_GRACE = 2.5
TICK_INTERVAL = 0.5


def main():
    _die_with_parent()
    try:
        record_dpy = display.Display()
        res_dpy = display.Display()
        # python-xlib connections aren't thread-safe; this one is used
        # only from the RECORD callback thread.
        owner_dpy = display.Display()
    except Exception as e:
        print("cannot connect to X display: %s" % e, file=sys.stderr)
        sys.exit(1)

    if not record_dpy.has_extension("RECORD"):
        print("RECORD extension not available on this X server", file=sys.stderr)
        sys.exit(1)

    try:
        res_dpy.res_query_version()
    except Exception as e:
        print("X-Resource extension not available: %s" % e, file=sys.stderr)
        sys.exit(1)

    # An XID's high bits identify the client that created it; the mask is
    # the same for every client on a server.
    resource_mask = record_dpy.display.info.resource_id_mask

    # Client XID base -> PID, via X-Resource. Compared by process, not
    # connection, because one app can hold several connections (Brave
    # holds two) and copying between them is not reading another app.
    # Short TTL because the server reuses a base after a client leaves.
    PID_CACHE_TTL = 30.0
    pid_cache = {}

    def pid_of(base):
        if base == 0:
            return None  # the X server itself (root window etc.)
        now = time.monotonic()
        hit = pid_cache.get(base)
        if hit and now - hit[1] < PID_CACHE_TTL:
            return hit[0]
        pid = None
        try:
            r = owner_dpy.res_query_client_ids(
                [{'client': base, 'mask': res.LocalClientPIDMask}])
            for item in r.ids:
                if item.value:
                    pid = item.value[0]
        except Exception:
            pass
        pid_cache[base] = (pid, now)
        return pid

    def copies_foreign_pixels(src, requester_base):
        owner_base = src & ~resource_mask
        if owner_base == requester_base:
            return False
        owner_pid = pid_of(owner_base)
        return owner_pid is None or owner_pid != pid_of(requester_base)

    # Pixmap XIDs are server-wide unique, so one set covers all clients.
    # Only touched from the RECORD thread. A capture already set up
    # before this helper started is unknown until it re-names its pixmap.
    named_window_pixmaps = set()

    # Extension major opcodes are per-server and must be queried.
    def ext_major(name):
        try:
            info = record_dpy.query_extension(name)
            if info and info.present:
                return info.major_opcode
        except Exception:
            pass
        return None

    shm_major = ext_major('MIT-SHM')
    composite_major = ext_major('Composite')
    xfixes_major = ext_major('XFIXES')

    events_lock = threading.Lock()
    events = {}  # id_base (identifies the sending X client) -> [timestamps]

    def u32(data, offset):
        # client_swapped is False for anything we look at, so the request
        # is in our own (native) byte order.
        return struct.unpack_from('=I', data, offset)[0]

    def record_callback(reply):
        if reply.category != record.FromClient:
            return
        if reply.client_swapped:
            return
        data = reply.data
        if len(data) < 2:
            return
        opcode, minor = data[0], data[1]

        if opcode == X_FreePixmap:
            if len(data) >= 8:
                named_window_pixmaps.discard(u32(data, 4))
            return
        if opcode == composite_major and minor == X_CompositeNameWindowPixmap:
            if len(data) >= 12:
                named_window_pixmaps.add(u32(data, 8))
            return

        if opcode == X_CopyArea:
            if len(data) < 8:
                return
            src = u32(data, 4)
            if (src not in named_window_pixmaps and
                    not copies_foreign_pixels(src, reply.id_base)):
                return
        elif not (
            opcode == X_GetImage or
            (opcode == shm_major and minor == X_ShmGetImage) or
            (opcode == xfixes_major and minor == X_XFixesGetCursorImage)
        ):
            return
        now = time.monotonic()
        with events_lock:
            lst = events.setdefault(reply.id_base, [])
            lst.append(now)
            cutoff = now - max(SUSTAIN_WINDOW, IDLE_GRACE)
            while lst and lst[0] < cutoff:
                lst.pop(0)

    def record_range(core=(0, 0), ext=(0, 0, 0, 0)):
        return {
            'core_requests': core,
            'core_replies': (0, 0),
            'ext_requests': ext,
            'ext_replies': (0, 0, 0, 0),
            'delivered_events': (0, 0),
            'device_events': (0, 0),
            'errors': (0, 0),
            'client_started': False,
            'client_died': False,
        }

    # One range per opcode rather than spans like (54, 73): the opcodes in
    # between are the core drawing requests (PolyLine, PutImage, ...) and
    # would flood this process with every app's rendering traffic.
    ranges = [record_range(core=(op, op))
              for op in (X_FreePixmap, X_CopyArea, X_GetImage)]
    for major, minor in ((shm_major, X_ShmGetImage),
                         (composite_major, X_CompositeNameWindowPixmap),
                         (xfixes_major, X_XFixesGetCursorImage)):
        if major is not None:
            ranges.append(record_range(ext=(major, major, minor, minor)))
    ctx = record_dpy.record_create_context(0, [record.AllClients], ranges)

    def run_record():
        # Blocks until record_disable_context() is called from elsewhere;
        # calls record_callback() for every matching request meanwhile.
        record_dpy.record_enable_context(ctx, record_callback)

    record_thread = threading.Thread(target=run_record, daemon=True)
    record_thread.start()

    print("READY", flush=True)

    prev_active_ids = frozenset()
    try:
        while True:
            time.sleep(TICK_INTERVAL)
            now = time.monotonic()
            with events_lock:
                active_ids = []
                for id_base, lst in list(events.items()):
                    while lst and lst[0] < now - IDLE_GRACE:
                        lst.pop(0)
                    if not lst:
                        del events[id_base]
                        continue
                    recent = [ts for ts in lst if ts >= now - SUSTAIN_WINDOW]
                    if len(recent) >= MIN_SUSTAINED_EVENTS:
                        active_ids.append(id_base)
            active_ids = frozenset(active_ids)
            if active_ids == prev_active_ids:
                continue
            prev_active_ids = active_ids
            if not active_ids:
                print("IDLE", flush=True)
                continue
            pids = []
            try:
                specs = [{'client': cid, 'mask': res.LocalClientPIDMask} for cid in active_ids]
                r = res_dpy.res_query_client_ids(specs)
                for item in r.ids:
                    if item.value:
                        pids.append(str(item.value[0]))
            except Exception:
                pass
            if not pids:
                pids = ['unknown']
            print("ACTIVE " + ",".join(pids), flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        try:
            record_dpy.record_disable_context(ctx)
            record_dpy.record_free_context(ctx)
        except Exception:
            pass


if __name__ == '__main__':
    main()

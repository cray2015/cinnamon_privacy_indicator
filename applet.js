// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 the cinnamon-privacy-indicator contributors

const Applet = imports.ui.applet;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const Mainloop = imports.mainloop;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const St = imports.gi.St;
const Gettext = imports.gettext;
const ByteArray = imports.byteArray;

const UUID = 'cinnamon-privacy-indicator@cray2015';

// Bind our own translation domain rather than relying on Cinnamon's global
// gettext setup, which only covers Cinnamon's own strings — without this,
// a translator's po/ files for this applet would never actually apply.
Gettext.bindtextdomain(UUID, GLib.get_user_data_dir() + '/locale');

function _(text) {
    return Gettext.dgettext(UUID, text);
}

const STATE = {
    IDLE: 'idle',
    CAMERA: 'camera',
    MIC: 'mic',
    BOTH: 'both'
};

const ICON_FILES = {
    [STATE.IDLE]: 'idle.svg',
    [STATE.CAMERA]: 'camera-active.svg',
    [STATE.MIC]: 'mic-active.svg',
    [STATE.BOTH]: 'both-active.svg',
    // Not a real activity state — an overlay shown instead of the hidden
    // idle icon when a detector is broken, so a permanently-unavailable
    // feature is discoverable instead of looking identical to "all quiet".
    error: 'error.svg'
};

// Screen-share is an orthogonal signal (ring overlay), not another STATE
// value — any of the four base icons can appear with or without it, so it
// gets its own filename map instead of growing STATE into eight values.
const ICON_FILES_SCREEN_SHARE = {
    [STATE.IDLE]: 'idle-share.svg',
    [STATE.CAMERA]: 'camera-active-share.svg',
    [STATE.MIC]: 'mic-active-share.svg',
    [STATE.BOTH]: 'both-active-share.svg'
};

// One notification per kind of activity, shown when a process starts
// using it (never on stop).
const NOTIFY_KINDS = {
    camera: { title: () => _("Camera in use"), icon: 'camera-active.svg' },
    mic: { title: () => _("Microphone in use"), icon: 'mic-active.svg' },
    screen: { title: () => _("Screen being captured"), icon: 'idle-share.svg' }
};

function iconFromFile(path, size) {
    return new St.Icon({ gicon: new Gio.FileIcon({ file: Gio.File.new_for_path(path) }), icon_size: size });
}

// Cinnamon's message tray respects its own "Do not disturb" switch
// (org.cinnamon.desktop.notifications display-notifications) for every
// source, so nothing here needs to check it.
function PrivacyNotificationSource(iconPath) {
    this._init(iconPath);
}

PrivacyNotificationSource.prototype = {
    __proto__: MessageTray.Source.prototype,

    _init(iconPath) {
        MessageTray.Source.prototype._init.call(this, _("Privacy Indicator"));
        this._setSummaryIcon(iconFromFile(iconPath, this.ICON_SIZE));
    }
    // open() is inherited as a no-op: clicking a notification does nothing.
};

// fuser sends PIDs to stdout and everything else (access-type letters, errors
// for a device with no holder) to stderr, so plain `fuser <paths>` on stdout
// is all we need — no -v table to parse, no ps call to cross-reference.
//
// callback(stdout, errorKind): errorKind is null on success, 'not-found' when
// the binary itself doesn't exist (distinguished via GLib.SpawnError.NOENT so
// callers can tell "this feature isn't available on this system" apart from
// "ran fine, nothing to report" or a one-off transient failure), else 'error'.
function runSubprocessAsync(argv, callback) {
    let proc;
    try {
        proc = new Gio.Subprocess({
            argv: argv,
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
        });
        proc.init(null);
    } catch (e) {
        let notFound = e.matches(GLib.spawn_error_quark(), GLib.SpawnError.NOENT);
        callback('', notFound ? 'not-found' : 'error');
        return;
    }
    proc.communicate_utf8_async(null, null, (source, res) => {
        try {
            let [, stdout] = source.communicate_utf8_finish(res);
            callback(stdout || '', null);
        } catch (e) {
            callback('', 'error');
        }
    });
}

// Async all the way down (enumerate + paged next_files_async), even though
// /dev is a tiny in-memory pseudo-fs — this runs in Cinnamon's own process,
// so any sync I/O here blocks the compositor's main loop, not just us.
function listVideoDevicesAsync(callback) {
    let devDir = Gio.File.new_for_path('/dev');
    devDir.enumerate_children_async(
        'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null,
        (source, res) => {
            let enumerator;
            try {
                enumerator = source.enumerate_children_finish(res);
            } catch (e) {
                // /dev not readable — no video devices to report.
                callback([]);
                return;
            }
            let devices = [];
            let collectNext = () => {
                enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, null, (src2, res2) => {
                    let infos;
                    try {
                        infos = src2.next_files_finish(res2);
                    } catch (e) {
                        infos = [];
                    }
                    if (infos.length === 0) {
                        enumerator.close_async(GLib.PRIORITY_DEFAULT, null, () => {});
                        callback(devices.sort());
                        return;
                    }
                    for (let info of infos) {
                        let name = info.get_name();
                        if (/^video\d+$/.test(name)) {
                            devices.push('/dev/' + name);
                        }
                    }
                    collectNext();
                });
            };
            collectNext();
        }
    );
}

// Resolves several PIDs' process names in parallel and fans back in once
// all have finished — same join pattern _pollTick() uses for camera/mic.
function resolveProcessNamesAsync(pids, callback) {
    let names = {};
    let remaining = pids.length;
    if (remaining === 0) {
        callback(names);
        return;
    }
    for (let pid of pids) {
        let file = Gio.File.new_for_path('/proc/' + pid + '/comm');
        file.load_contents_async(null, (source, res) => {
            try {
                let [ok, contents] = source.load_contents_finish(res);
                names[pid] = ok ? ByteArray.toString(contents).trim() : 'unknown';
            } catch (e) {
                // Process may have exited between fuser's snapshot and this read.
                names[pid] = 'unknown';
            }
            remaining--;
            if (remaining === 0) callback(names);
        });
    }
}

class PrivacyIndicatorApplet extends Applet.IconApplet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this._metadata = metadata;
        this._state = null;
        this._pollInFlight = false;
        this._timeoutId = null;
        this._cameraProcesses = [];
        this._micProcesses = [];
        // null = not checked yet, true = pw-dump present, false = missing.
        this._micDetectionAvailable = null;

        this._screenShareProc = null;
        this._screenShareActive = false;
        this._screenShareProcesses = [];
        // null = not checked yet, true = helper confirmed watching, false =
        // unavailable (not X11, python3-xlib missing, or the X server lacks
        // RECORD/X-Resource). Unlike mic, this degrades silently (no error
        // icon) — see _startScreenShareMonitor() and project_spec.md §7.3.
        this._screenShareDetectionAvailable = null;

        // Processes already seen using each kind of activity, so a
        // notification fires only when a new one starts.
        this._knownUsers = { camera: new Set(), mic: new Set(), screen: new Set() };
        this._notifySource = null;

        this.settings = new Settings.AppletSettings(this, metadata.uuid, instance_id);
        this._pollIntervalSec = 2;
        this.settings.bind('poll-interval', 'pollIntervalSetting', this._onPollIntervalChanged.bind(this));
        this._pollIntervalSec = Math.max(1, this.pollIntervalSetting || 2);
        this.settings.bind('notifications-enabled', 'notificationsEnabled');

        this.menuManager = new PopupMenu.PopupMenuManager(this);
        this.menu = new Applet.AppletPopupMenu(this, orientation);
        this.menuManager.addMenu(this.menu);

        this._applyIcon(STATE.IDLE);
        this.set_applet_tooltip(_("No camera or microphone activity detected."));
        // Mirrors the macOS/iOS privacy dot this applet is modeled on: no
        // permanent panel slot, it only appears while something is active.
        this.actor.hide();

        this._startPolling();
        this._startScreenShareMonitor();
    }

    _onPollIntervalChanged() {
        this._pollIntervalSec = Math.max(1, this.pollIntervalSetting || 2);
        this._startPolling();
    }

    _applyIcon(state, screenShareActive) {
        let filename = (screenShareActive && ICON_FILES_SCREEN_SHARE[state])
            ? ICON_FILES_SCREEN_SHARE[state] : ICON_FILES[state];
        let path = this._metadata.path + '/icons/' + filename;
        this.set_applet_icon_path(path);
    }

    _startPolling() {
        this._stopPolling();
        this._pollTick();
        this._timeoutId = Mainloop.timeout_add_seconds(this._pollIntervalSec, () => this._pollTick());
    }

    _stopPolling() {
        if (this._timeoutId !== null) {
            Mainloop.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }

    _pollTick() {
        if (this._pollInFlight) {
            // Previous poll's subprocesses haven't returned yet — skip this
            // tick rather than stacking a second round of detection calls.
            return GLib.SOURCE_CONTINUE;
        }
        this._pollInFlight = true;

        let camDone = false;
        let micDone = false;
        let finish = () => {
            if (camDone && micDone) {
                this._pollInFlight = false;
                this._updateState();
            }
        };

        this._checkCamera((processes) => {
            this._cameraProcesses = processes;
            this._reportUsers('camera', processes, processes.length > 0);
            camDone = true;
            finish();
        });

        this._checkMic((processes) => {
            this._micProcesses = processes;
            this._reportUsers('mic', processes, processes.length > 0);
            micDone = true;
            finish();
        });

        return GLib.SOURCE_CONTINUE;
    }

    _checkCamera(callback) {
        listVideoDevicesAsync((devices) => {
            if (devices.length === 0) {
                callback([]);
                return;
            }
            // errorKind is ignored here: fuser (psmisc) is near-universal on
            // desktop distros, unlike pw-dump/PipeWire — see _checkMic.
            runSubprocessAsync(['fuser'].concat(devices), (stdout, errorKind) => {
                let matches = stdout.match(/\d+/g);
                if (!matches) {
                    callback([]);
                    return;
                }
                let seen = {};
                let uniquePids = [];
                for (let pid of matches) {
                    if (seen[pid]) continue;
                    seen[pid] = true;
                    uniquePids.push(pid);
                }
                resolveProcessNamesAsync(uniquePids, (names) => {
                    callback(uniquePids.map(pid => ({ pid: pid, name: names[pid] })));
                });
            });
        });
    }

    // pw-dump queries PipeWire's own graph directly, rather than going
    // through the PulseAudio compatibility shim (pipewire-pulse). That shim
    // doesn't reliably surface every active capture — e.g. ALSA-plugin
    // clients can be missed or show only a running/idle "source-output"
    // regardless of whether audio is actually flowing. pw-dump's node
    // `state` field ("running" vs "idle"/"suspended") is the accurate
    // "is this actually capturing right now" signal.
    _checkMic(callback) {
        runSubprocessAsync(['pw-dump'], (stdout, errorKind) => {
            if (errorKind === 'not-found') {
                // Distinct from "no mic activity": this system has no
                // PipeWire at all, so mic detection can never work here.
                // Log once (not every poll) so it's discoverable via
                // Looking Glass instead of silently looking like idle
                // forever; _buildMenu() also surfaces it in the popup.
                if (this._micDetectionAvailable !== false) {
                    this._micDetectionAvailable = false;
                    global.logWarning('[' + UUID + '] ' +
                        'pw-dump not found — microphone detection is unavailable ' +
                        '(requires PipeWire). Camera detection is unaffected.');
                }
                callback([]);
                return;
            }

            let processes = [];
            if (errorKind === null) {
                this._micDetectionAvailable = true;
                try {
                    let data = JSON.parse(stdout || '[]');
                    for (let obj of data) {
                        if (obj.type !== 'PipeWire:Interface:Node') continue;
                        let info = obj.info || {};
                        let props = info.props || {};
                        if (props['media.class'] !== 'Stream/Input/Audio') continue;
                        if (info.state !== 'running') continue;
                        let name = props['application.name'] || props['node.name'] || 'unknown';
                        let pid = props['application.process.id'] || null;
                        processes.push({ pid: pid, name: name });
                    }
                } catch (e) {
                    // pw-dump ran but gave malformed output — no mic activity
                    // to report this tick, but don't flip availability off;
                    // that's reserved for "the binary doesn't exist at all".
                }
            }
            // errorKind === 'error': one-off transient failure (e.g. a
            // communicate_utf8_async hiccup) — treat as no data this tick,
            // same as before, without touching _micDetectionAvailable.
            callback(processes);
        });
    }

    // Long-lived helper (not another poll-tick subprocess): it blocks
    // inside the X11 RECORD extension's event loop, so it has to be a
    // persistent process we read incrementally from, not a spawn-wait-reap
    // like fuser/pw-dump. See screen_share_helper.py and project_spec.md
    // §7.3 for why no GJS/GObject-Introspection binding exists for this and
    // a separate Python process is unavoidable.
    _startScreenShareMonitor() {
        let sessionType = GLib.getenv('XDG_SESSION_TYPE');
        if (sessionType !== 'x11') {
            // Expected on Wayland, not a failure — the whole detection
            // mechanism (X11 RECORD) doesn't exist there. Logged once so
            // it's still discoverable via Looking Glass rather than just
            // silently never showing a ring.
            this._screenShareDetectionAvailable = false;
            global.logWarning('[' + UUID + '] Screen-share detection requires ' +
                'an X11 session (this session is \'' + (sessionType || 'unknown') +
                '\') — skipping.');
            return;
        }

        let proc;
        try {
            proc = new Gio.Subprocess({
                argv: ['python3', this._metadata.path + '/screen_share_helper.py'],
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            });
            proc.init(null);
        } catch (e) {
            this._screenShareDetectionAvailable = false;
            global.logWarning('[' + UUID + '] Screen-share detection unavailable ' +
                '— could not start helper (is python3 installed?): ' + e.message);
            return;
        }

        this._screenShareProc = proc;
        let stdout = new Gio.DataInputStream({ base_stream: proc.get_stdout_pipe() });
        let stderrStream = new Gio.DataInputStream({ base_stream: proc.get_stderr_pipe() });

        // Fires whenever the helper exits — on startup failure (missing
        // python3-xlib, no RECORD/XRes extension) or an unexpected crash.
        // Mirrors _checkMic()'s pattern: surface it once via logWarning
        // rather than silently degrading to "ring never appears".
        proc.wait_async(null, (source, res) => {
            try {
                source.wait_finish(res);
            } catch (e) { /* ignore */ }
            // this._screenShareProc was already nulled out by
            // _stopScreenShareMonitor() on an intentional shutdown —
            // don't log a false "unavailable" warning for that case.
            if (this._screenShareProc !== proc) return;
            this._screenShareProc = null;
            this._screenShareDetectionAvailable = false;
            this._screenShareActive = false;
            this._screenShareProcesses = [];
            this._reportUsers('screen', [], false);
            stderrStream.read_line_async(GLib.PRIORITY_DEFAULT, null, (src2, res2) => {
                let reason = 'exited unexpectedly';
                try {
                    let [line] = src2.read_line_finish_utf8(res2);
                    if (line) reason = line;
                } catch (e) { /* ignore */ }
                global.logWarning('[' + UUID + '] Screen-share detection unavailable — ' + reason);
                this._updateState();
            });
        });

        let readNextLine = () => {
            stdout.read_line_async(GLib.PRIORITY_DEFAULT, null, (source, res) => {
                let line;
                try {
                    [line] = source.read_line_finish_utf8(res);
                } catch (e) {
                    return; // stream closed — wait_async above handles cleanup
                }
                if (line === null) return; // EOF
                this._onScreenShareLine(line.trim());
                readNextLine();
            });
        };
        readNextLine();
    }

    _onScreenShareLine(line) {
        if (line === 'READY') {
            this._screenShareDetectionAvailable = true;
            return;
        }
        if (line === 'IDLE') {
            this._screenShareActive = false;
            this._screenShareProcesses = [];
            this._reportUsers('screen', [], false);
            this._updateState();
            return;
        }
        if (line.indexOf('ACTIVE') === 0) {
            let pids = line.substring('ACTIVE'.length).trim()
                .split(',').map(s => s.trim()).filter(s => s && s !== 'unknown');
            this._screenShareActive = true;
            if (pids.length === 0) {
                this._screenShareProcesses = [];
                this._reportUsers('screen', [], true);
                this._updateState();
                return;
            }
            resolveProcessNamesAsync(pids, (names) => {
                this._screenShareProcesses = pids.map(pid => ({ pid: pid, name: names[pid] }));
                this._reportUsers('screen', this._screenShareProcesses, true);
                this._updateState();
            });
        }
    }

    _stopScreenShareMonitor() {
        if (this._screenShareProc) {
            let proc = this._screenShareProc;
            this._screenShareProc = null;
            try {
                proc.force_exit();
            } catch (e) { /* already gone */ }
        }
    }

    // Remembers who is using `kind` now and notifies about anyone new.
    // No cooldown by design: a process that stops and starts again is
    // notified again.
    _reportUsers(kind, processes, active) {
        let users = processes.length > 0 ? processes
            : (active ? [{ pid: null, name: _("unknown process") }] : []);
        let current = new Set();
        let started = [];
        for (let p of users) {
            let key = p.pid ? 'pid:' + p.pid : 'name:' + p.name;
            // One app can hold several streams at once (OBS: two mic
            // capture nodes) -- report it once.
            if (current.has(key)) continue;
            current.add(key);
            if (!this._knownUsers[kind].has(key)) started.push(p);
        }
        this._knownUsers[kind] = current;
        if (started.length > 0 && this.notificationsEnabled) {
            this._notify(kind, started);
        }
    }

    _notify(kind, processes) {
        let iconDir = this._metadata.path + '/icons/';
        if (!this._notifySource) {
            this._notifySource = new PrivacyNotificationSource(iconDir + 'both-active.svg');
            // The tray destroys a source once its last notification is
            // gone; recreate it on the next notify.
            this._notifySource.connect('destroy', () => { this._notifySource = null; });
            Main.messageTray.add(this._notifySource);
        }
        let body = processes.map(p =>
            p.pid ? _("%s (PID %s)").format(p.name, p.pid) : p.name).join(', ');
        let notification = new MessageTray.Notification(
            this._notifySource, NOTIFY_KINDS[kind].title(), body,
            { icon: iconFromFile(iconDir + NOTIFY_KINDS[kind].icon, this._notifySource.ICON_SIZE) });
        this._notifySource.notify(notification);
    }

    _updateState() {
        let hasCam = this._cameraProcesses.length > 0;
        let hasMic = this._micProcesses.length > 0;
        let hasScreenShare = this._screenShareActive;
        let micBroken = this._micDetectionAvailable === false;

        let state = STATE.IDLE;
        if (hasCam && hasMic) state = STATE.BOTH;
        else if (hasCam) state = STATE.CAMERA;
        else if (hasMic) state = STATE.MIC;
        this._state = state;

        // Idle now means all three signals are quiet, not just cam/mic —
        // screen-share-alone is not idle, it just has nothing to put
        // inside the ring (falls back to the dim idle glyph, see
        // ICON_FILES_SCREEN_SHARE).
        let idle = (state === STATE.IDLE) && !hasScreenShare;

        // Icon/visibility are recomputed unconditionally every tick (not
        // just on a state change) so neither can stay desynced from the
        // actual state — this bit the applet once already (see commit
        // history / prior bugfix) when it was gated on a state transition.
        //
        // Idle is normally hidden entirely (§8.1), but a broken mic
        // detector needs to be discoverable even with nothing active —
        // otherwise it's silently indistinguishable from "all quiet"
        // forever, which defeats the point of surfacing it at all (see
        // _checkMic). Screen-share detection being unavailable does NOT
        // get the same treatment — see _startScreenShareMonitor().
        let showError = idle && micBroken;
        this._applyIcon(showError ? 'error' : state, !showError && hasScreenShare);
        if (idle && !showError) {
            this.actor.hide();
        } else {
            this.actor.show();
        }

        this.set_applet_tooltip(this._buildTooltip(hasCam, hasMic, hasScreenShare, showError));
    }

    _buildTooltip(hasCam, hasMic, hasScreenShare, showError) {
        if (showError) return _("Microphone detection unavailable — click for details");
        if (!hasCam && !hasMic && !hasScreenShare) return _("No camera or microphone activity detected.");
        let parts = [];
        if (hasCam) parts.push(_("Camera active"));
        if (hasMic) parts.push(_("Microphone active"));
        if (hasScreenShare) parts.push(_("Screen being captured"));
        return parts.join(' · ');
    }

    _buildMenu() {
        this.menu.removeAll();
        let hasCam = this._cameraProcesses.length > 0;
        let hasMic = this._micProcesses.length > 0;
        let hasScreenShare = this._screenShareActive;
        let micBroken = this._micDetectionAvailable === false;

        let sections = [];

        if (hasCam) {
            let items = [_("Camera:")];
            for (let p of this._cameraProcesses) {
                items.push('  ' + _("%s (PID %s)").format(p.name, p.pid));
            }
            sections.push(items);
        }

        if (hasMic) {
            let items = [_("Microphone:")];
            for (let p of this._micProcesses) {
                let label = p.pid ? _("%s (PID %s)").format(p.name, p.pid) : p.name;
                items.push('  ' + label);
            }
            sections.push(items);
        } else if (micBroken) {
            sections.push([_("Microphone: detection unavailable (pw-dump not found — requires PipeWire)")]);
        }

        if (hasScreenShare) {
            let items = [_("Screen capture:")];
            if (this._screenShareProcesses.length === 0) {
                items.push('  ' + _("Unknown process"));
            } else {
                for (let p of this._screenShareProcesses) {
                    items.push('  ' + _("%s (PID %s)").format(p.name, p.pid));
                }
            }
            sections.push(items);
        }

        if (sections.length === 0) {
            this.menu.addMenuItem(new PopupMenu.PopupMenuItem(
                _("No camera or microphone activity detected."), { reactive: false }));
            return;
        }

        sections.forEach((items, i) => {
            if (i > 0) this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            for (let line of items) {
                this.menu.addMenuItem(new PopupMenu.PopupMenuItem(line, { reactive: false }));
            }
        });
    }

    on_applet_clicked(event) {
        this._buildMenu();
        this.menu.toggle();
    }

    on_applet_removed_from_panel() {
        this._stopPolling();
        this._stopScreenShareMonitor();
        if (this._notifySource) {
            this._notifySource.destroy();
        }
        if (this.settings) {
            this.settings.finalize();
        }
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new PrivacyIndicatorApplet(metadata, orientation, panel_height, instance_id);
}

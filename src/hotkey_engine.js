/**
 * HotkeyEngine — Event-driven hotkey orchestration.
 *
 * Encapsulates all 29 mutable globals and 16 hotkey functions from main.js.
 * Emits typed events instead of calling side-effect functions directly.
 * Pattern: State Pattern via the existing hotkey_state_machine FSM.
 *
 * Events emitted:
 *   'toggle-recorder'            { sessionId }
 *   'request-selection-capture'  { sessionId }
 *   'instant-polish'             { text, oldClipboard }
 *   'toggle-assistant-panel'     (no payload)
 *   'chat-hotkey'                (no payload)
 *   'play-command-sound'         (no payload)
 *   'state-error'                { message }
 */
const EventEmitter = require('events');
const {
    RecorderLifecycleState,
    HotkeyCommandContext,
    HotkeyEventType,
    createInitialHotkeyState,
    transitionHotkeyState,
} = require('../hotkey_state_machine');
const { SYSTEM } = require('./config/constants');

// ── Constants ──────────────────────────────────────────────────

const HOTKEY_DEBOUNCE = SYSTEM.HOTKEY_DEBOUNCE_MS;
const COMMAND_TAP_THRESHOLD_MS = SYSTEM.INSTANT_TAP_THRESHOLD_MS;
const DICTATION_HOLD_THRESHOLD_MS = SYSTEM.LONG_PRESS_THRESHOLD_MS;
const HOTKEY_START_WATCHDOG_MS = SYSTEM.HOTKEY_START_WATCHDOG_MS;
const HOTKEY_STOP_TIMEOUT_MS = SYSTEM.HOTKEY_STOP_WATCHDOG_MS;
const SYNTHETIC_CAPTURE_IGNORE_MS = 120;

const CTRL_KEYCODES = new Set([29, 3613, 162, 163]);
const ALT_KEYCODES = new Set([56, 3640]);
const SPACE_KEYCODE = 57;

const RecordingType = Object.freeze({
    CLICK: 'CLICK',
    HOLD: 'HOLD',
    TAP_DISCARD: 'TAP_DISCARD',
});

class HotkeyEngine extends EventEmitter {
    /**
     * @param {object} deps
     * @param {object} deps.uIOhook — uIOhook instance (or EventEmitter mock for tests)
     * @param {Function} deps.getWindows — () => { dashboard, status, notification }
     */
    constructor({ uIOhook, getWindows }) {
        super();
        this._uIOhook = uIOhook;
        this._getWindows = getWindows;

        // ── Physical key state ────────────────────────────────────
        this._isCtrlPressed = false;
        this._isAltPressed = false;
        this._isSpacePressed = false;
        this._isAltSpaceHandled = false;
        this._isChatHotkeyActive = false;
        this._pressStartTime = 0;
        this._lastHotkeyTime = 0;

        // ── FSM state ─────────────────────────────────────────────
        this._fsmState = createInitialHotkeyState();
        this._activeSessionId = 0;
        this._sessionCounter = 0;
        this._startTimestamp = 0;
        this._startTimeout = null;
        this._stopTimeout = null;
        this._timedOutDeferredStopSessionId = 0;

        // ── Recording state ───────────────────────────────────────
        this._isProcessingHotkey = false;
        this._recordingType = null;
        this._isRecordingActive = false;

        // ── Selection capture state ───────────────────────────────
        this._pendingSelection = null;
        this._oldClipboardBeforeSelection = null;
        this._capturePromise = null;
        this._isCapturingSelection = false;
        this._ignoreHotkeyEventsUntil = 0;
        this._activePhysicalHold = false;
        this._activePhysicalHoldSessionId = 0;
        this._activePhysicalHoldStartedAt = 0;
        this._releasePendingDuringCapture = false;
        this._selectionCaptureCompleted = false;
        this._pendingModeCandidate = 'NONE';
        this._syntheticCaptureKeyEvents = false;

        // Bind listeners so they can be removed in stop()
        this._onKeyDown = this._handleKeyDown.bind(this);
        this._onKeyUp = this._handleKeyUp.bind(this);
    }

    // ╔══════════════════════════════════════════════════════════════╗
    // ║  PUBLIC API                                                  ║
    // ╚══════════════════════════════════════════════════════════════╝

    /** Register uIOhook listeners and start. */
    start() {
        this._uIOhook.on('keydown', this._onKeyDown);
        this._uIOhook.on('keyup', this._onKeyUp);
        this._uIOhook.start();
    }

    /** Unregister listeners. */
    stop() {
        this._uIOhook.removeListener('keydown', this._onKeyDown);
        this._uIOhook.removeListener('keyup', this._onKeyUp);
    }

    /**
     * Called by main.js after captureSelectedText() completes.
     * @param {object} result — { selection, oldClipboard, isEditable }
     */
    onSelectionCaptured(result) {
        this._capturePromise = null;
        const { selection, oldClipboard, isEditable } = result;
        const hasSelection = Boolean(selection && selection.trim().length > 0);
        const sessionId = this._activePhysicalHoldSessionId;

        const physicalHoldStillActive =
            this._activePhysicalHold &&
            this._activePhysicalHoldSessionId === sessionId &&
            this._isCtrlPressed &&
            this._isSpacePressed;

        this._selectionCaptureCompleted = true;

        if (hasSelection) {
            if (!isEditable) {
                this._logTrace({ event: 'trigger_aborted_non_editable', sessionId, selection_present: true });
                // Caller restores clipboard via the oldClipboard in the result
                this._resetPhysicalHoldSession();
                return;
            }

            this._pendingSelection = selection;
            this._oldClipboardBeforeSelection = oldClipboard;
            this._pendingModeCandidate = 'SELECTION_PENDING';

            if (!physicalHoldStillActive || this._releasePendingDuringCapture) {
                this._transitionFsm(HotkeyEventType.CONTEXT_UPDATE, { context: HotkeyCommandContext.SELECTION_TAP });
                this._logTrace({
                    event: 'selection_released_during_capture',
                    sessionId,
                    release_pending: this._releasePendingDuringCapture,
                });
                this.emit('instant-polish', {
                    text: this._pendingSelection,
                    oldClipboard: this._oldClipboardBeforeSelection,
                });
                this._pendingSelection = null;
                this._oldClipboardBeforeSelection = null;
                this._resetPhysicalHoldSession();
                return;
            }

            this.emit('play-command-sound');
            this._requestRecorderStart(HotkeyCommandContext.SELECTION_HOLD, sessionId, { selection_present: true });
            return;
        }

        this._recordingType = 'CLICK'; // Default to CLICK (overridden by keyup if HOLD)
        this._requestRecorderStart(HotkeyCommandContext.DICTATION, sessionId, { selection_present: false });

        // If the user tapped the keys so quickly that the release was swallowed by the capture window,
        // we must manually reset the stuck key trackers here.
        if (this._releasePendingDuringCapture) {
            this._logTrace({ event: 'dictation_release_flushed_after_capture' });
            this._resetPhysicalHoldSession();
        }
    }

    /**
     * Called by ipc_router when renderer sends 'update-app-state'.
     * @param {string} newState — AppStates value
     * @param {object} AppStates — The AppStates enum
     */
    onAppStateUpdate(newState, AppStates) {
        this._logTrace({ event: 'app_state_update', app_state: newState });

        if (newState === AppStates.LISTENING) {
            this._isRecordingActive = true;
            this._clearStartTimeout();
            this._transitionFsm(HotkeyEventType.LISTENING_CONFIRMED);

            if (!this._activeSessionId && this._timedOutDeferredStopSessionId) {
                this._activeSessionId = this._timedOutDeferredStopSessionId;
                this._timedOutDeferredStopSessionId = 0;
                this._transitionFsm(HotkeyEventType.STOP_REQUEST, { deferred: false });
                this.emit('toggle-recorder', { sessionId: this._activeSessionId });
                this._armStopTimeout(this._activeSessionId, 'late_listening_after_timeout');
                this._logTrace({ event: 'late_listening_for_timed_out_session' });
                return;
            }

            if (this._fsmState.deferredStop && this._activeSessionId) {
                this._requestRecorderStop('deferred_stop_on_listening', this._activeSessionId);
            }
            return;
        }

        if (newState === AppStates.PROCESSING) {
            this._isRecordingActive = false;
            this._clearAllTimers();
            this._transitionFsm(HotkeyEventType.PROCESSING_CONFIRMED);
            this._activeSessionId = 0;
            this._startTimestamp = 0;
            this._timedOutDeferredStopSessionId = 0;
            this._resetPhysicalHoldSession();
            return;
        }

        if (newState === AppStates.IDLE || newState === AppStates.ERROR) {
            this._isRecordingActive = false;
            this._clearAllTimers();
            this._transitionFsm(HotkeyEventType.RESET);
            this._activeSessionId = 0;
            this._startTimestamp = 0;
            this._timedOutDeferredStopSessionId = 0;
            this._resetPhysicalHoldSession();
        }
    }

    /**
     * Mark the capture as using synthetic key events (suppress detection).
     * Called by main.js around the selection scripts.
     */
    setSyntheticCapture(active) {
        this._syntheticCaptureKeyEvents = active;
    }

    /**
     * Mark selection capture start/end from main.js.
     */
    setCapturing(active) {
        this._isCapturingSelection = active;
        if (active) {
            this._ignoreHotkeyEventsUntil = Date.now() + SYNTHETIC_CAPTURE_IGNORE_MS;
        }
    }

    /**
     * Signal that capture finished — update ignore window.
     */
    onCaptureCompleted() {
        this._syntheticCaptureKeyEvents = false;
        this._isCapturingSelection = false;
        this._ignoreHotkeyEventsUntil = Date.now() + SYNTHETIC_CAPTURE_IGNORE_MS;
        this._selectionCaptureCompleted = true;
        this._logTrace({
            event: 'selection_capture_completed',
            event_source: 'physical',
            release_pending: this._releasePendingDuringCapture,
            selection_capture_completed: this._selectionCaptureCompleted,
        });
    }

    // ── State Getters (for ipc_router compatibility) ────────────

    get recordingType() { return this._recordingType; }
    set recordingType(v) { this._recordingType = v; }

    get pendingSelection() { return this._pendingSelection; }
    set pendingSelection(v) { this._pendingSelection = v; }

    get oldClipboardBeforeSelection() { return this._oldClipboardBeforeSelection; }
    set oldClipboardBeforeSelection(v) { this._oldClipboardBeforeSelection = v; }

    get isRecordingActive() { return this._isRecordingActive; }
    set isRecordingActive(v) { this._isRecordingActive = v; }

    get activeSessionId() { return this._activeSessionId; }
    get startTimestamp() { return this._startTimestamp; }
    get fsmState() { return this._fsmState; }
    get timedOutDeferredStopSessionId() { return this._timedOutDeferredStopSessionId; }

    // ╔══════════════════════════════════════════════════════════════╗
    // ║  PRIVATE — Key Event Handlers                                ║
    // ╚══════════════════════════════════════════════════════════════╝

    _handleKeyDown(e) {
        const { isCtrl, isAlt, isSpace } = _parseKeyEvent(e);

        if (this._isCaptureSuppressionActive() && !isSpace && (isCtrl || isSpace)) {
            this._logTrace({
                event: 'hotkey_ignored_during_selection_capture',
                event_source: this._syntheticCaptureKeyEvents ? 'synthetic_capture' : 'physical',
                capture_active: this._isCapturingSelection,
            });
            return;
        }

        if (isCtrl) this._isCtrlPressed = true;
        if (isAlt) this._isAltPressed = true;
        if (isSpace) this._isSpacePressed = true;

        // Alt+Space → toggle assistant panel
        if (this._isAltPressed && this._isSpacePressed && !this._isAltSpaceHandled) {
            this._isAltSpaceHandled = true;
            console.log('[LeelaV1] Hotkey Triggered: Alt+Space (Assistant Side Panel)');
            this.emit('toggle-assistant-panel');
            return;
        }

        // Ctrl+Space
        if (this._isCtrlPressed && this._isSpacePressed) {
            const { notification } = this._getWindows();
            const isChatFocused = notification && !notification.isDestroyed() && notification.isVisible() && notification.isFocused();
            const now = Date.now();

            if (isChatFocused) {
                if (!this._isChatHotkeyActive && now - this._lastHotkeyTime > HOTKEY_DEBOUNCE) {
                    this._lastHotkeyTime = now;
                    this._isChatHotkeyActive = true;
                    this.emit('chat-hotkey');
                }
                return;
            }

            if (this._pressStartTime === 0 && now - this._lastHotkeyTime > HOTKEY_DEBOUNCE) {
                this._lastHotkeyTime = now;
                this._pressStartTime = now;
                this._handleHotkeyTrigger();
            }
        }
    }

    _handleKeyUp(e) {
        const { isCtrl, isAlt, isSpace } = _parseKeyEvent(e);

        if (this._isCaptureSuppressionActive() && !isSpace && (isCtrl || isSpace)) {
            if (!this._syntheticCaptureKeyEvents) {
                this._releasePendingDuringCapture = true;
            }
            this._logTrace({
                event: 'hotkey_keyup_ignored_during_selection_capture',
                event_source: this._syntheticCaptureKeyEvents ? 'synthetic_capture' : 'physical',
                capture_active: this._isCapturingSelection,
                release_pending: this._releasePendingDuringCapture,
            });
            return;
        }

        if (isCtrl) this._isCtrlPressed = false;
        if (isAlt) {
            this._isAltPressed = false;
            this._isAltSpaceHandled = false;
        }
        if (isSpace) {
            this._isSpacePressed = false;
            if (!this._isAltPressed) this._isAltSpaceHandled = false;
        }

        if ((isCtrl || isSpace) && (!this._isCtrlPressed || !this._isSpacePressed)) {
            this._finalizeRelease();
        }
    }

    // ╔══════════════════════════════════════════════════════════════╗
    // ║  PRIVATE — Hotkey Orchestration                              ║
    // ╚══════════════════════════════════════════════════════════════╝

    _handleHotkeyTrigger() {
        if (this._isProcessingHotkey) return;
        this._isProcessingHotkey = true;

        this._logTrace({ event: 'hotkey_keydown' });

        try {
            if (this._fsmState.lifecycle === RecorderLifecycleState.LISTENING) {
                this._requestRecorderStop('keydown_while_listening', this._activeSessionId);
                return;
            }

            if (this._fsmState.lifecycle === RecorderLifecycleState.START_REQUESTED ||
                (this._fsmState.lifecycle === RecorderLifecycleState.STOP_REQUESTED && this._fsmState.deferredStop)) {
                this._requestRecorderStop('keydown_while_start_pending', this._activeSessionId);
                return;
            }

            if (this._fsmState.lifecycle === RecorderLifecycleState.STOP_REQUESTED) {
                this._logTrace({ event: 'keydown_ignored_stop_pending' });
                return;
            }

            this._pendingSelection = null;
            this._oldClipboardBeforeSelection = null;
            this._selectionCaptureCompleted = false;
            this._releasePendingDuringCapture = false;

            const sessionId = ++this._sessionCounter;
            this._activePhysicalHold = true;
            this._activePhysicalHoldSessionId = sessionId;
            this._activePhysicalHoldStartedAt = Date.now();
            this._pendingModeCandidate = 'DICTATION';

            // Request selection capture from main.js — it will call onSelectionCaptured()
            this._capturePromise = true; // Flag indicating capture in flight
            this.emit('request-selection-capture', { sessionId });
        } catch (err) {
            console.error('[LeelaV1] Trigger error:', err);
            this.emit('state-error', { message: 'Trigger Failed' });
            this._capturePromise = null;
            this._clearAllTimers();
            this._transitionFsm(HotkeyEventType.RESET);
            this._activeSessionId = 0;
            this._startTimestamp = 0;
            this._resetPhysicalHoldSession();
        } finally {
            this._isProcessingHotkey = false;
        }
    }

    _handleHotkeyRelease(duration) {
        this._logTrace({ event: 'hotkey_keyup', duration });

        if (this._capturePromise) {
            this._releasePendingDuringCapture = true;
            this._logTrace({ event: 'release_deferred_until_capture_done', duration });
            return;
        }

        if (this._fsmState.lifecycle === RecorderLifecycleState.STOP_REQUESTED || 
            this._fsmState.lifecycle === RecorderLifecycleState.PROCESSING || 
            this._fsmState.lifecycle === RecorderLifecycleState.IDLE) {
            this._logTrace({ event: 'keyup_ignored_post_stop', duration });
            this._resetPhysicalHoldSession();
            return;
        }

        const hasSelection = Boolean(this._pendingSelection && this._pendingSelection.trim().length > 0);
        const sessionId = this._activeSessionId;

        if (hasSelection) {
            if (duration < COMMAND_TAP_THRESHOLD_MS) {
                this._transitionFsm(HotkeyEventType.CONTEXT_UPDATE, { context: HotkeyCommandContext.SELECTION_TAP });
                this._recordingType = RecordingType.TAP_DISCARD;
                this._requestRecorderStop('selection_tap_discard', sessionId, { duration, selection_present: true });
                this.emit('instant-polish', {
                    text: this._pendingSelection,
                    oldClipboard: this._oldClipboardBeforeSelection,
                });
                this._pendingSelection = null;
                this._oldClipboardBeforeSelection = null;
                this._resetPhysicalHoldSession();
                return;
            }

            this._transitionFsm(HotkeyEventType.CONTEXT_UPDATE, { context: HotkeyCommandContext.SELECTION_HOLD });
            this._recordingType = RecordingType.HOLD;
            this._requestRecorderStop('selection_hold_release', sessionId, { duration, selection_present: true });
            this._resetPhysicalHoldSession();
            return;
        }

        if (duration >= DICTATION_HOLD_THRESHOLD_MS) {
            this._transitionFsm(HotkeyEventType.CONTEXT_UPDATE, { context: HotkeyCommandContext.DICTATION });
            this._recordingType = RecordingType.HOLD;
            this._requestRecorderStop('dictation_hold_release', sessionId, { duration, selection_present: false });
            this._resetPhysicalHoldSession();
            return;
        }

        this._recordingType = RecordingType.CLICK;
        this._logTrace({ event: 'dictation_click_release', duration, selection_present: false });
        this._resetPhysicalHoldSession();
    }

    _finalizeRelease() {
        if (this._isChatHotkeyActive) {
            this._isChatHotkeyActive = false;
            return;
        }
        if (this._pressStartTime !== 0) {
            const duration = Date.now() - this._pressStartTime;
            this._pressStartTime = 0;
            this._handleHotkeyRelease(duration);
        }
    }

    // ╔══════════════════════════════════════════════════════════════╗
    // ║  PRIVATE — Recorder Start/Stop                               ║
    // ╚══════════════════════════════════════════════════════════════╝

    _requestRecorderStart(context, sessionId, details = {}) {
        const { dashboard } = this._getWindows();
        if (!dashboard || dashboard.isDestroyed()) {
            this._logTrace({ event: 'start_blocked_no_dashboard', context, sessionId, ...details });
            return false;
        }

        this._activeSessionId = sessionId;
        this._startTimestamp = Date.now();
        this._timedOutDeferredStopSessionId = 0;
        this._transitionFsm(HotkeyEventType.START_REQUEST, { context });
        this.emit('toggle-recorder', { sessionId });
        this._armStartTimeout(sessionId);

        this._logTrace({ event: 'start_requested', context, sessionId, ...details });
        return true;
    }

    _requestRecorderStop(reason, sessionId, details = {}) {
        let targetSessionId = sessionId || this._activeSessionId;

        // Recover from lost session bookkeeping
        if (!targetSessionId &&
            (this._fsmState.lifecycle === RecorderLifecycleState.START_REQUESTED ||
                this._fsmState.lifecycle === RecorderLifecycleState.LISTENING ||
                (this._fsmState.lifecycle === RecorderLifecycleState.STOP_REQUESTED && this._fsmState.deferredStop))) {
            targetSessionId = ++this._sessionCounter;
            this._activeSessionId = targetSessionId;
            this._logTrace({ event: 'stop_recovered_session', reason, recovered_session: targetSessionId, lifecycle: this._fsmState.lifecycle, ...details });
        }

        if (!targetSessionId) {
            this._logTrace({ event: 'stop_ignored_no_session', reason, ...details });
            return false;
        }

        if (this._activeSessionId && targetSessionId !== this._activeSessionId) {
            this._logTrace({ event: 'stop_ignored_stale_session', reason, sessionId: targetSessionId, active_session: this._activeSessionId, ...details });
            return false;
        }

        if (this._fsmState.lifecycle === RecorderLifecycleState.START_REQUESTED) {
            // Unconditionally cancel initialization timeout and immediately move to STOP_REQUESTED.
            // This guarantees that any rapid double-tap (Dictation or Hold) halts cleanly.
            this._clearStartTimeout();
            this._transitionFsm(HotkeyEventType.STOP_REQUEST, { deferred: false });
            this.emit('toggle-recorder', { sessionId: targetSessionId });
            this._armStopTimeout(targetSessionId, 'immediate_stop_on_start_requested');
            this._logTrace({ event: 'stop_immediate_on_start_requested', reason, sessionId: targetSessionId, ...details });
            return true;
        }

        if (this._fsmState.lifecycle === RecorderLifecycleState.STOP_REQUESTED) {
            this._logTrace({ event: 'stop_already_requested', reason, sessionId: targetSessionId, ...details });
            return true;
        }

        if (this._fsmState.lifecycle !== RecorderLifecycleState.LISTENING) {
            this._logTrace({ event: 'stop_ignored_lifecycle', reason, sessionId: targetSessionId, lifecycle: this._fsmState.lifecycle, ...details });
            return false;
        }

        const { dashboard } = this._getWindows();
        if (!dashboard || dashboard.isDestroyed()) {
            this._logTrace({ event: 'stop_blocked_no_dashboard', reason, sessionId: targetSessionId, ...details });
            return false;
        }

        this._transitionFsm(HotkeyEventType.STOP_REQUEST, { deferred: false });
        this.emit('toggle-recorder', { sessionId: targetSessionId });
        this._armStopTimeout(targetSessionId, reason);
        this._logTrace({ event: 'stop_requested', reason, sessionId: targetSessionId, ...details });
        return true;
    }

    // ╔══════════════════════════════════════════════════════════════╗
    // ║  PRIVATE — Timers                                            ║
    // ╚══════════════════════════════════════════════════════════════╝

    _armStartTimeout(sessionId) {
        this._clearStartTimeout();
        this._startTimeout = setTimeout(() => {
            if (sessionId !== this._activeSessionId) return;
            const isStartPending = this._fsmState.lifecycle === RecorderLifecycleState.START_REQUESTED;
            const isDeferredPending = this._fsmState.lifecycle === RecorderLifecycleState.STOP_REQUESTED && this._fsmState.deferredStop;
            if (!isStartPending && !isDeferredPending) return;

            this._timedOutDeferredStopSessionId = this._fsmState.deferredStop ? sessionId : 0;
            this._logTrace({ event: 'start_timeout', blocked_start: true, duration: Date.now() - this._startTimestamp });
            this._transitionFsm(HotkeyEventType.RESET);
            this._activeSessionId = 0;
            this._startTimestamp = 0;
        }, HOTKEY_START_WATCHDOG_MS);
    }

    _armStopTimeout(sessionId, reason) {
        this._clearStopTimeout();
        this._stopTimeout = setTimeout(() => {
            if (sessionId !== this._activeSessionId) return;
            if (this._fsmState.lifecycle !== RecorderLifecycleState.STOP_REQUESTED) return;
            this._logTrace({ event: 'stop_timeout', reason });
            this._transitionFsm(HotkeyEventType.RESET);
            this._activeSessionId = 0;
            this._startTimestamp = 0;
        }, HOTKEY_STOP_TIMEOUT_MS);
    }

    _clearStartTimeout() {
        if (this._startTimeout) { clearTimeout(this._startTimeout); this._startTimeout = null; }
    }

    _clearStopTimeout() {
        if (this._stopTimeout) { clearTimeout(this._stopTimeout); this._stopTimeout = null; }
    }

    _clearAllTimers() {
        this._clearStartTimeout();
        this._clearStopTimeout();
    }

    // ╔══════════════════════════════════════════════════════════════╗
    // ║  PRIVATE — Helpers                                           ║
    // ╚══════════════════════════════════════════════════════════════╝

    _transitionFsm(eventType, payload = {}) {
        const prev = this._fsmState;
        this._fsmState = transitionHotkeyState(this._fsmState, { type: eventType, ...payload });

        if (prev.lifecycle !== this._fsmState.lifecycle) {
            console.log("HotkeyFSM:", prev.lifecycle, "→", this._fsmState.lifecycle);
        }

        if (prev.lifecycle !== this._fsmState.lifecycle || prev.context !== this._fsmState.context || prev.deferredStop !== this._fsmState.deferredStop) {
            this._logTrace({
                event: 'fsm_transition',
                state_from: prev.lifecycle, state_to: this._fsmState.lifecycle,
                context_from: prev.context, context_to: this._fsmState.context,
                stop_deferred_from: prev.deferredStop, stop_deferred_to: this._fsmState.deferredStop,
            });
        }
        return this._fsmState;
    }

    _resetPhysicalHoldSession() {
        this._activePhysicalHold = false;
        this._activePhysicalHoldSessionId = 0;
        this._activePhysicalHoldStartedAt = 0;
        this._releasePendingDuringCapture = false;
        this._selectionCaptureCompleted = false;
        this._pendingModeCandidate = 'NONE';
        
        // Failsafe: Clear stuck physical keys if they were suppressed during capture
        this._isCtrlPressed = false;
        this._isSpacePressed = false;
        this._isAltPressed = false;
        this._isAltSpaceHandled = false;
        this._pressStartTime = 0;
    }

    _isCaptureSuppressionActive() {
        return this._isCapturingSelection || Date.now() < this._ignoreHotkeyEventsUntil;
    }

    _logTrace(fields = {}) {
        const payload = {
            sessionId: this._activeSessionId,
            context: this._fsmState.context,
            lifecycle: this._fsmState.lifecycle,
            stop_deferred: this._fsmState.deferredStop,
            is_recording_active: this._isRecordingActive,
            ...fields,
        };
        console.log('[LeelaV1][HOTKEY] ' + JSON.stringify(payload));
    }
}

// ── Module-level static helper ────────────────────────────────

function _parseKeyEvent(e) {
    return {
        isCtrl: CTRL_KEYCODES.has(e.keycode),
        isAlt: ALT_KEYCODES.has(e.keycode),
        isSpace: e.keycode === SPACE_KEYCODE,
    };
}

module.exports = {
    HotkeyEngine,
    RecordingType,
    HOTKEY_DEBOUNCE,
    COMMAND_TAP_THRESHOLD_MS,
    DICTATION_HOLD_THRESHOLD_MS,
};

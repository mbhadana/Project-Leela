/**
 * Tests for HotkeyEngine — event-driven hotkey orchestration.
 * Uses a mock uIOhook (EventEmitter) to simulate keyboard events.
 */
const assert = require('assert');
const EventEmitter = require('events');

// We need to mock the hotkey_state_machine require path since the engine uses relative '../hotkey_state_machine'
// The test is run from the project root, so this works:
const { HotkeyEngine, RecordingType, COMMAND_TAP_THRESHOLD_MS, DICTATION_HOLD_THRESHOLD_MS } = require('../src/hotkey_engine');

let testCount = 0;
let passCount = 0;

function test(name, fn) {
    testCount++;
    try {
        fn();
        passCount++;
        console.log(`PASS ${name}`);
    } catch (err) {
        console.error(`FAIL ${name}: ${err.message}`);
    }
}

// ── Helpers ──────────────────────────────────────────────────────

const CTRL_KEYCODE = 29;
const ALT_KEYCODE = 56;
const SPACE_KEYCODE = 57;

function createMockUIOhook() {
    const mock = new EventEmitter();
    mock.start = () => { };
    return mock;
}

function createMockWindows(opts = {}) {
    const destroyed = opts.destroyed || false;
    const visible = opts.visible || false;
    const focused = opts.focused || false;
    return {
        dashboard: { isDestroyed: () => destroyed, webContents: { send: () => { } } },
        notification: {
            isDestroyed: () => destroyed,
            isVisible: () => visible,
            isFocused: () => focused,
        },
        status: { isDestroyed: () => destroyed, webContents: { send: () => { } } },
    };
}

function createEngine(opts = {}) {
    const uIOhook = opts.uIOhook || createMockUIOhook();
    const windows = opts.windows || createMockWindows();
    const engine = new HotkeyEngine({
        uIOhook,
        getWindows: () => windows,
    });
    return { engine, uIOhook, windows };
}

function pressCtrlSpace(uIOhook) {
    uIOhook.emit('keydown', { keycode: CTRL_KEYCODE });
    uIOhook.emit('keydown', { keycode: SPACE_KEYCODE });
}

function releaseCtrlSpace(uIOhook) {
    uIOhook.emit('keyup', { keycode: SPACE_KEYCODE });
    uIOhook.emit('keyup', { keycode: CTRL_KEYCODE });
}

function pressAltSpace(uIOhook) {
    uIOhook.emit('keydown', { keycode: ALT_KEYCODE });
    uIOhook.emit('keydown', { keycode: SPACE_KEYCODE });
}

function releaseAltSpace(uIOhook) {
    uIOhook.emit('keyup', { keycode: SPACE_KEYCODE });
    uIOhook.emit('keyup', { keycode: ALT_KEYCODE });
}

// ╔══════════════════════════════════════════════════════════════╗
// ║  TESTS                                                       ║
// ╚══════════════════════════════════════════════════════════════╝

// ── Alt+Space → toggle-assistant-panel ─────────────────────────

test('Alt+Space emits toggle-assistant-panel', () => {
    const { engine, uIOhook } = createEngine();
    engine.start();
    let emitted = false;
    engine.on('toggle-assistant-panel', () => { emitted = true; });
    pressAltSpace(uIOhook);
    assert.strictEqual(emitted, true);
    engine.stop();
});

// ── Ctrl+Space → request-selection-capture ─────────────────────

test('Ctrl+Space emits request-selection-capture', () => {
    const { engine, uIOhook } = createEngine();
    engine.start();
    let payload = null;
    engine.on('request-selection-capture', (p) => { payload = p; });
    pressCtrlSpace(uIOhook);
    assert.ok(payload, 'Should have emitted request-selection-capture');
    assert.strictEqual(typeof payload.sessionId, 'number');
    engine.stop();
});

// ── onSelectionCaptured: no selection → toggle-recorder (dictation) ──

test('onSelectionCaptured with no selection emits toggle-recorder', () => {
    const { engine, uIOhook } = createEngine();
    engine.start();
    let toggleEmitted = false;
    engine.on('toggle-recorder', () => { toggleEmitted = true; });
    engine.on('request-selection-capture', () => {
        engine.onSelectionCaptured({ selection: '', oldClipboard: '', isEditable: false });
    });
    pressCtrlSpace(uIOhook);
    assert.strictEqual(toggleEmitted, true);
    engine.stop();
});

// ── onSelectionCaptured: non-editable → no toggle ──

test('onSelectionCaptured with non-editable selection does not emit toggle', () => {
    const { engine, uIOhook } = createEngine();
    engine.start();
    let toggleEmitted = false;
    engine.on('toggle-recorder', () => { toggleEmitted = true; });
    engine.on('request-selection-capture', () => {
        engine.onSelectionCaptured({ selection: 'hello', oldClipboard: '', isEditable: false });
    });
    pressCtrlSpace(uIOhook);
    assert.strictEqual(toggleEmitted, false);
    engine.stop();
});

// ── onSelectionCaptured: selection + released → instant-polish ──

test('onSelectionCaptured with selection + released emits instant-polish', () => {
    const { engine, uIOhook } = createEngine();
    engine.start();
    let polishPayload = null;
    engine.on('instant-polish', (p) => { polishPayload = p; });
    engine.on('request-selection-capture', () => {
        // Simulate that keys were released during capture
        releaseCtrlSpace(uIOhook);
        engine.onSelectionCaptured({ selection: 'hello world', oldClipboard: 'old', isEditable: true });
    });
    pressCtrlSpace(uIOhook);
    assert.ok(polishPayload, 'Should have emitted instant-polish');
    assert.strictEqual(polishPayload.text, 'hello world');
    assert.strictEqual(polishPayload.oldClipboard, 'old');
    engine.stop();
});

// ── Ctrl+Space while chat focused → chat-hotkey ────────────────

test('Ctrl+Space while chat focused emits chat-hotkey', () => {
    const { engine, uIOhook } = createEngine({
        windows: createMockWindows({ visible: true, focused: true }),
    });
    engine.start();
    let chatEmitted = false;
    engine.on('chat-hotkey', () => { chatEmitted = true; });
    pressCtrlSpace(uIOhook);
    assert.strictEqual(chatEmitted, true);
    engine.stop();
});

// ── Debounce: rapid Ctrl+Space → only one trigger ──────────────

test('Debounce: rapid Ctrl+Space presses produce only one trigger', () => {
    const { engine, uIOhook } = createEngine();
    engine.start();
    let captureCount = 0;
    engine.on('request-selection-capture', () => { captureCount++; });
    // First press
    pressCtrlSpace(uIOhook);
    // Without releasing, try pressing again (should be debounced)
    uIOhook.emit('keydown', { keycode: SPACE_KEYCODE });
    assert.strictEqual(captureCount, 1);
    engine.stop();
});

// ── State getters ────────────────────────────────────────────────

test('State getters: recordingType initialized to null', () => {
    const { engine } = createEngine();
    assert.strictEqual(engine.recordingType, null);
});

test('State getters: pendingSelection initialized to null', () => {
    const { engine } = createEngine();
    assert.strictEqual(engine.pendingSelection, null);
});

test('State getters: isRecordingActive initialized to false', () => {
    const { engine } = createEngine();
    assert.strictEqual(engine.isRecordingActive, false);
});

// ── start/stop lifecycle ─────────────────────────────────────────

test('stop: after stop, keydown does not trigger events', () => {
    const { engine, uIOhook } = createEngine();
    engine.start();
    engine.stop();
    let emitted = false;
    engine.on('request-selection-capture', () => { emitted = true; });
    pressCtrlSpace(uIOhook);
    assert.strictEqual(emitted, false);
});

// ── onAppStateUpdate ─────────────────────────────────────────────

test('onAppStateUpdate: LISTENING sets isRecordingActive to true', () => {
    const { engine, uIOhook } = createEngine();
    engine.start();
    const AppStates = { LISTENING: 'LISTENING', PROCESSING: 'PROCESSING', IDLE: 'IDLE', ERROR: 'ERROR' };
    engine.on('request-selection-capture', () => {
        engine.onSelectionCaptured({ selection: '', oldClipboard: '', isEditable: false });
    });
    pressCtrlSpace(uIOhook);
    engine.onAppStateUpdate('LISTENING', AppStates);
    assert.strictEqual(engine.isRecordingActive, true);
    engine.stop();
});

test('onAppStateUpdate: PROCESSING resets state', () => {
    const { engine } = createEngine();
    const AppStates = { LISTENING: 'LISTENING', PROCESSING: 'PROCESSING', IDLE: 'IDLE', ERROR: 'ERROR' };
    engine.isRecordingActive = true;
    engine.onAppStateUpdate('PROCESSING', AppStates);
    assert.strictEqual(engine.isRecordingActive, false);
});

test('onAppStateUpdate: IDLE resets state', () => {
    const { engine } = createEngine();
    const AppStates = { LISTENING: 'LISTENING', PROCESSING: 'PROCESSING', IDLE: 'IDLE', ERROR: 'ERROR' };
    engine.isRecordingActive = true;
    engine.onAppStateUpdate('IDLE', AppStates);
    assert.strictEqual(engine.isRecordingActive, false);
});

// ── RecordingType constants ──────────────────────────────────────

test('RecordingType has CLICK, HOLD, TAP_DISCARD', () => {
    assert.strictEqual(RecordingType.CLICK, 'CLICK');
    assert.strictEqual(RecordingType.HOLD, 'HOLD');
    assert.strictEqual(RecordingType.TAP_DISCARD, 'TAP_DISCARD');
});

// ── Fast Release Race Condition ────────────────────────────────────

test('Fast Release: keyup before LISTENING confirmation triggers CLICK instead of sticking', () => {
    const { engine, uIOhook } = createEngine();
    engine.start();
    const AppStates = { LISTENING: 'LISTENING', PROCESSING: 'PROCESSING', IDLE: 'IDLE', ERROR: 'ERROR' };
    
    // Simulate capture resolving to Dictation (no selection)
    engine.on('request-selection-capture', () => {
        engine.onSelectionCaptured({ selection: '', oldClipboard: '', isEditable: false });
    });

    // 1. Key Down
    pressCtrlSpace(uIOhook);
    
    // Simulate 50ms hold (Fast Release)
    engine._pressStartTime = Date.now() - 50; 
    
    // 2. Fast Release 
    releaseCtrlSpace(uIOhook);
    
    // 3. Late UI Confirmation
    engine.onAppStateUpdate('LISTENING', AppStates);
    
    // VERIFY FIX: The engine should successfully handle the fast release as a CLICK
    // This implies it is successfully LISTENING and waiting for the second click to stop
    assert.strictEqual(engine.fsmState.lifecycle, 'LISTENING', 'Fix: System should stay in LISTENING for Dictation Taps');
    assert.strictEqual(engine.recordingType, 'CLICK', 'RecordingType should be CLICK');
    
    engine.stop();
});

// ── Dictation Toggle Cycle ───────────────────────────────────────

test('Dictation Toggle Cycle: IDLE -> LISTENING -> PROCESSING -> IDLE', () => {
    const { engine, uIOhook } = createEngine();
    engine.start();
    const AppStates = { LISTENING: 'LISTENING', PROCESSING: 'PROCESSING', IDLE: 'IDLE', ERROR: 'ERROR' };

    engine.on('request-selection-capture', () => {
        engine.onSelectionCaptured({ selection: '', oldClipboard: '', isEditable: false });
    });

    // 1. Initial State
    assert.strictEqual(engine.fsmState.lifecycle, 'IDLE');

    // 2. First Tap (Start Dictation)
    pressCtrlSpace(uIOhook);
    releaseCtrlSpace(uIOhook);

    // Engine is now in START_REQUESTED, waiting for UI confirmation
    assert.strictEqual(engine.fsmState.lifecycle, 'START_REQUESTED');

    // UI Confirms LISTENING
    engine.onAppStateUpdate('LISTENING', AppStates);
    assert.strictEqual(engine.fsmState.lifecycle, 'LISTENING');

    // 3. Second Tap (Stop Dictation)
    pressCtrlSpace(uIOhook);
    releaseCtrlSpace(uIOhook);

    // Engine requests stop
    assert.strictEqual(engine.fsmState.lifecycle, 'STOP_REQUESTED');

    // UI Confirms PROCESSING
    engine.onAppStateUpdate('PROCESSING', AppStates);
    assert.strictEqual(engine.fsmState.lifecycle, 'PROCESSING');

    // UI Confirms IDLE (Done)
    engine.onAppStateUpdate('IDLE', AppStates);
    assert.strictEqual(engine.fsmState.lifecycle, 'IDLE');

    engine.stop();
});

// ── Dictation Rapid Double Tap ─────────────────────────────────

test('Dictation Double Tap Cycle: IDLE -> START_REQUESTED -> STOP_REQUESTED -> IDLE', () => {
    const { engine, uIOhook } = createEngine();
    engine.start();
    const AppStates = { LISTENING: 'LISTENING', PROCESSING: 'PROCESSING', IDLE: 'IDLE', ERROR: 'ERROR' };

    engine.on('request-selection-capture', () => {
        engine.onSelectionCaptured({ selection: '', oldClipboard: '', isEditable: false });
    });

    // 1. Initial State
    assert.strictEqual(engine.fsmState.lifecycle, 'IDLE');

    // 2. First Tap (Start Dictation)
    pressCtrlSpace(uIOhook);
    releaseCtrlSpace(uIOhook);

    // Engine is now in START_REQUESTED, waiting for UI confirmation
    assert.strictEqual(engine.fsmState.lifecycle, 'START_REQUESTED');

    // 3. Second Tap (Stop Dictation BEFORE UI confirms LISTENING)
    // Manually clear debounce to simulate a user tapping after 150ms 
    engine._lastHotkeyTime = 0;
    pressCtrlSpace(uIOhook);
    releaseCtrlSpace(uIOhook);

    // Engine should forcibly move to STOP_REQUESTED immediately
    assert.strictEqual(engine.fsmState.lifecycle, 'STOP_REQUESTED', 'Failed to jump directly from START_REQUESTED to STOP_REQUESTED');

    // UI Confirms PROCESSING (Dashboard handles double-tap termination)
    engine.onAppStateUpdate('PROCESSING', AppStates);
    assert.strictEqual(engine.fsmState.lifecycle, 'PROCESSING');

    // UI Confirms IDLE
    engine.onAppStateUpdate('IDLE', AppStates);
    assert.strictEqual(engine.fsmState.lifecycle, 'IDLE');

    engine.stop();
});

// ── Summary ─────────────────────────────────────────────────────

console.log(`\n${passCount}/${testCount} tests passed.`);

const assert = require('assert');
const {
  RecorderLifecycleState,
  HotkeyCommandContext,
  HotkeyEventType,
  createInitialHotkeyState,
  transitionHotkeyState,
} = require('../hotkey_state_machine');

function it(name, fn) {
  try {
    fn();
    process.stdout.write(`PASS ${name}\n`);
  } catch (error) {
    process.stderr.write(`FAIL ${name}: ${error.message}\n`);
    process.exitCode = 1;
  }
}

run('Scenario 1: dictation toggle lifecycle', () => {
  let state = createInitialHotkeyState();

  state = transitionHotkeyState(state, {
    type: HotkeyEventType.START_REQUEST,
    context: HotkeyCommandContext.DICTATION,
  });
  assert.equal(state.lifecycle, RecorderLifecycleState.START_REQUESTED);
  assert.equal(state.context, HotkeyCommandContext.DICTATION);

  state = transitionHotkeyState(state, { type: HotkeyEventType.LISTENING_CONFIRMED });
  assert.equal(state.lifecycle, RecorderLifecycleState.LISTENING);

  state = transitionHotkeyState(state, {
    type: HotkeyEventType.STOP_REQUEST,
    deferred: false,
  });
  assert.equal(state.lifecycle, RecorderLifecycleState.STOP_REQUESTED);
  assert.equal(state.deferredStop, false);

  state = transitionHotkeyState(state, { type: HotkeyEventType.PROCESSING_CONFIRMED });
  assert.equal(state.lifecycle, RecorderLifecycleState.PROCESSING);

  state = transitionHotkeyState(state, { type: HotkeyEventType.RESET });
  assert.equal(state.lifecycle, RecorderLifecycleState.IDLE);
  assert.equal(state.context, HotkeyCommandContext.NONE);
});

run('Scenario 2: selection tap switches context to SELECTION_TAP', () => {
  let state = createInitialHotkeyState();
  state = transitionHotkeyState(state, {
    type: HotkeyEventType.START_REQUEST,
    context: HotkeyCommandContext.SELECTION_HOLD,
  });
  state = transitionHotkeyState(state, {
    type: HotkeyEventType.CONTEXT_UPDATE,
    context: HotkeyCommandContext.SELECTION_TAP,
  });

  assert.equal(state.lifecycle, RecorderLifecycleState.START_REQUESTED);
  assert.equal(state.context, HotkeyCommandContext.SELECTION_TAP);
});

run('Scenario 3: selection hold keeps SELECTION_HOLD context through listening', () => {
  let state = createInitialHotkeyState();
  state = transitionHotkeyState(state, {
    type: HotkeyEventType.START_REQUEST,
    context: HotkeyCommandContext.SELECTION_HOLD,
  });
  state = transitionHotkeyState(state, { type: HotkeyEventType.LISTENING_CONFIRMED });

  assert.equal(state.lifecycle, RecorderLifecycleState.LISTENING);
  assert.equal(state.context, HotkeyCommandContext.SELECTION_HOLD);
});

run('Race A: release-before-listening defers stop', () => {
  let state = createInitialHotkeyState();
  state = transitionHotkeyState(state, {
    type: HotkeyEventType.START_REQUEST,
    context: HotkeyCommandContext.SELECTION_HOLD,
  });
  state = transitionHotkeyState(state, {
    type: HotkeyEventType.STOP_REQUEST,
    deferred: true,
  });

  assert.equal(state.lifecycle, RecorderLifecycleState.STOP_REQUESTED);
  assert.equal(state.deferredStop, true);

  state = transitionHotkeyState(state, { type: HotkeyEventType.LISTENING_CONFIRMED });
  assert.equal(state.lifecycle, RecorderLifecycleState.LISTENING);
  assert.equal(state.deferredStop, true);
});

run('Race B: double stop requests remain STOP_REQUESTED', () => {
  let state = createInitialHotkeyState();
  state = transitionHotkeyState(state, {
    type: HotkeyEventType.START_REQUEST,
    context: HotkeyCommandContext.DICTATION,
  });
  state = transitionHotkeyState(state, {
    type: HotkeyEventType.STOP_REQUEST,
    deferred: true,
  });
  state = transitionHotkeyState(state, {
    type: HotkeyEventType.STOP_REQUEST,
    deferred: true,
  });

  assert.equal(state.lifecycle, RecorderLifecycleState.STOP_REQUESTED);
  assert.equal(state.deferredStop, true);
});

if (process.exitCode) process.exit(process.exitCode);

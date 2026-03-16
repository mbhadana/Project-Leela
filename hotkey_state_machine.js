const RecorderLifecycleState = Object.freeze({
  IDLE: 'IDLE',
  START_REQUESTED: 'START_REQUESTED',
  LISTENING: 'LISTENING',
  STOP_REQUESTED: 'STOP_REQUESTED',
  PROCESSING: 'PROCESSING',
});

const HotkeyCommandContext = Object.freeze({
  NONE: 'NONE',
  SELECTION_TAP: 'SELECTION_TAP',
  SELECTION_HOLD: 'SELECTION_HOLD',
  DICTATION: 'DICTATION',
});

const HotkeyEventType = Object.freeze({
  START_REQUEST: 'START_REQUEST',
  STOP_REQUEST: 'STOP_REQUEST',
  LISTENING_CONFIRMED: 'LISTENING_CONFIRMED',
  PROCESSING_CONFIRMED: 'PROCESSING_CONFIRMED',
  RESET: 'RESET',
  CONTEXT_UPDATE: 'CONTEXT_UPDATE',
});

function createInitialHotkeyState() {
  return {
    lifecycle: RecorderLifecycleState.IDLE,
    context: HotkeyCommandContext.NONE,
    deferredStop: false,
  };
}

function transitionHotkeyState(currentState, event) {
  const state = currentState || createInitialHotkeyState();
  const evt = event || {};
  const type = evt.type;

  switch (type) {
    case HotkeyEventType.START_REQUEST:
      return {
        lifecycle: RecorderLifecycleState.START_REQUESTED,
        context: evt.context || state.context || HotkeyCommandContext.DICTATION,
        deferredStop: false,
      };
    case HotkeyEventType.STOP_REQUEST:
      return {
        lifecycle: RecorderLifecycleState.STOP_REQUESTED,
        context: state.context,
        deferredStop: Boolean(evt.deferred),
      };
    case HotkeyEventType.LISTENING_CONFIRMED:
      return {
        lifecycle: RecorderLifecycleState.LISTENING,
        context: state.context,
        deferredStop: state.deferredStop,
      };
    case HotkeyEventType.PROCESSING_CONFIRMED:
      return {
        lifecycle: RecorderLifecycleState.PROCESSING,
        context: state.context,
        deferredStop: false,
      };
    case HotkeyEventType.CONTEXT_UPDATE:
      return {
        lifecycle: state.lifecycle,
        context: evt.context || state.context,
        deferredStop: state.deferredStop,
      };
    case HotkeyEventType.RESET:
      return createInitialHotkeyState();
    default:
      return { ...state };
  }
}

module.exports = {
  RecorderLifecycleState,
  HotkeyCommandContext,
  HotkeyEventType,
  createInitialHotkeyState,
  transitionHotkeyState,
};

const { app, BrowserWindow, globalShortcut, Notification, ipcMain, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec, execSync } = require('child_process');
const axios = require('axios');
const FormData = require('form-data');
const ffmpeg = require('ffmpeg-static');
const cleanup = require('./cleanup');
const settingsManager = require('./settings_manager');
const activityLogger = require('./activity_logger');
const secretManager = require('./secret_manager');
const platformHelper = require('./platform_helper');
const optimizer = require('./optimizer');
const { HotkeyEngine } = require('./src/hotkey_engine');
const { registerIpcHandlers } = require('./src/ipc_router');
const { uIOhook } = require('uiohook-napi');

// Set App User Model ID for Windows Taskbar consistency
if (process.platform === 'win32') {
  app.setAppUserModelId('com.leelav1.assistant');
}

// Help functionality: Load .env from both local and original project
function loadEnv(targetPath) {
  if (fs.existsSync(targetPath)) {
    try {
      const envRaw = fs.readFileSync(targetPath, 'utf8');
      envRaw.split(/\r?\n/).forEach(line => {
        const m = line.match(/^([^=]+)=(.*)$/);
        if (m) {
          const k = m[1].trim();
          let v = m[2].trim();
          if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
            v = v.slice(1, -1);
          }
          if (!process.env[k]) process.env[k] = v;
        }
      });
      console.log('[LeelaV1] Loaded env from', targetPath);
    } catch (e) {
      console.warn('[LeelaV1] Failed to read .env at', targetPath, e);
    }
  }
}

loadEnv(path.join(__dirname, '.env'));
loadEnv(path.join(__dirname, '..', 'voice-writer-ai', '.env'));
loadEnv(path.join('C:', 'Users', 'admin', 'Documents', 'SpeechToTextAI', 'voice-writer-ai', '.env'));

const logs = [];
const logLimit = 1000;

function addLog(level, msg) {
  const logLine = `${new Date().toISOString()} [${level}] ${String(msg)}`;
  logs.push(logLine);
  if (logs.length > logLimit) logs.shift();
  // Also write to file for persistence if desired, but for now memory buffer is enough for live debugging
  try {
    const logFile = path.join(process.env.ALLUSERSPROFILE || 'C:\\ProgramData', 'LeelaV1', 'app.log');
    fs.appendFileSync(logFile, logLine + '\n');
  } catch (e) { }
}

// Intercept console
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => {
  originalLog.apply(console, args);
  addLog('INFO', args.join(' '));
};
console.error = (...args) => {
  originalError.apply(console, args);
  addLog('ERROR', args.join(' '));
};
console.warn = (...args) => {
  originalWarn.apply(console, args);
  addLog('WARN', args.join(' '));
};

// Auto-Restart with Crash Loop Guard
// Max 3 restarts within 60 seconds to prevent infinite crash loops
const RESTART_WINDOW_MS = 60000;
const MAX_RESTARTS = 3;
const recentCrashes = [];

function safeRestart(reason) {
  const now = Date.now();
  recentCrashes.push(now);
  // Keep only crashes within the window
  while (recentCrashes.length > 0 && (now - recentCrashes[0]) > RESTART_WINDOW_MS) {
    recentCrashes.shift();
  }

  if (recentCrashes.length > MAX_RESTARTS) {
    console.error(`[LeelaV1] Crash loop detected (${recentCrashes.length} crashes in ${RESTART_WINDOW_MS / 1000}s). NOT restarting.`);
    app.exit(1);
    return;
  }

  console.error(`[LeelaV1] Auto-restarting due to: ${reason}`);
  app.relaunch();
  app.exit(0);
}

process.on('uncaughtException', (err) => {
  console.error('[LeelaV1 MAIN] Uncaught Exception:', err && err.message ? err.message : err);
  setTimeout(() => safeRestart(err && err.message ? err.message : 'uncaughtException'), 300);
});
process.on('unhandledRejection', (reason) => {
  console.error('[LeelaV1 MAIN] Unhandled Rejection:', reason);
  setTimeout(() => safeRestart(String(reason)), 300);
});

let isProcessingHotkey = false;
let statusWindow;
let dashboardWindow;
let notificationWindow;
let hotkeyEngine;

const AppStates = {
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  PROCESSING: 'PROCESSING',
  SUCCESS_PASTE: 'SUCCESS_PASTE',
  SUCCESS_POLISH: 'SUCCESS_POLISH',
  ERROR: 'ERROR',
  WARNING: 'WARNING'
};

let currentStateStatus = AppStates.IDLE;

// Dual-Mode Recording State
let isCtrlPressed = false;
let isSpacePressed = false;
let pressStartTime = 0;
let recordingType = null; // 'CLICK' or 'HOLD'
let isRecordingActive = false; // Tracks if the recorder is running
let lastHotkeyTime = 0; // Debounce guard
let pendingSelection = null; // Stores text for Command Mode
let oldClipboardBeforeSelection = null; // Stores clipboard for restoration
let capturePromise = null; // Promise tracker for selection capture
const HOTKEY_DEBOUNCE = 100; // ms

// createWindow() removed - functionality merged into Dashboard

function createStatusWindow() {
  if (statusWindow && !statusWindow.isDestroyed()) return;

  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width } = primaryDisplay.workAreaSize;
  const { x, y } = primaryDisplay.workArea;

  statusWindow = new BrowserWindow({
    width: width,
    height: 20, /* Height optimized for taskbar boundary */
    x: x,
    y: y + primaryDisplay.workArea.height - 20,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    focusable: false,
    icon: platformHelper.getIconPath(__dirname),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'src', 'preload.js'),
    }
  });

  statusWindow.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));

  // Position handled at window creation

  // Interaction-Transparent: Allow clicking through the pill to underlying windows
  statusWindow.setIgnoreMouseEvents(true);

  // Optional: Restore it for the close button if we really want it, 
  // but user said "Allow clicking/typing behind it"
}

function updateState(state, message = null) {
  // Check if overlay is enabled in settings
  const settings = settingsManager.getSettings();
  if (!settings.overlayEnabled && state !== AppStates.IDLE) return;

  if (currentStateStatus !== state) {
    console.log(`[STATE] Transition: ${currentStateStatus} -> ${state}`);
    currentStateStatus = state;
    
    // Sync with HotkeyEngine if initialized
    if (hotkeyEngine) {
      hotkeyEngine.onAppStateUpdate(state, AppStates);
    }
  }

  if (!statusWindow || statusWindow.isDestroyed()) createStatusWindow();

  if (state === AppStates.IDLE) {
    statusWindow.webContents.send('hide-status');
    setTimeout(() => { if (statusWindow && !statusWindow.isDestroyed()) statusWindow.hide(); }, 400);
  } else {
    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const { x, y } = primaryDisplay.workArea;
    const { height } = primaryDisplay.workArea;
    statusWindow.setPosition(x, y + height - 20);

    statusWindow.show();
    statusWindow.webContents.send('update-status', state, message);

    // Auto-hide for terminal states
    if (state === AppStates.SUCCESS_PASTE || state === AppStates.SUCCESS_POLISH || state === AppStates.ERROR || state === AppStates.WARNING) {
      setTimeout(() => updateState(AppStates.IDLE), 1500);
    }
  }
}

let tray = null;

function createTray() {
  const iconPath = platformHelper.getIconPath(__dirname);
  const { Menu, Tray } = require('electron');
  tray = new Tray(iconPath);

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show Dashboard', click: () => createDashboardWindow() },
    {
      label: 'Settings', click: () => {
        createDashboardWindow();
        // Potentially send IPC to switch to settings tab here if needed
      }
    },
    { type: 'separator' },
    {
      label: 'Quit Leela V1', click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setToolTip('Leela V1 - AI Assistant');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    createDashboardWindow();
  });
}

function createDashboardWindow() {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.show();
    dashboardWindow.focus();
    return;
  }

  dashboardWindow = new BrowserWindow({
    width: 900,
    height: 600,
    title: 'Leela V1 Dashboard',
    icon: platformHelper.getIconPath(__dirname),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'src', 'preload.js'),
    }
  });

  dashboardWindow.loadFile(path.join(__dirname, 'renderer', 'dashboard.html'));

  // Instead of closing, hide the dashboard
  dashboardWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      dashboardWindow.hide();
    }
  });

  dashboardWindow.on('closed', () => {
    dashboardWindow = null;
  });
}

function createNotificationWindow() {
  if (notificationWindow && !notificationWindow.isDestroyed()) return;

  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  notificationWindow = new BrowserWindow({
    width: 400,
    height: height,
    x: width - 400,
    y: 0,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    show: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'src', 'preload.js'),
    }
  });

  notificationWindow.loadFile(path.join(__dirname, 'renderer', 'notification_panel.html'));

  notificationWindow.on('closed', () => {
    notificationWindow = null;
  });
}

function toggleAssistantSidePanel() {
  if (!notificationWindow || notificationWindow.isDestroyed()) {
    createNotificationWindow();
    setTimeout(() => {
      if (notificationWindow && !notificationWindow.isDestroyed()) {
        notificationWindow.show();
        notificationWindow.focus();
      }
    }, 200);
  } else {
    if (notificationWindow.isVisible()) {
      notificationWindow.hide();
    } else {
      notificationWindow.show();
      notificationWindow.focus();
    }
  }
}

function notifyDashboard(event, data) {
  if (dashboardWindow && !dashboardWindow.isDestroyed()) {
    dashboardWindow.webContents.send(event, data);
  }
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    // Both command line and simple double-click should now trigger the Dashboard
    createDashboardWindow();
  });
}

/**
 * Runs a platform-specific selection script (copy, cut, undo, paste)
 * with a timeout to prevent hangs.
 */
async function runSelectionScript(scriptContent, tempPrefix, settleMs = 100) {
  const scriptPath = path.join(require('os').tmpdir(), `${tempPrefix}_${Date.now()}.${platformHelper.getScriptExtension()}`);
  fs.writeFileSync(scriptPath, scriptContent);
  const cmd = platformHelper.getExecutionCommand(scriptPath);

  try {
    await Promise.race([
      new Promise((resolve) => {
        exec(cmd, { windowsHide: true }, () => resolve());
      }),
      new Promise((resolve) => {
        setTimeout(() => {
          console.warn('[LeelaV1] Selection script timeout for ' + tempPrefix);
          resolve();
        }, 500);
      })
    ]);
  } finally {
    try { fs.unlinkSync(scriptPath); } catch (_) { }
  }

  if (settleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }
}

/**
 * Captures currently selected text by simulating Ctrl+C.
 * The isEditable Cut heuristic has been removed because it
 * conflicts with physically held Ctrl+Space during Hold-to-Talk.
 */
async function captureSelectedText(engine) {
  engine.setCapturing(true);
  console.log('[LeelaV1]', { event: 'selection_capture_started', event_source: 'physical' });

  try {
    const oldClipboard = clipboard.readText();
    clipboard.clear();

    engine.setSyntheticCapture(true);
    await runSelectionScript(platformHelper.getCopyScript(), 'leelacopy', 100);
    engine.setSyntheticCapture(false);
    
    const selectionResult = clipboard.readText();

    if (!selectionResult || selectionResult.trim().length === 0) {
      return { selection: '', oldClipboard, isEditable: false };
    }

    // If we successfully copied text, assume editable. The old Cut heuristic
    // was removed because simulating Ctrl+X while user holds Ctrl+Space
    // causes OS-level key interference, breaking Hold-to-Talk.
    return { selection: selectionResult, oldClipboard, isEditable: true };
  } finally {
    engine.setSyntheticCapture(false);
    engine.setCapturing(false);
    engine.onCaptureCompleted();
  }
}

/**
 * Polishes text using Sarvam Chat API for Intelligent Dictation
 */
async function polishText(text, instruction = null, overrideLang = null, overrideLangName = null) {
  const apiKey = secretManager.getApiKey();
  if (!apiKey) throw new Error('Sarvam API Key not found. Please set it in Settings.');

  const settings = settingsManager.getSettings();
  const targetLang = overrideLang || settings.targetLanguage || 'en';
  const targetLangName = overrideLangName || settings.targetLanguageName || 'English';

  const isEnglish = targetLang === 'en';

  let systemPrompt = "";
  if (instruction) {
    // COMMAND MODE PROMPT: Strict Text Transformation Engine
    systemPrompt = `You are a strict text transformation engine.
Your sole job is to transform "INPUT_TEXT" according to "USER_INSTRUCTION".

STRICT RULES:
1. Return ONLY the final transformed text.
2. Absolutely NO reasoning, explanations, or internal thinking.
3. Absolutely NO <think> or <thought> tags.
4. Absolutely NO quotes around the output.
5. NO metadata, scores, or comments.
6. The output must be clean, copy-ready text.`;
  } else {
    // STANDARD POLISH PROMPT
    systemPrompt = isEnglish
      ? `You are a strict text transformation engine.
Transform the provided transcription into professional, high-quality English.

STRICT RULES:
1. Return ONLY the final polished text.
2. Absolutely NO reasoning, explanations, or internal thinking.
3. Absolutely NO <think> or <thought> tags.
4. Absolutely NO quotes around the output.
5. NO metadata, scores, or comments.`
      : `You are a strict text transformation engine.
Translate/Transform the provided transcription into high-quality ${targetLangName}.

STRICT RULES:
1. Return ONLY the final result text.
2. Absolutely NO reasoning, explanations, or internal thinking.
3. Absolutely NO <think> or <thought> tags.
4. Absolutely NO quotes around the output.
5. NO metadata, scores, or comments.`;
  }

  const userPrompt = instruction
    ? `USER_INSTRUCTION: "${instruction}"\nINPUT_TEXT: "${text}"`
    : `TRANSCRIPTION TO PROCESS: "${text}"`;

  const response = await axios.post('https://api.sarvam.ai/v1/chat/completions', {
    model: 'sarvam-m',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.1
  }, {
    headers: { 'api-subscription-key': apiKey },
    timeout: 30000
  });

  const content = response.data?.choices?.[0]?.message?.content || text;
  console.log('DIAGNOSTIC - RAW_MODEL_OUTPUT:', JSON.stringify(content));

  // EXTRACTION & SANITIZATION
  // Strictly remove all thinking, reasoning, and analysis tags/blocks.
  let cleaned = content
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<internal_analysis>[\s\S]*?<\/internal_analysis>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
    .replace(/<final_result>|<\/final_result>/gi, '')
    .replace(/<final_output>|<\/final_output>/gi, '')
    .replace(/<internal_feedback>[\s\S]*?<\/internal_feedback>/gi, '')
    .trim();
  
  console.log('DIAGNOSTIC - AFTER_RESPONSE_PROCESSOR:', JSON.stringify(cleaned));

  // Safety Cleanup: Prune potential preamble or AI chatter
  const removalPatterns = [
    /^(?:certainly|of course|sure|okay|here is|the (?:polished|transformed) version is)[:\s-]*/i,
    /^(?:Result|Transformed|Polished|Final Text|Here is the result)[:\s-]*/i,
    /^["'«„](.*?)["'»“]$/s
  ];

  for (const regex of removalPatterns) {
    cleaned = cleaned.replace(regex, (match, p1) => p1 || '').trim();
  }

  // Final trim and character cleanup
  cleaned = cleaned.replace(/^[:\s.-]+/, '').trim();
  console.log('DIAGNOSTIC - AFTER_FORMATTER:', JSON.stringify(cleaned));

  return {
    text: cleaned,
    qualityScores: { meaning: 10, grammar: 10, tone: 10 }
  };
}

/**
 * Sync the "Run on Startup" setting with Windows using Electron's API
 */
function syncStartupSetting() {
  const settings = settingsManager.getSettings();
  const startWithWindows = settings.startWithWindows;

  console.log(`[LeelaV1] Syncing startup setting: ${startWithWindows}`);

  try {
    app.setLoginItemSettings({
      openAtLogin: startWithWindows,
      path: process.execPath,
      args: [
        path.resolve(__dirname)
      ]
    });
    console.log(`[LeelaV1] Successfully ${startWithWindows ? 'registered' : 'unregistered'} for startup.`);
  } catch (e) {
    console.error('[LeelaV1] Failed to sync startup setting:', e);
  }
}

app.whenReady().then(() => {
  // First-run Initialization
  const userDataPath = app.getPath('userData');
  const firstRunFile = path.join(userDataPath, 'first_run.flag');
  if (!fs.existsSync(firstRunFile)) {
    console.log('[LeelaV1] First run detected. Initializing setup.');
    // History initialization is handled by activity_logger.js's migrate logic
    // but we can ensure the directory exists here if needed.
    fs.writeFileSync(firstRunFile, 'initialized');
  }

  createTray();

  // createWindow() removed
  createDashboardWindow(); // Single UI window (will show setup or dashboard internally)

  createStatusWindow();

  createNotificationWindow(); // Side panel for chat/actions

  // Handle command line flags
  if (process.argv.includes('--dashboard')) {
    createDashboardWindow();
  }
  // Helper for instant polish (tap behavior)
  async function runInstantPolish(text, oldClipboard) {
    updateState(AppStates.PROCESSING);
    try {
      const polishResult = await polishText(text);
      
      // SURGICAL FIX: Apply shared sanitizer as a final safety layer
      const { sanitizeAIOutput } = require('./src/utils/sanitize_output');
      const polished = sanitizeAIOutput(polishResult.text);
      
      const qualityScores = polishResult.qualityScores;

      if (settingsManager.getSettings().historyEnabled) {
        activityLogger.logAction({
          type: 'Smart Polish',
          input: text,
          output: polished,
          status: 'SUCCESS',
          qualityScores
        });
        notifyDashboard('history-updated');
      }

      clipboard.writeText(polished);
      const scriptContent = platformHelper.getPasteScript();
      const scriptPath = path.join(require('os').tmpdir(), `leelapaste_polish_${Date.now()}.${platformHelper.getScriptExtension()}`);
      fs.writeFileSync(scriptPath, scriptContent);

      const cmd = platformHelper.getExecutionCommand(scriptPath);
      exec(cmd, { windowsHide: true }, () => {
        try { fs.unlinkSync(scriptPath); } catch (_) { }
        setTimeout(() => {
          clipboard.writeText(oldClipboard);
          updateState(AppStates.SUCCESS_POLISH);
        }, 500);
      });
    } catch (err) {
      console.error('[LeelaV1] Polish failed:', err.message);
      updateState(AppStates.ERROR);
      clipboard.writeText(oldClipboard);
    }
  }

  // ── Initialize HotkeyEngine ──────────────────────────────────
  hotkeyEngine = new HotkeyEngine({
    uIOhook,
    getWindows: () => ({ dashboard: dashboardWindow, status: statusWindow, notification: notificationWindow }),
  });

  hotkeyEngine.on('toggle-recorder', () => {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      console.log(`[${new Date().toISOString()}] [IPC] Sending 'hotkey-toggle' to dashboardWindow`);
      dashboardWindow.webContents.send('hotkey-toggle');
    }
  });

  hotkeyEngine.on('request-selection-capture', async ({ sessionId }) => {
    try {
      const result = await captureSelectedText(hotkeyEngine);
      console.log(`[${new Date().toISOString()}] [CAPTURE] captureSelectedText returned:`, JSON.stringify(result));
      hotkeyEngine.onSelectionCaptured(result);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] [LeelaV1] Selection capture error:`, err);
      hotkeyEngine.onSelectionCaptured({ selection: '', oldClipboard: '', isEditable: false });
    }
  });

  hotkeyEngine.on('instant-polish', ({ text, oldClipboard }) => {
    runInstantPolish(text, oldClipboard);
  });

  hotkeyEngine.on('toggle-assistant-panel', () => {
    toggleAssistantSidePanel();
  });

  hotkeyEngine.on('chat-hotkey', () => {
    if (notificationWindow && !notificationWindow.isDestroyed()) {
      notificationWindow.webContents.send('chat-hotkey-toggle');
    }
  });

  hotkeyEngine.on('play-command-sound', () => {
    if (dashboardWindow && !dashboardWindow.isDestroyed()) {
      dashboardWindow.webContents.send('play-command-sound');
    }
  });

  hotkeyEngine.on('state-error', ({ message }) => {
    updateState(AppStates.ERROR, message);
  });

  // ── Register IPC Handlers ────────────────────────────────────
  registerIpcHandlers({
    app,
    clipboard,
    settingsManager,
    secretManager,
    activityLogger,
    optimizer,
    platformHelper,
    cleanup,
    getWindows: () => ({ dashboard: dashboardWindow, status: statusWindow, notification: notificationWindow }),
    getAppState: () => ({
      logs,
      get recordingType() { return hotkeyEngine.recordingType; },
      set recordingType(v) { hotkeyEngine.recordingType = v; },
      get pendingSelection() { return hotkeyEngine.pendingSelection; },
      set pendingSelection(v) { hotkeyEngine.pendingSelection = v; },
      get oldClipboardBeforeSelection() { return hotkeyEngine.oldClipboardBeforeSelection; },
      set oldClipboardBeforeSelection(v) { hotkeyEngine.oldClipboardBeforeSelection = v; },
      get isRecordingActive() { return hotkeyEngine.isRecordingActive; },
      set isRecordingActive(v) { hotkeyEngine.isRecordingActive = v; },
      get activeHotkeySessionId() { return hotkeyEngine.activeSessionId; },
      set activeHotkeySessionId(v) { /* managed by engine */ },
      get hotkeyStartTimestamp() { return hotkeyEngine.startTimestamp; },
      set hotkeyStartTimestamp(v) { /* managed by engine */ },
      get timedOutDeferredStopSessionId() { return hotkeyEngine.timedOutDeferredStopSessionId; },
      set timedOutDeferredStopSessionId(v) { /* managed by engine */ },
      get hotkeyFsmState() { return hotkeyEngine.fsmState; },
    }),
    updateState,
    polishText,
    notifyDashboard,
    syncStartupSetting,
    createDashboardWindow,
    AppStates,
    hotkeyEngine
  });

  uIOhook.start();
  hotkeyEngine.start();

  // Sync startup setting on launch
  syncStartupSetting();

  // Start background cleanup (silent)
  cleanup.initCleanup(__dirname);

  // Start Local Demo Server
  try {
    require("./server/local_demo_server");
    console.log('[LeelaV1] Local Demo Server started successfully');
  } catch (err) {
    console.error('[LeelaV1] Failed to start Local Demo Server:', err);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createDashboardWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Ensure we unregister global shortcuts on quit
app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll();
    console.log('[LeelaV1] Unregistered all global shortcuts');
  } catch (e) {
    console.error('[LeelaV1] Error unregistering global shortcuts:', e);
  }
});

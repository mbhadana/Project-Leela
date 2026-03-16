/**
 * IPC Router — All inter-process communication handlers for LeelaV1.
 *
 * Extracted from main.js to reduce the God Object.
 * Pattern: Factory function with dependency injection.
 * Structure: Stepdown Rule — thin routing at top, implementations below.
 */
const { ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const axios = require('axios');
const FormData = require('form-data');
const ffmpeg = require('ffmpeg-static');
const { sanitizeAiOutput, detectVoiceLanguageDirective, SUPPORTED_VOICE_LANGUAGES } = require('../text_processing');
const { VoicePipeline } = require('./voice_pipeline');

const execAsync = util.promisify(exec);

/**
 * Registers all IPC handlers. Call once after app.whenReady().
 *
 * @param {object} deps — Injected dependencies
 * @param {object} deps.app           — Electron app instance
 * @param {object} deps.clipboard     — Electron clipboard module
 * @param {object} deps.settingsManager
 * @param {object} deps.secretManager
 * @param {object} deps.activityLogger
 * @param {object} deps.optimizer
 * @param {object} deps.platformHelper
 * @param {object} deps.cleanup
 * @param {Function} deps.getWindows  — () => { dashboard, status, notification }
 * @param {Function} deps.getAppState — () => { logs, recordingType, pendingSelection, ... }
 * @param {Function} deps.updateState — (state, message?) => void
 * @param {Function} deps.polishText  — (text, instruction, overrideLang, overrideLangName) => Promise
 * @param {Function} deps.notifyDashboard — (event, data?) => void
 * @param {Function} deps.syncStartupSetting — () => void
 * @param {Function} deps.createDashboardWindow — () => void
 * @param {object} deps.AppStates     — State enum
 * @param {object} deps.hotkeyEngine  — HotkeyEngine instance
 */
function registerIpcHandlers(deps) {
    const {
        app, clipboard,
        settingsManager, secretManager, activityLogger,
        optimizer, platformHelper, cleanup,
        getWindows, getAppState, updateState, polishText, notifyDashboard,
        syncStartupSetting, createDashboardWindow,
        AppStates, hotkeyEngine,
    } = deps;

    // ╔══════════════════════════════════════════════════════════════╗
    // ║  HIGH-LEVEL ROUTING — Thin IPC registrations (Stepdown)     ║
    // ╚══════════════════════════════════════════════════════════════╝

    // ── Recording & Transcription ─────────────────────────────────

    ipcMain.handle('save-temp-recording', async (event, arrayBuffer, filename) => {
        return handleSaveTempRecording(app, arrayBuffer, filename);
    });

    ipcMain.handle('paste-text', async (event, text) => {
        return handlePasteText(text, clipboard, platformHelper);
    });

    ipcMain.handle('transcribe-recording-chat', async (event, filePath) => {
        return handleTranscribeChat(filePath, secretManager, settingsManager);
    });

    ipcMain.handle('process-recording', async (event, filePath) => {
        return handleProcessRecording(filePath, deps);
    });

    // ── Settings & History ────────────────────────────────────────

    ipcMain.handle('get-history', () => {
        return activityLogger.getHistory();
    });

    ipcMain.handle('get-temp-path', () => {
        return app.getPath('temp');
    });

    ipcMain.handle('get-settings', () => {
        return settingsManager.getSettings();
    });

    ipcMain.on('update-setting', (event, newSetting) => {
        const oldSettings = settingsManager.getSettings();
        settingsManager.updateSettings(newSetting);
        if (newSetting.hasOwnProperty('startWithWindows') && newSetting.startWithWindows !== oldSettings.startWithWindows) {
            syncStartupSetting();
        }
    });

    // ── API Key Management ────────────────────────────────────────

    ipcMain.handle('test-sarvam-key', async (event, key) => {
        return handleTestSarvamKey(key, secretManager);
    });

    ipcMain.handle('save-sarvam-key', async (event, key) => {
        return handleSaveSarvamKey(key, secretManager, settingsManager, getWindows, createDashboardWindow);
    });

    ipcMain.handle('remove-sarvam-key', () => {
        return secretManager.removeApiKey();
    });

    ipcMain.handle('has-sarvam-key', () => {
        return secretManager.hasApiKey();
    });

    // ── Logs ──────────────────────────────────────────────────────

    ipcMain.handle('get-logs', () => {
        return getAppState().logs;
    });

    ipcMain.on('clear-logs', () => {
        getAppState().logs.length = 0;
    });

    ipcMain.on('renderer-log', (event, level, msg) => {
        try {
            const logLine = `${new Date().toISOString()} [${level}] ${String(msg)}\n`;
            fs.appendFileSync(path.join(app.getAppPath(), 'renderer.log'), logLine);
        } catch (e) {
            console.error('[LeelaV1] Failed to write renderer.log', e);
        }
    });

    ipcMain.on('overlay-log', (event, msg) => {
        console.log(`[OVERLAY DEBUG] ${msg}`);
    });

    // ── Onboarding ────────────────────────────────────────────────

    ipcMain.handle('get-onboarding-status', () => {
        const settings = settingsManager.getSettings();
        return !settings.onboarding_completed;
    });

    ipcMain.on('complete-onboarding', () => {
        settingsManager.updateSettings({ onboarding_completed: true });
        console.log('[LeelaV1] Onboarding completed.');
    });

    // ── Window Management ─────────────────────────────────────────

    ipcMain.on('open-dashboard', () => {
        createDashboardWindow();
    });

    ipcMain.on('dismiss-notification-panel', () => {
        const { notification } = getWindows();
        if (notification && !notification.isDestroyed()) {
            notification.hide();
        }
    });

    // ── App State Updates ─────────────────────────────────────────

    ipcMain.on('update-app-state', (event, state) => {
        handleUpdateAppState(state, deps);
    });

    ipcMain.on('mic-data', (event, value) => {
        const { status } = getWindows();
        if (status && !status.isDestroyed()) {
            status.webContents.send('mic-data', value);
        }
    });

    // ── Optimizer ─────────────────────────────────────────────────

    ipcMain.handle('optimize-file', async (event, filePath, options) => {
        try {
            const result = await optimizer.optimizeFile(filePath, {
                ...options,
                onProgress: (stage, percent, message) => {
                    notifyDashboard('optimizer-progress', { stage, percent, message });
                },
            });
            return result;
        } catch (e) {
            console.error('[LeelaV1] optimize-file error:', e);
            return { success: false, error: String(e) };
        }
    });

    ipcMain.handle('analyze-file', async (event, filePath) => {
        try {
            return await optimizer.analyzeFile(filePath);
        } catch (e) {
            return { error: String(e) };
        }
    });

    ipcMain.handle('get-optimizer-stats', () => {
        return optimizer.getOptimizerStats();
    });

    ipcMain.handle('get-optimizer-settings', () => {
        return optimizer.getOptimizerSettings();
    });

    ipcMain.on('update-optimizer-settings', (event, newSettings) => {
        optimizer.updateOptimizerSettings(newSettings);
    });

    ipcMain.handle('get-optimizer-metrics', () => {
        return optimizer.getOptimizerMetrics();
    });

    ipcMain.on('reset-optimizer-learning', () => {
        optimizer.resetLearning();
    });

    // ── Notification Commands ─────────────────────────────────────

    ipcMain.on('execute-command', (event, command) => {
        handleExecuteCommand(event, command, getWindows);
    });

    ipcMain.on('notification-action', (event, payload) => {
        console.log('[LeelaV1] Notification Action:', payload);
    });
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  HANDLER IMPLEMENTATIONS — Complex logic (Stepdown Rule)        ║
// ╚══════════════════════════════════════════════════════════════════╝

// ── save-temp-recording ─────────────────────────────────────────

async function handleSaveTempRecording(app, arrayBuffer, filename) {
    try {
        const tempDir = app.getPath('temp');
        const safeName = String(filename || `recording-${Date.now()}.webm`).replace(/[^a-zA-Z0-9._-]/g, '_');
        const filePath = path.join(tempDir, safeName);
        const buffer = Buffer.from(arrayBuffer);
        await fs.promises.writeFile(filePath, buffer);
        return { ok: true, path: filePath };
    } catch (e) {
        console.error('[LeelaV1] save-temp-recording error:', e);
        return { ok: false, error: String(e) };
    }
}

// ── paste-text ──────────────────────────────────────────────────

async function handlePasteText(text, clipboard, platformHelper) {
    try {
        if (!text) return { ok: false, error: 'empty' };
        console.log('[LeelaV1] Pasting transcript:', String(text).substring(0, 50) + '...');
        clipboard.writeText(String(text));

        const scriptContent = platformHelper.getPasteScript();
        const scriptPath = path.join(require('os').tmpdir(), `leelapaste_${Date.now()}.${platformHelper.getScriptExtension()}`);
        fs.writeFileSync(scriptPath, scriptContent);

        const cmd = platformHelper.getExecutionCommand(scriptPath);
        exec(cmd, { windowsHide: true }, () => {
            try { fs.unlinkSync(scriptPath); } catch (_) { }
        });

        return { ok: true };
    } catch (e) {
        console.error('[LeelaV1] paste-text handler error:', e);
        return { ok: false, error: String(e) };
    }
}

// ── transcribe-recording-chat ───────────────────────────────────

async function handleTranscribeChat(filePath, secretManager, settingsManager) {
    try {
        if (!filePath || !fs.existsSync(filePath)) {
            return { ok: false, error: 'file_missing' };
        }

        const apiKey = secretManager.getApiKey();
        if (!apiKey) {
            return { ok: false, error: 'no_api_key' };
        }

        const result = await transcribeSynchronous(filePath, apiKey, settingsManager);
        if (result.ok && result.text) {
            return { ok: true, text: result.text.trim() };
        }

        return { ok: false, error: result.error || 'transcription_failed' };
    } catch (e) {
        return { ok: false, error: String(e) };
    } finally {
        try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (_) { }
    }
}

// ── process-recording ───────────────────────────────────────────

async function handleProcessRecording(filePath, deps) {
    const pipeline = new VoicePipeline(deps);
    
    // Hold-to-Command Context
    const appState = deps.getAppState();
    const isContextCommand = appState.pendingSelection !== null;
    const contextText = appState.pendingSelection;
    const contextClipboard = appState.oldClipboardBeforeSelection;
    
    // Clear pending state immediately to prevent re-runs
    appState.pendingSelection = null;
    appState.oldClipboardBeforeSelection = null;

    if (appState.recordingType === 'TAP_DISCARD') {
        console.log('[LeelaV1] Recording discarded (Quick Polish mode).');
        appState.recordingType = null;
        return { ok: true, text: '' };
    }

    return await pipeline.process(
        filePath, 
        isContextCommand, 
        contextText, 
        contextClipboard
    );
}

// ── Shared paste helper (DRYs the 2x duplicated paste logic) ────

// ── transcribeSynchronous migrated to VoicePipeline ────────────────────────

// ── test-sarvam-key ─────────────────────────────────────────────

async function handleTestSarvamKey(key, secretManager) {
    try {
        const testKey = key || secretManager.getApiKey();
        if (!testKey) return { ok: false, error: 'No API key provided or stored.' };

        await axios.post('https://api.sarvam.ai/v1/chat/completions', {
            model: 'sarvam-m',
            messages: [{ role: 'user', content: 'hello' }],
            max_tokens: 1
        }, {
            headers: { 'api-subscription-key': testKey },
            timeout: 5000
        });

        return { ok: true };
    } catch (err) {
        console.error('[LeelaV1] API Key test failed:', err.response?.data || err.message);
        return { ok: false, error: err.response?.data?.message || err.message };
    }
}

// ── save-sarvam-key ─────────────────────────────────────────────

async function handleSaveSarvamKey(key, secretManager, settingsManager, getWindows, createDashboardWindow) {
    const success = secretManager.setApiKey(key);
    if (success) {
        const { dashboard } = getWindows();
        if (dashboard && !dashboard.isDestroyed()) {
            dashboard.webContents.send('key-saved');

            const settings = settingsManager.getSettings();
            if (!settings.onboarding_completed) {
                setTimeout(() => {
                    const { dashboard: dw } = getWindows();
                    if (dw && !dw.isDestroyed()) {
                        dw.webContents.send('start-onboarding');
                    }
                }, 500);
            }
        }
        createDashboardWindow();
    }
    return success;
}

// ── update-app-state ────────────────────────────────────────────

function handleUpdateAppState(state, deps) {
    const { updateState, AppStates, hotkeyEngine } = deps;
    const newState = AppStates[state] || state;
    updateState(newState);

    // Delegate all FSM/timer/state management to the engine
    if (hotkeyEngine) {
        hotkeyEngine.onAppStateUpdate(newState, AppStates);
    }
}

// ── execute-command ─────────────────────────────────────────────

function handleExecuteCommand(event, command, getWindows) {
    console.log('[LeelaV1] Executing server-routed command:', command);

    const payload = {
        section: 'automations',
        data: {
            title: 'Server Response',
            desc: 'Processed command: "' + String(command) + '"',
            actions: ['Dismiss']
        }
    };

    setTimeout(() => {
        try {
            if (event.sender && !event.sender.isDestroyed()) {
                event.sender.send('new-notification', payload);
                return;
            }
        } catch (err) {
            console.warn('[LeelaV1] Failed to reply to execute-command sender:', err.message);
        }

        const { notification } = getWindows();
        if (notification && !notification.isDestroyed()) {
            notification.webContents.send('new-notification', payload);
        }
    }, 100);
}

module.exports = { registerIpcHandlers };

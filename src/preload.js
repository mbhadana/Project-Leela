/**
 * Preload Bridge — Principle of Least Privilege
 *
 * Exposes a minimal, whitelisted API surface to renderer processes via
 * `window.leela`. No raw Node.js globals (fs, path, Buffer) or
 * ipcRenderer are leaked to the renderer context.
 *
 * Pattern: Revealing Module via contextBridge.exposeInMainWorld
 */
const { contextBridge, ipcRenderer, clipboard, shell } = require('electron');

// ── Channel Whitelists ──────────────────────────────────────────
// Only these channels are allowed through the bridge.
// Any unlisted channel is silently rejected.

const INVOKE_CHANNELS = new Set([
    'paste-text',
    'transcribe-recording-chat',
    'process-recording',
    'get-history',
    'get-temp-path',
    'get-settings',
    'test-sarvam-key',
    'save-sarvam-key',
    'remove-sarvam-key',
    'has-sarvam-key',
    'get-logs',
    'get-onboarding-status',
    'optimize-file',
    'analyze-file',
    'get-optimizer-stats',
    'get-optimizer-settings',
    'get-optimizer-metrics',
    'save-temp-recording',
]);

const SEND_CHANNELS = new Set([
    'renderer-log',
    'mic-data',
    'overlay-log',
    'update-setting',
    'open-dashboard',
    'update-app-state',
    'clear-logs',
    'complete-onboarding',
    'update-optimizer-settings',
    'reset-optimizer-learning',
    'dismiss-notification-panel',
    'execute-command',
    'notification-action',
]);

const RECEIVE_CHANNELS = new Set([
    'mic-data',
    'update-status',
    'hide-status',
    'hotkey-toggle',
    'play-command-sound',
    'start-onboarding',
    'history-updated',
    'key-saved',
    'chat-hotkey-toggle',
    'new-notification',
    'optimizer-progress',
]);

// ── Exposed API ─────────────────────────────────────────────────

contextBridge.exposeInMainWorld('leela', {
    /**
     * Request-response IPC (renderer → main → renderer).
     * Maps to ipcMain.handle on the main side.
     */
    invoke(channel, ...args) {
        if (!INVOKE_CHANNELS.has(channel)) {
            return Promise.reject(new Error(`Blocked invoke on unlisted channel: ${channel}`));
        }
        return ipcRenderer.invoke(channel, ...args);
    },

    /**
     * Fire-and-forget IPC (renderer → main).
     * Maps to ipcMain.on on the main side.
     */
    send(channel, ...args) {
        if (!SEND_CHANNELS.has(channel)) {
            console.warn(`[preload] Blocked send on unlisted channel: ${channel}`);
            return;
        }
        ipcRenderer.send(channel, ...args);
    },

    /**
     * Listen for main → renderer events.
     * Returns the wrapped listener for cleanup via off().
     */
    on(channel, callback) {
        if (!RECEIVE_CHANNELS.has(channel)) {
            console.warn(`[preload] Blocked listener on unlisted channel: ${channel}`);
            return () => { };
        }
        // Wrap to strip the Electron event object from the callback
        const wrappedCallback = (_event, ...args) => callback(...args);
        ipcRenderer.on(channel, wrappedCallback);
        return wrappedCallback;
    },

    /**
     * Remove a previously registered listener.
     */
    off(channel, wrappedCallback) {
        ipcRenderer.removeListener(channel, wrappedCallback);
    },

    // ── Curated Node.js Helpers ─────────────────────────────────
    // These replace direct require('electron') usage in renderers.

    clipboard: {
        writeText(text) {
            clipboard.writeText(String(text));
        },
    },

    shell: {
        openExternal(url) {
            // Only allow http/https URLs for safety
            const parsed = String(url || '');
            if (parsed.startsWith('http://') || parsed.startsWith('https://')) {
                shell.openExternal(parsed);
            } else {
                console.warn(`[preload] Blocked openExternal for non-http URL: ${parsed}`);
            }
        },
    },
});

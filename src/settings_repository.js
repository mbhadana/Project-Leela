/**
 * SettingsRepository — Cached settings with atomic persistence.
 *
 * - In-memory cache loaded once at initialize()
 * - getSettings() always returns from cache (sync, fast)
 * - updateSettings() merges partial, updates cache, then async-flushes
 * - No Electron dependency — file path injected via constructor
 */
const fs = require('fs');

const DEFAULT_SETTINGS = Object.freeze({
    overlayEnabled: true,
    hotkey: 'Ctrl+Space',
    historyEnabled: true,
    historyRetentionLimit: 200,
    startWithWindows: false,
    targetLanguage: 'en',
    targetLanguageName: 'English',
    onboarding_completed: false,
    optimizerEnabled: true,
    optimizerQualityThreshold: 95,
    optimizerMaxFileSizeMB: 500,
    optimizerAutoLearn: true,
    micDeviceId: 'default',
});

class SettingsRepository {
    /**
     * @param {import('./json_file_adapter').JsonFileAdapter} adapter
     * @param {object} options
     * @param {object} options.defaults — Default settings to merge with
     * @param {string[]} options.legacyPaths — Legacy file paths to migrate from
     */
    constructor(adapter, { defaults = DEFAULT_SETTINGS, legacyPaths = [] } = {}) {
        this._adapter = adapter;
        this._defaults = defaults;
        this._legacyPaths = legacyPaths;
        this._cache = { ...defaults };
        this._initialized = false;
    }

    /**
     * Load settings from disk into cache. Run legacy migrations.
     * Must be called once before use. If no file exists, writes defaults.
     */
    async initialize() {
        this._runMigrations();

        const data = await this._adapter.readJson(null);
        if (data && typeof data === 'object') {
            this._cache = { ...this._defaults, ...data };
        } else {
            // First run — persist defaults
            this._cache = { ...this._defaults };
            await this._flush();
        }
        this._initialized = true;
    }

    /**
     * Get all settings from cache.
     * @returns {object} — Copy of the cached settings
     */
    getSettings() {
        this._assertInitialized();
        return { ...this._cache };
    }

    /**
     * Merge partial settings into cache and persist.
     *
     * @param {object} partial — Key-value pairs to merge
     * @returns {object} — Updated settings copy
     */
    updateSettings(partial) {
        this._assertInitialized();
        this._cache = { ...this._cache, ...partial };

        // Async flush — fire-and-forget (errors logged by adapter)
        this._flush();

        return { ...this._cache };
    }

    // ── Internal Methods ────────────────────────────────────────

    async _flush() {
        await this._adapter.writeJson(this._cache);
    }

    _assertInitialized() {
        if (!this._initialized) {
            throw new Error('[SettingsRepository] Not initialized. Call initialize() first.');
        }
    }

    /**
     * Migrate settings from legacy file paths.
     */
    _runMigrations() {
        const targetPath = this._adapter.filePath;

        for (const legacyPath of this._legacyPaths) {
            try {
                if (fs.existsSync(legacyPath)) {
                    if (!fs.existsSync(targetPath)) {
                        fs.copyFileSync(legacyPath, targetPath);
                        console.log(`[SettingsRepository] Migrated settings from ${legacyPath}`);
                    }
                    fs.unlinkSync(legacyPath);
                    console.log(`[SettingsRepository] Removed legacy settings: ${legacyPath}`);
                }
            } catch (e) {
                console.error(`[SettingsRepository] Migration failed for ${legacyPath}:`, e.message);
            }
        }
    }
}

module.exports = { SettingsRepository, DEFAULT_SETTINGS };

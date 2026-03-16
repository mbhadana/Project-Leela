/**
 * HistoryRepository — Read-through cached activity history with atomic persistence.
 *
 * - In-memory cache loaded once at initialize()
 * - logAction() updates cache synchronously, then async-flushes to disk
 * - No Electron dependency — file path injected via constructor
 */
const fs = require('fs');
const path = require('path');

class HistoryRepository {
    /**
     * @param {import('./json_file_adapter').JsonFileAdapter} adapter
     * @param {object} options
     * @param {number} options.maxEntries — Maximum history entries (default: 200)
     * @param {string[]} options.legacyPaths — Legacy file paths to migrate from
     */
    constructor(adapter, { maxEntries = 200, legacyPaths = [] } = {}) {
        this._adapter = adapter;
        this._maxEntries = maxEntries;
        this._legacyPaths = legacyPaths;
        this._cache = [];
        this._initialized = false;
    }

    /**
     * Load history from disk into cache. Run legacy migrations.
     * Must be called once before use.
     */
    async initialize() {
        this._runMigrations();
        this._cache = await this._adapter.readJson([]);
        if (!Array.isArray(this._cache)) {
            console.warn('[HistoryRepository] Corrupt cache data, resetting to empty array');
            this._cache = [];
        }
        this._initialized = true;
    }

    /**
     * Log a new activity entry.
     * Updates cache synchronously, then async-flushes to disk.
     *
     * @param {object} entry
     * @param {string} entry.type
     * @param {string} entry.input
     * @param {string} entry.output
     * @param {string} entry.status
     * @param {object|null} entry.qualityScores
     */
    logAction({ type, input, output, status, qualityScores }) {
        this._assertInitialized();

        const entry = {
            id: Date.now(),
            timestamp: new Date().toISOString(),
            type,
            input: input || '',
            output: output || '',
            status,
            qualityScores: qualityScores || null,
        };

        this._cache.unshift(entry);

        // Enforce max entries
        if (this._cache.length > this._maxEntries) {
            this._cache = this._cache.slice(0, this._maxEntries);
        }

        // Async flush — fire-and-forget (errors logged by adapter)
        this._flush();

        console.log(`[HistoryRepository] Logged ${type}: ${status}`);
    }

    /**
     * Get all history entries from cache.
     * @returns {Array} — Copy of the cached history
     */
    getHistory() {
        this._assertInitialized();
        return [...this._cache];
    }

    // ── Internal Methods ────────────────────────────────────────

    async _flush() {
        await this._adapter.writeJson(this._cache);
    }

    _assertInitialized() {
        if (!this._initialized) {
            throw new Error('[HistoryRepository] Not initialized. Call initialize() first.');
        }
    }

    /**
     * Migrate history from legacy file paths to the current location.
     * Synchronous — runs during initialize() before any async work.
     */
    _runMigrations() {
        const targetPath = this._adapter.filePath;

        for (const legacyPath of this._legacyPaths) {
            try {
                if (fs.existsSync(legacyPath)) {
                    if (!fs.existsSync(targetPath)) {
                        fs.copyFileSync(legacyPath, targetPath);
                        console.log(`[HistoryRepository] Migrated history from ${legacyPath}`);
                    }
                    fs.unlinkSync(legacyPath);
                    console.log(`[HistoryRepository] Removed legacy history: ${legacyPath}`);
                }
            } catch (e) {
                console.error(`[HistoryRepository] Migration failed for ${legacyPath}:`, e.message);
            }
        }
    }
}

module.exports = { HistoryRepository };

/**
 * JsonFileAdapter — Crash-safe JSON file I/O.
 *
 * - Atomic writes: data → .tmp file → fs.rename over original
 * - Async mutex: serializes concurrent writes via promise queue
 * - No Electron dependency — pure Node.js
 */
const fs = require('fs');
const path = require('path');

class JsonFileAdapter {
    /**
     * @param {string} filePath — Absolute path to the JSON file
     */
    constructor(filePath) {
        this._filePath = filePath;
        this._tmpPath = filePath + '.tmp';
        this._writeLock = Promise.resolve(); // Mutex chain
    }

    /** @returns {string} The file path this adapter manages */
    get filePath() {
        return this._filePath;
    }

    /**
     * Read and parse the JSON file.
     * Returns defaultValue if file doesn't exist or is corrupt.
     *
     * @param {*} defaultValue — Value to return on missing/corrupt file
     * @returns {Promise<*>}
     */
    async readJson(defaultValue = null) {
        try {
            const data = await fs.promises.readFile(this._filePath, 'utf8');
            return JSON.parse(data);
        } catch (err) {
            if (err.code === 'ENOENT') {
                return defaultValue;
            }
            // Corrupt JSON — log and return default
            console.error(`[JsonFileAdapter] Corrupt JSON in ${this._filePath}:`, err.message);
            return defaultValue;
        }
    }

    /**
     * Atomically write data to the JSON file.
     * Write to .tmp first, then rename over the original.
     * Serialized by an async mutex to prevent concurrent writes from clobbering.
     *
     * @param {*} data — The data to serialize
     * @returns {Promise<void>}
     */
    async writeJson(data) {
        // Chain onto the mutex — each write waits for the previous to complete
        this._writeLock = this._writeLock.then(() => this._atomicWrite(data)).catch(err => {
            console.error(`[JsonFileAdapter] Write failed for ${this._filePath}:`, err.message);
        });
        return this._writeLock;
    }

    /**
     * Internal: perform the actual atomic write.
     * 1. Ensure directory exists
     * 2. Write to .tmp
     * 3. Rename .tmp → original (atomic on same filesystem)
     */
    async _atomicWrite(data) {
        const dir = path.dirname(this._filePath);
        await fs.promises.mkdir(dir, { recursive: true });

        const serialized = JSON.stringify(data, null, 2);
        await fs.promises.writeFile(this._tmpPath, serialized, 'utf8');
        await fs.promises.rename(this._tmpPath, this._filePath);
    }
}

module.exports = { JsonFileAdapter };

/**
 * Tests for SettingsRepository — defaults, merge, persistence, concurrent updates.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JsonFileAdapter } = require('../src/json_file_adapter');
const { SettingsRepository, DEFAULT_SETTINGS } = require('../src/settings_repository');

const TEST_DIR = path.join(require('os').tmpdir(), `leela_settings_test_${Date.now()}`);
let testCount = 0;
let passCount = 0;

function test(name, fn) {
    testCount++;
    return fn()
        .then(() => { passCount++; console.log(`PASS ${name}`); })
        .catch(err => { console.error(`FAIL ${name}: ${err.message}`); });
}

function freshRepo(name, options = {}) {
    const fp = path.join(TEST_DIR, `${name}_${Date.now()}.json`);
    const adapter = new JsonFileAdapter(fp);
    return { repo: new SettingsRepository(adapter, options), fp, adapter };
}

async function it() {
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // ── DEFAULT_SETTINGS ──────────────────────────────────────────

    await test('DEFAULT_SETTINGS: is frozen (immutable)', async () => {
        DEFAULT_SETTINGS.newProp = true;
        assert.strictEqual(DEFAULT_SETTINGS.newProp, undefined); // Assignment silently ignored
    });

    await test('DEFAULT_SETTINGS: has expected keys', async () => {
        assert.strictEqual(DEFAULT_SETTINGS.overlayEnabled, true);
        assert.strictEqual(DEFAULT_SETTINGS.targetLanguage, 'en');
        assert.strictEqual(DEFAULT_SETTINGS.onboarding_completed, false);
        assert.strictEqual(DEFAULT_SETTINGS.micDeviceId, 'default');
    });

    // ── initialize ────────────────────────────────────────────────

    await test('initialize: creates file with defaults when no file exists', async () => {
        const { repo, fp } = freshRepo('firstrun');
        await repo.initialize();
        // Wait for async flush
        await new Promise(r => setTimeout(r, 100));
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        assert.strictEqual(data.overlayEnabled, true);
        assert.strictEqual(data.targetLanguage, 'en');
    });

    await test('initialize: loads existing settings, merges with defaults', async () => {
        const fp = path.join(TEST_DIR, `existing_${Date.now()}.json`);
        fs.writeFileSync(fp, JSON.stringify({ targetLanguage: 'hi', customField: 'preserved' }));
        const adapter = new JsonFileAdapter(fp);
        const repo = new SettingsRepository(adapter);
        await repo.initialize();
        const settings = repo.getSettings();
        assert.strictEqual(settings.targetLanguage, 'hi'); // From file
        assert.strictEqual(settings.overlayEnabled, true); // From defaults
    });

    await test('initialize: handles corrupt JSON gracefully', async () => {
        const fp = path.join(TEST_DIR, `corrupt_${Date.now()}.json`);
        fs.writeFileSync(fp, '%%%broken%%%');
        const adapter = new JsonFileAdapter(fp);
        const repo = new SettingsRepository(adapter);
        await repo.initialize();
        // Falls back to defaults
        assert.strictEqual(repo.getSettings().overlayEnabled, true);
    });

    // ── getSettings ───────────────────────────────────────────────

    await test('getSettings: returns a copy, not a reference', async () => {
        const { repo } = freshRepo('copy');
        await repo.initialize();
        const s1 = repo.getSettings();
        s1.targetLanguage = 'mutated';
        assert.strictEqual(repo.getSettings().targetLanguage, 'en'); // Unaffected
    });

    // ── updateSettings ────────────────────────────────────────────

    await test('updateSettings: merges partial settings', async () => {
        const { repo } = freshRepo('merge');
        await repo.initialize();
        repo.updateSettings({ targetLanguage: 'hi', targetLanguageName: 'Hindi' });
        const settings = repo.getSettings();
        assert.strictEqual(settings.targetLanguage, 'hi');
        assert.strictEqual(settings.targetLanguageName, 'Hindi');
        assert.strictEqual(settings.overlayEnabled, true); // Other fields preserved
    });

    await test('updateSettings: persists to disk', async () => {
        const { repo, fp } = freshRepo('persist');
        await repo.initialize();
        repo.updateSettings({ overlayEnabled: false });
        await new Promise(r => setTimeout(r, 100));
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        assert.strictEqual(data.overlayEnabled, false);
    });

    await test('updateSettings: returns updated settings copy', async () => {
        const { repo } = freshRepo('return');
        await repo.initialize();
        const result = repo.updateSettings({ startWithWindows: true });
        assert.strictEqual(result.startWithWindows, true);
    });

    // ── Concurrent Updates ────────────────────────────────────────

    await test('updateSettings: rapid concurrent updates preserve last values', async () => {
        const { repo, fp } = freshRepo('concurrent');
        await repo.initialize();

        // Fire 20 rapid updates
        for (let i = 0; i < 20; i++) {
            repo.updateSettings({ historyRetentionLimit: i });
        }

        // Cache should have the latest value immediately
        assert.strictEqual(repo.getSettings().historyRetentionLimit, 19);

        // Wait for disk flush
        await new Promise(r => setTimeout(r, 300));
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        assert.strictEqual(data.historyRetentionLimit, 19);
    });

    // ── Not Initialized ───────────────────────────────────────────

    await test('getSettings: throws if not initialized', async () => {
        const { repo } = freshRepo('noinit');
        assert.throws(() => repo.getSettings(), /Not initialized/);
    });

    await test('updateSettings: throws if not initialized', async () => {
        const { repo } = freshRepo('noinit2');
        assert.throws(() => repo.updateSettings({ x: 1 }), /Not initialized/);
    });

    // ── Cleanup ───────────────────────────────────────────────────
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) { }

    console.log(`\n${passCount}/${testCount} tests passed.`);
    if (passCount < testCount) // process.exit removed for Jest compat
}

run().catch(err => { console.error('Test runner error:', err); // process.exit removed for Jest compat });

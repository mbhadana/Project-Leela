/**
 * Tests for HistoryRepository — cache, logAction, max entries, high-load.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JsonFileAdapter } = require('../src/json_file_adapter');
const { HistoryRepository } = require('../src/history_repository');

const TEST_DIR = path.join(require('os').tmpdir(), `leela_history_test_${Date.now()}`);
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
    return { repo: new HistoryRepository(adapter, options), fp, adapter };
}

async function it() {
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // ── initialize ────────────────────────────────────────────────

    await test('initialize: starts with empty array when no file', async () => {
        const { repo } = freshRepo('empty');
        await repo.initialize();
        assert.deepStrictEqual(repo.getHistory(), []);
    });

    await test('initialize: loads existing data from disk', async () => {
        const fp = path.join(TEST_DIR, `preloaded_${Date.now()}.json`);
        const existing = [{ id: 1, type: 'test', input: 'a', output: 'b', status: 'OK', qualityScores: null, timestamp: '2024-01-01' }];
        fs.writeFileSync(fp, JSON.stringify(existing));
        const adapter = new JsonFileAdapter(fp);
        const repo = new HistoryRepository(adapter);
        await repo.initialize();
        assert.strictEqual(repo.getHistory().length, 1);
        assert.strictEqual(repo.getHistory()[0].id, 1);
    });

    await test('initialize: handles corrupt JSON gracefully', async () => {
        const fp = path.join(TEST_DIR, `corrupt_${Date.now()}.json`);
        fs.writeFileSync(fp, 'not json at all{{');
        const adapter = new JsonFileAdapter(fp);
        const repo = new HistoryRepository(adapter);
        await repo.initialize();
        assert.deepStrictEqual(repo.getHistory(), []);
    });

    // ── logAction ─────────────────────────────────────────────────

    await test('logAction: adds entry to cache', async () => {
        const { repo } = freshRepo('logaction');
        await repo.initialize();
        repo.logAction({ type: 'Voice Dictation', input: 'hello', output: 'Hello.', status: 'SUCCESS' });
        const history = repo.getHistory();
        assert.strictEqual(history.length, 1);
        assert.strictEqual(history[0].type, 'Voice Dictation');
        assert.strictEqual(history[0].input, 'hello');
        assert.strictEqual(history[0].output, 'Hello.');
        assert.strictEqual(history[0].status, 'SUCCESS');
    });

    await test('logAction: newest entry is first (unshift)', async () => {
        const { repo } = freshRepo('order');
        await repo.initialize();
        repo.logAction({ type: 'A', input: '', output: '', status: 'OK' });
        repo.logAction({ type: 'B', input: '', output: '', status: 'OK' });
        assert.strictEqual(repo.getHistory()[0].type, 'B');
        assert.strictEqual(repo.getHistory()[1].type, 'A');
    });

    await test('logAction: entry has id, timestamp, qualityScores', async () => {
        const { repo } = freshRepo('fields');
        await repo.initialize();
        const scores = { meaning: 9, grammar: 8, tone: 7 };
        repo.logAction({ type: 'Polish', input: 'x', output: 'y', status: 'OK', qualityScores: scores });
        const entry = repo.getHistory()[0];
        assert.strictEqual(typeof entry.id, 'number');
        assert.strictEqual(typeof entry.timestamp, 'string');
        assert.deepStrictEqual(entry.qualityScores, scores);
    });

    await test('logAction: defaults missing input/output to empty string', async () => {
        const { repo } = freshRepo('defaults');
        await repo.initialize();
        repo.logAction({ type: 'T', status: 'OK' });
        assert.strictEqual(repo.getHistory()[0].input, '');
        assert.strictEqual(repo.getHistory()[0].output, '');
        assert.strictEqual(repo.getHistory()[0].qualityScores, null);
    });

    // ── Max Entries ───────────────────────────────────────────────

    await test('logAction: enforces maxEntries limit', async () => {
        const { repo } = freshRepo('maxentries', { maxEntries: 5 });
        await repo.initialize();
        for (let i = 0; i < 8; i++) {
            repo.logAction({ type: `T${i}`, input: '', output: '', status: 'OK' });
        }
        assert.strictEqual(repo.getHistory().length, 5);
        // Newest entry should be T7
        assert.strictEqual(repo.getHistory()[0].type, 'T7');
    });

    // ── Persistence ───────────────────────────────────────────────

    await test('logAction: persists to disk', async () => {
        const { repo, fp } = freshRepo('persist');
        await repo.initialize();
        repo.logAction({ type: 'Persist', input: 'a', output: 'b', status: 'OK' });
        // Wait for async flush
        await new Promise(r => setTimeout(r, 100));
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        assert.strictEqual(data.length, 1);
        assert.strictEqual(data[0].type, 'Persist');
    });

    // ── getHistory: cache isolation ───────────────────────────────

    await test('getHistory: returns a copy, not a reference', async () => {
        const { repo } = freshRepo('isolation');
        await repo.initialize();
        repo.logAction({ type: 'T', input: '', output: '', status: 'OK' });
        const h1 = repo.getHistory();
        h1.push({ id: 999 }); // Mutate the returned array
        assert.strictEqual(repo.getHistory().length, 1); // Cache unaffected
    });

    // ── High-Load Test ────────────────────────────────────────────

    await test('HIGH-LOAD: 50 rapid logAction calls — no data loss', async () => {
        const { repo, fp } = freshRepo('highload', { maxEntries: 100 });
        await repo.initialize();

        for (let i = 0; i < 50; i++) {
            repo.logAction({ type: `Load${i}`, input: `in${i}`, output: `out${i}`, status: 'OK' });
        }

        // Cache should have all 50 immediately
        assert.strictEqual(repo.getHistory().length, 50);

        // Wait for all async flushes to complete
        await new Promise(r => setTimeout(r, 500));

        // Disk should also have all 50
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        assert.strictEqual(data.length, 50);
        assert.strictEqual(data[0].type, 'Load49'); // Most recent first
        assert.strictEqual(data[49].type, 'Load0'); // Oldest last
    });

    // ── Not Initialized ───────────────────────────────────────────

    await test('getHistory: throws if not initialized', async () => {
        const { repo } = freshRepo('noinit');
        assert.throws(() => repo.getHistory(), /Not initialized/);
    });

    await test('logAction: throws if not initialized', async () => {
        const { repo } = freshRepo('noinit2');
        assert.throws(() => repo.logAction({ type: 'T', status: 'OK' }), /Not initialized/);
    });

    // ── Cleanup ───────────────────────────────────────────────────
    try { fs.rmSync(TEST_DIR, { recursive: true, force: true }); } catch (_) { }

    console.log(`\n${passCount}/${testCount} tests passed.`);
    if (passCount < testCount) // process.exit removed for Jest compat
}

run().catch(err => { console.error('Test runner error:', err); // process.exit removed for Jest compat });

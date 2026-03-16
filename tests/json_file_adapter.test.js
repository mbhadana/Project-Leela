/**
 * Tests for JsonFileAdapter — atomic writes, mutex, error handling.
 * Uses the same assert + it() harness as the rest of the test suite.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JsonFileAdapter } = require('../src/json_file_adapter');

const TEST_DIR = path.join(require('os').tmpdir(), `leela_adapter_test_${Date.now()}`);
let testCount = 0;
let passCount = 0;

function test(name, fn) {
    testCount++;
    return fn()
        .then(() => { passCount++; console.log(`PASS ${name}`); })
        .catch(err => { console.error(`FAIL ${name}: ${err.message}`); });
}

function freshPath(name) {
    return path.join(TEST_DIR, `${name}_${Date.now()}.json`);
}

async function run() {
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // ── readJson ──────────────────────────────────────────────────

    await test('readJson: returns default when file missing', async () => {
        const adapter = new JsonFileAdapter(freshPath('missing'));
        const result = await adapter.readJson({ fallback: true });
        assert.deepStrictEqual(result, { fallback: true });
    });

    await test('readJson: returns null default when file missing', async () => {
        const adapter = new JsonFileAdapter(freshPath('missing'));
        const result = await adapter.readJson();
        assert.strictEqual(result, null);
    });

    await test('readJson: parses valid JSON', async () => {
        const fp = freshPath('valid');
        fs.writeFileSync(fp, JSON.stringify({ key: 'value' }));
        const adapter = new JsonFileAdapter(fp);
        const result = await adapter.readJson();
        assert.deepStrictEqual(result, { key: 'value' });
    });

    await test('readJson: returns default on corrupt JSON', async () => {
        const fp = freshPath('corrupt');
        fs.writeFileSync(fp, '{broken json!!!');
        const adapter = new JsonFileAdapter(fp);
        const result = await adapter.readJson([]);
        assert.deepStrictEqual(result, []);
    });

    // ── writeJson ─────────────────────────────────────────────────

    await test('writeJson: creates file with correct content', async () => {
        const fp = freshPath('write');
        const adapter = new JsonFileAdapter(fp);
        await adapter.writeJson({ hello: 'world' });
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        assert.deepStrictEqual(data, { hello: 'world' });
    });

    await test('writeJson: no .tmp file remains after write', async () => {
        const fp = freshPath('notmp');
        const adapter = new JsonFileAdapter(fp);
        await adapter.writeJson({ clean: true });
        assert.strictEqual(fs.existsSync(fp + '.tmp'), false);
    });

    await test('writeJson: creates parent directories', async () => {
        const deepPath = path.join(TEST_DIR, 'deep', 'nested', `dirs_${Date.now()}.json`);
        const adapter = new JsonFileAdapter(deepPath);
        await adapter.writeJson({ deep: true });
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(deepPath, 'utf8')), { deep: true });
    });

    await test('writeJson: overwrites existing file', async () => {
        const fp = freshPath('overwrite');
        const adapter = new JsonFileAdapter(fp);
        await adapter.writeJson({ version: 1 });
        await adapter.writeJson({ version: 2 });
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        assert.strictEqual(data.version, 2);
    });

    // ── Mutex / Concurrency ───────────────────────────────────────

    await test('writeJson: concurrent writes serialize correctly (no data loss)', async () => {
        const fp = freshPath('concurrent');
        const adapter = new JsonFileAdapter(fp);

        // Fire 20 concurrent writes
        const promises = [];
        for (let i = 0; i < 20; i++) {
            promises.push(adapter.writeJson({ index: i }));
        }
        await Promise.all(promises);

        // The last write (index 19) should win since mutex serializes them in order
        const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
        assert.strictEqual(data.index, 19);
    });

    await test('writeJson: file is valid JSON after all concurrent writes', async () => {
        const fp = freshPath('valid_after_concurrent');
        const adapter = new JsonFileAdapter(fp);
        const promises = [];
        for (let i = 0; i < 30; i++) {
            promises.push(adapter.writeJson({ items: Array.from({ length: i + 1 }, (_, j) => j) }));
        }
        await Promise.all(promises);

        // File should be valid JSON, not corrupted
        const raw = fs.readFileSync(fp, 'utf8');
        assert.doesNotThrow(() => JSON.parse(raw), 'File should be valid JSON after concurrent writes');
    });

    // ── Roundtrip ─────────────────────────────────────────────────

    await test('writeJson + readJson: roundtrip preserves data', async () => {
        const fp = freshPath('roundtrip');
        const adapter = new JsonFileAdapter(fp);
        const data = [{ id: 1, name: 'test' }, { id: 2, name: 'other' }];
        await adapter.writeJson(data);
        const result = await adapter.readJson();
        assert.deepStrictEqual(result, data);
    });

    // ── Cleanup ───────────────────────────────────────────────────
    try {
        fs.rmSync(TEST_DIR, { recursive: true, force: true });
    } catch (_) { }

    console.log(`\n${passCount}/${testCount} tests passed.`);
    if (passCount < testCount) // process.exit removed for Jest compat
}

run().catch(err => { console.error('Test runner error:', err); // process.exit removed for Jest compat });

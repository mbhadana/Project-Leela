const { VoicePipeline } = require('../src/voice_pipeline');
const { Worker } = require('worker_threads');
const fs = require('fs');
const axios = require('axios');

// Mock out all external effects/I/O
jest.mock('worker_threads');
jest.mock('fs');
jest.mock('axios');
jest.mock('child_process', () => ({
    exec: jest.fn((cmd, opts, cb) => cb(null))
}));

describe('VoicePipeline (3A Isolaton)', () => {
    let deps;
    let pipeline;

    // ARRANGE
    beforeEach(() => {
        deps = {
            clipboard: { writeText: jest.fn() },
            settingsManager: {
                getSettings: jest.fn().mockReturnValue({ historyEnabled: true, targetLanguage: 'en' })
            },
            secretManager: {
                getApiKey: jest.fn().mockReturnValue('fake_api_key')
            },
            activityLogger: { logAction: jest.fn() },
            platformHelper: {
                getPasteScript: jest.fn().mockReturnValue('mock script'),
                getScriptExtension: jest.fn().mockReturnValue('vbs'),
                getExecutionCommand: jest.fn().mockReturnValue('echo test')
            },
            updateState: jest.fn(),
            polishText: jest.fn(),
            notifyDashboard: jest.fn(),
            AppStates: {
                PROCESSING: 'PROCESSING',
                SUCCESS_PASTE: 'SUCCESS_PASTE',
                WARNING: 'WARNING',
                ERROR: 'ERROR'
            }
        };

        fs.existsSync.mockReturnValue(true);
        fs.unlinkSync.mockImplementation(() => {});
        fs.readdirSync.mockReturnValue(['chunk1.wav']);
        fs.createReadStream.mockReturnValue('fakeStream');

        pipeline = new VoicePipeline(deps);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('should complete the entire pipeline properly (Happy Path)', async () => {
        // ARRANGE
        const mockWorker = {
            postMessage: jest.fn(),
            on: jest.fn((event, callback) => {
                if (event === 'message') {
                    // Simulate fast success
                    setTimeout(() => callback({ type: 'CONVERSION_COMPLETE', payload: { chunkFiles: ['chunk1.wav'] } }), 10);
                }
            })
        };
        Worker.mockImplementation(() => mockWorker);

        axios.post.mockResolvedValue({ data: { transcript: 'Hello World' } });

        // ACT
        // Process a raw recording. No context command applied
        const result = await pipeline.process('/path/to/fake.webm', false, null, null);

        // ASSERT
        // Validates transcript correctly processed
        expect(result.ok).toBe(true);
        expect(result.text).toBe('Hello World');

        // Validates Worker initialized and signaled correctly
        expect(Worker).toHaveBeenCalledTimes(1);
        expect(mockWorker.postMessage).toHaveBeenCalledWith({
            type: 'START_CONVERSION',
            payload: { webmPath: '/path/to/fake.webm' }
        });

        // Mock execution of leelapaste script
        const execSpy = require('child_process').exec;
        execSpy.mockImplementation((cmd, opts, cb) => cb(null));

        // Validates API was hit
        expect(axios.post).toHaveBeenCalledTimes(1);
        
        // Ensure state updates triggered properly to keep UI responsive
        expect(deps.updateState).toHaveBeenCalledWith(deps.AppStates.PROCESSING);
    });

    it('should catch errors appropriately (Unhappy Path)', async () => {
        // ARRANGE
        const mockWorker = {
            postMessage: jest.fn(),
            on: jest.fn((event, callback) => {
                if (event === 'message') {
                    setTimeout(() => callback({ type: 'CONVERSION_ERROR', error: 'FFmpeg crashed' }), 10);
                }
            })
        };
        Worker.mockImplementation(() => mockWorker);

        // ACT
        const result = await pipeline.process('/path/to/fake.webm', false, null, null);

        // ASSERT
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/Worker Error: FFmpeg crashed/);
        expect(deps.updateState).toHaveBeenCalledWith(deps.AppStates.ERROR, expect.any(String));
    });

    it('should apply polish and respect quality thresholds', async () => {
        // ARRANGE
        const mockWorker = {
            postMessage: jest.fn(),
            on: jest.fn((event, callback) => {
                if (event === 'message') {
                    setTimeout(() => callback({ type: 'CONVERSION_COMPLETE', payload: { chunkFiles: ['chunk1.wav'] } }), 10);
                }
            })
        };
        Worker.mockImplementation(() => mockWorker);
        axios.post.mockResolvedValue({ data: { transcript: 'Translate to Spanish: Hello' } });

        // Simulate polish returning low score
        deps.polishText.mockResolvedValue({
            text: 'Hola',
            qualityScores: { meaning: 5, grammar: 8, tone: 9 }
        });

        const execSpy = require('child_process').exec;
        execSpy.mockImplementation((cmd, opts, cb) => cb(null)); // Success paste

        // ACT
        const result = await pipeline.process('/path/to/fake.webm', false, null, null);

        // ASSERT
        // Because of meaning=5, pipeline will trigger WARNING AppState immediately
        expect(deps.updateState).toHaveBeenCalledWith(deps.AppStates.WARNING, 'Low Quality Detected');
    });
});

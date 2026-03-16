const { Worker } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const { API_ENDPOINTS, VOICE_MODELS, THRESHOLDS, TIMEOUTS } = require('./config/constants');
const { sanitizeAiOutput, detectVoiceLanguageDirective, SUPPORTED_VOICE_LANGUAGES } = require('../text_processing');

/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  VoicePipeline                                               ║
 * ║  Orchestrator for the "audio to text" workflow               ║
 * ╚══════════════════════════════════════════════════════════════╝
 */
const { polishText } = require('./utils/ai_polish');
const secretManager = require('../secret_manager');
const settingsManager = require('../settings_manager');

class VoicePipeline {
    constructor(deps) {
        // Injection of dependencies from main.js/ipc_router
        this.clipboard = deps.clipboard;
        this.settingsManager = deps.settingsManager;
        this.secretManager = deps.secretManager;
        this.activityLogger = deps.activityLogger;
        this.platformHelper = deps.platformHelper;
        this.updateState = deps.updateState;
        this.polishText = deps.polishText;
        this.notifyDashboard = deps.notifyDashboard;
        this.AppStates = deps.AppStates;
    }

    /**
     * STATIC HELPER FOR DEMO API
     * Provides a direct way to process text without a full pipeline instance.
     */
    static async processText({ input, instruction }) {
        try {
            const settings = settingsManager.getSettings();
            const result = await polishText(input, instruction, {
                apiKey: secretManager.getApiKey(),
                targetLanguage: settings.targetLanguage,
                targetLanguageName: settings.targetLanguageName
            });
            return result.text;
        } catch (error) {
            console.error('[VoicePipeline] processText failed:', error);
            throw error;
        }
    }

    /**
     * TOP-LEVEL ORCHESTRATOR
     * Ensures all steps complete via a single Promise chain. Eradicates Zalgo.
     */
    async process(filePath, isContextCommand, contextText, contextClipboard) {
        this.updateState(this.AppStates.PROCESSING);
        let finalState = this.AppStates.IDLE;
        let finalMessage = null;

        try {
            this._validateEnvironment(filePath);

            const apiKey = this.secretManager.getApiKey();
            console.log('[VoicePipeline] Starting fast-path transcription for:', filePath);

            // Step 1: Threaded conversion and chunking (Non-blocking)
            const chunks = await this._runFfmpegWorker(filePath);

            // Step 2: Batch transcription
            const transcript = await this._transcribeChunks(chunks, apiKey);
            console.log('DIAGNOSTIC - VOICE_PIPELINE_RAW_TRANSCRIPT:', JSON.stringify(transcript));
            console.log('[VoicePipeline] Transcript received:', transcript);

            // Step 3: Directive and AI Polish
            const finishResult = await this._applyPolishAndFinish(
                transcript, 
                isContextCommand, 
                contextText, 
                contextClipboard
            );
            
            finalState = finishResult.state || this.AppStates.SUCCESS_PASTE;
            finalMessage = finishResult.message;

            return { ok: true, text: transcript };

        } catch (error) {
            console.error('[VoicePipeline] Execution Failed:', error);
            finalState = this.AppStates.ERROR;
            finalMessage = error.message || 'System Error';
            return { ok: false, error: finalMessage };
        } finally {
            // The Invariant: Safely release system locks back to IDLE or equivalent
            this.updateState(finalState, finalMessage);
            
            try { 
                if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); 
            } catch (fsErr) {
                console.warn('[VoicePipeline] Failed to delete temp audio file:', fsErr.message);
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────
    // LOW-LEVEL IMPLEMENTATIONS (Stepdown Rule)
    // ─────────────────────────────────────────────────────────────────

    _validateEnvironment(filePath) {
        if (!filePath || !fs.existsSync(filePath)) {
            throw new Error('File Missing');
        }
        if (!this.secretManager.getApiKey()) {
            throw new Error('API Key Missing');
        }
    }

    /**
     * Spawns worker to keep main event loop free. 
     */
    _runFfmpegWorker(webmPath) {
        return new Promise((resolve, reject) => {
            const workerPath = path.join(__dirname, 'workers', 'ffmpeg_worker.js');
            const worker = new Worker(workerPath);

            worker.postMessage({
                type: 'START_CONVERSION',
                payload: { webmPath }
            });

            worker.on('message', (message) => {
                if (message.type === 'CONVERSION_COMPLETE') {
                    resolve(message.payload.chunkFiles);
                } else if (message.type === 'CONVERSION_ERROR') {
                    reject(new Error(`Worker Error: ${message.error}`));
                }
            });

            worker.on('error', reject);
            worker.on('exit', (code) => {
                if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
            });
        });
    }

    /**
     * Orchestrates batch transcription of chunks
     */
    async _transcribeChunks(chunkFiles, apiKey) {
        if (!chunkFiles || chunkFiles.length === 0) {
            throw new Error('transcription_failed - no chunks available');
        }

        console.log(`[VoicePipeline] Transcribing ${chunkFiles.length} chunk(s)...`);
        const transcripts = [];
        const settings = this.settingsManager.getSettings();
        const targetLanguage = settings.targetLanguage || 'en';

        for (const chunk of chunkFiles) {
            try {
                const text = await this._transcribeSingleChunk(chunk, apiKey, targetLanguage);
                if (text) transcripts.push(text);
            } catch (err) {
                console.error(`[VoicePipeline] Chunk failed:`, err.message);
            } finally {
                // Garbage collect chunk after processing
                try { 
                    fs.unlinkSync(chunk); 
                } catch (fsErr) {
                    console.warn(`[VoicePipeline] Failed to delete audio chunk ${chunk}:`, fsErr.message);
                }
            }
        }

        if (transcripts.length === 0) throw new Error('transcription_failed');
        return transcripts.join(' ').trim();
    }

    async _transcribeSingleChunk(chunkFilePath, apiKey, targetLanguage) {
        const formData = new FormData();
        formData.append('file', fs.createReadStream(chunkFilePath), {
            filename: 'audio.wav',
            contentType: 'audio/wav'
        });
        formData.append('model', VOICE_MODELS.TRANSLATION);
        formData.append('mode', 'translate');
        formData.append('targetLanguage', targetLanguage);

        const response = await axios.post(API_ENDPOINTS.SARVAM_SPEECH_TO_TEXT, formData, {
            headers: {
                ...formData.getHeaders(),
                'api-subscription-key': apiKey
            },
            timeout: TIMEOUTS.TRANSCRIPTION_API_MS
        });

        return response.data?.transcript?.trim();
    }

    /**
     * High-level AI polish and final clipboard application.
     * Prevents Zalgo by awaiting the paste operation completely.
     */
    async _applyPolishAndFinish(transcript, isContextCommand, contextText, contextClipboard) {
        const directive = detectVoiceLanguageDirective(transcript, SUPPORTED_VOICE_LANGUAGES);
        const { overrideLang, overrideLangName, cleanTranscript } = directive;

        if (overrideLang && overrideLangName) {
            console.log(`[VoicePipeline] Voice Directive Detected: ${overrideLangName}. Clean text: ${cleanTranscript}`);
        }

        let finalResult = transcript;
        let finalState = this.AppStates.SUCCESS_PASTE;
        let finalMessage = null;
        let qualityScores = null;

        try {
            console.log('[VoicePipeline] Starting AI Polish...');
            const { polishText } = require('./utils/ai_polish');
            const settings = this.settingsManager.getSettings();
            
            const polishResult = isContextCommand
                ? await polishText(contextText, transcript, {
                    apiKey: this.secretManager.getApiKey(),
                    targetLanguage: overrideLang || settings.targetLanguage,
                    targetLanguageName: overrideLangName || settings.targetLanguageName
                })
                : await polishText(cleanTranscript, null, {
                    apiKey: this.secretManager.getApiKey(),
                    targetLanguage: overrideLang || settings.targetLanguage,
                    targetLanguageName: overrideLangName || settings.targetLanguageName
                });

            if (polishResult && polishResult.text) {
                finalResult = polishResult.text;
                qualityScores = polishResult.qualityScores;
            }
            
            // Check quality threshold to identify poor text mapping
            if (qualityScores) {
                const minScore = Math.min(qualityScores.meaning, qualityScores.grammar, qualityScores.tone);
                if (minScore < THRESHOLDS.MIN_QUALITY_SCORE_THRESHOLD) {
                    finalState = this.AppStates.WARNING;
                    finalMessage = 'Low Quality Detected';
                    console.warn('[VoicePipeline] Low-quality result detected:', qualityScores);
                }
            }
        } catch (err) {
            console.warn('[VoicePipeline] Auto-polish failed, using raw transcript:', err.message);
        }

        const logEntry = {
            type: isContextCommand ? 'Context Command' : (finalResult === transcript ? 'Voice Dictation' : 'Smart Polish'),
            input: isContextCommand ? `Context: ${contextText} | Cmd: ${transcript}` : transcript,
            output: finalResult,
            status: 'SUCCESS',
            qualityScores: qualityScores || undefined,
        };

        // Fully await execution
        await this._pasteAndLogResults(
            finalResult, 
            logEntry, 
            isContextCommand ? contextClipboard : null
        );
        
        return { state: finalState, message: finalMessage };
    }

    /**
     * Wraps exec inside a Promise to properly bubble and serialize events.
     */
    _pasteAndLogResults(text, logEntry, contextClipboard) {
        return new Promise((resolve, reject) => {
            this.clipboard.writeText(String(text));
            const scriptContent = this.platformHelper.getPasteScript();
            const scriptPath = path.join(require('os').tmpdir(), `leelapaste_fast_${Date.now()}.${this.platformHelper.getScriptExtension()}`);
            fs.writeFileSync(scriptPath, scriptContent);

            const cmd = this.platformHelper.getExecutionCommand(scriptPath);
            const { exec } = require('child_process');

            exec(cmd, { windowsHide: true }, (err) => {
                try { 
                    fs.unlinkSync(scriptPath); 
                } catch (scriptErr) { 
                    console.warn('[VoicePipeline] Failed to delete paste script:', scriptErr.message);
                }
                
                if (err) {
                    console.error('[VoicePipeline] Failed to paste:', err);
                    return reject(err);
                }

                // Happy path
                if (this.settingsManager.getSettings().historyEnabled) {
                    this.activityLogger.logAction(logEntry);
                    this.notifyDashboard('history-updated');
                }

                if (contextClipboard) {
                    setTimeout(() => this.clipboard.writeText(contextClipboard), 500);
                }
                
                resolve();
            });
        });
    }
}

module.exports = { VoicePipeline };

/**
 * Text Processing Module — Pure functions for AI output sanitization
 * and voice language directive detection.
 *
 * Extracted from main.js to enable independent testing and reuse.
 * Zero Electron dependencies — works in any Node.js environment.
 */

// ── Supported Voice Languages ───────────────────────────────────
// Used by detectVoiceLanguageDirective and the process-recording pipeline.
const SUPPORTED_VOICE_LANGUAGES = Object.freeze([
    { code: 'hi', name: 'Hindi' },
    { code: 'fr', name: 'French' },
    { code: 'es', name: 'Spanish' },
    { code: 'de', name: 'German' },
    { code: 'it', name: 'Italian' },
    { code: 'ja', name: 'Japanese' },
    { code: 'ko', name: 'Korean' },
    { code: 'zh', name: 'Chinese' },
    { code: 'bn', name: 'Bengali' },
    { code: 'ta', name: 'Tamil' },
    { code: 'te', name: 'Telugu' },
    { code: 'gu', name: 'Gujarati' },
    { code: 'kn', name: 'Kannada' },
    { code: 'ml', name: 'Malayalam' },
    { code: 'mr', name: 'Marathi' },
    { code: 'pa', name: 'Punjabi' },
    { code: 'or', name: 'Odia' },
    { code: 'en', name: 'English' },
]);

// ── AI Output Sanitization ──────────────────────────────────────

/**
 * Cleans raw AI model output for end-user consumption.
 *
 * Strips: markdown code fences, think/analysis XML tags, smart quotes,
 * conversational preamble ("Certainly!", "Here is the result:"), and
 * excessive whitespace.
 *
 * @param {string} content   — Raw AI response text
 * @param {string} fallbackText — Returned if cleaned output is empty
 * @returns {string} Cleaned text ready for pasting
 */
function sanitizeAiOutput(content, fallbackText) {
    const normalizedFallback = String(fallbackText || '').trim();
    
    // Import the surgical sanitizer
    const { sanitizeAIOutput } = require('./src/utils/sanitize_output');
    let cleaned = sanitizeAIOutput(content);

    // Safety Cleanup: Prune potential preamble or AI chatter
    const removalPatterns = [
        /^(?:certainly|of course|sure|okay|here is|the (?:polished|transformed) version is)[:\s-]*/i,
        /^(?:Result|Transformed|Polished|Final Text|Here is the result)[:\s-]*/i,
        /^["'](.*?)["']$/s
    ];

    for (const regex of removalPatterns) {
        cleaned = cleaned.replace(regex, (match, p1) => p1 || '').trim();
    }

    cleaned = cleaned
        .replace(/^[:\s.-]+/, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return cleaned || normalizedFallback;
}

// ── Voice Language Directive Detection ──────────────────────────

/**
 * Parses a voice transcript for language-switching directives.
 *
 * Recognises patterns like:
 *   - "translate to Hindi: hello world"  (start directive)
 *   - "hello world, write in French"     (end directive)
 *   - "translate to Hindi"               (directive-only)
 *
 * @param {string} transcript — Raw voice transcript
 * @param {Array<{code: string, name: string}>} languages — Supported languages
 * @returns {{ overrideLang: string|null, overrideLangName: string|null, cleanTranscript: string }}
 */
function detectVoiceLanguageDirective(transcript, languages) {
    const source = String(transcript || '').trim();
    if (!source) return { overrideLang: null, overrideLangName: null, cleanTranscript: source };

    for (const lang of languages) {
        const langPattern = lang.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const startRegex = new RegExp(
            `^(?:translate\\s+(?:to|in)\\s+|write\\s+in\\s+|convert\\s+to\\s+|say\\s+in\\s+|in\\s+)${langPattern}[,:\\s-]+(.*)`,
            'i'
        );
        const endRegex = new RegExp(
            `^(.*?)[,:\\s-]+(?:translate\\s+(?:to|in)\\s+|write\\s+in\\s+|convert\\s+to\\s+|say\\s+in\\s+|in\\s+)${langPattern}[.]?$`,
            'i'
        );
        const directiveOnlyRegex = new RegExp(
            `^(?:translate\\s+(?:to|in)\\s+|write\\s+in\\s+|convert\\s+to\\s+|say\\s+in\\s+|in\\s+)${langPattern}[.!?]?$`,
            'i'
        );

        const startMatch = source.match(startRegex);
        if (startMatch && startMatch[1]) {
            return {
                overrideLang: lang.code,
                overrideLangName: lang.name,
                cleanTranscript: startMatch[1].trim()
            };
        }

        if (directiveOnlyRegex.test(source)) {
            return {
                overrideLang: lang.code,
                overrideLangName: lang.name,
                cleanTranscript: source
            };
        }

        const endMatch = source.match(endRegex);
        if (endMatch && endMatch[1]) {
            return {
                overrideLang: lang.code,
                overrideLangName: lang.name,
                cleanTranscript: endMatch[1].trim()
            };
        }
    }

    return { overrideLang: null, overrideLangName: null, cleanTranscript: source };
}

module.exports = {
    sanitizeAiOutput,
    detectVoiceLanguageDirective,
    SUPPORTED_VOICE_LANGUAGES,
};

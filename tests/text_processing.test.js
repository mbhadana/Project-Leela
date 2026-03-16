const assert = require('assert');
const {
    sanitizeAiOutput,
    detectVoiceLanguageDirective,
    SUPPORTED_VOICE_LANGUAGES,
} = require('../text_processing');

function it(name, fn) {
    try {
        fn();
        process.stdout.write(`PASS ${name}\n`);
    } catch (error) {
        process.stderr.write(`FAIL ${name}: ${error.message}\n`);
        process.exitCode = 1;
    }
}

// ── sanitizeAiOutput ────────────────────────────────────────────

run('sanitizeAiOutput: strips markdown code fences', () => {
    // Arrange
    const input = '```json\n{"key": "value"}\n```';
    // Act
    const result = sanitizeAiOutput(input, 'fallback');
    // Assert
    assert.ok(!result.includes('```'), 'Should strip code fences');
    assert.ok(result.includes('"key"'), 'Should preserve inner content');
});

run('sanitizeAiOutput: strips <think> tags but preserves inner text', () => {
    // Arrange — think tags are stripped but content is kept (unlike analysis blocks)
    const input = '<think>Internal reasoning here</think>The actual output';
    // Act
    const result = sanitizeAiOutput(input, 'fallback');
    // Assert
    assert.ok(!result.includes('<think>'), 'Should remove opening think tag');
    assert.ok(!result.includes('</think>'), 'Should remove closing think tag');
    assert.ok(result.includes('The actual output'), 'Should preserve text after tag');
});

run('sanitizeAiOutput: strips full <analysis> blocks', () => {
    // Arrange
    const input = '<analysis>Some deep analysis\nmultiline</analysis>Clean text here';
    // Act
    const result = sanitizeAiOutput(input, 'fallback');
    // Assert
    assert.equal(result, 'Clean text here');
});

run('sanitizeAiOutput: strips <internal_analysis> blocks', () => {
    // Arrange
    const input = '<internal_analysis>hidden</internal_analysis>Visible output';
    // Act
    const result = sanitizeAiOutput(input, 'fallback');
    // Assert
    assert.equal(result, 'Visible output');
});

run('sanitizeAiOutput: strips conversational preamble "Certainly"', () => {
    // Arrange
    const input = 'Certainly! The polished text is here.';
    // Act
    const result = sanitizeAiOutput(input, 'fallback');
    // Assert
    assert.ok(!result.startsWith('Certainly'), 'Should strip preamble');
    assert.ok(result.includes('polished text is here'), 'Should keep content');
});

run('sanitizeAiOutput: strips "Here is the result:" preamble', () => {
    // Arrange
    const input = 'Here is the result: The final version.';
    // Act
    const result = sanitizeAiOutput(input, 'fallback');
    // Assert
    assert.ok(!result.startsWith('Here is'), 'Should strip preamble');
    assert.ok(result.includes('final version'), 'Should keep content');
});

run('sanitizeAiOutput: returns fallback when content is empty', () => {
    // Arrange & Act
    const result = sanitizeAiOutput('', 'My Fallback');
    // Assert
    assert.equal(result, 'My Fallback');
});

run('sanitizeAiOutput: returns fallback when content is whitespace-only', () => {
    // Arrange & Act
    const result = sanitizeAiOutput('   \n  \n  ', 'Fallback Text');
    // Assert
    assert.equal(result, 'Fallback Text');
});

run('sanitizeAiOutput: preserves legitimate content unchanged', () => {
    // Arrange
    const input = 'This is a perfectly normal sentence with no AI artifacts.';
    // Act
    const result = sanitizeAiOutput(input, 'fallback');
    // Assert
    assert.equal(result, input);
});

run('sanitizeAiOutput: replaces smart quotes with straight quotes', () => {
    // Arrange — using Unicode smart quotes
    const input = 'He said \u201CHello\u201D and she said \u2018Goodbye\u2019';
    // Act
    const result = sanitizeAiOutput(input, 'fallback');
    // Assert
    assert.ok(result.includes('"Hello"'), 'Should replace double smart quotes');
    assert.ok(result.includes("'Goodbye'"), 'Should replace single smart quotes');
});

run('sanitizeAiOutput: collapses excessive newlines', () => {
    // Arrange
    const input = 'Line one\n\n\n\n\nLine two';
    // Act
    const result = sanitizeAiOutput(input, 'fallback');
    // Assert
    assert.equal(result, 'Line one\n\nLine two');
});

// ── detectVoiceLanguageDirective ────────────────────────────────

const HINDI = [{ code: 'hi', name: 'Hindi' }];
const FRENCH = [{ code: 'fr', name: 'French' }];
const MULTI = [
    { code: 'hi', name: 'Hindi' },
    { code: 'fr', name: 'French' },
    { code: 'es', name: 'Spanish' },
];

run('detectVoiceLanguageDirective: detects "translate to Hindi" at start', () => {
    // Arrange
    const transcript = 'translate to Hindi hello world';
    // Act
    const result = detectVoiceLanguageDirective(transcript, HINDI);
    // Assert
    assert.equal(result.overrideLang, 'hi');
    assert.equal(result.overrideLangName, 'Hindi');
    assert.equal(result.cleanTranscript, 'hello world');
});

run('detectVoiceLanguageDirective: detects "write in French" at end', () => {
    // Arrange
    const transcript = 'good morning, write in French';
    // Act
    const result = detectVoiceLanguageDirective(transcript, FRENCH);
    // Assert
    assert.equal(result.overrideLang, 'fr');
    assert.equal(result.overrideLangName, 'French');
    assert.equal(result.cleanTranscript, 'good morning');
});

run('detectVoiceLanguageDirective: detects directive-only input', () => {
    // Arrange
    const transcript = 'translate to Hindi';
    // Act
    const result = detectVoiceLanguageDirective(transcript, HINDI);
    // Assert
    assert.equal(result.overrideLang, 'hi');
    assert.equal(result.overrideLangName, 'Hindi');
});

run('detectVoiceLanguageDirective: detects "convert to Spanish"', () => {
    // Arrange
    const transcript = 'convert to Spanish, this is a test message';
    // Act
    const result = detectVoiceLanguageDirective(transcript, MULTI);
    // Assert
    assert.equal(result.overrideLang, 'es');
    assert.equal(result.cleanTranscript, 'this is a test message');
});

run('detectVoiceLanguageDirective: returns null for no directive match', () => {
    // Arrange
    const transcript = 'just some regular text without any commands';
    // Act
    const result = detectVoiceLanguageDirective(transcript, MULTI);
    // Assert
    assert.equal(result.overrideLang, null);
    assert.equal(result.overrideLangName, null);
    assert.equal(result.cleanTranscript, transcript);
});

run('detectVoiceLanguageDirective: returns null for empty input', () => {
    // Arrange & Act
    const result = detectVoiceLanguageDirective('', HINDI);
    // Assert
    assert.equal(result.overrideLang, null);
    assert.equal(result.cleanTranscript, '');
});

run('detectVoiceLanguageDirective: handles null input gracefully', () => {
    // Arrange & Act
    const result = detectVoiceLanguageDirective(null, HINDI);
    // Assert
    assert.equal(result.overrideLang, null);
    assert.equal(result.cleanTranscript, '');
});

// ── SUPPORTED_VOICE_LANGUAGES ───────────────────────────────────

run('SUPPORTED_VOICE_LANGUAGES: is a non-empty array', () => {
    // Assert
    assert.ok(Array.isArray(SUPPORTED_VOICE_LANGUAGES), 'Should be an array');
    assert.ok(SUPPORTED_VOICE_LANGUAGES.length > 0, 'Should not be empty');
});

run('SUPPORTED_VOICE_LANGUAGES: contains Hindi and English', () => {
    // Assert
    const codes = SUPPORTED_VOICE_LANGUAGES.map(l => l.code);
    assert.ok(codes.includes('hi'), 'Should contain Hindi');
    assert.ok(codes.includes('en'), 'Should contain English');
});

run('SUPPORTED_VOICE_LANGUAGES: is frozen (immutable)', () => {
    // Assert
    assert.ok(Object.isFrozen(SUPPORTED_VOICE_LANGUAGES), 'Should be frozen');
});

// End of tests. Let Jest handle exit codes naturally.

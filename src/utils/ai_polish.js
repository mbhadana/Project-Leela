const axios = require('axios');
const { sanitizeAIOutput } = require('./sanitize_output');

/**
 * Polishes text using Sarvam Chat API for Intelligent Dictation
 * This is a standalone version of the logic previously in main.js
 */
async function polishText(text, instruction = null, options = {}) {
    const { 
        apiKey, 
        targetLanguage = 'en', 
        targetLanguageName = 'English' 
    } = options;

    if (!apiKey) throw new Error('Sarvam API Key not found. Please set it in Settings.');

    const isEnglish = targetLanguage === 'en';

    let systemPrompt = "";
    if (instruction) {
        // COMMAND MODE PROMPT: Strict Text Transformation Engine
        systemPrompt = `You are a strict text transformation engine.
Your sole job is to transform "INPUT_TEXT" according to "USER_INSTRUCTION".

STRICT RULES:
1. Return ONLY the final transformed text.
2. Absolutely NO reasoning, explanations, or internal thinking.
3. Absolutely NO <think> or <thought> tags.
4. Absolutely NO quotes around the output.
5. NO metadata, scores, or comments.
6. The output must be clean, copy-ready text.`;
    } else {
        // STANDARD POLISH PROMPT
        systemPrompt = isEnglish
            ? `You are a strict text transformation engine.
Transform the provided transcription into professional, high-quality English.

STRICT RULES:
1. Return ONLY the final polished text.
2. Absolutely NO reasoning, explanations, or internal thinking.
3. Absolutely NO <think> or <thought> tags.
4. Absolutely NO quotes around the output.
5. NO metadata, scores, or comments.`
            : `You are a strict text transformation engine.
Translate/Transform the provided transcription into high-quality ${targetLanguageName}.

STRICT RULES:
1. Return ONLY the final result text.
2. Absolutely NO reasoning, explanations, or internal thinking.
3. Absolutely NO <think> or <thought> tags.
4. Absolutely NO quotes around the output.
5. NO metadata, scores, or comments.`;
    }

    const userPrompt = instruction
        ? `USER_INSTRUCTION: "${instruction}"\nINPUT_TEXT: "${text}"`
        : `TRANSCRIPTION TO PROCESS: "${text}"`;

    const response = await axios.post('https://api.sarvam.ai/v1/chat/completions', {
        model: 'sarvam-m',
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
        ],
        temperature: 0.1
    }, {
        headers: { 'api-subscription-key': apiKey },
        timeout: 30000
    });

    const content = response.data?.choices?.[0]?.message?.content || text;
    
    // EXTRACTION & SANITIZATION
    let cleaned = sanitizeAIOutput(content);

    // Safety Cleanup: Prune potential preamble or AI chatter
    const removalPatterns = [
        /^(?:certainly|of course|sure|okay|here is|the (?:polished|transformed) version is)[:\s-]*/i,
        /^(?:Result|Transformed|Polished|Final Text|Here is the result)[:\s-]*/i,
        /^["'«„](.*?)["'»“]$/s
    ];

    for (const regex of removalPatterns) {
        cleaned = cleaned.replace(regex, (match, p1) => p1 || '').trim();
    }

    // Final trim and character cleanup
    cleaned = cleaned.replace(/^[:\s.-]+/, '').trim();

    return {
        text: cleaned,
        qualityScores: { meaning: 10, grammar: 10, tone: 10 }
    };
}

module.exports = { polishText };

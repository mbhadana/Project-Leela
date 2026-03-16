const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config(); // Try local .env first
if (!process.env.SARVAM_API_KEY) {
    dotenv.config({ path: path.join(__dirname, '..', '.env') }); // Fallback to parent .env
}


const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const SARVAM_API_KEY = process.env.SARVAM_API_KEY;


/**
 * Robust sanitization helper to strip all tags and conversational preludes.
 */
function sanitizeOutput(content) {
    if (!content) return "";
    
    let cleaned = content
        // 1. Remove all common thinking/analysis tags (closed blocks)
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/<internal_analysis>[\s\S]*?<\/internal_analysis>/gi, '')
        .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
        .replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
        .replace(/<final_result>|<\/final_result>/gi, '')
        .replace(/<final_output>|<\/final_output>/gi, '')
        .replace(/<internal_feedback>[\s\S]*?<\/internal_feedback>/gi, '')
        .trim();
    
    // 2. If after removing closed blocks we still have unclosed tags, remove them selectively (non-destructively)
    cleaned = cleaned
        .replace(/<think>/gi, '') 
        .replace(/<\/think>/gi, '')
        .replace(/<thought>/gi, '')
        .replace(/<\/thought>/gi, '')
        .trim();


    
    // 3. Prune potential preamble or AI chatter
    const removalPatterns = [
        /^(?:certainly|of course|sure|okay|here is|the (?:polished|transformed) version is)[:\s-]*/i,
        /^(?:Result|Transformed|Polished|Final Text|Here is the result)[:\s-]*/i,
        /^["'«„](.*?)["'»“]$/s
    ];

    for (const regex of removalPatterns) {
        cleaned = cleaned.replace(regex, (match, p1) => p1 || '').trim();
    }

    // 4. Final trim and character cleanup (remove leading punctuation/bullets)
    cleaned = cleaned.replace(/^[:\s.-]+/, '').trim();
    
    return cleaned;
}

// API Endpoint to proxy text polishing to Sarvam AI
app.post('/api/polish', async (req, res) => {
    const { text, instruction } = req.body;

    if (!text) {
        return res.status(400).json({ error: 'Text is required' });
    }

    try {
        console.log(`[Server] Polishing text: "${text.substring(0, 50)}..."`);

        const response = await axios.post('https://api.sarvam.ai/v1/chat/completions', {
            model: "sarvam-m",
            messages: [
                {
                    role: "system",
                    content: `You are a strict text transformation engine.
Your sole job is to transform "INPUT_TEXT" into professional, high-quality English.

STRICT RULES:
1. Return ONLY the final transformed text.
2. Absolutely NO reasoning, explanations, or internal thinking.
3. Absolutely NO <think> or <thought> tags.
4. Absolutely NO quotes around the output.
5. NO metadata, scores, or comments.
6. The output must be clean, copy-ready text.`
                },
                {
                    role: "user",
                    content: text
                }
            ]
        }, {
            headers: {
                'api-subscription-key': SARVAM_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        const polishedText = sanitizeOutput(response.data.choices[0].message.content);
        res.json({ polishedText });
    } catch (error) {
        console.error('[Server] Polishing error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to polish text', details: error.message });
    }
});

// Added to match App.tsx expectations
app.post('/api/improve', async (req, res) => {
    const { text, command } = req.body;
    if (!text) return res.status(400).json({ success: false, error: 'Text is required' });

    if (!SARVAM_API_KEY) {
        console.error("Missing SARVAM_API_KEY in environment");
        return res.status(500).json({
            success: false,
            error: "AI service not configured"
        });
    }

    try {
        console.log("REQUEST_PAYLOAD:", req.body);
        const response = await axios.post('https://api.sarvam.ai/v1/chat/completions', {
            model: "sarvam-m",
            messages: [
                {
                    role: "system",
                    content: `You are a writing assistant.
Your task is to improve the quality of the user's text by:
* correcting grammar
* improving clarity
* improving sentence structure
* preserving the original meaning

STRICT RULES:
1. Do not translate the language.
2. Return ONLY the final improved text.
3. Absolutely NO reasoning, explanations, or internal thinking.
4. Absolutely NO <think> or <thought> tags.
5. Absolutely NO quotes around the output.
6. The output must be clean, copy-ready text.`
                },
                {
                    role: "user",
                    content: `USER_INSTRUCTION: "${command || "improve style and grammar"}"\nINPUT_TEXT: "${text}"`
                }
            ]
        }, {
            headers: {
                'api-subscription-key': SARVAM_API_KEY,
                'Content-Type': 'application/json'
            }
        });

        console.log("AI_RESPONSE:", response.data);
        const rawOutput = response.data.choices[0].message.content;
        const result = sanitizeOutput(rawOutput);
        console.log(`[Server] Sanitized result: "${result}"`);
        res.json({ success: true, result });

    } catch (error) {
        console.error('[Server] Improve error:', error.response?.data || error.message);
        res.status(500).json({ 
            success: false, 
            error: "AI service temporarily unavailable" 
        });
    }
});

// API Endpoint to record user interest
app.get('/api/debug-env', (req, res) => {
    res.json({
        has_key: !!process.env.SARVAM_API_KEY,
        key_length: process.env.SARVAM_API_KEY ? process.env.SARVAM_API_KEY.length : 0,
        key_start: process.env.SARVAM_API_KEY ? process.env.SARVAM_API_KEY.substring(0, 3) + '...' : 'none'
    });
});

app.post('/api/interest', (req, res) => {
    const { email, name, message } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email is required' });
    }

    const interestData = {
        timestamp: new Date().toISOString(),
        email,
        name,
        message
    };

    const logFile = path.join(__dirname, 'user_interest.json');

    let currentData = [];
    if (fs.existsSync(logFile)) {
        try {
            currentData = JSON.parse(fs.readFileSync(logFile, 'utf8'));
        } catch (e) {
            console.error('[Server] Failed to read interest log:', e.message);
        }
    }

    currentData.push(interestData);

    try {
        fs.writeFileSync(logFile, JSON.stringify(currentData, null, 2));
        console.log(`[Server] User interest recorded: ${email}`);
        res.json({ success: true, message: 'Thank you for your interest! We will get back to you soon.' });
    } catch (error) {
        console.error('[Server] Failed to save interest:', error.message);
        res.status(500).json({ error: 'Failed to record interest' });
    }
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`LeelaV1 Live Demo server running at http://localhost:${PORT}`);
    });
}

module.exports = app;


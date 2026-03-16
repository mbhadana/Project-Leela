const express = require("express");
const path = require("path");
const { VoicePipeline } = require("../src/voice_pipeline");

const app = express();
app.use(express.json());

// Serve the UI static files
// Note: In a production environment, we would serve the build folder.
// For the demo, we'll try to serve the source or a message if build is missing.
const demoUiPath = path.join(__dirname, "../demo-ui/dist");
app.use("/", express.static(demoUiPath));

// Fallback to source if dist doesn't exist (for development/demo purposes)
app.get("/", (req, res, next) => {
    const fs = require('fs');
    if (!fs.existsSync(demoUiPath)) {
        res.send(`
            <html>
                <body style="font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background: #0f172a; color: #f8fafc;">
                    <h1>Leela AI Demo UI</h1>
                    <p>The UI build was not found in <code>demo-ui/dist</code>.</p>
                    <p>Please run <code>npm run build</code> in the <code>demo-ui</code> folder.</p>
                    <div style="margin-top: 20px; padding: 20px; border: 1px solid #1e293b; border-radius: 8px; background: #1e293b;">
                        <p>API Endpoint: <code>POST /api/improve</code> is active.</p>
                    </div>
                </body>
            </html>
        `);
    } else {
        next();
    }
});

/**
 * Step 2 — Create transformation endpoint
 */
app.post("/api/improve", async (req, res) => {
    try {
        const { text, command } = req.body;
        
        if (!text) {
            return res.status(400).json({
                success: false,
                error: "No text provided"
            });
        }

        const result = await VoicePipeline.processText({
            input: text,
            instruction: command || "polish"
        });

        res.json({
            success: true,
            result
        });
    } catch (error) {
        console.error("Demo API error:", error);
        res.status(500).json({
            success: false,
            error: "Processing failed: " + error.message
        });
    }
});

/**
 * Step 3 — Start server
 */
const PORT = 3000;
const server = app.listen(PORT, () => {
    console.log(`[LocalServer] Leela Demo running at http://localhost:${PORT}`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`[LocalServer] Port ${PORT} is already in use. Local demo server failed to start.`);
    } else {
        console.error(`[LocalServer] Server error:`, err);
    }
});

module.exports = app;

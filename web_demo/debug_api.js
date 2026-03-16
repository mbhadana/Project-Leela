const axios = require('axios');

const text = "I Want Write A Message About My Project Idea But My Writing Not Very Good";
const commands = [
    "Improve writing",
    "Translate to Hindi",
    "Make it professional",
    "Summarize"
];

async function runDiagnostics() {
    for (const command of commands) {
        console.log(`\n--- Testing Command: ${command} ---`);
        try {
            const response = await axios.post('http://localhost:3000/api/improve', {
                text: text,
                command: command
            });
            console.log("RESPONSE:", JSON.stringify(response.data, null, 2));
        } catch (error) {
            console.log("ERROR STATUS:", error.response?.status);
            console.log("ERROR DATA:", JSON.stringify(error.response?.data, null, 2));
        }
    }
}

runDiagnostics();

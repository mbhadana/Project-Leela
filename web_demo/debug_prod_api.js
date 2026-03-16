const axios = require('axios');

const text = "I Want Write A Message About My Project Idea But My Writing Not Very Good";
const url = "https://webdemo-self.vercel.app/api/improve";
const commands = [
    "Polish text",
    "Translate to Hindi",
    "Make it professional",
    "Summarize"
];

async function runProdDiagnostics() {
    for (const command of commands) {
        console.log(`\n--- Testing Command: ${command} ---`);
        try {
            const response = await axios.post(url, {
                text: text,
                command: command
            }, { timeout: 15000 });
            console.log("STATUS:", response.status);
            console.log("RESPONSE:", JSON.stringify(response.data, null, 2));
        } catch (error) {
            console.log("ERROR STATUS:", error.response?.status);
            console.log("ERROR DATA:", JSON.stringify(error.response?.data, null, 2));
            console.log("MESSAGE:", error.message);
        }
    }
}

runProdDiagnostics();

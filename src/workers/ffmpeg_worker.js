const { parentPort } = require('worker_threads');
const { exec } = require('child_process');
const util = require('util');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('ffmpeg-static');

const execAsync = util.promisify(exec);

// Listen for incoming messages matching the discriminated union protocol
parentPort.on('message', async (message) => {
    try {
        if (message.type === 'START_CONVERSION') {
            const { webmPath } = message.payload;
            const chunkFiles = await convertAndChunkVideo(webmPath);
            
            // CONVERSION_COMPLETE response
            parentPort.postMessage({
                type: 'CONVERSION_COMPLETE',
                payload: { chunkFiles }
            });
        }
    } catch (error) {
        // CONVERSION_ERROR response
        parentPort.postMessage({
            type: 'CONVERSION_ERROR',
            error: error.message || String(error)
        });
    }
});

/**
 * CPU-Bound Work:
 * Convert .webm to .wav (16kHz, mono) and chunk into 25s segments using FFmpeg.
 */
async function convertAndChunkVideo(webmPath) {
    const baseName = path.basename(webmPath, '.webm');
    const tempDir = path.dirname(webmPath);
    const wavPath = path.join(tempDir, `${baseName}_full.wav`);
    const chunkPattern = path.join(tempDir, `${baseName}_chunk_%03d.wav`);

    try {
        console.log('[WORKER] Converting to WAV:', webmPath);
        // Convert to 16k, mono, 16bit WAV
        const convCmd = `"${ffmpeg}" -i "${webmPath}" -ar 16000 -ac 1 -c:a pcm_s16le -y "${wavPath}"`;
        await execAsync(convCmd, { maxBuffer: 10 * 1024 * 1024 });

        console.log('[WORKER] Chunking audio...');
        // Split into 25s chunks 
        const splitCmd = `"${ffmpeg}" -i "${wavPath}" -f segment -segment_time 25 -c copy "${chunkPattern}"`;
        await execAsync(splitCmd, { maxBuffer: 10 * 1024 * 1024 });

        // Identify and sort the resulting chunk files
        const files = fs.readdirSync(tempDir);
        const chunkFiles = files
            .filter(f => f.startsWith(`${baseName}_chunk_`) && f.endsWith('.wav'))
            .sort()
            .map(f => path.join(tempDir, f));

        return chunkFiles;
    } finally {
        // Always try to cleanup the large intermediate full.wav
        try { 
            if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath); 
        } catch (fsErr) {
            console.warn('[WORKER] Failed to delete intermediate WAV file:', fsErr.message);
        }
    }
}

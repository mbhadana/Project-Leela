const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const axios = require('axios');

async function run() {
  const cfgPath = path.join(__dirname, 'config.json');
  let apiKey = process.env.SARVAM_API_KEY;
  if (fs.existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      apiKey = apiKey || cfg.apiKey;
    } catch (e) {
      console.error('Failed to parse config.json', e);
    }
  }
  if (!apiKey) {
    console.error('No SARVAM API key found in config or env.');
    process.exit(2);
  }

  const { SarvamAIClient } = require('sarvamai');

  const client = new SarvamAIClient({ apiSubscriptionKey: apiKey });

  const files = fs.readdirSync(__dirname).filter(f => f.startsWith('recording-') && f.endsWith('.webm'));
  if (files.length === 0) {
    console.error('No recording files found.');
    process.exit(3);
  }
  const filePath = path.join(__dirname, files[files.length - 1]); // latest
  // If file is webm, transcode to WAV (16kHz mono) using ffmpeg-static
  let uploadBase64 = null;
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.webm' || ext === '.ogg' || ext === '.mp4') {
    const ffmpegPath = require('ffmpeg-static');
    const tmpOut = path.join(__dirname, 'transcode-' + Date.now() + '.wav');
    console.log('Transcoding to WAV via ffmpeg:', ffmpegPath);
    const { spawnSync } = require('child_process');
    const args = ['-y', '-i', filePath, '-ar', '16000', '-ac', '1', '-f', 'wav', tmpOut];
    const res = spawnSync(ffmpegPath, args, { stdio: 'inherit' });
    if (res.error) {
      console.error('ffmpeg spawn error', res.error);
      process.exit(5);
    }
    if (!fs.existsSync(tmpOut)) {
      console.error('Transcode failed, output not found');
      process.exit(6);
    }
    uploadBase64 = fs.readFileSync(tmpOut).toString('base64');
    // remove tmpOut later
  } else {
    uploadBase64 = fs.readFileSync(filePath).toString('base64');
  }
  console.log('Using file:', filePath);

  try {
    const socket = await client.speechToTextStreaming.connect({
      model: 'saaras:v3',
      mode: 'translate',          // request translation to English
      'language-code': 'unknown',
      targetLanguage: 'en',
      high_vad_sensitivity: 'true'
    });

    let transcript = null;
    socket.on('open', () => {
      console.log('Socket open — sending audio');
      socket.transcribe({
        audio: uploadBase64,
        sample_rate: 16000,
        encoding: 'audio/wav'
      });
    });

    socket.on('message', (response) => {
      try {
        console.log('Message:', response);
        if (response && (response.text || response.transcription || response.final)) {
          transcript = response.text || response.transcription || response.final || JSON.stringify(response);
        }
      } catch (e) { console.warn('message parse', e); }
    });

    await socket.waitForOpen();
    // wait up to 30s for transcript
    const start = Date.now();
    while (!transcript && Date.now() - start < 30000) {
      await new Promise(r => setTimeout(r, 500));
    }
    try { socket.close(); } catch (_) { }

    if (!transcript) {
      console.error('No transcript received from Sarvam within timeout.');
      process.exit(4);
    }

    console.log('Transcript:', transcript);

    // Auto-polish
    let finalResult = transcript;
    try {
      console.log('Polishing transcript...');
      const polishPrompt = `Fix grammar and sentence structure of the following text while strictly preserving the original tone, style, and manner of the user input. Do not make it overly formal if the input is casual. Do not add new information. Return ONLY the corrected text.\n\nTEXT:\n${transcript}`;
      const polishRes = await axios.post('https://api.sarvam.ai/v1/chat/completions', {
        model: 'sarvam-m',
        messages: [
          { role: 'system', content: 'You are a professional grammar and tone preservation assistant. Always return only the corrected text, nothing else.' },
          { role: 'user', content: polishPrompt }
        ],
        temperature: 0.1
      }, {
        headers: { 'api-subscription-key': apiKey },
        timeout: 30000
      const { sanitizeAIOutput } = require('./src/utils/sanitize_output');
      finalResult = sanitizeAIOutput(polishRes.data?.choices?.[0]?.message?.content || transcript);
      console.log('Polished Transcript:', finalResult);
    } catch (e) {
      console.warn('Polishing failed, using original transcript:', e.message);
    }

    // Save transcript
    const outPath = path.join(__dirname, 'transcript-' + Date.now() + '.txt');
    fs.writeFileSync(outPath, finalResult, 'utf8');
    console.log('Saved transcript to', outPath);

    // Put in clipboard and paste into active window (Windows)
    try {
      if (process.platform === 'win32') {
        // copy to clipboard via powershell
        const ps = `Set-Clipboard -Value @'\n${finalResult}\n'@`;
        exec(`powershell -NoProfile -Command "${ps}"`, (err) => {
          if (err) console.error('Set-Clipboard failed', err);
          else {
            // paste
            exec('powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(\'^v\')"', (e2) => {
              if (e2) console.error('Paste failed', e2);
              else console.log('Pasted transcript to active window.');
            });
          }
        });
      }
    } catch (e) {
      console.error('Clipboard/paste error', e);
    }

  } catch (e) {
    console.error('Sarvam transcription error', e);
    process.exit(5);
  }
}

run().catch(err => { console.error(err); process.exit(1); });


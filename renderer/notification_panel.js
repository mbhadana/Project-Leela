// Renderer communicates through the preload bridge (window.leela)

const panel = document.getElementById('notification-panel');
const commandInput = document.getElementById('command-input');
const chatScroll = document.getElementById('chat-scroll');
const chatHistory = document.getElementById('chat-history');

const n8nWebhookInput = document.getElementById('n8n-webhook-url');
const n8nSaveBtn = document.getElementById('n8n-save-btn');
const n8nTestBtn = document.getElementById('n8n-test-btn');
const n8nStatus = document.getElementById('n8n-status');
const micBtn = document.getElementById('mic-btn');

const N8N_WEBHOOK_KEY = 'leela_n8n_webhook_url';
const NAT_PREFIX = '/nat';
const ROUTE_WEB_SEARCH = 'web_search';
const ROUTE_N8N_TASK = 'n8n_task';
let typingRow = null;
let recognition = null;
let isVoiceListening = false;
let isVoiceProcessing = false;
let isVoiceTransitioning = false;
let lastVoiceToggleAt = 0;
const VOICE_TOGGLE_DEBOUNCE = 280;
let mediaRecorder = null;
let currentStream = null;
let voiceChunks = [];
let voiceSessionCounter = 0;
let activeVoiceSessionId = 0;
let voiceStopWatchdogId = null;
const VOICE_STOP_WATCHDOG_MS = 2000;
const SpeechRecognitionClass = window.SpeechRecognition || window.webkitSpeechRecognition || null;

function nowTime() {
    return new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function scrollToBottom() {
    if (!chatScroll) return;
    chatScroll.scrollTop = chatScroll.scrollHeight;
}

function escapeHtml(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatMessageText(text) {
    const safe = escapeHtml(text || '');
    const withBold = safe.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    const lines = withBold.split(/\r?\n/);
    const chunks = [];
    let listBuffer = [];

    const flushList = () => {
        if (listBuffer.length === 0) return;
        const items = listBuffer.map((line) => `<li>${line}</li>`).join('');
        chunks.push(`<ul>${items}</ul>`);
        listBuffer = [];
    };

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) {
            flushList();
            continue;
        }

        const bullet = line.match(/^[-*]\s+(.+)/);
        const ordered = line.match(/^\d+[.)]\s+(.+)/);

        if (bullet) {
            listBuffer.push(bullet[1]);
            continue;
        }

        if (ordered) {
            listBuffer.push(ordered[1]);
            continue;
        }

        flushList();
        chunks.push(`<p>${line}</p>`);
    }

    flushList();

    if (chunks.length === 0) {
        return '<p>(No content)</p>';
    }

    return chunks.join('');
}

function normalizeInteractiveActions(raw) {
    if (!Array.isArray(raw)) return [];

    return raw
        .map((item) => {
            if (typeof item === 'string') {
                return { label: item, value: item };
            }
            if (!item || typeof item !== 'object') return null;

            const label = item.label || item.title || item.text || item.name || item.action || item.value;
            const value = item.value || item.command || item.action || label;
            if (!label || !value) return null;

            return { label: String(label), value: String(value) };
        })
        .filter(Boolean);
}

function extractInteractiveActions(payload) {
    if (!payload || typeof payload !== 'object') return [];

    const queue = [payload];
    const visited = new Set();
    const actionKeys = ['actions', 'options', 'buttons', 'choices'];

    while (queue.length) {
        const current = queue.shift();
        if (!current || typeof current !== 'object') continue;
        if (visited.has(current)) continue;
        visited.add(current);

        for (const key of actionKeys) {
            if (Array.isArray(current[key])) {
                const normalized = normalizeInteractiveActions(current[key]);
                if (normalized.length) return normalized;
            }
        }

        if (Array.isArray(current)) {
            current.forEach((v) => { if (v && typeof v === 'object') queue.push(v); });
        } else {
            Object.values(current).forEach((v) => { if (v && typeof v === 'object') queue.push(v); });
        }
    }

    return [];
}

function parseStructuredResponseFromText(text) {
    const raw = typeof text === 'string' ? text.trim() : '';
    if (!raw) {
        return { type: 'text', title: '', options: [] };
    }
    const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
    const matches = raw.match(emailRegex) || [];
    const seen = new Set();
    const options = [];
    for (const match of matches) {
        const email = String(match).trim().toLowerCase();
        if (!email || seen.has(email)) continue;
        seen.add(email);
        options.push({ label: email, value: email });
    }
    if (options.length > 0) {
        return {
            type: 'selection',
            title: 'Select email address',
            options
        };
    }
    return { type: 'text', title: raw, options: [] };
}
function addMessage(role, text, options = {}) {
    if (!chatHistory) return null;

    const row = document.createElement('div');
    row.className = `message-row ${role}`;

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    const content = document.createElement('div');
    content.className = 'message-content';
    content.innerHTML = formatMessageText(text);

    bubble.appendChild(content);

    const actions = normalizeInteractiveActions(options.actions || []);
    if (actions.length > 0) {
        const actionWrap = document.createElement('div');
        actionWrap.className = 'message-actions';

        actions.forEach((action) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'message-action-btn';
            btn.textContent = action.label;
            btn.addEventListener('click', async () => {
                addMessage('user', action.label, { metaText: 'Selected option' });
                await handleCommandSubmit(action.value);
            });
            actionWrap.appendChild(btn);
        });

        bubble.appendChild(actionWrap);
    }

    if (options.meta !== false) {
        const meta = document.createElement('div');
        meta.className = 'message-meta';
        meta.textContent = options.metaText || nowTime();
        bubble.appendChild(meta);
    }

    row.appendChild(bubble);
    chatHistory.appendChild(row);
    scrollToBottom();
    return row;
}
function showTyping() {
    if (typingRow || !chatHistory) return;

    typingRow = document.createElement('div');
    typingRow.className = 'message-row assistant';

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';

    const typing = document.createElement('div');
    typing.className = 'typing-bubble';
    typing.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';

    bubble.appendChild(typing);
    typingRow.appendChild(bubble);
    chatHistory.appendChild(typingRow);
    scrollToBottom();
}

function hideTyping() {
    if (!typingRow) return;
    typingRow.remove();
    typingRow = null;
}

function updateMicButtonUi() {
    if (!micBtn) return;
    if (isVoiceProcessing) {
        micBtn.textContent = '...';
        micBtn.classList.remove('listening');
        return;
    }
    micBtn.textContent = isVoiceListening ? 'Stop' : 'Mic';
    micBtn.classList.toggle('listening', isVoiceListening);
}

async function requestMicAccess() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        addMessage('error', 'Microphone API is not available in this environment.');
        return false;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        try {
            stream.getTracks().forEach((t) => t.stop());
        } catch (_) { }
        return true;
    } catch (error) {
        addMessage('error', `Microphone permission denied: ${error.message}`);
        return false;
    }
}

function cleanupVoiceStream() {
    try {
        if (currentStream && currentStream.getTracks) {
            currentStream.getTracks().forEach((t) => t.stop());
        }
    } catch (_) { }
    currentStream = null;
}

function clearVoiceStopWatchdog() {
    if (voiceStopWatchdogId) {
        clearTimeout(voiceStopWatchdogId);
        voiceStopWatchdogId = null;
    }
}

function finalizeVoiceSession(options = {}) {
    clearVoiceStopWatchdog();
    cleanupVoiceStream();
    if (options.clearRecorder !== false) mediaRecorder = null;
    if (options.clearChunks !== false) voiceChunks = [];
    if (options.resetSession !== false) activeVoiceSessionId = 0;
    isVoiceListening = Boolean(options.listening);
    isVoiceProcessing = Boolean(options.processing);
    updateMicButtonUi();
}

function armVoiceStopWatchdog(sessionId) {
    clearVoiceStopWatchdog();
    voiceStopWatchdogId = setTimeout(() => {
        if (sessionId !== activeVoiceSessionId) return;
        addMessage('error', 'Voice stop timeout. Session reset.');
        finalizeVoiceSession();
    }, VOICE_STOP_WATCHDOG_MS);
}


function canToggleVoice() {
    const now = Date.now();
    if (isVoiceTransitioning || isVoiceProcessing) return false;
    if (now - lastVoiceToggleAt < VOICE_TOGGLE_DEBOUNCE) return false;
    lastVoiceToggleAt = now;
    return true;
}

async function processVoiceRecording() {
    if (!activeVoiceSessionId) {
        finalizeVoiceSession();
        return;
    }
    isVoiceProcessing = true;
    isVoiceListening = false;
    updateMicButtonUi();

    try {
        if (!voiceChunks.length) {
            addMessage('error', 'No voice data captured.');
            return;
        }

        const blob = new Blob(voiceChunks, { type: 'audio/webm' });
        const arrayBuffer = await blob.arrayBuffer();

        const saveResult = await window.leela.invoke('save-temp-recording', arrayBuffer, `chat-recording-${Date.now()}.webm`);
        if (!saveResult.ok) {
            addMessage('error', `Failed to save recording: ${saveResult.error}`);
            return;
        }
        const localPath = saveResult.path;

        const result = await window.leela.invoke('transcribe-recording-chat', localPath);
        if (result && result.ok && result.text) {
            const incoming = String(result.text).trim();
            if (incoming) {
                commandInput.value = commandInput.value ? `${commandInput.value} ${incoming}` : incoming;
            }
        } else {
            addMessage('error', `Voice dictation failed: ${(result && result.error) ? result.error : 'unknown_error'}`);
        }
    } catch (error) {
        addMessage('error', `Voice dictation failed: ${error.message || error}`);
    } finally {
        finalizeVoiceSession();
    }
}


async function startVoiceDictation() {
    if (isVoiceProcessing || isVoiceListening) return;

    try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            addMessage('error', 'Microphone API is not available in this environment.');
            return;
        }

        const sessionId = ++voiceSessionCounter;
        activeVoiceSessionId = sessionId;
        currentStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(currentStream, { mimeType: 'audio/webm' });
        voiceChunks = [];

        mediaRecorder.ondataavailable = (event) => {
            if (event.data && event.data.size > 0) {
                voiceChunks.push(event.data);
            }
        };

        mediaRecorder.onstop = async () => {
            if (sessionId !== activeVoiceSessionId) return;
            clearVoiceStopWatchdog();
            cleanupVoiceStream();
            await processVoiceRecording();
        };

        mediaRecorder.start();
        isVoiceListening = true;
        isVoiceProcessing = false;
        updateMicButtonUi();
        addMessage('system', 'Listening... Press Ctrl+Space again to stop.');
    } catch (error) {
        finalizeVoiceSession();
        addMessage('error', `Could not start voice dictation: ${error.message || error}`);
    }
}


async function stopVoiceDictation() {
    const sessionId = activeVoiceSessionId;
    try {
        if (mediaRecorder && mediaRecorder.state !== 'inactive') {
            isVoiceListening = false;
            isVoiceProcessing = true;
            updateMicButtonUi();
            armVoiceStopWatchdog(sessionId);
            mediaRecorder.stop();
        } else {
            finalizeVoiceSession();
        }
    } catch (_) {
        finalizeVoiceSession();
    }
}


async function toggleVoiceDictation() {
    if (!canToggleVoice()) return;

    isVoiceTransitioning = true;
    try {
        if (isVoiceListening) {
            await stopVoiceDictation();
            return;
        }
        await startVoiceDictation();
    } finally {
        setTimeout(() => {
            isVoiceTransitioning = false;
        }, 120);
    }
}

function extractAssistantText(payload) {
    if (!payload) return '';
    if (typeof payload === 'string') return payload.trim();

    const preferredKeys = ['output', 'text', 'message', 'answer', 'response', 'final', 'content'];
    const queue = [payload];
    const visited = new Set();

    while (queue.length) {
        const current = queue.shift();
        if (!current || typeof current !== 'object') continue;
        if (visited.has(current)) continue;
        visited.add(current);

        for (const key of preferredKeys) {
            if (typeof current[key] === 'string' && current[key].trim()) {
                return current[key].trim();
            }
        }

        if (Array.isArray(current)) {
            for (const item of current) queue.push(item);
        } else {
            for (const value of Object.values(current)) {
                if (typeof value === 'string' && value.trim()) {
                    if (/workflow was started/i.test(value)) {
                        continue;
                    }
                    return value.trim();
                }
                if (value && typeof value === 'object') {
                    queue.push(value);
                }
            }
        }
    }

    return '';
}

function isAsyncWebhookAck(text) {
    if (!text) return false;
    const normalized = String(text).toLowerCase();
    return normalized.includes('workflow was started') || normalized.includes('workflow started');
}

function getInputWebhookUrl() {
    return (n8nWebhookInput && n8nWebhookInput.value ? n8nWebhookInput.value.trim() : '');
}

function getN8nWebhookUrl() {
    return (localStorage.getItem(N8N_WEBHOOK_KEY) || getInputWebhookUrl() || '').trim();
}

function setN8nStatus(message, isError = false) {
    if (!n8nStatus) return;
    n8nStatus.textContent = message;
    n8nStatus.style.color = isError ? '#ef4444' : '#a3adc2';
}

function persistN8nWebhookUrl() {
    const url = getInputWebhookUrl();
    if (!url) {
        localStorage.removeItem(N8N_WEBHOOK_KEY);
        setN8nStatus('Not configured');
        return '';
    }
    localStorage.setItem(N8N_WEBHOOK_KEY, url);
    setN8nStatus('Configured');
    return url;
}

function loadN8nConfig() {
    const savedUrl = getN8nWebhookUrl();
    if (n8nWebhookInput) {
        n8nWebhookInput.value = savedUrl;
    }
    setN8nStatus(savedUrl ? 'Configured' : 'Not configured');
}

function getAlternateWebhookUrl(url) {
    if (url.includes('/webhook-test/')) {
        return url.replace('/webhook-test/', '/webhook/');
    }
    if (url.includes('/webhook/')) {
        return url.replace('/webhook/', '/webhook-test/');
    }
    return '';
}

async function postToN8nUrl(url, command, route = ROUTE_N8N_TASK) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command, route, user_id: 'leela-desktop' })
    });

    let payload = null;
    try {
        payload = await response.json();
    } catch (_) {
        payload = null;
    }

    return { response, payload };
}

async function postCommandToN8n(command, route = ROUTE_N8N_TASK) {
    const webhookUrl = getN8nWebhookUrl().trim();
    const triedUrls = [webhookUrl];

    if (!webhookUrl) {
        return { ok: false, error: 'n8n webhook URL is not configured', triedUrls };
    }

    try {
        let { response, payload } = await postToN8nUrl(webhookUrl, command, route);

        if (response.ok) {
            return { ok: true, payload, usedUrl: webhookUrl, triedUrls };
        }

        if (response.status === 404) {
            const alternate = getAlternateWebhookUrl(webhookUrl);
            if (alternate) {
                triedUrls.push(alternate);
                const retry = await postToN8nUrl(alternate, command, route);
                response = retry.response;
                payload = retry.payload;

                if (response.ok) {
                    if (n8nWebhookInput) n8nWebhookInput.value = alternate;
                    localStorage.setItem(N8N_WEBHOOK_KEY, alternate);
                    return { ok: true, payload, usedUrl: alternate, triedUrls };
                }
            }
        }

        return { ok: false, error: `HTTP ${response.status}`, payload, triedUrls };
    } catch (error) {
        return { ok: false, error: error.message, triedUrls };
    }
}

function isNatCommand(command) {
    const normalized = String(command || '').trim();
    return normalized.toLowerCase().startsWith(NAT_PREFIX + ' ') || normalized.toLowerCase() === NAT_PREFIX;
}

function stripNatPrefix(command) {
    const normalized = String(command || '').trim();
    if (!isNatCommand(normalized)) return normalized;
    const withoutPrefix = normalized.slice(NAT_PREFIX.length).trim();
    return withoutPrefix;
}

function classifyCommandIntent(command) {
    const text = String(command || '').trim().toLowerCase();
    if (!text) return ROUTE_N8N_TASK;

    const webIndicators = [
        'where', 'what', 'who', 'when', 'why', 'how',
        'states of', 'about', 'tell me', 'search', 'find information',
        'map', 'history of', 'capital of', 'facts about'
    ];
    const taskIndicators = [
        'send', 'schedule', 'create', 'email', 'calendar', 'remind',
        'message', 'add event', 'book', 'set reminder'
    ];

    if (taskIndicators.some((token) => text.includes(token))) {
        return ROUTE_N8N_TASK;
    }
    if (webIndicators.some((token) => text.includes(token))) {
        return ROUTE_WEB_SEARCH;
    }

    return ROUTE_WEB_SEARCH;
}


async function handleCommandSubmit(command) {
    const rawCommand = String(command || '').trim();
    if (!rawCommand) return;

    const routeToNat = isNatCommand(rawCommand);
    const routedCommand = routeToNat ? stripNatPrefix(rawCommand) : rawCommand;
    const route = routeToNat ? ROUTE_N8N_TASK : classifyCommandIntent(routedCommand);

    addMessage('user', rawCommand);

    if (routeToNat && !routedCommand) {
        addMessage('error', 'Please add a NAT command after /nat.');
        return;
    }

    const webhookUrl = persistN8nWebhookUrl() || getN8nWebhookUrl();
    if (!webhookUrl) {
        addMessage('error', 'n8n webhook URL is not configured. Please set it and click Save.');
        return;
    }

    showTyping();
    if (route === ROUTE_WEB_SEARCH) {
        setN8nStatus('Routing web search to n8n...');
    } else {
        setN8nStatus('Routing n8n task...');
    }

    const result = await postCommandToN8n(routedCommand, route);
    hideTyping();

    if (result.ok) {
        setN8nStatus('Command delivered (' + result.usedUrl + ')');
        const responseText = extractAssistantText(result.payload);
        console.log('DIAGNOSTIC - RAW_N8N_OUTPUT:', JSON.stringify(result.payload));
        console.log('DIAGNOSTIC - EXTRACTED_TEXT:', JSON.stringify(responseText));

        const asyncAck = isAsyncWebhookAck(responseText);

        const payloadActions = extractInteractiveActions(result.payload);
        const parsedUi = parseStructuredResponseFromText(responseText || '');
        const interactiveActions = payloadActions.length > 0 ? payloadActions : parsedUi.options;
        
        let displayText = responseText
            ? ((payloadActions.length === 0 && parsedUi.type === 'selection') ? parsedUi.title : responseText)
            : 'Workflow accepted your command payload.';
        
        // SURGICAL FIX: Sanitize output before rendering
        const { sanitizeAIOutput } = require('../src/utils/sanitize_output');
        displayText = sanitizeAIOutput(displayText);

        console.log('DIAGNOSTIC - FINAL_DISPLAY_TEXT:', JSON.stringify(displayText));

        addMessage('assistant', displayText, {
            metaText: asyncAck ? 'n8n async acknowledgment' : nowTime(),
            actions: interactiveActions
        });

        if (asyncAck) {
            addMessage('system', 'n8n returned an async acknowledgment. To show follow-up prompts here, configure webhook response as "When Last Node Finishes" or return agent text via Respond to Webhook node.');
        }
        return;
    }

    const tried = result.triedUrls && result.triedUrls.length ? '\n\nTried:\n- ' + result.triedUrls.join('\n- ') : '';
    setN8nStatus('n8n error: ' + result.error, true);
    addMessage('error', 'n8n request failed: ' + result.error + tried);
}

function dismissPanel() {
    panel.classList.remove('visible');
    setTimeout(() => {
        window.leela.send('dismiss-notification-panel');
    }, 300);
}

function mapExternalNotification(payload) {
    const title = payload?.data?.title ? `${payload.data.title}` + "\n" : "";
    const desc = payload?.data?.desc || '';
    const suggestion = payload?.data?.suggestion ? `\n\n${payload.data.suggestion}` : "";
    const text = `${title}${desc}${suggestion}`.trim();
    const actions = normalizeInteractiveActions(payload?.data?.actions || []);
    return { text, actions };
}
window.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        panel.classList.add('visible');
    }, 40);

    loadN8nConfig();
    addMessage('assistant', 'Ready. Web queries and tasks route through n8n automatically. Use /nat to force n8n task mode.', { metaText: 'Assistant ready' });

    if (n8nSaveBtn) {
        n8nSaveBtn.addEventListener('click', () => {
            const saved = persistN8nWebhookUrl();
            addMessage('system', saved ? `Webhook URL saved.\n${saved}` : 'Webhook URL cleared.');
        });
    }

    if (n8nTestBtn) {
        n8nTestBtn.addEventListener('click', async () => {
            const webhookUrl = persistN8nWebhookUrl();
            if (!webhookUrl) {
                addMessage('error', 'Cannot run test without webhook URL.');
                return;
            }

            showTyping();
            const result = await postCommandToN8n('health check: confirm webhook connectivity', ROUTE_N8N_TASK);
            hideTyping();

            if (result.ok) {
                setN8nStatus(`Test succeeded (${result.usedUrl})`);
                addMessage('assistant', 'n8n test passed. Webhook responded successfully.', { metaText: 'Connection test' });
            } else {
                const tried = result.triedUrls && result.triedUrls.length ? `\n\nTried:\n- ${result.triedUrls.join('\n- ')}` : '';
                setN8nStatus(`Test failed: ${result.error}`, true);
                addMessage('error', `n8n test failed: ${result.error}${tried}`);
            }
        });
    }
});

document.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') {
        dismissPanel();
        return;
    }

    if (e.ctrlKey && e.code === 'Space') {
        e.preventDefault();
        await toggleVoiceDictation();
    }
});

commandInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
        const command = commandInput.value.trim();
        if (!command) return;
        commandInput.value = '';
        await handleCommandSubmit(command);
    }
});

window.leela.on('chat-hotkey-toggle', async () => {
    await toggleVoiceDictation();
});
    const mapped = mapExternalNotification(payload);
    if (mapped.text) {
        const parsedUi = parseStructuredResponseFromText(mapped.text);
        const hasMappedActions = mapped.actions && mapped.actions.length;
        const actions = hasMappedActions ? mapped.actions : parsedUi.options;
        let displayText = hasMappedActions ? mapped.text : (parsedUi.type === 'selection' ? parsedUi.title : mapped.text);
        
        // SURGICAL FIX: Sanitize output
        const { sanitizeAIOutput } = require('../src/utils/sanitize_output');
        displayText = sanitizeAIOutput(displayText);
        
        addMessage('assistant', displayText, { metaText: 'System event', actions });
    }
if (micBtn) {
    micBtn.addEventListener('click', async () => {
        await toggleVoiceDictation();
    });
}
updateMicButtonUi();

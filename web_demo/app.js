document.addEventListener('DOMContentLoaded', () => {
    const editor = document.getElementById('editor');
    const dictateBtn = document.getElementById('dictate-btn');
    const btnText = document.getElementById('btn-text');
    const suggestionChips = document.querySelectorAll('.suggestion-chip');
    
    let isDictating = false;
    let holdTimeout = null;
    let isHolding = false;
    let recognition = null;

    // Initialize Web Speech API
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        recognition = new SpeechRecognition();
        recognition.continuous = false;
        recognition.interimResults = true;
        recognition.lang = 'en-US';

        recognition.onstart = () => {
            isDictating = true;
            dictateBtn.classList.add('bg-purple-100', 'animate-pulse');
            btnText.textContent = isHolding ? "Listening for instructions..." : "Listening...";
        };

        recognition.onresult = (event) => {
            let finalTranscript = '';
            for (let i = event.resultIndex; i < event.results.length; ++i) {
                if (event.results[i].isFinal) {
                    finalTranscript += event.results[i][0].transcript;
                }
            }

            if (finalTranscript) {
                handleSpeechFinal(finalTranscript);
            }
        };

        recognition.onerror = (event) => {
            console.error('Speech recognition error', event.error);
            stopDictation();
        };

        recognition.onend = () => {
            stopDictation();
        };
    }

    function stopDictation() {
        isDictating = false;
        isHolding = false;
        dictateBtn.classList.remove('bg-purple-100', 'animate-pulse');
        btnText.textContent = "Start dictating";
    }

    async function handleSpeechFinal(transcript) {
        const selection = getEditorSelection();
        
        if (isHolding && selection) {
            // Command 3: Voice Instructions
            if (window.va) window.va('event', { name: 'voice_instructions_triggered' });
            await performImprovement(selection, transcript);
        } else if (!selection) {
            // Command 1: Dictate
            if (window.va) window.va('event', { name: 'dictation_triggered' });
            const start = editor.selectionStart;
            const end = editor.selectionEnd;
            const oldText = editor.value;
            editor.value = oldText.substring(0, start) + transcript + oldText.substring(end);
            autoExpand();
        } else {
            // Context Click behavior - append to end if something else happened
            editor.value += (editor.value ? ' ' : '') + transcript;
            autoExpand();
        }
    }

    const sc3Indicators = document.getElementById('screen3-indicators');
    const headerArea = document.getElementById('header-area');

    function switchScreen(screenNum) {
        console.log(`[UI] Switching to Screen ${screenNum}`);
        
        // Default resets
        sc3Indicators.classList.add('hidden');
        headerArea.classList.remove('hidden');
        dictateBtn.style.width = '265px';
        btnText.textContent = "Start dictating";
        btnText.style.width = "auto";
        btnText.style.left = "auto";

        if (screenNum === 1) {
            dictateBtn.style.width = '265px';
            btnText.textContent = "Start dictating";
        } else if (screenNum === 2) {
            dictateBtn.style.width = '485px';
            btnText.textContent = "Leela is thinking..."; // Second screen mode often processing
            btnText.style.width = "370px";
            btnText.style.textAlign = "center";
        } else if (screenNum === 3) {
            dictateBtn.style.width = '658px';
            btnText.textContent = "Speak instructions to modify the selected text.";
            btnText.style.width = "573px";
            btnText.style.textAlign = "center";
            sc3Indicators.classList.remove('hidden');
        }
    }

    // Auto-expand textarea (Static for specs, but keeping for usage)
    function autoExpand() {
        // editor.style.height = 'auto'; // Disabled to maintain Frame 2558 bounds
    }

    editor.addEventListener('input', autoExpand);
    autoExpand();

    function getEditorSelection() {
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        if (start === end) return "";
        return editor.value.substring(start, end).trim();
    }

    // Monitor selection to switch screens
    editor.addEventListener('mouseup', () => {
        const selection = getEditorSelection();
        if (selection) {
            switchScreen(2);
        } else {
            switchScreen(1);
        }
    });

    async function performImprovement(textToImprove, command = "polish") {
        if (!textToImprove) return;
        
        switchScreen(2);
        btnText.textContent = "Leela is thinking...";
        editor.classList.add('opacity-50');
        
        try {
            console.log("REQUEST_PAYLOAD:", { text: textToImprove, command: command });
            const response = await fetch('/api/improve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: textToImprove, command: command })
            });
            const data = await response.json();
            
            if (data.success && data.result) {
                const start = editor.selectionStart;
                const end = editor.selectionEnd;
                const oldText = editor.value;
                editor.value = oldText.substring(0, start) + data.result + oldText.substring(end);
                
                editor.classList.remove('opacity-50');
                editor.classList.add('bg-white/10');
                setTimeout(() => editor.classList.remove('bg-white/10'), 1500);
            } else {
                const errorMsg = data.error || "Failed to process request.";
                alert("Leela says: " + errorMsg);
            }
        } catch (error) {
            console.error("Error improving text:", error);
            alert("Connection error: Please check your internet or try again later.");
        } finally {
            editor.classList.remove('opacity-50');
            stopDictation();
            switchScreen(selection ? 2 : 1);
        }
    }

    // Suggestion Chips (Update for Screen 3 context if needed)
    suggestionChips.forEach(chip => {
        chip.addEventListener('click', () => {
            const selection = getEditorSelection() || editor.value;
            const command = chip.textContent.trim();
            performImprovement(selection, command);
        });
    });

    function startDictating() {
        if (!recognition) {
            alert("Speech recognition is not supported in this browser. Please try Chrome or Edge.");
            return;
        }
        try {
            recognition.start();
        } catch (e) {
            console.warn("Recognition already started or failed", e);
        }
    }

    // Mouse events for Hold vs Click
    dictateBtn.addEventListener('mousedown', (e) => {
        if (isDictating) return;
        
        isHolding = false;
        holdTimeout = setTimeout(() => {
            const selection = getEditorSelection();
            if (selection) {
                isHolding = true;
                switchScreen(3);
                startDictating();
            }
        }, 500);
    });

    dictateBtn.addEventListener('mouseup', () => {
        clearTimeout(holdTimeout);
        if (isHolding) return;
        
        const selection = getEditorSelection();
        if (selection) {
            performImprovement(selection);
        } else {
            startDictating();
        }
    });

    // Keyboard shortcut Ctrl + Space
    let keyHoldTimeout = null;

    window.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.code === 'Space') {
            e.preventDefault();
            if (e.repeat) return;
            
            const selection = getEditorSelection();
            if (!selection) {
                isHolding = false;
                startDictating();
                return;
            }

            // Setup hold detection for keyboard
            isHolding = false;
            keyHoldTimeout = setTimeout(() => {
                isHolding = true;
                if (window.va) window.va('event', { name: 'voice_instructions_triggered_kbd' });
                switchScreen(3);
                startDictating();
            }, 500);
        }
    });

    window.addEventListener('keyup', (e) => {
        if (e.code === 'Space' || e.key === 'Control') {
            if (keyHoldTimeout) {
                clearTimeout(keyHoldTimeout);
                keyHoldTimeout = null;
                
                const selection = getEditorSelection();
                if (selection && !isHolding) {
                    performImprovement(selection);
                }
                // isHolding is reset by stopDictation() which is called on recognition end
            }
        }
    });

});

document.addEventListener('DOMContentLoaded', () => {
    const editor = document.getElementById('editor');
    const dictateBtn = document.getElementById('dictate-btn');
    const btnText = document.getElementById('btn-text');
    const suggestionChips = document.querySelectorAll('.flex.flex-wrap.items-center button');
    
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

    // Auto-expand textarea
    function autoExpand() {
        editor.style.height = 'auto';
        editor.style.height = (editor.scrollHeight) + 'px';
    }

    editor.addEventListener('input', autoExpand);
    autoExpand();

    function getEditorSelection() {
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        if (start === end) return "";
        return editor.value.substring(start, end).trim();
    }

    async function performImprovement(textToImprove, command = "polish") {
        if (!textToImprove) return;
        
        btnText.textContent = "Leela is thinking...";
        editor.classList.add('opacity-50');
        
        try {
            if (window.va) window.va('event', { name: 'improvement_started', data: { command: command } });
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
                
                // Visual feedback
                editor.classList.remove('opacity-50');
                editor.classList.add('bg-emerald-50');
                setTimeout(() => editor.classList.remove('bg-emerald-50'), 1500);
            } else if (data.success && !data.result) {
                console.warn("AI returned empty result");
                editor.classList.remove('opacity-50');
            } else {
                alert("Improvement failed: " + (data.error || "Unknown error"));
            }
        } catch (error) {
            console.error("Error improving text:", error);
            alert("Failed to connect to Leela server.");
        } finally {
            editor.classList.remove('opacity-50');
            stopDictation();
            autoExpand();
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

    // Suggestion Chips
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

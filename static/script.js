// Haley Voice Assistant - Web Speech API + ElevenLabs Audio

let socket = null;
let recognition = null;
let isListening = false;
let isSpeaking = false; // Prevents recognition during audio playback
let audioContext = null;
let audioQueue = [];
let isPlaying = false;
let lastAssistantText = ''; // For echo detection
let audioPlayer = new Audio(); // HTML5 Audio element for better iOS compatibility

// DOM Elements
const micBtn = document.getElementById('mic-btn');
const statusBadge = document.getElementById('status-badge');
const statusText = statusBadge.querySelector('.status-text');
const chatArea = document.getElementById('chat-area');
const visualizerContainer = document.getElementById('visualizer-container');
const listeningText = document.getElementById('listening-text');

// Initialize
micBtn.addEventListener('click', toggleConversation);

function toggleConversation() {
    if (isListening) {
        stopConversation();
    } else {
        startConversation();
    }
}

async function startConversation() {
    try {
        // Check for speech recognition support
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            alert('Speech recognition is not supported in your browser. Please use Chrome or Edge.');
            return;
        }

        // Connect WebSocket
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        socket = new WebSocket(`${protocol}//${window.location.host}/ws/chat`);

        socket.onopen = () => {
            console.log('WebSocket connected');
            updateStatus('online', 'Connected');

            // Initialize audio context for playback
            audioContext = new (window.AudioContext || window.webkitAudioContext)();

            // iOS requires audio context to be resumed on user gesture
            // This happens here because the button click is a user gesture
            if (audioContext.state === 'suspended') {
                audioContext.resume().then(() => {
                    console.log('AudioContext resumed');
                });
            }

            // iOS audio unlock hack - play a silent buffer to "unlock" audio
            unlockAudioForIOS();

            // Also unlock the HTML5 audio element
            audioPlayer.src = 'data:audio/mp3;base64,//NExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq//NExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq';
            audioPlayer.volume = 0;
            audioPlayer.play().then(() => {
                console.log('HTML5 Audio unlocked');
                audioPlayer.volume = 1;
            }).catch(e => console.log('HTML5 Audio unlock failed', e));

            // Start speech recognition
            startRecognition();
        };

        socket.onmessage = async (event) => {
            const data = JSON.parse(event.data);
            await handleMessage(data);
        };

        socket.onclose = () => {
            console.log('WebSocket closed');
            stopConversation();
        };

        socket.onerror = (error) => {
            console.error('WebSocket error:', error);
            stopConversation();
        };

        // Update UI
        isListening = true;
        micBtn.classList.add('active');

    } catch (err) {
        console.error('Error starting conversation:', err);
        alert('Could not start conversation: ' + err.message);
    }
}

function startRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onstart = () => {
        updateStatus('listening', 'Listening...');
        visualizerContainer.classList.add('active');
        listeningText.textContent = 'Listening...';
    };

    recognition.onresult = (event) => {
        // Ignore any recognition results while speaking
        if (isSpeaking) {
            return;
        }

        let finalTranscript = '';
        let interimTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
                finalTranscript += transcript;
            } else {
                interimTranscript += transcript;
            }
        }

        // Update listening text with interim results
        if (interimTranscript) {
            listeningText.textContent = interimTranscript;
        }

        // Send final transcript to server (with echo detection)
        if (finalTranscript.trim()) {
            const userText = finalTranscript.trim();

            // Echo detection: check if user is just repeating what assistant said
            if (isEcho(userText, lastAssistantText)) {
                console.log('Echo detected, ignoring:', userText);
                return;
            }

            sendMessage(userText);
        }
    };

    recognition.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        if (event.error === 'no-speech') {
            // Restart recognition if no speech detected
            setTimeout(() => {
                if (isListening && recognition) {
                    try {
                        recognition.start();
                    } catch (e) {
                        // Already started
                    }
                }
            }, 100);
        }
    };

    recognition.onend = () => {
        // Restart if still listening
        if (isListening) {
            setTimeout(() => {
                if (isListening && recognition) {
                    try {
                        recognition.start();
                    } catch (e) {
                        // Already started
                    }
                }
            }, 100);
        }
    };

    recognition.start();
}

function sendMessage(text) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
            type: 'user_message',
            text: text
        }));

        // Pause listening while processing
        if (recognition) {
            recognition.stop();
        }
        updateStatus('speaking', 'Processing...');
        listeningText.textContent = 'Thinking...';
    }
}

async function handleMessage(data) {
    switch (data.type) {
        case 'user_transcript':
            addMessage('user', data.text);
            break;

        case 'assistant_message':
            lastAssistantText = data.text; // Store for echo detection
            addMessage('assistant', data.text);
            break;

        case 'audio_start':
            isSpeaking = true; // Block recognition
            if (recognition) {
                recognition.stop();
            }
            updateStatus('speaking', 'Speaking...');
            listeningText.textContent = 'Speaking...';
            audioQueue = []; // Clear buffer for new audio
            isPlaying = false;
            break;

        case 'audio_chunk':
            // Just buffer the chunk, don't play yet (iOS compatibility)
            bufferAudioChunk(data.data);
            break;

        case 'audio_end':
            // Now play the complete buffered audio
            await playCompleteAudio();
            isSpeaking = false; // Allow recognition again
            if (isListening) {
                updateStatus('listening', 'Listening...');
                listeningText.textContent = 'Listening...';
                // Delay before restarting to avoid picking up echo
                setTimeout(() => {
                    if (recognition && isListening && !isSpeaking) {
                        try {
                            recognition.start();
                        } catch (e) {
                            // Already started
                        }
                    }
                }, 500);
            }
            break;

        case 'audio_error':
            console.error('Audio error:', data.message);
            if (isListening) {
                updateStatus('listening', 'Listening...');
                if (recognition) {
                    recognition.start();
                }
            }
            break;
    }
}

function bufferAudioChunk(base64Data) {
    // Decode base64 to array buffer and add to queue
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }
    audioQueue.push(bytes.buffer);
}

async function playCompleteAudio() {
    if (audioQueue.length === 0 || !audioContext) {
        isPlaying = false;
        return;
    }

    isPlaying = true;

    // iOS: Always try to resume audio context before playing
    if (audioContext.state === 'suspended') {
        try {
            await audioContext.resume();
            console.log('AudioContext resumed for playback');
        } catch (e) {
            console.error('Failed to resume AudioContext:', e);
        }
    }

    // Combine ALL chunks into one complete audio buffer
    const combinedBuffer = combineArrayBuffers(audioQueue);
    audioQueue = [];

    try {
        // Create a Blob from the buffer and stream it via HTML5 Audio
        // This is much more robust on iOS than Web Audio API
        const blob = new Blob([combinedBuffer], { type: 'audio/mpeg' });
        const audioUrl = URL.createObjectURL(blob);

        audioPlayer.src = audioUrl;
        audioPlayer.volume = 1;

        // Wait for audio to complete
        return new Promise((resolve) => {
            audioPlayer.onended = () => {
                isPlaying = false;
                console.log('Audio playback complete');
                URL.revokeObjectURL(audioUrl); // Clean up
                resolve();
            };

            const playPromise = audioPlayer.play();
            if (playPromise !== undefined) {
                playPromise.catch(error => {
                    console.error('Audio playback failed:', error);
                    isPlaying = false;
                    resolve();
                });
            }
        });
    } catch (e) {
        console.error('Audio error:', e);
        isPlaying = false;
    }
}

function combineArrayBuffers(buffers) {
    const totalLength = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const buf of buffers) {
        result.set(new Uint8Array(buf), offset);
        offset += buf.byteLength;
    }
    return result.buffer;
}

// iOS audio unlock hack - plays a silent buffer to "unlock" audio playback
function unlockAudioForIOS() {
    if (!audioContext) return;

    // Create a silent buffer (1 sample of silence)
    const buffer = audioContext.createBuffer(1, 1, 22050);
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);

    // Play the silent buffer
    source.start(0);
    source.stop(0.001);

    console.log('iOS audio unlocked');
}

async function waitForAudioEnd() {
    // Wait for audio queue to empty and playback to finish
    while (isPlaying || audioQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    // Extended delay to prevent echo pickup (1.5 seconds)
    await new Promise(resolve => setTimeout(resolve, 1500));
}

// Echo detection - check if text is similar to what assistant just said
function isEcho(userText, assistantText) {
    if (!assistantText) return false;

    // Normalize both strings
    const normalizeText = (text) => text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const normalUser = normalizeText(userText);
    const normalAssistant = normalizeText(assistantText);

    // Check if user text contains significant portion of assistant text
    if (normalUser.length < 5) return false;

    // If user text is very similar to assistant text, it's likely an echo
    if (normalAssistant.includes(normalUser) || normalUser.includes(normalAssistant)) {
        return true;
    }

    // Check word overlap
    const userWords = normalUser.split(' ');
    const assistantWords = normalAssistant.split(' ');
    let matchCount = 0;
    for (const word of userWords) {
        if (word.length > 2 && assistantWords.includes(word)) {
            matchCount++;
        }
    }

    // If more than 60% of words match, likely an echo
    const matchRatio = matchCount / userWords.length;
    return matchRatio > 0.6;
}

function stopConversation() {
    isListening = false;

    if (recognition) {
        recognition.stop();
        recognition = null;
    }

    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
    }
    socket = null;

    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }

    audioQueue = [];
    isPlaying = false;

    // Update UI
    micBtn.classList.remove('active');
    visualizerContainer.classList.remove('active');
    updateStatus('offline', 'Offline');
}

function updateStatus(state, text) {
    statusBadge.className = 'status-badge ' + state;
    statusText.textContent = text;
}

function addMessage(role, text) {
    // Remove welcome message if present
    const welcome = chatArea.querySelector('.welcome-message');
    if (welcome) {
        welcome.remove();
    }

    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
    chatArea.appendChild(div);
    chatArea.scrollTop = chatArea.scrollHeight;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

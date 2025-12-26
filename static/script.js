// Haley Voice Assistant - Web Speech API + ElevenLabs Audio

let socket = null;
let recognition = null;
let isListening = false;
let isSpeaking = false; // Prevents recognition during audio playback
let audioContext = null;
let audioQueue = [];
let isPlaying = false;

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

        // Send final transcript to server
        if (finalTranscript.trim()) {
            sendMessage(finalTranscript.trim());
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
            addMessage('assistant', data.text);
            break;

        case 'audio_start':
            isSpeaking = true; // Block recognition
            if (recognition) {
                recognition.stop();
            }
            updateStatus('speaking', 'Speaking...');
            listeningText.textContent = 'Speaking...';
            audioQueue = [];
            break;

        case 'audio_chunk':
            queueAudioChunk(data.data);
            break;

        case 'audio_end':
            // Wait for audio to finish, then resume listening
            await waitForAudioEnd();
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

function queueAudioChunk(base64Data) {
    // Decode base64 to array buffer
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
    }

    audioQueue.push(bytes.buffer);

    if (!isPlaying) {
        playAudioQueue();
    }
}

async function playAudioQueue() {
    if (audioQueue.length === 0 || !audioContext) {
        isPlaying = false;
        return;
    }

    isPlaying = true;

    // Resume audio context if suspended
    if (audioContext.state === 'suspended') {
        await audioContext.resume();
    }

    // Combine all chunks into one buffer
    const combinedBuffer = combineArrayBuffers(audioQueue);
    audioQueue = [];

    try {
        // Decode MP3 audio
        const audioBuffer = await audioContext.decodeAudioData(combinedBuffer);

        // Play the audio
        const source = audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(audioContext.destination);

        source.onended = () => {
            if (audioQueue.length > 0) {
                playAudioQueue();
            } else {
                isPlaying = false;
            }
        };

        source.start();
    } catch (e) {
        console.error('Audio decode error:', e);
        isPlaying = false;

        // Try to play remaining chunks
        if (audioQueue.length > 0) {
            setTimeout(() => playAudioQueue(), 100);
        }
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

async function waitForAudioEnd() {
    // Wait for audio queue to empty and playback to finish
    while (isPlaying || audioQueue.length > 0) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    // Extra delay for smooth transition
    await new Promise(resolve => setTimeout(resolve, 500));
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

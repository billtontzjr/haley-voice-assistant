let socket;
let audioContext;
let playbackContext;
let isRecording = false;
let audioQueue = [];
let isPlaying = false;
let nextPlayTime = 0;

const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const statusIndicator = document.getElementById('status-indicator');
const chatContainer = document.getElementById('chat-container');

startBtn.addEventListener('click', startSession);
stopBtn.addEventListener('click', stopSession);

async function startSession() {
    try {
        // 1. Request Microphone
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

        // 2. Connect WebSocket
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        socket = new WebSocket(`${protocol}//${window.location.host}/ws/chat`);

        socket.onopen = () => {
            statusIndicator.textContent = 'Connected';
            statusIndicator.classList.add('online');
            startBtn.disabled = true;
            stopBtn.disabled = false;

            // Create playback context on user interaction (required by browsers)
            playbackContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
            nextPlayTime = 0;

            startAudioCapture(stream);
        };

        socket.onmessage = async (event) => {
            const data = JSON.parse(event.data);
            console.log('Received:', data.type, data);

            // Handle different Hume EVI message types
            if (data.type === 'audio_output') {
                // Queue audio for playback
                queueAudio(data.data);
            } else if (data.type === 'user_message') {
                // User's transcribed speech
                if (data.message && data.message.content) {
                    addMessage('user', data.message.content);
                }
            } else if (data.type === 'assistant_message') {
                // Assistant's text response
                if (data.message && data.message.content) {
                    addMessage('assistant', data.message.content);
                }
            } else if (data.type === 'user_interruption') {
                // User interrupted - clear audio queue
                audioQueue = [];
            } else if (data.type === 'error') {
                console.error('Hume error:', data);
                addMessage('system', 'Error: ' + (data.message || 'Unknown error'));
            }
        };

        socket.onclose = (event) => {
            console.log('WebSocket closed:', event.code, event.reason);
            stopSession();
        };

        socket.onerror = (error) => {
            console.error('WebSocket error:', error);
        };

    } catch (err) {
        console.error("Error starting session:", err);
        alert("Could not access microphone. Please allow permissions.");
    }
}

function startAudioCapture(stream) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);

    source.connect(processor);
    processor.connect(audioContext.destination);

    processor.onaudioprocess = (e) => {
        if (!isRecording || socket.readyState !== WebSocket.OPEN) return;

        const inputData = e.inputBuffer.getChannelData(0);

        // Convert Float32 to Int16
        const buffer = new ArrayBuffer(inputData.length * 2);
        const view = new DataView(buffer);
        for (let i = 0; i < inputData.length; i++) {
            let s = Math.max(-1, Math.min(1, inputData[i]));
            view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true); // little-endian
        }

        // Convert to Base64
        const base64Audio = arrayBufferToBase64(buffer);

        socket.send(JSON.stringify({
            type: 'audio_input',
            data: base64Audio
        }));
    };

    isRecording = true;
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

function stopSession() {
    isRecording = false;
    audioQueue = [];
    isPlaying = false;
    nextPlayTime = 0;

    if (audioContext) {
        audioContext.close();
        audioContext = null;
    }
    if (playbackContext) {
        playbackContext.close();
        playbackContext = null;
    }
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.close();
    }
    socket = null;

    statusIndicator.textContent = 'Offline';
    statusIndicator.classList.remove('online');
    startBtn.disabled = false;
    stopBtn.disabled = true;
}

function queueAudio(base64Data) {
    audioQueue.push(base64Data);
    if (!isPlaying) {
        playNextAudio();
    }
}

async function playNextAudio() {
    if (audioQueue.length === 0) {
        isPlaying = false;
        return;
    }

    if (!playbackContext || playbackContext.state === 'closed') {
        console.error('Playback context not available');
        isPlaying = false;
        return;
    }

    isPlaying = true;
    const base64Data = audioQueue.shift();

    try {
        // Resume context if suspended (browser autoplay policy)
        if (playbackContext.state === 'suspended') {
            await playbackContext.resume();
        }

        // Decode base64 to ArrayBuffer
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }

        // Convert Int16 PCM to Float32 for Web Audio API
        const int16Array = new Int16Array(bytes.buffer);
        const float32Array = new Float32Array(int16Array.length);
        for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768.0;
        }

        // Create audio buffer and play
        const audioBuffer = playbackContext.createBuffer(1, float32Array.length, 24000);
        audioBuffer.getChannelData(0).set(float32Array);

        const source = playbackContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(playbackContext.destination);

        // Schedule seamless playback
        const currentTime = playbackContext.currentTime;
        const startTime = Math.max(currentTime, nextPlayTime);
        nextPlayTime = startTime + audioBuffer.duration;

        source.onended = () => {
            playNextAudio();
        };

        source.start(startTime);
        console.log('Playing audio chunk, duration:', audioBuffer.duration);
    } catch (e) {
        console.error('Audio playback error:', e);
        playNextAudio();
    }
}

function addMessage(role, text) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.innerHTML = `<div class="bubble">${text}</div>`;
    chatContainer.appendChild(div);
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

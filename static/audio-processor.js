// AudioWorklet processor for efficient, low-latency audio capture
// Runs on dedicated audio thread to prevent main thread blocking

class AudioCaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.buffer = new Float32Array(0);
        this.targetSamples = 8192; // Accumulate ~0.5s at 16kHz before sending
    }

    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (input.length === 0 || input[0].length === 0) {
            return true;
        }

        const channelData = input[0];

        // Accumulate samples
        const newBuffer = new Float32Array(this.buffer.length + channelData.length);
        newBuffer.set(this.buffer);
        newBuffer.set(channelData, this.buffer.length);
        this.buffer = newBuffer;

        // Send when we have enough samples
        if (this.buffer.length >= this.targetSamples) {
            // Convert Float32 to Int16
            const int16Buffer = new Int16Array(this.buffer.length);
            for (let i = 0; i < this.buffer.length; i++) {
                const s = Math.max(-1, Math.min(1, this.buffer[i]));
                int16Buffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }

            // Send to main thread
            this.port.postMessage({
                type: 'audio',
                buffer: int16Buffer.buffer
            }, [int16Buffer.buffer]);

            this.buffer = new Float32Array(0);
        }

        return true;
    }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);

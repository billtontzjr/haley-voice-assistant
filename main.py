# === TURNKEY HUME.AI + GEMINI VOICE ASSISTANT (Haley clone) ===

import os
import asyncio
import websockets
import json
import base64
import sounddevice as sd
import numpy as np
from google import generativeai as genai
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# ------------------------------------------------------------------
# 1. Configuration
# ------------------------------------------------------------------
HUME_API_KEY = os.getenv("HUME_API_KEY")
HALEY_VOICE_ID = os.getenv("HALEY_VOICE_ID", "62840f23-8309-4a9d-97d3-d419ba7d0f60")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
GEMINI_MODEL = "gemini-1.5-flash"  # or gemini-1.5-pro

if not HUME_API_KEY:
    print("Error: HUME_API_KEY not found in environment variables.")
    exit(1)
if not GEMINI_API_KEY:
    print("Error: GEMINI_API_KEY not found in environment variables.")
    exit(1)

# ------------------------------------------------------------------
# 2. Setup clients
# ------------------------------------------------------------------
genai.configure(api_key=GEMINI_API_KEY)
model = genai.GenerativeModel(GEMINI_MODEL)

# Global chat history so Haley remembers the conversation
chat = model.start_chat(history=[])

# ------------------------------------------------------------------
# 3. The actual real-time voice assistant using Hume EVI 2 + custom Gemini brain
# ------------------------------------------------------------------
async def haley_assistant():
    uri = "wss://api.hume.ai/v0/evi/chat"
    
    extra_headers = {
        "X-Hume-Api-Key": HUME_API_KEY,
        "Content-Type": "application/json; charset=utf-8"
    }

    # This config forces Hume to use YOUR cloned voice "Haley"
    config_payload = {
        "type": "websocket_config",
        "version": "2.0",
        "voice": {
            "type": "hume",
            "provider": "HUME_VOICE",
            "voice_id": HALEY_VOICE_ID
        },
        "system_prompt": "You are Haley, a warm, helpful, and slightly playful personal assistant. Keep responses concise and natural."
    }

    async with websockets.connect(uri, additional_headers=extra_headers, max_size=None) as ws:
        print("Haley is online! Say something… (press Ctrl+C to quit)")

        # Capture the loop to use in the callback
        loop = asyncio.get_running_loop()

        # 1. Send config with your Haley voice
        await ws.send(json.dumps(config_payload))

        # 2. Open microphone (16kHz, mono – perfect for Hume)
        def audio_callback(indata, frames, time, status):
            if status:
                print(status)
            # indata is already int16 bytes from RawInputStream
            audio_bytes = bytes(indata)
            message = {
                "type": "audio_input",
                "data": base64.b64encode(audio_bytes).decode("utf-8")
            }
            # Schedule the coroutine on the main event loop
            asyncio.run_coroutine_threadsafe(ws.send(json.dumps(message)), loop)

        # Start recording
        stream = sd.RawInputStream(
            samplerate=16000,
            blocksize=8000,
            dtype="int16",
            channels=1,
            callback=audio_callback
        )

        with stream:
            while True:
                try:
                    message = await ws.recv()
                    data = json.loads(message)

                    # When Hume sends us assistant text → send to Gemini
                    if data.get("type") == "assistant_message" and "text" in data:
                        user_text = data["text"]
                        print(f"\nYou: {user_text}")

                        # Gemini generates the real reply
                        response = chat.send_message(user_text)
                        haley_reply = response.text

                        print(f"Haley: {haley_reply}")

                        # Send Gemini's reply back to Hume so it speaks with Haley’s voice
                        await ws.send(json.dumps({
                            "type": "user_interruption",  # clears any ongoing speech
                        }))
                        await ws.send(json.dumps({
                            "type": "assistant_text",
                            "text": haley_reply
                        }))

                    # Play audio chunks as soon as they arrive
                    if data.get("type") == "audio_output":
                        audio_bytes = base64.b64decode(data["data"])
                        audio_np = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0
                        sd.play(audio_np, samplerate=24000)  # Hume EVI2 outputs 24kHz

                except websockets.ConnectionClosed:
                    print("Connection closed. Goodbye!")
                    break
                except KeyboardInterrupt:
                    print("\nGoodbye!")
                    break

# ------------------------------------------------------------------
# 4. Run it!
# ------------------------------------------------------------------
if __name__ == "__main__":
    asyncio.run(haley_assistant())

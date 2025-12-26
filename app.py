import os
import json
import asyncio
from fastapi import FastAPI, WebSocket, Request, Form, WebSocketDisconnect
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from dotenv import load_dotenv
import httpx
import google.generativeai as genai

# Load environment variables
load_dotenv()

ELEVENLABS_API_KEY = os.getenv("ELEVENLABS_API_KEY")
ELEVENLABS_VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
ACCESS_CODE = os.getenv("ACCESS_CODE", "1996")

# Validate required keys
if not ELEVENLABS_API_KEY:
    print("Warning: Missing ELEVENLABS_API_KEY")
if not ELEVENLABS_VOICE_ID:
    print("Warning: Missing ELEVENLABS_VOICE_ID")
if not GEMINI_API_KEY:
    print("Warning: Missing GEMINI_API_KEY")

# Configure Gemini
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)
    model = genai.GenerativeModel(
        "gemini-1.5-flash",
        system_instruction="""You are Haley, a warm, helpful, and slightly playful personal assistant. 
Keep your responses concise and conversational - typically 1-3 sentences.
Be natural and friendly, like talking to a close friend.
Never use markdown, bullet points, or formatted text - speak naturally."""
    )

app = FastAPI()

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# Store chat histories per session (in production, use Redis or similar)
chat_sessions = {}

# --- Routes ---

@app.get("/", response_class=HTMLResponse)
async def get_home(request: Request):
    if request.cookies.get("auth") != ACCESS_CODE:
        return RedirectResponse(url="/login")
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/login", response_class=HTMLResponse)
async def get_login(request: Request):
    return templates.TemplateResponse("login.html", {"request": request})

@app.post("/login")
async def post_login(request: Request, code: str = Form(...)):
    if code == ACCESS_CODE:
        response = RedirectResponse(url="/", status_code=303)
        response.set_cookie(key="auth", value=ACCESS_CODE)
        return response
    else:
        return templates.TemplateResponse("login.html", {"request": request, "error": "Incorrect code"})

# --- WebSocket for Voice Chat ---

@app.websocket("/ws/chat")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    
    # Create a new chat session
    session_id = id(ws)
    chat = model.start_chat(history=[])
    chat_sessions[session_id] = chat
    
    try:
        while True:
            # Receive message from browser (text from speech recognition)
            data = await ws.receive_json()
            
            if data.get("type") == "user_message":
                user_text = data.get("text", "").strip()
                if not user_text:
                    continue
                
                # Send acknowledgment
                await ws.send_json({
                    "type": "user_transcript",
                    "text": user_text
                })
                
                # Get response from Gemini
                try:
                    response = chat.send_message(user_text)
                    assistant_text = response.text.strip()
                except Exception as e:
                    print(f"Gemini error: {e}")
                    assistant_text = "I'm sorry, I had trouble thinking of a response."
                
                # Send assistant text to browser
                await ws.send_json({
                    "type": "assistant_message",
                    "text": assistant_text
                })
                
                # Stream audio from ElevenLabs
                await stream_elevenlabs_audio(ws, assistant_text)
                
    except WebSocketDisconnect:
        print(f"Client disconnected: {session_id}")
    except Exception as e:
        print(f"WebSocket error: {e}")
    finally:
        chat_sessions.pop(session_id, None)


async def stream_elevenlabs_audio(ws: WebSocket, text: str):
    """Stream TTS audio from ElevenLabs to the browser"""
    
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}/stream"
    
    headers = {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        "Accept": "audio/mpeg"
    }
    
    payload = {
        "text": text,
        "model_id": "eleven_turbo_v2_5",
        "voice_settings": {
            "stability": 0.5,
            "similarity_boost": 0.75,
            "style": 0.0,
            "use_speaker_boost": True
        }
    }
    
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            async with client.stream("POST", url, headers=headers, json=payload) as response:
                if response.status_code != 200:
                    error_text = await response.aread()
                    print(f"ElevenLabs error: {response.status_code} - {error_text}")
                    return
                
                # Signal start of audio
                await ws.send_json({"type": "audio_start"})
                
                # Stream audio chunks
                import base64
                async for chunk in response.aiter_bytes(chunk_size=4096):
                    if chunk:
                        # Send as base64 encoded MP3
                        await ws.send_json({
                            "type": "audio_chunk",
                            "data": base64.b64encode(chunk).decode("utf-8")
                        })
                
                # Signal end of audio
                await ws.send_json({"type": "audio_end"})
                
    except Exception as e:
        print(f"ElevenLabs streaming error: {e}")
        await ws.send_json({"type": "audio_error", "message": str(e)})

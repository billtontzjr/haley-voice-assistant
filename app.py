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
missing_keys = []
if not ELEVENLABS_API_KEY:
    missing_keys.append("ELEVENLABS_API_KEY")
if not ELEVENLABS_VOICE_ID:
    missing_keys.append("ELEVENLABS_VOICE_ID")
if not GEMINI_API_KEY:
    missing_keys.append("GEMINI_API_KEY")

if missing_keys:
    print(f"WARNING: Missing environment variables: {', '.join(missing_keys)}")
else:
    print("All required environment variables are set.")

# Configure Gemini
if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)
    model = genai.GenerativeModel(
        "gemini-pro",
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

# --- Debug endpoint to test Gemini ---
@app.get("/debug")
async def debug_gemini():
    """Test Gemini API connection and show actual errors"""
    import traceback
    
    result = {
        "gemini_api_key_set": bool(GEMINI_API_KEY),
        "gemini_api_key_preview": GEMINI_API_KEY[:10] + "..." if GEMINI_API_KEY else None,
        "elevenlabs_api_key_set": bool(ELEVENLABS_API_KEY),
        "elevenlabs_voice_id_set": bool(ELEVENLABS_VOICE_ID),
    }
    
    if not GEMINI_API_KEY:
        result["error"] = "GEMINI_API_KEY not configured"
        return result
    
    # List available models
    try:
        available_models = []
        for m in genai.list_models():
            if 'generateContent' in [method.name for method in m.supported_generation_methods]:
                available_models.append(m.name)
        result["available_models"] = available_models[:10]  # First 10
    except Exception as e:
        result["list_models_error"] = str(e)
    
    # Try different model names
    models_to_try = [
        "gemini-1.5-flash-latest",
        "gemini-1.5-pro-latest", 
        "gemini-pro",
        "models/gemini-pro",
        "gemini-1.0-pro",
    ]
    
    for model_name in models_to_try:
        try:
            test_model = genai.GenerativeModel(model_name)
            response = test_model.generate_content("Say hi")
            result["gemini_test"] = "SUCCESS"
            result["working_model"] = model_name
            result["gemini_response"] = response.text[:100] if response.text else "Empty"
            break
        except Exception as e:
            if "gemini_errors" not in result:
                result["gemini_errors"] = {}
            result["gemini_errors"][model_name] = str(e)[:100]
    
    if "gemini_test" not in result:
        result["gemini_test"] = "FAILED - No models worked"
    
    return result

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
                    if not GEMINI_API_KEY:
                        raise Exception("GEMINI_API_KEY not configured")
                    response = chat.send_message(user_text)
                    assistant_text = response.text.strip()
                    if not assistant_text:
                        assistant_text = "Hmm, let me think about that."
                    print(f"Gemini response: {assistant_text[:100]}...")
                except Exception as e:
                    print(f"Gemini error: {type(e).__name__}: {e}")
                    import traceback
                    traceback.print_exc()
                    assistant_text = "I'm having a little trouble right now. Could you try again?"
                
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

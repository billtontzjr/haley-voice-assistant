import os
import json
import asyncio
from fastapi import FastAPI, WebSocket, Request, Form
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from dotenv import load_dotenv
import websockets

# Load environment variables
load_dotenv()

HUME_API_KEY = os.getenv("HUME_API_KEY")
HUME_CONFIG_ID = os.getenv("HALEY_VOICE_ID", "62840f23-8309-4a9d-97d3-d419ba7d0f60")
ACCESS_CODE = "1996"

if not HUME_API_KEY:
    print("Error: Missing HUME_API_KEY in .env")

app = FastAPI()

app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# --- Routes ---

@app.get("/", response_class=HTMLResponse)
async def get_home(request: Request):
    # Check for auth cookie
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

# --- WebSocket - Proxy to Hume EVI ---

@app.websocket("/ws/chat")
async def websocket_endpoint(client_ws: WebSocket):
    await client_ws.accept()

    # Build Hume EVI WebSocket URL with authentication and config
    hume_url = f"wss://api.hume.ai/v0/evi/chat?api_key={HUME_API_KEY}&config_id={HUME_CONFIG_ID}"

    hume_ws = None

    try:
        # Connect to Hume EVI
        hume_ws = await websockets.connect(hume_url, max_size=16 * 1024 * 1024)
        print("Connected to Hume EVI")

        # Send session settings for audio format (16kHz mono PCM)
        session_settings = {
            "type": "session_settings",
            "audio": {
                "encoding": "linear16",
                "channels": 1,
                "sample_rate": 16000
            }
        }
        await hume_ws.send(json.dumps(session_settings))
        print("Sent session settings to Hume")

        async def forward_browser_to_hume():
            """Forward messages from browser to Hume"""
            try:
                while True:
                    data = await client_ws.receive_text()
                    await hume_ws.send(data)
            except Exception as e:
                print(f"Browser->Hume closed: {e}")

        async def forward_hume_to_browser():
            """Forward messages from Hume to browser"""
            try:
                async for message in hume_ws:
                    data = json.loads(message)
                    await client_ws.send_json(data)
            except Exception as e:
                print(f"Hume->Browser closed: {e}")

        # Run both directions concurrently
        await asyncio.gather(
            forward_browser_to_hume(),
            forward_hume_to_browser(),
            return_exceptions=True
        )

    except websockets.exceptions.ConnectionClosed as e:
        print(f"Hume connection closed: {e}")
    except Exception as e:
        print(f"Connection error: {e}")
        import traceback
        traceback.print_exc()
    finally:
        if hume_ws:
            await hume_ws.close()
        try:
            await client_ws.close()
        except:
            pass

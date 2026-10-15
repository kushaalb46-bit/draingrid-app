import os
import uuid
import sqlite3
import shutil
from datetime import datetime
from pathlib import Path
import bcrypt
from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Form, status, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded
from dotenv import load_dotenv

load_dotenv()
ENVIRONMENT = os.getenv("ENVIRONMENT", "development")
DEBUG_MODE = ENVIRONMENT == "development"

# --- Upload Directory ---
UPLOAD_DIR = Path("./uploads")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB

# --- Rate Limiter ---
limiter = Limiter(key_func=get_remote_address)

app = FastAPI(
    title="DrainGRID API",
    docs_url=None if not DEBUG_MODE else "/docs",
    redoc_url=None
)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# --- CORS & Security Headers ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response

# Serve uploaded files statically
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

# --- Database Setup (SQLite) ---
DB_PATH = "draingrid.db"

def get_db():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute('''
        CREATE TABLE IF NOT EXISTS tickets (
            id TEXT PRIMARY KEY,
            location TEXT NOT NULL,
            description TEXT NOT NULL,
            before_image_url TEXT NOT NULL,
            status TEXT NOT NULL,
            ai_confidence_score REAL,
            after_image_url TEXT,
            created_at TEXT NOT NULL
        )
    ''')
    conn.commit()
    conn.close()

init_db()

# --- Auth Helpers (Pure bcrypt, bypassing passlib bugs) ---
def hash_pin(pin: str) -> str:
    return bcrypt.hashpw(pin.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

def verify_pin(plain_pin: str, hashed_pin: str) -> bool:
    return bcrypt.checkpw(plain_pin.encode('utf-8'), hashed_pin.encode('utf-8'))

WORKER_PIN_HASH = hash_pin(os.getenv("WORKER_PIN", "1234"))

# --- Helper: Save Upload Safely ---
async def save_upload(file: UploadFile) -> str:
    ext = Path(file.filename or "").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid file type. Allowed: {', '.join(ALLOWED_EXTENSIONS)}"
        )
    
    unique_filename = f"{uuid.uuid4().hex}{ext}"
    target_path = UPLOAD_DIR / unique_filename

    # Read up to MAX_FILE_SIZE + 1 bytes to prevent DOS
    contents = await file.read(MAX_FILE_SIZE + 1)
    if len(contents) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="File size exceeds 10 MB limit."
        )
    
    with open(target_path, "wb") as f:
        f.write(contents)
    
    return f"http://localhost:8000/uploads/{unique_filename}"

# --- Data Models ---
class WorkerAuthRequest(BaseModel):
    pin: str = Field(..., min_length=4, max_length=10)

class VerifyTicketPayload(BaseModel):
    after_image_url: str

# --- Endpoints ---

@app.get("/api/tickets")
def list_tickets(db: sqlite3.Connection = Depends(get_db)):
    rows = db.execute("SELECT * FROM tickets ORDER BY created_at DESC").fetchall()
    return [dict(r) for r in rows]

@app.post("/api/worker/login")
@limiter.limit("5/minute")
def worker_login(request: Request, body: WorkerAuthRequest):
    if not verify_pin(body.pin, WORKER_PIN_HASH):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid worker passkey.")
    return {"authenticated": True, "token": "worker-session-active"}

@app.post("/api/tickets/new")
@limiter.limit("10/minute")
async def create_ticket(
    request: Request,
    location: str = Form(..., min_length=2, max_length=150),
    description: str = Form(..., min_length=5, max_length=1000),
    image: UploadFile = File(...),
    db: sqlite3.Connection = Depends(get_db)
):
    saved_url = await save_upload(image)
    ticket_id = uuid.uuid4().hex[:8]
    created_at = datetime.utcnow().isoformat() + "Z"

    record = {
        "id": ticket_id,
        "location": location.strip(),
        "description": description.strip(),
        "before_image_url": saved_url,
        "status": "PENDING",
        "ai_confidence_score": None,
        "after_image_url": None,
        "created_at": created_at
    }

    db.execute('''
        INSERT INTO tickets 
        (id, location, description, before_image_url, status, ai_confidence_score, after_image_url, created_at)
        VALUES (:id, :location, :description, :before_image_url, :status, :ai_confidence_score, :after_image_url, :created_at)
    ''', record)
    db.commit()

    return record

@app.post("/api/tickets/{ticket_id}/verify")
@limiter.limit("20/minute")
async def verify_ticket(
    request: Request,
    ticket_id: str,
    payload: VerifyTicketPayload,
    db: sqlite3.Connection = Depends(get_db)
):
    ticket = db.execute("SELECT * FROM tickets WHERE id = ?", (ticket_id,)).fetchone()
    if not ticket:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Ticket not found")

    updated = {
        "id": ticket_id,
        "after_image_url": payload.after_image_url,
        "status": "VERIFIED_RESOLVED",
        "ai_confidence_score": 94.8  # Score placeholder until Vision model integration
    }

    db.execute('''
        UPDATE tickets
        SET after_image_url = :after_image_url,
            status = :status,
            ai_confidence_score = :ai_confidence_score
        WHERE id = :id
    ''', updated)
    db.commit()

    return {**dict(ticket), **updated}

"""
OOH Survey Platform — Backend
Run: python server.py  →  http://0.0.0.0:8765

Server-deployment notes:
- Inventory root defaults to $HOME/OOH_Inventory. Deploy this process as the
  user whose home directory should hold the data (e.g. run as `admin` so this
  resolves to /home/admin/OOH_Inventory), or set OOH_INVENTORY_PATH explicitly.
- Native OS file/folder pickers have been removed — they require a desktop
  session and cannot work on a headless server. All file intake now goes
  through browser-based multipart upload (/api/upload/video) and GPS
  extraction runs against the uploaded file, not an arbitrary client path.
- CORS is left wide open (allow_origins=["*"]) to match current behavior;
"""

import os, json, shutil, base64, re, csv
from pathlib import Path
from datetime import date
from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from typing import Optional
import uvicorn

from gpmf import extract_gps_from_video

app = FastAPI(title="OOH Platform")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── Inventory root ────────────────────────────────────────────────────────
# Configurable via OOH_INVENTORY_PATH; falls back to $HOME/OOH_Inventory.

ROOT: Optional[Path] = None

def get_root() -> Path:
    if ROOT is None:
        raise HTTPException(400, "No inventory folder set.")
    return ROOT

def ensure_structure(root: Path):
    for sub in ("Videos", "GPS", "Sites"):
        (root / sub).mkdir(exist_ok=True)
    inv = root / "inventory.json"
    if not inv.exists():
        inv.write_text(json.dumps({
            "created_at": str(date.today()),
            "total_sites": 0,
            "sites": {},
            "trash": {},
        }, indent=2))

def _init_root():
    global ROOT
    env_path = os.environ.get("OOH_INVENTORY_PATH")
    ROOT = Path(env_path) if env_path else (Path.home() / "OOH_Inventory")
    ROOT.mkdir(parents=True, exist_ok=True)
    ensure_structure(ROOT)

_init_root()

# ── Folder endpoint ───────────────────────────────────────────────────────
# Read-only on a server deployment: the inventory location is fixed by
# OOH_INVENTORY_PATH / $HOME at process start, not user-selectable at runtime.

@app.get("/api/folder")
def get_folder():
    return {
        "path": str(ROOT),
        "name": ROOT.name
    }

# ── Inventory JSON ────────────────────────────────────────────────────────

@app.get("/api/inventory")
def get_inventory():
    root = get_root()
    return json.loads((root / "inventory.json").read_text())

@app.put("/api/inventory")
def put_inventory(data: dict):
    root = get_root()
    (root / "inventory.json").write_text(json.dumps(data, indent=2))
    return {"ok": True}

# ── Trash ─────────────────────────────────────────────────────────────────

class DeleteSiteFilesRequest(BaseModel):
    site_id: str

@app.post("/api/delete-site-files")
def delete_site_files(req: DeleteSiteFilesRequest):
    root = get_root()
    if not re.match(r'^SITE\d{4}$', req.site_id):
        raise HTTPException(400, "Invalid site_id format")
    site_dir = root / "Sites" / req.site_id
    if site_dir.exists():
        shutil.rmtree(site_dir)
    return {"ok": True}

# ── Upload ────────────────────────────────────────────────────────────────

@app.post("/api/upload/video")
async def upload_video(file: UploadFile = File(...)):
    root = get_root()
    # Guard against path traversal via a crafted filename (e.g. "../../etc/x").
    safe_name = Path(file.filename).name
    dest = root / "Videos" / safe_name
    CHUNK = 4 * 1024 * 1024  # 4 MB per chunk
    with open(dest, "wb") as fout:
        while True:
            chunk = await file.read(CHUNK)
            if not chunk:
                break
            fout.write(chunk)
    return {"path": f"Videos/{safe_name}", "filename": safe_name}

# ── GPS extraction (from GoPro GPMF telemetry embedded in the video) ────────
# Runs against a file that has already been uploaded into the inventory
# (Videos/<name>), not an arbitrary client-supplied filesystem path — the
# server has no visibility into the uploading browser's local disk.

class ExtractGpsRequest(BaseModel):
    video_path: str  # e.g. "Videos/myfile.mp4", as returned by /api/upload/video

@app.post("/api/extract-gps")
def extract_gps(req: ExtractGpsRequest):
    root = get_root()
    src = (root / req.video_path).resolve()
    try:
        src.relative_to(root.resolve())
    except ValueError:
        raise HTTPException(403, "Access denied")
    if not src.exists():
        raise HTTPException(400, f"Source not found: {req.video_path}")

    points = extract_gps_from_video(src)
    if not points:
        raise HTTPException(422, "No GPS telemetry found in this video. GoPro GPS must be enabled (HERO 5+).")

    dest = root / "GPS" / f"{src.stem}_extracted.csv"
    with open(dest, "w", newline="") as fout:
        w = csv.writer(fout)
        w.writerow(["timestamp", "latitude", "longitude"])
        for p in points:
            w.writerow([p["ts"], p["lat"], p["lng"]])

    return {"path": f"GPS/{dest.name}", "filename": dest.name, "points": points}

# ── Delete an uploaded video ─────────────────────────────────────────────
# Used by the frontend to clean up a video that was uploaded but had no
# usable GPS telemetry, so failed attempts don't accumulate in Videos/.

class DeleteVideoRequest(BaseModel):
    video_path: str  # e.g. "Videos/myfile.mp4"

@app.post("/api/delete-video")
def delete_video(req: DeleteVideoRequest):
    root = get_root()
    full = (root / req.video_path).resolve()
    try:
        full.relative_to(root.resolve())
    except ValueError:
        raise HTTPException(403, "Access denied")
    if full.exists() and full.is_file():
        full.unlink()
    return {"ok": True}

# ── Save image ────────────────────────────────────────────────────────────

class ImageSaveRequest(BaseModel):
    site_id: str
    filename: str
    data: str

@app.post("/api/save-image")
def save_image(req: ImageSaveRequest):
    root = get_root()
    site_dir = root / "Sites" / req.site_id
    site_dir.mkdir(parents=True, exist_ok=True)
    raw = req.data.split(",", 1)[-1]
    (site_dir / req.filename).write_bytes(base64.b64decode(raw))
    return {"path": f"Sites/{req.site_id}/{req.filename}"}

# ── Serve files ───────────────────────────────────────────────────────────

@app.get("/api/image")
def get_image(path: str):
    root = get_root()
    full = (root / path).resolve()
    try: full.relative_to(root.resolve())
    except ValueError: raise HTTPException(403, "Access denied")
    if not full.exists(): raise HTTPException(404, "Not found")
    return FileResponse(str(full))

VIDEO_CHUNK_SIZE = 1024 * 1024

def _iter_file_range(path: Path, start: int, end: int):
    with open(path, "rb") as f:
        f.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            chunk = f.read(min(VIDEO_CHUNK_SIZE, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk

@app.get("/api/video")
def get_video(path: str, request: Request):
    root = get_root()
    full = (root / path).resolve()
    try: full.relative_to(root.resolve())
    except ValueError: raise HTTPException(403, "Access denied")
    if not full.exists(): raise HTTPException(404, "Not found")

    file_size = full.stat().st_size
    range_header = request.headers.get("range")

    if not range_header:
        return StreamingResponse(
            _iter_file_range(full, 0, file_size - 1), media_type="video/mp4",
            headers={"Accept-Ranges": "bytes", "Content-Length": str(file_size)})

    m = re.match(r"bytes=(\d+)-(\d*)", range_header)
    if not m:
        raise HTTPException(416, "Invalid Range header")
    start = int(m.group(1))
    end   = int(m.group(2)) if m.group(2) else file_size - 1
    end   = min(end, file_size - 1)
    if start > end or start >= file_size:
        raise HTTPException(416, "Range Not Satisfiable",
                            headers={"Content-Range": f"bytes */{file_size}"})
    return StreamingResponse(
        _iter_file_range(full, start, end), status_code=206, media_type="video/mp4",
        headers={"Accept-Ranges": "bytes",
                 "Content-Range": f"bytes {start}-{end}/{file_size}",
                 "Content-Length": str(end - start + 1)})

@app.get("/api/health")
def health():
    return {"ok": True, "folder": str(ROOT) if ROOT else None}

# ── Run ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("\n" + "="*50)
    print("  OOH Survey Platform — Server")
    print(f"  Inventory : {ROOT}")
    print("  Address   : http://0.0.0.0:8765")
    print("="*50 + "\n")
    uvicorn.run(app, host="0.0.0.0", port=8765, log_level="warning")
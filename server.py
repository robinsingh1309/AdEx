"""
OOH Survey Platform — Local Backend
Run: python server.py  →  http://localhost:8765
"""

import os, json, shutil, base64, sys, re, csv
from pathlib import Path
from datetime import date
from fastapi import FastAPI, UploadFile, File, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from typing import Optional
import uvicorn

from gpmf import extract_gps_from_video

app = FastAPI(title="OOH Local Platform")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# ── Config persistence ────────────────────────────────────────────────────

CONFIG_FILE = Path(__file__).parent / "ooh_config.json"

def _default_folder() -> Path:
    if sys.platform == "win32":
        d_adex = Path("D:/Adex")
        if d_adex.exists():
            return d_adex / "OOH_Inventory"
    return Path.home() / "OOH_Inventory"

def _save_config(root: Path):
    CONFIG_FILE.write_text(json.dumps({"folder": str(root)}, indent=2))

def _load_config() -> Optional[Path]:
    try:
        data = json.loads(CONFIG_FILE.read_text())
        p = Path(data["folder"])
        if p.exists():
            return p
    except Exception:
        pass
    return None

# ── Inventory root ────────────────────────────────────────────────────────

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

def _init_default():
    """Load persisted folder or create the default one on first run."""
    global ROOT
    saved = _load_config()
    if saved:
        ROOT = saved
        ensure_structure(ROOT)
        return
    default = _default_folder()
    default.mkdir(parents=True, exist_ok=True)
    ensure_structure(default)
    ROOT = default
    _save_config(ROOT)

_init_default()

# ── Native OS pickers ─────────────────────────────────────────────────────

def _pick_folder_native() -> Optional[str]:
    if sys.platform == "win32":
        import subprocess
        # Helper form with TopMost=True keeps the dialog in front of Chrome
        ps = (
            "Add-Type -AssemblyName System.Windows.Forms;"
            "$h=New-Object System.Windows.Forms.Form;"
            "$h.TopMost=$true;$h.ShowInTaskbar=$false;"
            "$h.Opacity=0;$h.StartPosition='CenterScreen';$h.Show();$h.Activate();"
            "$fb=New-Object System.Windows.Forms.FolderBrowserDialog;"
            "$fb.Description='Select OOH Inventory Folder';"
            "$fb.ShowNewFolderButton=$true;"
            "$r=$fb.ShowDialog($h);$h.Dispose();"
            "if($r -eq 'OK'){Write-Output $fb.SelectedPath}"
        )
        try:
            out = subprocess.run(["powershell","-NoProfile","-Command",ps],
                                 capture_output=True, text=True, timeout=120)
        except subprocess.TimeoutExpired:
            return None
        p = out.stdout.strip()
        return p or None

    elif sys.platform == "darwin":
        import subprocess
        s = 'tell application "Finder" to set f to choose folder with prompt "Select OOH Inventory Folder"\nPOSIX path of f'
        r = subprocess.run(["osascript","-e",s], capture_output=True, text=True)
        p = r.stdout.strip().rstrip("/")
        return p or None

    else:
        import subprocess
        for cmd in [
            ["zenity","--file-selection","--directory","--title=Select OOH Inventory Folder"],
            ["kdialog","--getexistingdirectory", os.path.expanduser("~")],
        ]:
            try:
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
                if r.stdout.strip():
                    return r.stdout.strip()
            except (FileNotFoundError, subprocess.TimeoutExpired):
                continue
        return None


def _pick_file_native(title: str, filetypes: str) -> Optional[str]:
    if sys.platform == "win32":
        import subprocess
        ps = (
            "Add-Type -AssemblyName System.Windows.Forms;"
            "$h=New-Object System.Windows.Forms.Form;"
            "$h.TopMost=$true;$h.ShowInTaskbar=$false;"
            "$h.Opacity=0;$h.StartPosition='CenterScreen';$h.Show();$h.Activate();"
            "$f=New-Object System.Windows.Forms.OpenFileDialog;"
            f"$f.Title='{title}';$f.Filter='{filetypes}';$f.Multiselect=$false;"
            "$r=$f.ShowDialog($h);$h.Dispose();"
            "if($r -eq 'OK'){Write-Output $f.FileName}"
        )
        try:
            out = subprocess.run(["powershell","-NoProfile","-Command",ps],
                                 capture_output=True, text=True, timeout=120)
        except subprocess.TimeoutExpired:
            return None
        p = out.stdout.strip()
        return p or None

    elif sys.platform == "darwin":
        import subprocess
        s = f'tell application "Finder" to set f to choose file with prompt "{title}"\nPOSIX path of f'
        r = subprocess.run(["osascript","-e",s], capture_output=True, text=True)
        p = r.stdout.strip().rstrip("/")
        return p or None

    else:
        import subprocess
        for cmd in [
            ["zenity","--file-selection",f"--title={title}"],
            ["kdialog","--getopenfilename", os.path.expanduser("~")],
        ]:
            try:
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
                if r.stdout.strip():
                    return r.stdout.strip()
            except (FileNotFoundError, subprocess.TimeoutExpired):
                continue
        return None

# ── Folder endpoints ──────────────────────────────────────────────────────

@app.post("/api/pick-folder")
def pick_folder():
    global ROOT
    path = _pick_folder_native()
    if not path:
        raise HTTPException(400, "No folder selected")
    p = Path(path).resolve()
    if not p.exists():
        raise HTTPException(400, f"Folder does not exist: {p}")
    ROOT = p
    ensure_structure(ROOT)
    _save_config(ROOT)
    return {"ok": True, "path": str(ROOT), "name": ROOT.name}


class FolderRequest(BaseModel):
    path: str

@app.post("/api/set-folder")
def set_folder(req: FolderRequest):
    global ROOT
    p = Path(req.path).expanduser().resolve()
    p.mkdir(parents=True, exist_ok=True)
    ROOT = p
    ensure_structure(ROOT)
    _save_config(ROOT)
    return {"ok": True, "path": str(ROOT), "name": ROOT.name}


@app.get("/api/folder")
def get_folder():
    return {"path": str(ROOT) if ROOT else None, "name": ROOT.name if ROOT else None}

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

# ── Native file picker + local copy ──────────────────────────────────────

@app.post("/api/pick-video-file")
def pick_video_file():
    path = _pick_file_native("Select Survey Video",
                             "Video Files|*.mp4;*.mov;*.avi;*.mkv;*.MP4;*.MOV|All Files|*.*")
    if not path:
        raise HTTPException(400, "No file selected")
    p = Path(path)
    if not p.exists():
        raise HTTPException(400, f"File not found: {p}")
    return {"path": str(p), "name": p.name}


class CopyVideoRequest(BaseModel):
    src: str

@app.post("/api/copy-video")
def copy_video(req: CopyVideoRequest):
    root = get_root()
    src = Path(req.src)
    if not src.exists():
        raise HTTPException(400, f"Source not found: {src}")
    dest = root / "Videos" / src.name
    shutil.copy2(str(src), str(dest))
    return {"path": f"Videos/{src.name}", "filename": src.name}


# ── Upload (direct — clients should call http://localhost:8765 to skip proxy) ──

@app.post("/api/upload/video")
async def upload_video(file: UploadFile = File(...)):
    root = get_root()
    dest = root / "Videos" / file.filename
    CHUNK = 4 * 1024 * 1024  # 4 MB per chunk
    with open(dest, "wb") as fout:
        while True:
            chunk = await file.read(CHUNK)
            if not chunk:
                break
            fout.write(chunk)
    return {"path": f"Videos/{file.filename}", "filename": file.filename}

# ── GPS extraction (from GoPro GPMF telemetry embedded in the video) ────────
# Runs directly against the original picked file (before it's copied into the
# inventory) so a "no GPS" failure surfaces in seconds instead of after a
# multi-minute copy of a multi-GB video. Same arbitrary-local-path trust model
# as /api/copy-video — no root confinement, since it's read-only.

class ExtractGpsRequest(BaseModel):
    src: str

@app.post("/api/extract-gps")
def extract_gps(req: ExtractGpsRequest):
    root = get_root()
    src = Path(req.src)
    if not src.exists():
        raise HTTPException(400, f"Source not found: {src}")

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
    print("  OOH Survey Platform — Local Server")
    print(f"  Inventory : {ROOT}")
    print("  Address   : http://localhost:8765")
    print("="*50 + "\n")
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")

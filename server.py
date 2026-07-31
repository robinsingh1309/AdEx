"""
OOH Survey Platform — Local Backend
Run: python server.py  →  http://localhost:8765
"""

import os, json, shutil, base64, sys, re, csv
from pathlib import Path
from datetime import date
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel
from typing import Optional
import uvicorn

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
    for sub in ("GPS", "Sites"):
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

# ── Save GPS (already extracted client-side from the video's GPMF telemetry) ──
# The video itself is never sent to the server — only these small extracted
# points, kept purely as a record under GPS/.

class SaveGpsRequest(BaseModel):
    name: str
    points: list[dict]

@app.post("/api/save-gps")
def save_gps(req: SaveGpsRequest):
    root = get_root()
    safe_stem = re.sub(r'[^A-Za-z0-9_-]', '_', Path(req.name).stem) or "survey"
    dest = root / "GPS" / f"{safe_stem}_extracted.csv"
    with open(dest, "w", newline="") as fout:
        w = csv.writer(fout)
        w.writerow(["timestamp", "latitude", "longitude"])
        for p in req.points:
            w.writerow([p.get("ts"), p.get("lat"), p.get("lng")])
    return {"ok": True, "path": f"GPS/{dest.name}"}

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

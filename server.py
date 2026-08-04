"""
OOH Survey Platform — Local Backend
Run: python server.py  →  http://localhost:8765
"""

import os, json, shutil, base64, sys, re, csv
import threading
from functools import lru_cache
from dotenv import load_dotenv
from pathlib import Path
from datetime import date, datetime, timezone
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from typing import Optional
from botocore.config import Config
import boto3
import uvicorn

load_dotenv(Path(__file__).parent / ".env.local")

app = FastAPI(title="OOH Local Platform")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

ARCHIVE_AFTER_DAYS = 60
ARCHIVE_WORKER_INTERVAL_SECONDS = 3600
_ARCHIVE_WORKER_THREAD = None
_ARCHIVE_WORKER_STOP = threading.Event()

# ── Config persistence ────────────────────────────────────────────────────

CONFIG_FILE = Path(__file__).parent / "ooh_config.json"

def _load_config_data() -> dict:
    try:
        data = json.loads(CONFIG_FILE.read_text())
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}

def _default_folder() -> Path:
    if sys.platform == "win32":
        d_adex = Path("D:/Adex")
        if d_adex.exists():
            return d_adex / "OOH_Inventory"
    return Path.home() / "OOH_Inventory"

def _save_config(root: Path):
    data = _load_config_data()
    data["folder"] = str(root)
    CONFIG_FILE.write_text(json.dumps(data, indent=2))

def _load_config() -> Optional[Path]:
    try:
        data = _load_config_data()
        folder = data.get("folder")
        if isinstance(folder, str):
            p = Path(folder)
            if p.exists():
                return p
    except Exception:
        pass
    return None

def _lookup_config_value(data: dict, nested_keys: list[str], flat_key: str, env_name: str,
        default: Optional[str] = None) -> Optional[str]:
    # Env first so secrets in environment always win over file values.
    value = os.getenv(env_name)

    if value is None:
        nested_value = data
        for key in nested_keys:
            if not isinstance(nested_value, dict):
                nested_value = None
                break
            nested_value = nested_value.get(key)
        value = nested_value

    if value is None and isinstance(data, dict):
        value = data.get(flat_key)

    if isinstance(value, str):
        value = value.strip()
        if not value:
            return default

    return default if value is None else value


def _cloud_settings() -> dict:
    data = _load_config_data()
    return {
        "cloud_name": _lookup_config_value(data, ["cloud", "name"], "cloud.name", "CLOUD_NAME", "AWS"),
        "cloud_type": _lookup_config_value(data, ["cloud", "type"], "cloud.type", "CLOUD_TYPE", "AWS"),
        "bucket_name": _lookup_config_value(data, ["cloud", "bucket_name"], "cloud.bucket.name", "S3_BUCKET_NAME"),
        "access_key": _lookup_config_value(data, ["cloud", "access_key"], "cloud.access.key", "AWS_ACCESS_KEY_ID"),
        "secret_key": _lookup_config_value(data, ["cloud", "secret_key"], "cloud.secret.key", "AWS_SECRET_ACCESS_KEY"),
        "region": _lookup_config_value(data, ["cloud", "region"], "cloud.region", "AWS_DEFAULT_REGION"),
        "endpoint_url": _lookup_config_value(data, ["cloud", "endpoint_url"], "cloud.endpoint.url", "AWS_ENDPOINT_URL"),
        "media_prefix": _lookup_config_value(data, ["cloud", "media_prefix"], "cloud.media.prefix", "S3_MEDIA_PREFIX", "Sites"),
        "hidden_media_prefix": _lookup_config_value(data, ["cloud", "hidden_media_prefix"], "cloud.hidden.media.prefix", "S3_HIDDEN_MEDIA_PREFIX", "Hidden"),
    }


def _cloud_enabled() -> bool:
    settings = _cloud_settings()
    return bool(settings["bucket_name"] and settings["access_key"] and settings["secret_key"])


@lru_cache(maxsize=1)
def _s3_client():
    settings = _cloud_settings()
    if not _cloud_enabled():
        raise HTTPException(400, "Cloud storage is not configured.")

    client_kwargs = {
        "aws_access_key_id": settings["access_key"],
        "aws_secret_access_key": settings["secret_key"],
        "config": Config(signature_version="s3v4"),
    }
    if settings["region"]:
        client_kwargs["region_name"] = settings["region"]
    if settings["endpoint_url"]:
        client_kwargs["endpoint_url"] = settings["endpoint_url"]

    return boto3.client("s3", **client_kwargs)


def _image_object_key(site_id: str, filename: str) -> str:
    if not re.match(r'^SITE\d{4}$', site_id):
        raise HTTPException(400, "Invalid site_id format")

    safe_filename = Path(filename).name.strip()
    if not safe_filename:
        raise HTTPException(400, "Invalid filename")

    settings = _cloud_settings()
    return f"{settings['media_prefix'].rstrip('/')}/{site_id}/{safe_filename}"


def _hide_site_media(site_id: str) -> dict:
    settings = _cloud_settings()
    source_prefix = f"{settings['media_prefix'].rstrip('/')}/{site_id}/"
    hidden_prefix = settings["hidden_media_prefix"].rstrip("/")

    client = _s3_client()
    bucket_name = settings["bucket_name"]
    paginator = client.get_paginator("list_objects_v2")

    scanned_count = 0
    hidden_count = 0

    for page in paginator.paginate(Bucket=bucket_name, Prefix=source_prefix):
        for item in page.get("Contents", []):
            scanned_count += 1
            object_key = item["Key"]
            relative_key = object_key[len(source_prefix):]
            if not relative_key:
                continue

            hidden_key = f"{hidden_prefix}/{site_id}/{relative_key}"
            client.copy_object(
                Bucket=bucket_name,
                CopySource={"Bucket": bucket_name, "Key": object_key},
                Key=hidden_key,
            )
            hidden_count += 1

    return {
        "site_id": site_id,
        "scanned_count": scanned_count,
        "deleted_count": 0,
        "hidden_count": hidden_count,
        "source_prefix": source_prefix,
    }


def _presigned_get_url(object_key: str) -> str:
    settings = _cloud_settings()
    return _s3_client().generate_presigned_url(
        "get_object",
        Params={"Bucket": settings["bucket_name"], "Key": object_key},
        ExpiresIn=900,
    )


def _parse_iso_date(value: str):
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value).date()
    except Exception:
        return None


def _archive_surveys_in_site(site: dict, archived_at_iso: str) -> int:
    surveys = site.get("surveys", []) if isinstance(site, dict) else []
    changed = 0
    for survey in surveys:
        if not isinstance(survey, dict):
            continue
        if survey.get("isArchived", False):
            continue
        survey["isArchived"] = True
        survey["archivedAt"] = archived_at_iso
        changed += 1

    if isinstance(site, dict):
        site["isArchived"] = True

    return changed


def _auto_archive_old_trash_surveys_once() -> int:
    inventory = get_inventory_json()
    trash = inventory.get("trash", {})
    if not isinstance(trash, dict):
        return 0

    now_utc = datetime.now(timezone.utc)
    today = now_utc.date()
    changed_count = 0

    for site in trash.values():
        if not isinstance(site, dict):
            continue

        deleted_on = _parse_iso_date(site.get("deleted_at", ""))
        if deleted_on is None:
            continue

        if (today - deleted_on).days > ARCHIVE_AFTER_DAYS:
            changed_count += _archive_surveys_in_site(site, now_utc.isoformat())

    if changed_count > 0:
        save_inventory_json(inventory)

    return changed_count


def _archive_worker_loop():
    while not _ARCHIVE_WORKER_STOP.is_set():
        try:
            _auto_archive_old_trash_surveys_once()
        except Exception:
            # Worker errors should not crash the API process.
            pass
        _ARCHIVE_WORKER_STOP.wait(ARCHIVE_WORKER_INTERVAL_SECONDS)

def get_inventory_json():
    root = get_root()
    return json.loads((root / "inventory.json").read_text())


def save_inventory_json(data):
    root = get_root()
    (root / "inventory.json").write_text(
        json.dumps(data, indent=2)
    )

# ── Inventory root ────────────────────────────────────────────────────────

ROOT: Optional[Path] = None

def get_root() -> Path:
    if ROOT is None:
        raise HTTPException(400, "No inventory folder set.")
    return ROOT

def ensure_structure(root: Path):
    # Removed "Sites" directory creation
    (root / "GPS").mkdir(exist_ok=True)
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
    return get_inventory_json()

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
    if not re.match(r'^SITE\d{4}$', req.site_id):
        raise HTTPException(400, "Invalid site_id format")

    if not _cloud_enabled():
        raise HTTPException(400, "Cloud storage is not configured.")

    # Hide all media objects under the site prefix, never delete from S3.
    result = _hide_site_media(req.site_id)
    inventory = get_inventory_json()

    if not inventory.get("hidden_sites") or not isinstance(inventory.get("hidden_sites"), dict):
        inventory["hidden_sites"] = {}

    archived_at = datetime.now(timezone.utc).isoformat()
    archived_survey_count = 0
    trash_site = inventory.get("trash", {}).get(req.site_id) if isinstance(inventory.get("trash"), dict) else None
    if isinstance(trash_site, dict):
        archived_survey_count = _archive_surveys_in_site(trash_site, archived_at)

    hidden_site = {
        "site_id": req.site_id,
        "hidden_at": archived_at,
        "policy": "hide_only",
        "archivedSurveyCount": archived_survey_count,
    }
    inventory["hidden_sites"][req.site_id] = hidden_site
    save_inventory_json(inventory)

    return {"ok": True, **result, "hidden_site": hidden_site}

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
    # Ensure cloud storage is active; refuse to save locally
    if not _cloud_enabled():
        raise HTTPException(
            status_code=400,
            detail="Cloud storage (S3) is not configured. Local saving is disabled."
        )

    raw = req.data.split(",", 1)[-1]
    object_key = _image_object_key(req.site_id, req.filename)
    body = base64.b64decode(raw)

    content_type = None
    if req.data.startswith("data:") and ";base64," in req.data:
        content_type = req.data[5:req.data.index(";base64,")]

    put_kwargs = {
        "Bucket": _cloud_settings()["bucket_name"],
        "Key": object_key,
        "Body": body,
    }
    if content_type:
        put_kwargs["ContentType"] = content_type

    _s3_client().put_object(**put_kwargs)

    inventory = get_inventory_json()
    site = inventory["sites"].get(req.site_id)

    if site:

        if "images" not in site:
            site["images"] = []

        site["images"].append({
            "path": object_key,
            "uploadedAt": datetime.now(timezone.utc).isoformat()
        })

    save_inventory_json(inventory)

    return {"path": object_key}

# ── Serve files ───────────────────────────────────────────────────────────

@app.get("/api/image")
def get_image(path: str):
    if not _cloud_enabled():
        raise HTTPException(400, "Cloud storage is not configured.")

    clean_path = path.lstrip("/")
    if not clean_path or ".." in Path(clean_path).parts:
        raise HTTPException(403, "Access denied")

    inventory = get_inventory_json()
    hidden_sites = inventory.get("hidden_sites", {})

    settings = _cloud_settings()
    media_prefix = settings["media_prefix"].rstrip("/") + "/"
    hidden_prefix = settings["hidden_media_prefix"].rstrip("/") + "/"

    if clean_path.startswith(hidden_prefix):
        raise HTTPException(404, "Media is hidden")

    if clean_path.startswith(media_prefix):
        relative_path = clean_path[len(media_prefix):]
        site_id = relative_path.split("/", 1)[0] if relative_path else ""
        if site_id and site_id in hidden_sites:
            raise HTTPException(404, "Media is hidden")

    return RedirectResponse(_presigned_get_url(clean_path), status_code=302)

@app.get("/api/health")
def health():
    return {"ok": True, "folder": str(ROOT) if ROOT else None}


@app.on_event("startup")
def _start_archive_worker():
    global _ARCHIVE_WORKER_THREAD
    _ARCHIVE_WORKER_STOP.clear()
    _auto_archive_old_trash_surveys_once()
    if _ARCHIVE_WORKER_THREAD and _ARCHIVE_WORKER_THREAD.is_alive():
        return
    _ARCHIVE_WORKER_THREAD = threading.Thread(target=_archive_worker_loop, daemon=True)
    _ARCHIVE_WORKER_THREAD.start()


@app.on_event("shutdown")
def _stop_archive_worker():
    _ARCHIVE_WORKER_STOP.set()

# ── Run ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("\n" + "="*50)
    print("  OOH Survey Platform — Local Server")
    print(f"  Inventory : {ROOT}")
    print("  Address   : http://localhost:8765")
    print("="*50 + "\n")
    uvicorn.run(app, host="127.0.0.1", port=8765, log_level="warning")

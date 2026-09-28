#!/usr/bin/env python3
"""
Elscione Light Novel Ingestion Helper CLI

Uses curl_cffi with chrome131 impersonation to:
1. Bypass Cloudflare TLS fingerprinting and challenge barriers.
2. Solve Anubis Proof-of-Work (PoW) SHA-256 challenges automatically.
3. Query _h5ai directory API for series folder manifests.
4. Strictly filter folder items to avoid mixing parent/sibling series.
5. Provide generalized volume parsing across standard and complex LN naming schemes.
6. Stream EPUB files directly to disk with integrity validation.

Usage:
    python3 uploader/scripts/elscione_helper.py manifest "<url>"
    python3 uploader/scripts/elscione_helper.py download "<file_url>" "<dest_path>"
"""

import contextlib
import hashlib
import json
import os
import posixpath
import re
import sys
import time
from typing import TYPE_CHECKING
from urllib.parse import quote, unquote, urljoin, urlsplit

if TYPE_CHECKING:
    from curl_cffi import requests

MAX_EPUB_BYTES = 500 * 1024 * 1024  # 500 MB
MAX_VOLUMES_PER_REQUEST = 50
SUBPROCESS_TIMEOUT = 30
DOWNLOAD_TIMEOUT = 300  # 5 minutes for streaming large EPUBs

ALLOWED_HOSTS = {"server.elscione.com", "elscione.com"}
ALLOWED_HOST_SUFFIX = ".elscione.com"


def assert_elscione_host(hostname: str) -> None:
    """
    SSRF guard: verifies that target host is strictly server.elscione.com or *.elscione.com.
    """
    h = (hostname or "").lower().rstrip(".")
    if h not in ALLOWED_HOSTS and not h.endswith(ALLOWED_HOST_SUFFIX):
        raise RuntimeError(f"Refusing non-Elscione host: {hostname}")


def safe_unquote(path_str: str) -> str:
    """
    Safe unquote that never throws on malformed percent sequences.
    """
    if not path_str:
        return ""
    try:
        return unquote(path_str)
    except Exception:
        return path_str


def normalize_elscione_url(url: str) -> dict:
    """
    Normalizes any Elscione URL variation (quotes, spaces, encoded %27, trailing slashes).
    """
    clean = url.strip()
    if clean.startswith("//"):
        clean = "https:" + clean
    elif not clean.startswith("http://") and not clean.startswith("https://"):
        clean = "https://" + clean.lstrip("/")

    parts = urlsplit(clean)
    hostname = parts.netloc.lower()
    assert_elscione_host(hostname)

    unquoted_path = safe_unquote(parts.path)
    is_epub = unquoted_path.lower().endswith(".epub")
    if not is_epub and not unquoted_path.endswith("/"):
        unquoted_path += "/"

    # Standard browser quoting: safe='/'
    normalized_path = quote(unquoted_path, safe="/")
    canonical_url = f"{parts.scheme}://{hostname}{normalized_path}"

    segments = [s for s in unquoted_path.split("/") if s]
    if is_epub:
        filename = segments[-1]
        series_title = segments[-2] if len(segments) >= 2 else "Light Novel"
        folder_path = "/" + "/".join(segments[:-1]) + "/"
    else:
        filename = None
        series_title = segments[-1] if segments else "Light Novel"
        folder_path = unquoted_path

    return {
        "canonical_url": canonical_url,
        "hostname": hostname,
        "is_epub": is_epub,
        "filename": filename,
        "folder_path": folder_path,
        "series_title": series_title,
    }


def _safe_parse_num(val_str: str):
    if not val_str:
        return None
    try:
        return float(val_str) if "." in val_str else int(val_str)
    except (ValueError, TypeError):
        return None


def parse_volume_info(filename: str) -> dict:
    """
    Generalized volume parser for light novel filenames:
    - Volume 01, Volume 14.5
    - v01, v02, v1
    - Vol. 04, Vol 4
    - Part X Volume Y (e.g. Part 1 Volume 2, Part 1 Daughter of a Soldier v02)
    - Book 3, #02, - 01 -
    - Trailing numbers
    """
    name = re.sub(r"\.epub$", "", filename, flags=re.IGNORECASE).strip()

    # 1. Part X ... Volume Y or Part X ... vY (e.g. "Part 1 Volume 2" or "Part 1 Daughter of a Soldier v02")
    m_part = re.search(
        r"Part\s*(\d+).*?(?:Volume|Vol\.?|v)\s*(\d+(?:\.\d+)?)",
        name,
        re.IGNORECASE,
    )
    if m_part:
        part_num = _safe_parse_num(m_part.group(1))
        vol_num = _safe_parse_num(m_part.group(2))
        if vol_num is not None:
            part_int = None
            if part_num is not None:
                try:
                    part_int = int(part_num)
                except (ValueError, TypeError):
                    part_int = None
            return {"part": part_int, "volume": vol_num}

    # 2. Volume / Vol / Book (e.g. "Volume 01", "Vol. 4.5", "Book 3")
    m_vol = re.search(
        r"(?:vol(?:ume)?|book)\.?\s*(\d+(?:\.\d+)?)",
        name,
        re.IGNORECASE,
    )
    if m_vol:
        vol_num = _safe_parse_num(m_vol.group(1))
        if vol_num is not None:
            return {"part": None, "volume": vol_num}

    # 3. v(\d+) (e.g. "Series v01.epub" or "Series - v02.epub")
    m_v = re.search(
        r"(?:^|[\s_\-\[\(])v(\d+(?:\.\d+)?)(?:$|[\s_\-\]\)])",
        name,
        re.IGNORECASE,
    )
    if m_v:
        vol_num = _safe_parse_num(m_v.group(1))
        if vol_num is not None:
            return {"part": None, "volume": vol_num}

    # 4. #01
    m_hash = re.search(r"#\s*(\d+(?:\.\d+)?)", name)
    if m_hash:
        vol_num = _safe_parse_num(m_hash.group(1))
        if vol_num is not None:
            return {"part": None, "volume": vol_num}

    # 5. " - 01" or " - 01 - "
    m_dash = re.search(r"(?:^|\s)-\s*(\d+(?:\.\d+)?)(?:\s|-|$)", name)
    if m_dash:
        vol_num = _safe_parse_num(m_dash.group(1))
        if vol_num is not None:
            return {"part": None, "volume": vol_num}

    # 6. Trailing number
    m_tail = re.search(r"\b(\d+(?:\.\d+)?)\s*$", name)
    if m_tail:
        vol_num = _safe_parse_num(m_tail.group(1))
        if vol_num is not None:
            return {"part": None, "volume": vol_num}

    return {"part": None, "volume": None}


def parse_anubis_challenge(html: str) -> dict | None:
    """
    Extracts Anubis challenge rules & payload from HTML.
    Supports both nested { rules: { difficulty }, challenge: { id, randomData } }
    and flat { id, randomData, difficulty } JSON.
    """
    if not html:
        return None

    m = re.search(
        r'<script[^>]*id=["\']anubis_challenge["\'][^>]*>([\s\S]*?)</script>',
        html,
        re.IGNORECASE,
    )
    if not m:
        m = re.search(
            r'<script[^>]*type=["\']application/json["\'][^>]*id=["\']anubis_challenge["\'][^>]*>([\s\S]*?)</script>',
            html,
            re.IGNORECASE,
        )
    if not m:
        return None

    try:
        data = json.loads(m.group(1).strip())
        ch = data.get("challenge", data) if isinstance(data, dict) else {}
        cid = ch.get("id") or data.get("id")
        random_data = ch.get("randomData") or data.get("randomData")
        raw_difficulty = None
        if isinstance(data.get("rules"), dict) and "difficulty" in data["rules"]:
            raw_difficulty = data["rules"]["difficulty"]
        elif "difficulty" in ch:
            raw_difficulty = ch["difficulty"]
        elif "difficulty" in data:
            raw_difficulty = data["difficulty"]

        parsed_diff = _safe_parse_num(str(raw_difficulty)) if raw_difficulty is not None else 2
        difficulty = int(parsed_diff) if parsed_diff is not None else 2

        if cid and random_data:
            return {
                "id": str(cid),
                "randomData": str(random_data),
                "difficulty": difficulty,
            }
    except (json.JSONDecodeError, ValueError, TypeError):
        return None
    return None


def solve_anubis_challenge(challenge: dict) -> dict:
    """
    Fast SHA-256 loop: sha256(randomData + nonce) with leading zero half-bytes.
    """
    cid = challenge["id"]
    random_data = challenge["randomData"]
    raw_diff = challenge.get("difficulty", 2)
    try:
        parsed_diff = int(raw_diff)
    except (ValueError, TypeError):
        parsed_diff = 2
    difficulty = max(0, min(64, parsed_diff))
    target_prefix = "0" * difficulty
    start_time = time.time()
    nonce = 0
    max_nonce = 50_000_000
    h = ""

    while nonce < max_nonce:
        h = hashlib.sha256((random_data + str(nonce)).encode("utf-8")).hexdigest()
        if h.startswith(target_prefix):
            break
        nonce += 1

    if nonce >= max_nonce or not h.startswith(target_prefix):
        raise RuntimeError("Anubis challenge solving exceeded maximum nonce limit")

    try:
        elapsed_ms = int((time.time() - start_time) * 1000)
    except (ValueError, TypeError):
        elapsed_ms = 0
    return {
        "id": cid,
        "hash": h,
        "nonce": nonce,
        "elapsedTime": elapsed_ms,
    }


def submit_anubis_solution(session: requests.Session, base_url: str, solution: dict, redir_path: str):
    """
    Submits solved challenge to /.within.website/x/cmd/anubis/api/pass-challenge
    capturing authorized authentication cookies.
    """
    parsed = urlsplit(base_url)
    assert_elscione_host(parsed.netloc)
    pass_url = f"{parsed.scheme}://{parsed.netloc}/.within.website/x/cmd/anubis/api/pass-challenge"
    params = {
        "id": solution["id"],
        "response": solution["hash"],
        "nonce": str(solution["nonce"]),
        "redir": redir_path or "/",
        "elapsedTime": str(solution["elapsedTime"]),
    }
    headers = {
        "Referer": base_url,
    }
    return session.get(pass_url, params=params, headers=headers, allow_redirects=False, timeout=SUBPROCESS_TIMEOUT)


def ensure_authenticated_session(session: requests.Session, target_url: str, max_rounds: int = 3):
    """
    Checks if target URL triggers an Anubis challenge and solves it.
    """
    parsed_target = urlsplit(target_url)
    assert_elscione_host(parsed_target.netloc)

    for _ in range(max_rounds):
        res = session.get(target_url, allow_redirects=False, timeout=SUBPROCESS_TIMEOUT)

        # Handle same-origin redirect
        if res.status_code in (301, 302, 303, 307, 308):
            loc = res.headers.get("location") or ""
            target_url = urljoin(target_url, loc)
            parsed_loc = urlsplit(target_url)
            assert_elscione_host(parsed_loc.netloc)
            continue

        challenge = parse_anubis_challenge(res.text)
        if not challenge:
            return res
        solution = solve_anubis_challenge(challenge)
        parsed = urlsplit(target_url)
        redir_path = parsed.path if parsed.path else "/"
        submit_anubis_solution(session, target_url, solution, redir_path)

    return session.get(target_url, allow_redirects=False, timeout=SUBPROCESS_TIMEOUT)


def create_session():
    """
    Creates an impersonated Chrome 131 session with fallback proxy support.
    """
    try:
        from curl_cffi import requests
    except ImportError:
        sys.stderr.write(
            "Error: curl_cffi is required for Elscione network operations. "
            "Install with 'pip3 install curl_cffi'.\n"
        )
        sys.exit(1)

    session = requests.Session(impersonate="chrome131")
    proxy_url = os.environ.get("PROXY_URL") or os.environ.get("HTTP_PROXY")
    if proxy_url:
        session.proxies = {"http": proxy_url, "https": proxy_url}
    return session


def cmd_manifest(url: str):
    norm = normalize_elscione_url(url)
    session = create_session()

    # 1. Direct .epub file URL
    if norm["is_epub"] and norm["filename"]:
        vol_info = parse_volume_info(norm["filename"])
        vol_num = vol_info["volume"] if vol_info["volume"] is not None else 1
        part_num = vol_info["part"]
        series_title = norm["series_title"]

        if part_num is not None:
            title = f"{series_title}: Part {part_num} Volume {vol_num}"
        else:
            title = f"{series_title}: Volume {vol_num}"

        manifest = {
            "success": True,
            "seriesTitle": series_title,
            "url": norm["canonical_url"],
            "isSingleVolume": True,
            "totalCount": 1,
            "volumes": [
                {
                    "volumeNumber": vol_num,
                    "partNumber": part_num,
                    "filename": norm["filename"],
                    "downloadUrl": norm["canonical_url"],
                    "title": title,
                }
            ],
        }
        print(json.dumps(manifest, indent=2))
        return 0

    # 2. Series folder URL: Query _h5ai
    folder_url = norm["canonical_url"]
    folder_path = norm["folder_path"]
    series_title = norm["series_title"]

    ensure_authenticated_session(session, folder_url)

    post_url = folder_url + "?"
    payload = json.dumps({
        "action": "get",
        "items": {
            "href": folder_path,
            "what": 1,
        },
    })
    headers = {
        "Content-Type": "application/json;charset=utf-8",
        "Accept": "application/json, text/plain, */*",
        "Referer": folder_url,
    }

    res = session.post(post_url, headers=headers, data=payload, allow_redirects=False, timeout=SUBPROCESS_TIMEOUT)
    if res.status_code == 403 or "anubis_challenge" in res.text:
        ensure_authenticated_session(session, folder_url)
        res = session.post(post_url, headers=headers, data=payload, allow_redirects=False, timeout=SUBPROCESS_TIMEOUT)

    if res.status_code != 200:
        raise RuntimeError(f"Failed to fetch directory manifest from Elscione ({res.status_code}): {folder_url}")

    try:
        body_json = res.json()
    except Exception as err:
        raise RuntimeError(f"Failed to parse _h5ai JSON response: {err}") from err

    raw_items = []
    items_container = body_json.get("items") or (body_json.get("data") or {}).get("items")
    if isinstance(items_container, list):
        raw_items = items_container
    elif isinstance(items_container, dict):
        raw_items = list(items_container.values())

    unquoted_target = safe_unquote(folder_path)
    norm_target = posixpath.normpath(unquoted_target).rstrip("/") + "/"

    parsed_parts = urlsplit(folder_url)
    origin = f"{parsed_parts.scheme}://{parsed_parts.netloc}"

    numbered_items = []
    unnumbered_items = []

    for item in raw_items:
        raw_href = item.get("href") or item.get("name")
        if not raw_href or not isinstance(raw_href, str):
            continue
        if not raw_href.lower().endswith(".epub"):
            continue

        unquoted_raw = safe_unquote(raw_href)
        # Normalize relative or absolute href against target folder
        if unquoted_raw.startswith("/"):
            abs_unquoted = posixpath.normpath(unquoted_raw)
        else:
            abs_unquoted = posixpath.normpath(posixpath.join(norm_target, unquoted_raw))

        # Strict folder scoping check: must reside inside normalized target folder
        if not abs_unquoted.startswith(norm_target):
            continue

        filename = posixpath.basename(abs_unquoted)
        vol_info = parse_volume_info(filename)
        vol_num = vol_info["volume"]
        part_num = vol_info["part"]

        download_url = f"{origin}{quote(abs_unquoted, safe='/')}"

        item_info = {
            "part": part_num,
            "volNum": vol_num,
            "filename": filename,
            "downloadUrl": download_url,
            "size": item.get("size") if isinstance(item.get("size"), int) else None,
        }

        if vol_num is not None:
            numbered_items.append(item_info)
        else:
            unnumbered_items.append(item_info)

    total_found = len(numbered_items) + len(unnumbered_items)
    if total_found == 0:
        raise RuntimeError(f"No EPUB volumes found in Elscione folder: {folder_url}")

    # Sort numbered items by (part, volumeNumber, filename)
    numbered_items.sort(
        key=lambda x: (
            x["part"] if x["part"] is not None else 0,
            x["volNum"] if x["volNum"] is not None else 0,
            x["filename"],
        )
    )

    # Sort unnumbered items alphabetically
    unnumbered_items.sort(key=lambda x: x["filename"])

    volumes = []
    for item in numbered_items:
        if item["part"] is not None:
            title = f"{series_title}: Part {item['part']} Volume {item['volNum']}"
        else:
            title = f"{series_title}: Volume {item['volNum']}"

        volumes.append({
            "volumeNumber": item["volNum"],
            "partNumber": item["part"],
            "filename": item["filename"],
            "downloadUrl": item["downloadUrl"],
            "title": title,
            "size": item["size"],
        })

    max_numbered = max([item["volNum"] for item in numbered_items]) if numbered_items else 0
    try:
        next_index = int(max_numbered) + 1
    except (ValueError, TypeError):
        next_index = 1

    for item in unnumbered_items:
        clean_base = re.sub(r"\.epub$", "", item["filename"], flags=re.IGNORECASE).strip()
        volumes.append({
            "volumeNumber": next_index,
            "partNumber": None,
            "filename": item["filename"],
            "downloadUrl": item["downloadUrl"],
            "title": f"{series_title}: Volume {next_index} ({clean_base})",
            "size": item["size"],
        })
        next_index += 1

    if len(volumes) > MAX_VOLUMES_PER_REQUEST:
        sys.stderr.write(
            f"[ElscioneHelper] Truncating {len(volumes)} volumes to MAX_VOLUMES_PER_REQUEST ({MAX_VOLUMES_PER_REQUEST})\n"
        )
        volumes = volumes[:MAX_VOLUMES_PER_REQUEST]

    manifest = {
        "success": True,
        "seriesTitle": series_title,
        "url": folder_url,
        "isSingleVolume": False,
        "totalCount": len(volumes),
        "volumes": volumes,
    }
    print(json.dumps(manifest, indent=2))
    return 0


def validate_destination_path(dest_path: str) -> str:
    """
    Validates destination path against null bytes, traversal, and system roots.
    """
    if not dest_path or "\0" in dest_path:
        raise RuntimeError("Invalid destination path: contains null bytes or empty")
    real = os.path.realpath(os.path.abspath(dest_path))
    if not real.lower().endswith(".epub"):
        raise RuntimeError("Destination path must have .epub extension")
    parent = os.path.dirname(real)
    if parent in ("/", "/etc", "/bin", "/sbin", "/usr", "/usr/bin", "/System"):
        raise RuntimeError(f"Refusing to write to protected system directory: {parent}")
    return real


def cmd_download(file_url: str, dest_path: str):
    validated_dest = validate_destination_path(dest_path)
    norm = normalize_elscione_url(file_url)
    canonical_file_url = norm["canonical_url"]
    parsed = urlsplit(canonical_file_url)
    assert_elscione_host(parsed.netloc)
    folder_url = f"{parsed.scheme}://{parsed.netloc}{quote(norm['folder_path'], safe='/')}"

    headers = {
        "Referer": folder_url,
        "Accept": "*/*",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1",
    }

    dest_dir = os.path.dirname(validated_dest)
    if dest_dir:
        try:
            os.makedirs(dest_dir, exist_ok=True)
        except OSError as err:
            raise RuntimeError(f"Failed to create directory {dest_dir}: {err}") from err

    max_attempts = 3
    last_err = None

    for attempt in range(1, max_attempts + 1):
        temp_dest = validated_dest + f".tmp.{os.getpid()}.{attempt}"
        session = create_session()

        try:
            if attempt > 1:
                backoff_sec = min(5, 2 ** (attempt - 2))
                time.sleep(backoff_sec)

            # Authenticate on folder first
            ensure_authenticated_session(session, folder_url)

            res = session.get(
                canonical_file_url,
                headers=headers,
                stream=True,
                allow_redirects=True,
                timeout=DOWNLOAD_TIMEOUT,
            )

            # Assert final landing URL stays on allowed Elscione host
            if getattr(res, "url", None):
                assert_elscione_host(urlsplit(res.url).netloc)

            # Check for challenge or non-EPUB HTML response
            content_type = (res.headers.get("content-type") or "").lower()
            if res.status_code == 403 or "text/html" in content_type:
                ensure_authenticated_session(session, folder_url)
                res = session.get(
                    canonical_file_url,
                    headers=headers,
                    stream=True,
                    allow_redirects=True,
                    timeout=DOWNLOAD_TIMEOUT,
                )
                if getattr(res, "url", None):
                    assert_elscione_host(urlsplit(res.url).netloc)

            if res.status_code != 200:
                raise RuntimeError(f"Failed to download EPUB (HTTP {res.status_code}): {canonical_file_url}")

            content_length = res.headers.get("content-length")
            total_bytes = 0
            if content_length and content_length.isdigit():
                try:
                    total_bytes = int(content_length)
                except (ValueError, TypeError):
                    total_bytes = 0

            downloaded_bytes = 0
            last_report_time = time.time()
            stream_iter = res.iter_content(chunk_size=65536)

            # Check first chunk for EPUB ZIP magic bytes before writing full file
            first_chunk = next(stream_iter, b"")
            if not first_chunk:
                raise RuntimeError("Downloaded stream was empty")

            if not first_chunk.startswith(b"PK\x03\x04"):
                # Check if this is an Anubis challenge HTML page in disguise
                probe_text = first_chunk.decode("utf-8", errors="ignore")
                challenge = parse_anubis_challenge(probe_text)
                if challenge:
                    ensure_authenticated_session(session, folder_url)
                    res = session.get(
                        canonical_file_url,
                        headers=headers,
                        stream=True,
                        allow_redirects=True,
                        timeout=DOWNLOAD_TIMEOUT,
                    )
                    if getattr(res, "url", None):
                        assert_elscione_host(urlsplit(res.url).netloc)
                    if res.status_code != 200:
                        raise RuntimeError(f"Stream retry failed to download EPUB (HTTP {res.status_code}): {canonical_file_url}")
                    stream_iter = res.iter_content(chunk_size=65536)
                    first_chunk = next(stream_iter, b"")
                    if not first_chunk.startswith(b"PK\x03\x04"):
                        raise RuntimeError(f"Stream retry did not return valid EPUB ZIP magic bytes: {canonical_file_url}")
                else:
                    raise RuntimeError(f"Stream did not start with valid EPUB ZIP magic bytes (got {first_chunk[:8]!r})")

            with open(temp_dest, "wb") as f:
                f.write(first_chunk)
                downloaded_bytes += len(first_chunk)

                for chunk in stream_iter:
                    if not chunk:
                        continue
                    downloaded_bytes += len(chunk)
                    if downloaded_bytes > MAX_EPUB_BYTES:
                        raise RuntimeError(f"Downloaded bytes exceeded maximum allowed ({MAX_EPUB_BYTES} bytes)")
                    f.write(chunk)

                    now = time.time()
                    if now - last_report_time >= 0.5 or (total_bytes and downloaded_bytes == total_bytes):
                        last_report_time = now
                        if total_bytes > 0:
                            pct = round((downloaded_bytes / total_bytes) * 100, 1)
                            print(f"PROGRESS: {pct}% ({downloaded_bytes}/{total_bytes})", flush=True)
                        else:
                            print(f"PROGRESS: {downloaded_bytes} bytes", flush=True)

            if not os.path.exists(temp_dest) or os.path.getsize(temp_dest) < 100:
                raise RuntimeError("Downloaded file is empty or too small to be an EPUB")

            with open(temp_dest, "rb") as f:
                magic = f.read(4)
                if magic != b"PK\x03\x04":
                    raise RuntimeError(f"Downloaded file does not start with ZIP/EPUB magic bytes (got {magic!r})")

            os.replace(temp_dest, validated_dest)
            print(f"DOWNLOAD_COMPLETE: {validated_dest} ({downloaded_bytes} bytes)", flush=True)
            return 0

        except Exception as err:
            last_err = err
            if os.path.exists(temp_dest):
                with contextlib.suppress(Exception):
                    os.remove(temp_dest)
            if attempt < max_attempts:
                sys.stderr.write(f"Download attempt {attempt}/{max_attempts} failed ({err}), retrying...\n")
                sys.stderr.flush()
                continue
            raise RuntimeError(f"EPUB download failed after {max_attempts} attempts: {last_err}") from last_err


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("Usage: elscione_helper.py <manifest|download> [args...]\n")
        sys.exit(1)

    mode = sys.argv[1].lower()
    try:
        if mode == "manifest":
            if len(sys.argv) < 3:
                sys.stderr.write("Usage: elscione_helper.py manifest <url>\n")
                sys.exit(1)
            sys.exit(cmd_manifest(sys.argv[2]))
        elif mode == "download":
            if len(sys.argv) < 4:
                sys.stderr.write("Usage: elscione_helper.py download <file_url> <dest_path>\n")
                sys.exit(1)
            sys.exit(cmd_download(sys.argv[2], sys.argv[3]))
        else:
            sys.stderr.write(f"Unknown mode: {mode}. Expected 'manifest' or 'download'.\n")
            sys.exit(1)
    except Exception as err:
        sys.stderr.write(f"Error: {err}\n")
        # In manifest mode, also emit structured JSON for parser friendliness
        if mode == "manifest":
            print(json.dumps({"success": False, "error": str(err)}))
        sys.exit(1)


if __name__ == "__main__":
    main()

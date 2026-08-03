#!/usr/bin/env python3
"""Lyris — 動態歌詞播放器的極簡後端。

只依賴 Python 標準函式庫，不需要 pip install 任何東西。

    python3 server.py                # 讀取 ./media，開在 http://127.0.0.1:8000
    python3 server.py --media ~/Music --port 9000 --open

後端只做四件事：
  1. 掃描資料夾，把同名的 .mp3 / .lrc 配成一首歌
  2. 送出音檔（支援 HTTP Range，這樣拖動進度條才會順）
  3. 送出原始 .lrc 文字（真正的解析在前端做）
  4. 送出封面圖（優先讀 MP3 內嵌的 ID3 APIC，其次找同名圖檔）
"""

from __future__ import annotations

import argparse
import errno
import hashlib
import http.server
import json
import mimetypes
import os
import re
import threading
import webbrowser
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import unquote, urlparse

AUDIO_EXTS = {".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav", ".flac"}
IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp")
FOLDER_COVER_NAMES = ("cover", "folder", "front", "album")

WEB_DIR = Path(__file__).resolve().parent / "web"


# --------------------------------------------------------------------------
# LRC：後端只抓 metadata，完整解析交給前端（避免兩套解析器各說各話）
# --------------------------------------------------------------------------

_META_RE = re.compile(r"^\[(ti|ar|al|by):(.*)\]\s*$", re.IGNORECASE)


def read_lrc_meta(path: Path) -> dict[str, str]:
    """讀出 [ti:] [ar:] [al:] 這幾個標籤，只掃檔案開頭幾十行就夠了。"""
    meta: dict[str, str] = {}
    try:
        with path.open("r", encoding="utf-8", errors="replace") as fh:
            for i, line in enumerate(fh):
                if i > 40:
                    break
                m = _META_RE.match(line.strip())
                if m:
                    meta[m.group(1).lower()] = m.group(2).strip()
    except OSError:
        pass
    return meta


# --------------------------------------------------------------------------
# ID3v2：從 MP3 裡挖出內嵌封面（APIC / PIC frame）
# --------------------------------------------------------------------------


def _synchsafe(raw: bytes) -> int:
    value = 0
    for byte in raw:
        value = (value << 7) | (byte & 0x7F)
    return value


def extract_embedded_cover(path: Path) -> tuple[str, bytes] | None:
    """回傳 (mime, bytes)，找不到就回 None。優先挑 front cover（type 3）。"""
    try:
        with path.open("rb") as fh:
            header = fh.read(10)
            if len(header) < 10 or header[:3] != b"ID3":
                return None
            major, flags = header[3], header[5]
            body = fh.read(_synchsafe(header[6:10]))
    except OSError:
        return None

    pos = 0
    if flags & 0x40:  # extended header
        if major >= 4:
            pos += max(_synchsafe(body[0:4]), 6)
        else:
            pos += 4 + int.from_bytes(body[0:4], "big")

    candidates: list[tuple[int, str, bytes]] = []
    while True:
        head_len = 6 if major == 2 else 10
        if pos + head_len > len(body):
            break
        if major == 2:
            frame_id = body[pos : pos + 3]
            size = int.from_bytes(body[pos + 3 : pos + 6], "big")
        else:
            frame_id = body[pos : pos + 4]
            raw_size = body[pos + 4 : pos + 8]
            size = _synchsafe(raw_size) if major >= 4 else int.from_bytes(raw_size, "big")
        if not frame_id.strip(b"\x00") or size <= 0:
            break
        frame = body[pos + head_len : pos + head_len + size]
        pos += head_len + size
        if frame_id in (b"APIC", b"PIC"):
            parsed = _parse_picture_frame(frame, legacy=frame_id == b"PIC")
            if parsed:
                candidates.append(parsed)

    if not candidates:
        return None
    candidates.sort(key=lambda c: (c[0] != 3, c[0]))  # front cover 優先
    _, mime, data = candidates[0]
    return mime, data


def _parse_picture_frame(frame: bytes, legacy: bool) -> tuple[int, str, bytes] | None:
    if len(frame) < 4:
        return None
    encoding = frame[0]
    if legacy:
        fmt = frame[1:4].decode("latin-1", "ignore").lower()
        mime = "image/png" if fmt == "png" else "image/jpeg"
        cursor = 4
    else:
        end = frame.find(b"\x00", 1)
        if end < 0:
            return None
        mime = frame[1:end].decode("latin-1", "ignore").strip() or "image/jpeg"
        if "/" not in mime:  # 有些檔案只寫 "JPG"
            mime = "image/png" if "png" in mime.lower() else "image/jpeg"
        cursor = end + 1

    if cursor >= len(frame):
        return None
    pic_type = frame[cursor]
    cursor += 1

    if encoding in (1, 2):  # UTF-16，描述文字以兩個 0x00 結尾
        while cursor + 1 < len(frame):
            if frame[cursor : cursor + 2] == b"\x00\x00":
                cursor += 2
                break
            cursor += 2
    else:
        end = frame.find(b"\x00", cursor)
        cursor = len(frame) if end < 0 else end + 1

    data = frame[cursor:]
    return (pic_type, mime, data) if len(data) > 256 else None


# --------------------------------------------------------------------------
# 曲庫
# --------------------------------------------------------------------------


@dataclass
class Track:
    id: str
    audio: Path
    lyrics: Path | None
    cover_file: Path | None
    title: str
    artist: str
    album: str = ""
    has_embedded_cover: bool = field(default=False)

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "hasLyrics": self.lyrics is not None,
            "audio": f"/api/tracks/{self.id}/audio",
            "lyrics": f"/api/tracks/{self.id}/lyrics" if self.lyrics else None,
            "cover": f"/api/tracks/{self.id}/cover"
            if (self.has_embedded_cover or self.cover_file)
            else None,
        }


class Library:
    """每次要曲目清單就重掃一次資料夾，丟新歌進去不用重開 server。"""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._tracks: dict[str, Track] = {}
        self._lock = threading.Lock()

    def scan(self) -> list[Track]:
        tracks: list[Track] = []
        if self.root.is_dir():
            for audio in sorted(self.root.rglob("*")):
                if not audio.is_file() or audio.suffix.lower() not in AUDIO_EXTS:
                    continue
                tracks.append(self._build_track(audio))
        with self._lock:
            self._tracks = {t.id: t for t in tracks}
        return tracks

    def get(self, track_id: str) -> Track | None:
        with self._lock:
            track = self._tracks.get(track_id)
        if track is None:
            self.scan()
            with self._lock:
                track = self._tracks.get(track_id)
        return track

    def _build_track(self, audio: Path) -> Track:
        rel = audio.relative_to(self.root).as_posix()
        track_id = hashlib.sha1(rel.encode("utf-8")).hexdigest()[:12]
        lyrics = self._find_lyrics(audio)
        meta = read_lrc_meta(lyrics) if lyrics else {}

        title = meta.get("ti") or audio.stem
        artist = meta.get("ar", "")
        if not artist and " - " in audio.stem:
            # 常見的「歌手 - 歌名.mp3」命名
            left, right = audio.stem.split(" - ", 1)
            artist, title = left.strip(), meta.get("ti") or right.strip()

        return Track(
            id=track_id,
            audio=audio,
            lyrics=lyrics,
            cover_file=self._find_cover_file(audio),
            title=title.strip(),
            artist=artist.strip() or "未知演出者",
            album=meta.get("al", "").strip(),
            has_embedded_cover=extract_embedded_cover(audio) is not None,
        )

    @staticmethod
    def _find_lyrics(audio: Path) -> Path | None:
        for candidate in (audio.with_suffix(".lrc"), audio.with_suffix(".LRC")):
            if candidate.is_file():
                return candidate
        # 大小寫混雜的檔名（例如 song.Lrc）也接住
        for sibling in audio.parent.glob(f"{glob_escape(audio.stem)}.*"):
            if sibling.suffix.lower() == ".lrc":
                return sibling
        return None

    @staticmethod
    def _find_cover_file(audio: Path) -> Path | None:
        for ext in IMAGE_EXTS:
            candidate = audio.with_suffix(ext)
            if candidate.is_file():
                return candidate
        for name in FOLDER_COVER_NAMES:
            for ext in IMAGE_EXTS:
                candidate = audio.parent / f"{name}{ext}"
                if candidate.is_file():
                    return candidate
        return None


def glob_escape(text: str) -> str:
    return re.sub(r"([\[\]\*\?])", r"[\1]", text)


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------


class LyrisHandler(http.server.BaseHTTPRequestHandler):
    server_version = "Lyris/1.0"
    library: Library  # 由 build_server 塞進來

    # ---- routing ---------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802
        self._handle(send_body=True)

    def do_HEAD(self) -> None:  # noqa: N802
        self._handle(send_body=False)

    def _handle(self, send_body: bool) -> None:
        path = unquote(urlparse(self.path).path)
        try:
            if path == "/api/tracks":
                self._send_json({"tracks": [t.to_json() for t in self.library.scan()]}, send_body)
                return
            match = re.fullmatch(r"/api/tracks/([0-9a-f]{12})/(audio|lyrics|cover)", path)
            if match:
                self._serve_track(match.group(1), match.group(2), send_body)
                return
            self._serve_static(path, send_body)
        except (BrokenPipeError, ConnectionResetError):  # 使用者切歌時很常見，忽略
            pass

    def _serve_track(self, track_id: str, kind: str, send_body: bool) -> None:
        track = self.library.get(track_id)
        if track is None:
            self._send_error(404, "track not found")
            return

        if kind == "audio":
            self._send_file(track.audio, send_body=send_body, allow_range=True)
        elif kind == "lyrics":
            if not track.lyrics:
                self._send_error(404, "no lyrics")
                return
            body = track.lyrics.read_bytes()
            self._send_bytes(body, "text/plain; charset=utf-8", send_body)
        else:
            embedded = extract_embedded_cover(track.audio)
            if embedded:
                mime, data = embedded
                self._send_bytes(data, mime, send_body, cache="public, max-age=86400")
            elif track.cover_file:
                self._send_file(track.cover_file, send_body=send_body, cache="public, max-age=86400")
            else:
                self._send_error(404, "no cover")

    def _serve_static(self, path: str, send_body: bool) -> None:
        rel = "index.html" if path in ("/", "") else path.lstrip("/")
        target = (WEB_DIR / rel).resolve()
        if not str(target).startswith(str(WEB_DIR.resolve())) or not target.is_file():
            self._send_error(404, "not found")
            return
        self._send_file(target, send_body=send_body)

    # ---- responses -------------------------------------------------------

    def _send_json(self, payload: dict, send_body: bool) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send_bytes(body, "application/json; charset=utf-8", send_body)

    def _send_bytes(
        self, body: bytes, content_type: str, send_body: bool, cache: str = "no-cache"
    ) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if send_body:
            self.wfile.write(body)

    def _send_error(self, code: int, message: str) -> None:
        body = json.dumps({"error": message}).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(
        self,
        path: Path,
        send_body: bool,
        allow_range: bool = False,
        cache: str = "no-cache",
    ) -> None:
        size = path.stat().st_size
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        start, end = 0, size - 1
        status = 200

        range_header = self.headers.get("Range") if allow_range else None
        if range_header:
            m = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
            if m:
                raw_start, raw_end = m.group(1), m.group(2)
                if raw_start:
                    start = int(raw_start)
                    end = int(raw_end) if raw_end else size - 1
                elif raw_end:  # bytes=-500 → 最後 500 bytes
                    start = max(size - int(raw_end), 0)
                if start >= size:
                    self.send_response(416)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.end_headers()
                    return
                end = min(end, size - 1)
                status = 206

        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", cache)
        if allow_range:
            self.send_header("Accept-Ranges", "bytes")
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()

        if not send_body:
            return
        with path.open("rb") as fh:
            fh.seek(start)
            remaining = length
            while remaining > 0:
                chunk = fh.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def log_message(self, fmt: str, *args) -> None:  # 安靜一點
        if os.environ.get("LYRIS_VERBOSE"):
            super().log_message(fmt, *args)


class ThreadedServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def build_server(media: Path, host: str, port: int) -> ThreadedServer:
    handler = type("BoundHandler", (LyrisHandler,), {"library": Library(media)})
    return ThreadedServer((host, port), handler)


def main() -> None:
    parser = argparse.ArgumentParser(description="Lyris 動態歌詞播放器")
    parser.add_argument("--media", default="media", help="放 mp3 / lrc 的資料夾（預設 ./media）")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--open", action="store_true", help="啟動後自動開瀏覽器")
    args = parser.parse_args()

    media = Path(args.media).expanduser().resolve()
    media.mkdir(parents=True, exist_ok=True)

    server = build_server(media, args.host, args.port)
    url = f"http://{args.host}:{server.server_address[1]}"

    count = len(Library(media).scan())
    print(f"♪ Lyris  {url}")
    print(f"  曲庫：{media}（找到 {count} 首）")
    print("  把 song.mp3 和 song.lrc（同檔名）丟進去就會自動出現，重新整理即可。")
    print("  Ctrl+C 結束")

    if args.open:
        threading.Timer(0.4, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n再見 👋")
    finally:
        server.server_close()


if __name__ == "__main__":
    try:
        main()
    except OSError as exc:
        if exc.errno == errno.EADDRINUSE:
            raise SystemExit("連接埠已被占用，換一個：python3 server.py --port 8080") from exc
        raise

"""Private Leonida map, served through a loopback SSH tunnel."""
import argparse
import base64
import hmac
import json
import logging
import mimetypes
import os
import re
import signal
import sqlite3
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from catalog import Catalog
from psn import Synchronizer
from store import DEFAULT_PREFERENCES, Store, backup

HERE = Path(__file__).resolve().parent
STATIC = {"/": "index.html", "/app.css": "app.css", "/app.js": "app.js", "/icons.js": "icons.js",
          "/expedition.js": "expedition.js", "/tracker.js": "tracker.js"}
VENDOR = {
    "/vendor/leaflet.css": "leaflet/dist/leaflet.css",
    "/vendor/leaflet.js": "leaflet/dist/leaflet.js",
    "/vendor/cluster.css": "leaflet.markercluster/dist/MarkerCluster.css",
    "/vendor/cluster.js": "leaflet.markercluster/dist/leaflet.markercluster.js",
    "/vendor/images/layers.png": "leaflet/dist/images/layers.png",
    "/vendor/images/layers-2x.png": "leaflet/dist/images/layers-2x.png",
    "/vendor/images/marker-icon.png": "leaflet/dist/images/marker-icon.png",
}
CSP = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
LOG = logging.getLogger("leonida")


def log(event, **fields):
    LOG.info(json.dumps({"event": event, **fields}, separators=(",", ":")))


class InvalidRequest(Exception):
    def __init__(self, message, status=400):
        self.status = status
        super().__init__(message)


def create_server(port, catalog, store, sync, password):
    expected = b"Basic " + base64.b64encode(b"leonida:" + password)
    loopback = re.compile(r"(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?")

    class Handler(BaseHTTPRequestHandler):
        timeout = 12
        server_version = "Leonida"

        def log_message(self, *values):
            pass

        def respond(self, payload, content_type, status=200, cache="no-store"):
            try:
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Cache-Control", cache)
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Referrer-Policy", "no-referrer")
                self.send_header("Cross-Origin-Resource-Policy", "same-origin")
                self.send_header("X-Frame-Options", "DENY")
                self.send_header("Content-Security-Policy", CSP)
                self.send_header("Permissions-Policy", "fullscreen=(self), camera=(), microphone=(), geolocation=()")
                if status == 401:
                    self.send_header("WWW-Authenticate", 'Basic realm="Leonida AI", charset="UTF-8"')
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(payload)
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass

        def json(self, payload, status=200):
            self.respond(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode(),
                         "application/json; charset=utf-8", status)

        def file(self, path, cache="no-store"):
            try:
                data = path.read_bytes()
            except FileNotFoundError:
                raise InvalidRequest("File not found", 404) from None
            self.respond(data, mimetypes.guess_type(path)[0] or "application/octet-stream", cache=cache)

        def body(self):
            if self.headers.get_content_type() != "application/json":
                raise InvalidRequest("JSON required", 415)
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 8192:
                    raise ValueError
                data = json.loads(self.rfile.read(size))
                if not isinstance(data, dict):
                    raise ValueError
                return data
            except (ValueError, TimeoutError, RecursionError):
                raise InvalidRequest("Invalid request body") from None

        def guard(self, mutate):
            host = self.headers.get("Host", "")
            if not loopback.fullmatch(host):
                raise InvalidRequest("Invalid host", 403)
            supplied = self.headers.get("Authorization", "").encode("utf-8")
            if not hmac.compare_digest(supplied, expected):
                raise InvalidRequest("Authentication required", 401)
            if mutate:
                expected_origin = "http://" + host
                if self.headers.get("Origin") != expected_origin or self.headers.get("Sec-Fetch-Site") == "cross-site":
                    raise InvalidRequest("Invalid origin", 403)

        def reveal(self, value):
            if not isinstance(value, list) or not all(isinstance(x, str) and x in catalog.kinds for x in value):
                raise InvalidRequest("Invalid categories")
            return set(value)

        def location(self, identifier, progress, reveal):
            row = catalog.rows.get(identifier) if isinstance(identifier, str) else None
            if not row or not catalog.visible(row, progress, reveal):
                raise InvalidRequest("Location unavailable under current spoiler settings", 404)
            return row

        def get(self, path, query):
            if path in STATIC:
                return self.file(HERE / "static" / STATIC[path])
            if path in VENDOR:
                return self.file(HERE / "node_modules" / VENDOR[path], "private, max-age=86400")
            tile = re.fullmatch(r"/tiles/([0-6])/([0-6]),([0-9]{1,3}),([0-9]{1,3})\.jpg", path)
            if tile:
                zoom, repeated, y, x = map(int, tile.groups())
                if zoom != repeated or zoom > catalog.native_zoom or max(x, y) >= 4 * 2**zoom:
                    raise InvalidRequest("Tile not found", 404)
                return self.file(catalog.tiles / str(zoom) / f"{zoom},{y},{x}.jpg", "private, max-age=3600")
            if path == "/api/health":
                with store.db() as c:
                    c.execute("SELECT 1 FROM config LIMIT 1").fetchone()
                return self.json({"status": "ok", "version": "0.5.0", "nativeZoom": catalog.native_zoom,
                                  "locations": len(catalog.rows), "tileCounts": catalog.tile_counts})
            if path == "/api/catalog":
                return self.json({"categories": catalog.categories, "districts": catalog.districts,
                                  "preferences": store.preferences(), "nativeZoom": catalog.native_zoom})
            if path == "/api/status":
                value = store.status()
                value["sync"].update(sync.public_state())
                return self.json(value)
            if path == "/api/guides":
                search = query.get("q", [""])[0].strip()
                identifier = query.get("id", [None])[0]
                if len(search) > 100 or (identifier is not None and len(identifier) > 100):
                    raise InvalidRequest("Guide search is limited to 100 characters")
                progress, *_ = store.map_state()
                return self.json(catalog.guide_results(catalog.context(progress), search, identifier))
            if path in {"/api/map", "/api/location", "/api/media"}:
                reveal = self.reveal(query["reveal"][0].split(",") if query.get("reveal") else [])
                if query.get("view") == ["full"]:
                    reveal.add("*")
                progress, complete, favorite, waypoints, linked = store.map_state()
                progress = catalog.context(progress)
                if path == "/api/map":
                    story = progress["story"]
                    checkpoint = catalog.missions.get(story.get("checkpoint"))
                    can_kenton = progress["chapter"] >= 1 or "island-dreams" in progress["reached"]
                    tracking = progress["tracking"]
                    return self.json({"markers": catalog.markers(progress, complete, favorite, reveal),
                                      "waypoints": waypoints,
                                      "story": {"name": checkpoint["name"] if checkpoint else None,
                                                "chapter": checkpoint["chapter"] if checkpoint else progress["chapter"],
                                                "completedMissions": [m["name"] for key, m in catalog.missions.items()
                                                                     if key in progress["reached"] and key != "arrived-starlet"],
                                                "kenton": story.get("kenton", 0), "canKenton": can_kenton},
                                      "position": tracking.get("position"), "visited": tracking["visited"],
                                      "linked": {key: value for key, value in linked.items()
                                                 if catalog.visible(catalog.rows[key], progress, reveal)}})
                row = self.location(query.get("id", [None])[0], progress, reveal)
                details = catalog.detail(row, progress, full="*" in reveal)
                if path == "/api/location":
                    return self.json(details)
                if "media" not in details:
                    raise InvalidRequest("Image unavailable", 404)
                return self.file(catalog.media[row["id"]][0])
            raise InvalidRequest("Not found", 404)

        def post(self, path, data):
            if path == "/api/preferences":
                selected = data.get("selected")
                if selected is not None:
                    selected = sorted(self.reveal(selected))
                value = {"selected": selected}
                for key in ("hideCompleted", "favoritesOnly", "fog", "fullMap"):
                    value[key] = data.get(key, DEFAULT_PREFERENCES[key])
                    if type(value[key]) is not bool:
                        raise InvalidRequest("Invalid preference")
                return self.json(store.preferences(value))
            if path == "/api/story":
                if "checkpoint" in data:
                    title = data["checkpoint"]
                    if not isinstance(title, str) or len(title) > 100:
                        raise InvalidRequest("Enter a supported completed mission or save checkpoint")
                    identifier = catalog.mission_names.get(catalog.mission_key(title))
                    if title.strip() and identifier is None:
                        raise InvalidRequest("No unlock data for that mission yet")
                    store.save_story("checkpoint", identifier)
                elif type(data.get("kenton")) is int and 0 <= data["kenton"] <= 2:
                    progress, *_ = store.map_state()
                    progress = catalog.context(progress)
                    if data["kenton"] and progress["chapter"] < 1 and "island-dreams" not in progress["reached"]:
                        raise InvalidRequest("Record the introductory dive mission first")
                    store.save_story("kenton", data["kenton"])
                else:
                    raise InvalidRequest("Invalid story update")
                return self.json({"ok": True})
            if path == "/api/player-position":
                if data.get("clear") is True:
                    store.save_position(None)
                    return self.json({"ok": True})
                x, y, source = data.get("x"), data.get("y"), data.get("source")
                if (source not in ("map", "screenshot", "landmark", "video") or
                        not all(type(value) in (int, float) and 0 <= value <= 1024 for value in (x, y))):
                    raise InvalidRequest("Invalid player position")
                store.save_position({"x": round(x, 3), "y": round(y, 3), "source": source})
                return self.json({"ok": True})
            if path == "/api/sync":
                status, message = sync.trigger()
                return self.json({"message": message}, status)
            if path == "/api/auto":
                if type(data.get("enabled")) is not bool:
                    raise InvalidRequest("Invalid automatic-sync setting")
                error = sync.auto(data["enabled"])
                if error:
                    raise InvalidRequest(error, 409)
                return self.json({"enabled": data["enabled"]})
            if path == "/api/waypoint":
                if data.get("delete") is True:
                    identifier = data.get("id", "")
                    if not isinstance(identifier, str) or not re.fullmatch(r"wp-[0-9a-f]{32}", identifier):
                        raise InvalidRequest("Invalid waypoint")
                    store.waypoint(identifier, None)
                    return self.json({"ok": True})
                name = data.get("name")
                coordinates = (data.get("x"), data.get("y"))
                if (not isinstance(name, str) or not 1 <= len(name.strip()) <= 70
                        or not all(type(v) in {int, float} and 0 <= v <= 1024 for v in coordinates)):
                    raise InvalidRequest("Invalid waypoint name or coordinates")
                store.waypoint(f"wp-{uuid.uuid4().hex}", (name.strip(), *coordinates))
                return self.json({"ok": True}, 201)
            if path in {"/api/mark", "/api/favorite", "/api/reconcile"}:
                progress, *_ = store.map_state()
                progress = catalog.context(progress)
                reveal = self.reveal(data.get("reveal", []))
                if data.get("view") == "full":
                    reveal.add("*")
                if path == "/api/reconcile":
                    event = data.get("event")
                    action = data.get("action")
                    if type(event) is not int or not 0 < event < 2**63:
                        raise InvalidRequest("Invalid progress event")
                    candidate = self.location(data.get("id"), progress, reveal) if action in ("confirm", "unlink") else None
                    if action not in ("confirm", "dismiss", "undo-dismiss", "unlink"):
                        raise InvalidRequest("Invalid reconciliation action")
                    if action == "unlink":
                        store.unlink(event, candidate["id"])
                    else:
                        try:
                            store.reconcile(event, candidate, dismiss=action == "dismiss")
                        except ValueError as error:
                            raise InvalidRequest(str(error), 409) from None
                else:
                    row = self.location(data.get("id"), progress, reveal)
                    if type(data.get("enabled")) is not bool:
                        raise InvalidRequest("Invalid location state")
                    action = store.mark if path == "/api/mark" else store.favorite
                    action(row["id"], data["enabled"])
                return self.json({"ok": True})
            raise InvalidRequest("Not found", 404)

        def dispatch(self, mutate=False):
            try:
                self.guard(mutate)
                target = urlsplit(self.path)
                if mutate:
                    self.post(target.path, self.body())
                else:
                    self.get(target.path, parse_qs(target.query, max_num_fields=8))
            except InvalidRequest as error:
                self.json({"error": str(error)}, error.status)
            except ValueError:
                self.json({"error": "Invalid request"}, 400)
            except (OSError, sqlite3.Error) as error:
                log("request_error", type=type(error).__name__)
                self.json({"error": "Temporary service error"}, 503)

        do_GET = dispatch
        do_HEAD = dispatch

        def do_POST(self):
            self.dispatch(mutate=True)

    class Server(ThreadingHTTPServer):
        request_queue_size = 64

    return Server(("127.0.0.1", port), Handler)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data", type=Path)
    parser.add_argument("--tiles", type=Path)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--password-file", type=Path)
    parser.add_argument("--node", default="node")
    parser.add_argument("--backup", type=Path)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    if args.backup:
        result = backup(args.db, args.backup)
        log("backup_created", name=result.name)
        return
    if not args.password_file:
        args.password_file = Path(os.environ["CREDENTIALS_DIRECTORY"]) / "http-password"
    password = args.password_file.read_bytes().strip()
    if len(password) < 32:
        raise RuntimeError("Server password must be at least 32 bytes")
    catalog = Catalog(args.data, args.tiles)
    if not args.db.is_file():
        raise RuntimeError("A backed-up v0.4 SQLite database is required")
    store = Store(args.db)
    store.migrate()
    sync = Synchronizer(store, args.node)
    with create_server(args.port, catalog, store, sync, password) as server:
        def stop(_number, _frame):
            threading.Thread(target=server.shutdown, daemon=True).start()

        signal.signal(signal.SIGTERM, stop)
        sync.start()
        log("ready", version="0.5.0", locations=len(catalog.rows), native_zoom=catalog.native_zoom)
        server.serve_forever()


if __name__ == "__main__":
    main()

"""Exercise migration, PSN validation, HTTP gating and reconciliation on disposable state."""
import base64
import json
import sqlite3
import tempfile
import threading
import time
import unittest
from contextlib import closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from app import create_server
from catalog import Catalog
from psn import Synchronizer, merge_progress
from store import OBJECTIVES, Store, backup

MANUAL = "meditation-001"
UNKNOWN = "meditation-002"
FUTURE = "meditation-003"
PASSWORD = b"local-test-password-only-000000000000"


def fixture(root):
    db = root / "legacy.sqlite3"
    with closing(sqlite3.connect(db)) as connection, connection:
        connection.executescript("CREATE TABLE found(id TEXT PRIMARY KEY,updated_at TEXT);"
                                 "CREATE TABLE snapshot(id INTEGER PRIMARY KEY,data TEXT);")
        connection.execute("INSERT INTO found VALUES (?,?)", (MANUAL, "2026-11-24"))
        connection.execute("INSERT INTO snapshot VALUES (1,?)", (json.dumps({
            "objectives": [["Meditation", 1, 18]], "completionObjective": 16, "playtimeHours": 18,
            "trophiesEarned": 3, "trophiesTotal": 55, "chapter": "Chapter 1 completed",
            "lastTrophyUpdate": "2026-11-24T06:50:39Z",
        }),))
    data = {
        "locations": [{"id": key, "kind": "meditation", "x": 501.5, "y": 456.8, "name": name,
                       "description": "REDACTED " + name}
                      for key, name in ((MANUAL, "Known"), (UNKNOWN, "Unverified"), (FUTURE, "Future mission"))],
        "places": [],
        "districts": [{"name": "Vice City", "x": 503.9, "y": 489.7}],
        "categories": {"kinds": [{"key": "meditation", "name": "Meditation", "group": "Activities"}]},
        "story-milestones": {"missions": [
            {"id": "arrived", "name": "Arrival", "chapter": 2},
            {"id": "next-mission", "name": "Next Mission", "chapter": 2},
        ]},
        "mission-guides": [
            {"id": "local-job", "title": "Local Job", "aliases": ["The flyer"], "kind": "Side mission",
             "chapter": 2, "after": "arrived", "marker": FUTURE, "source": "https://example.com/local-job",
             "steps": ["Read the flyer outside."]},
            {"id": "future-job", "title": "Future Job", "kind": "Story",
             "chapter": 2, "after": "next-mission", "source": "https://example.com/future-job",
             "steps": ["Hidden walkthrough."]},
        ],
        "verified-availability": {MANUAL: {"chapter": 1, "source": "fixture"},
                                  FUTURE: {"chapter": 2, "source": "fixture"}},
        "licensed-media": {MANUAL: {"file": "known.png", "credit": "Fixture", "license": "CC BY 4.0"}},
    }
    for key, value in data.items():
        (root / f"{key}.json").write_text(json.dumps(value), encoding="utf-8")
    (root / "licensed-media").mkdir()
    (root / "licensed-media" / "known.png").write_bytes(b"image")
    (root / "tiles" / "0").mkdir(parents=True)
    (root / "tiles" / "0" / "0,1,1.jpg").write_bytes(b"tile")
    return Store(db)


def psn_payload():
    return {
        "titleId": "PPSA01547_00", "communicationId": "NPWR21085_00",
        "definitions": [{"trophyId": i, "trophyHidden": i == 47,
                         "trophyName": "Concealed fixture" if i == 47 else "Trophy " + str(i),
                         "trophyDetail": "Mission description " + str(i),
                         "trophyProgressTargetValue": OBJECTIVES.get(i, (None, None))[1]} for i in range(55)],
        "earnedRows": [{"trophyId": i, "earned": i in {2, 11, 12}, "progress": {27: "2", 13: "17"}.get(i)}
                       for i in range(55)],
        "total": 55, "earnedCount": 3, "playSeconds": 68000, "storyProgress": 0,
    }


class TestLeonida(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.store = fixture(self.root)
        self.store.migrate()
        self.catalog = Catalog(self.root, self.root / "tiles")
        self.sync = Synchronizer(self.store, "node")
        self.server = create_server(0, self.catalog, self.store, self.sync, PASSWORD)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.origin = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def api(self, path, data=None, auth=True, origin=None):
        headers = {}
        if auth:
            headers["Authorization"] = "Basic " + base64.b64encode(b"leonida:" + PASSWORD).decode()
        if data is not None:
            headers.update({"Origin": origin or self.origin, "Content-Type": "application/json"})
        request = Request(self.origin + path, headers=headers,
                          data=json.dumps(data).encode() if data is not None else None)
        try:
            with urlopen(request, timeout=3) as response:
                payload = response.read()
                return response.status, json.loads(payload) if response.headers.get_content_type() == "application/json" else payload
        except HTTPError as error:
            with error:
                return error.code, json.loads(error.read())

    def sync_once(self):
        with self.store.db() as c:
            old = self.store.get(c, "progress")
        snapshot = merge_progress(old, psn_payload())
        self.store.commit_sync(snapshot, {"status": "ok", "lastSuccess": snapshot["updated"]})

    def test_migration_keeps_manual_states_and_persists(self):
        self.store.migrate()
        self.assertEqual(self.api("/api/status")[1]["confirmed"], {"manual": 1})
        self.assertEqual(self.api("/api/favorite", {"id": MANUAL, "enabled": True})[0], 200)
        self.assertEqual(self.api("/api/waypoint", {"name": "My pin", "x": 421, "y": 490})[0], 201)
        exported = backup(self.store.path, self.root / "backups")
        reopened = Store(exported)
        reopened.migrate()
        _, complete, favorites, waypoints, _ = reopened.map_state()
        self.assertEqual(complete, {MANUAL: "manual"})
        self.assertEqual(favorites, {MANUAL})
        self.assertEqual(waypoints[0]["name"], "My pin")

    def test_spoilers_tiles_and_access(self):
        self.assertEqual(self.api("/api/health", auth=False)[0], 401)
        tracker_script = self.api("/tracker.js")
        self.assertEqual(tracker_script[0], 200)
        self.assertIn(b"LeonidaTracker", tracker_script[1])
        strict = self.api("/api/map")[1]["markers"]
        self.assertEqual([(m["id"], m["x"], m["y"]) for m in strict], [(MANUAL, 501.5, 456.8)])
        self.assertEqual(self.api("/api/location?id=" + FUTURE + "&reveal=meditation")[0], 404)
        self.assertEqual(self.api("/api/location?id=" + UNKNOWN)[0], 404)
        self.assertIsNone(self.api("/api/location?id=" + UNKNOWN + "&reveal=meditation")[1]["description"])
        self.assertEqual(self.api("/api/media?id=" + MANUAL), (200, b"image"))
        self.assertEqual(self.api("/tiles/0/0,1,1.jpg"), (200, b"tile"))
        self.assertEqual(self.api("/api/mark", {"id": MANUAL, "enabled": False}, origin="https://foreign.invalid")[0], 403)
        self.sync_once()
        status = json.dumps(self.api("/api/status")[1])
        self.assertNotIn("Concealed fixture", status)
        self.assertNotIn("Mission description 47", status)
        self.assertNotIn('"Trophy 24"', status)
        self.assertIn('"Trophy 2"', status)

    def test_closed_window_and_objective_unlock(self):
        self.catalog.availability[MANUAL]["closedAfterChapter"] = 1
        self.catalog.availability[UNKNOWN] = {"chapter": 1, "objective": 27, "minimum": 2}
        markers = self.api("/api/map")[1]["markers"]
        self.assertEqual([(row["id"], row["availability"]) for row in markers], [(MANUAL, "closed")])
        self.assertEqual(self.api("/api/location?id=" + UNKNOWN + "&reveal=meditation")[0], 404)
        self.sync_once()
        markers = self.api("/api/map")[1]["markers"]
        self.assertEqual([(row["id"], row["availability"], row["completion"]) for row in markers],
                         [(MANUAL, "closed", "manual"), (UNKNOWN, "available", None)])

    def test_counter_increase_duplicates_reconcile_and_undo(self):
        self.sync_once()
        self.sync_once()
        status = self.api("/api/status")[1]
        event, = status["pendingEvents"]
        self.assertEqual(event["pending"], 1)
        self.assertEqual(status["confirmed"], {"manual": 1})
        self.assertEqual(next(item["value"] for item in status["objectives"] if item["id"] == 13), 17)
        data = {"event": event["id"], "action": "confirm", "id": UNKNOWN, "reveal": ["meditation"]}
        self.assertEqual(self.api("/api/reconcile", data)[0], 200)
        self.assertEqual(self.api("/api/reconcile", data)[0], 200)
        self.assertEqual(self.api("/api/status")[1]["pendingEvents"], [])
        self.assertEqual(self.api("/api/status")[1]["confirmed"], {"manual": 2})
        self.assertEqual(self.api("/api/mark", {"id": UNKNOWN, "enabled": False, "reveal": ["meditation"]})[0], 200)
        self.assertEqual(self.api("/api/status")[1]["pendingEvents"][0]["pending"], 1)
        self.api("/api/reconcile", {"event": event["id"], "action": "dismiss"})
        self.assertEqual(self.api("/api/status")[1]["pendingEvents"], [])
        self.api("/api/reconcile", {"event": event["id"], "action": "undo-dismiss"})
        self.assertEqual(self.api("/api/status")[1]["pendingEvents"][0]["pending"], 1)
        self.store.record_verified(UNKNOWN, "Unique fixture location")
        self.assertEqual(self.api("/api/status")[1]["confirmed"], {"manual": 1, "automatic": 1})

    def test_rejects_invalid_or_regressing_progress(self):
        with self.store.db() as c:
            old = self.store.get(c, "progress")
        payload = psn_payload()
        payload["playSeconds"] = 0
        payload["earnedRows"][13]["progress"] = None
        payload["earnedRows"][13]["progressRate"] = 0
        payload["earnedRows"][27]["progress"] = "567"
        merged = merge_progress(old, payload)
        self.assertEqual(merged["playSeconds"], 18 * 3600)
        self.assertEqual(merged["objectives"]["13"]["value"], 16)
        self.assertEqual(merged["objectives"]["27"]["value"], 1)
        payload["earnedRows"].pop()
        with self.assertRaises(ValueError):
            merge_progress(old, payload)
        self.assertEqual(self.api("/api/status")[1]["earned"], 3)

    def test_earned_story_milestone_unlocks_next_verified_chapter(self):
        with self.store.db() as c:
            old = self.store.get(c, "progress")
        payload = psn_payload()
        payload["earnedRows"][3]["earned"] = True
        payload["earnedCount"] += 1
        snapshot = merge_progress(old, payload)
        self.assertEqual(snapshot["chapter"], 2)
        self.store.commit_sync(snapshot, {"status": "ok"})
        self.assertIn(FUTURE, [row["id"] for row in self.api("/api/map")[1]["markers"]])

    def test_checkpoint_gates_locations_and_position_persists(self):
        self.catalog.availability[FUTURE]["mission"] = "arrived"
        self.assertEqual(self.api("/api/story", {"checkpoint": "invented"})[0], 400)
        self.assertEqual(self.api("/api/story", {"checkpoint": "Arrival"})[0], 200)
        self.assertIn(FUTURE, [row["id"] for row in self.api("/api/map")[1]["markers"]])
        self.assertEqual(self.api("/api/story", {"checkpoint": "Next Mission"})[0], 200)
        self.assertNotIn(FUTURE, [row["id"] for row in self.api("/api/map")[1]["markers"]])
        self.assertEqual(self.api("/api/player-position", {"x": 400, "y": 500, "source": "screenshot"})[0], 200)
        self.assertEqual(self.api("/api/player-position", {"x": 1025, "y": 500, "source": "screenshot"})[0], 400)
        self.assertEqual(self.api("/api/player-position", {"x": 401, "y": 500, "source": "map"})[0], 200)
        data = self.api("/api/map")[1]
        self.assertEqual((data["position"]["x"], data["position"]["y"], data["position"]["source"]), (401, 500, "map"))
        self.assertEqual(data["visited"], [{"x": 401, "y": 500}])
        self.assertEqual(self.api("/api/player-position", {"x": 402, "y": 500, "source": "video"})[0], 200)
        self.assertEqual(self.api("/api/map")[1]["position"]["source"], "video")
        self.assertEqual(self.api("/api/player-position", {"clear": True})[0], 200)
        self.assertIsNone(self.api("/api/map")[1]["position"])

    def test_guide_search_uses_mission_alias_and_spoiler_ceiling(self):
        self.catalog.availability[FUTURE]["mission"] = "arrived"
        self.assertEqual(self.api("/api/guides?q=future")[1], [])
        locked, = self.api("/api/guides?q=Future+Job")[1]
        self.assertTrue(locked["locked"])
        self.assertNotIn("steps", locked)
        self.assertEqual(self.api("/api/guides?id=future-job")[1], [])
        self.api("/api/story", {"checkpoint": "Arrival"})
        found, = self.api("/api/guides?q=the+flyer")[1]
        self.assertEqual(found["marker"], FUTURE)
        self.assertFalse(found["locked"])
        self.assertEqual(found["steps"], ["Read the flyer outside."])

    def test_sync_guard_auth_and_backoff(self):
        self.assertEqual(self.api("/api/auto", {"enabled": True})[0], 409)
        self.assertEqual(self.api("/api/sync", {})[0], 409)
        (self.root / "psn-bootstrap").touch()
        entered, allowed = threading.Event(), threading.Event()

        def limit(*unused, **kwargs):
            entered.set()
            allowed.wait(3)
            return SimpleNamespace(stdout=b'{"error":"rate_limited","retryAfter":2400}')

        with patch("psn.subprocess.run", side_effect=limit):
            self.assertEqual(self.api("/api/sync", {})[0], 202)
            self.assertTrue(entered.wait(2))
            self.assertEqual(self.api("/api/sync", {})[0], 409)
            allowed.set()
            while self.sync.lock.locked():
                time.sleep(.02)
        status = self.api("/api/status")[1]
        self.assertEqual(status["sync"]["status"], "rate_limited")
        self.assertGreater(status["sync"]["nextAllowed"], time.time() + 2390)
        self.assertEqual(status["earned"], 3)
        self.assertEqual(self.api("/api/sync", {})[0], 429)
        self.store.sync_state({"nextAllowed": 0, "automatic": True, "verified": True})
        with patch("psn.subprocess.run", return_value=SimpleNamespace(stdout=b'{"error":"auth_expired"}')):
            self.assertEqual(self.api("/api/sync", {})[0], 202)
            while self.sync.lock.locked():
                time.sleep(.02)
        state = self.api("/api/status")[1]["sync"]
        self.assertEqual(state["status"], "auth_expired")
        self.assertFalse(state["automatic"])
        self.assertFalse(state["verified"])


if __name__ == "__main__":
    unittest.main()

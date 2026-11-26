"""SQLite migrations, progress reconciliation and backup for Leonida."""
import json
import os
import sqlite3
from contextlib import closing, contextmanager
from datetime import UTC, datetime
from pathlib import Path


OBJECTIVES = {
    13: ("Overall completion", 100), 14: ("Stunts", 250),
    15: ("Activity types", 9), 16: ("Shooting range gold medals", 42),
    17: ("Drone race locations", 14), 18: ("Different races", 20),
    24: ("Stranger mission strands", 8), 27: ("Meditation spots", 18),
    29: ("Collectible card sets", 3), 30: ("WAiNK locations", 100),
    31: ("Challenges", 50), 34: ("Vehicles discovered", 100),
    39: ("Bank vaults", 5), 41: ("Areas explored", 52),
    42: ("Gang operations", 9), 47: ("Hidden objective", None),
    51: ("Marked bills laundered", 250000), 52: ("Money spent", 100000),
    53: ("Garage properties", 8), 54: ("Scooter Bros registrations", 10),
}
# Only units that can be usefully linked to a single mapped activity.
# These mappings create choices for the owner, never inferred matches.
CANDIDATE_KINDS = {14: "stunt", 17: "drone", 18: "race", 27: "meditation", 30: "waink"}
CHAPTERS = {2: 1, 3: 2, 4: 3, 5: 4}
DEFAULT_PREFERENCES = {"selected": None, "hideCompleted": False, "favoritesOnly": False, "fog": True, "fullMap": True}


def now():
    return datetime.now(UTC).isoformat(timespec="seconds")


def seed_snapshot(data):
    aliases = {"Meditation": "Meditation spots", "Races": "Different races"}
    baseline = {aliases.get(label, label): value for label, value, _ in data["objectives"]}
    baseline["Overall completion"] = data["completionObjective"]
    return {
        "source": "Imported PSN snapshot",
        "updated": data["lastTrophyUpdate"],
        "playSeconds": round(data["playtimeHours"] * 3600),
        "playUpdated": None,
        "earned": data["trophiesEarned"],
        "total": data["trophiesTotal"],
        "chapter": 1 if data["chapter"] == "Chapter 1 completed" else 0,
        "trophies": [],
        "objectives": {str(i): {"value": baseline.get(label), "target": target}
                       for i, (label, target) in OBJECTIVES.items()},
    }


class Store:
    def __init__(self, path):
        self.path = Path(path)

    @contextmanager
    def db(self, write=False):
        connection = sqlite3.connect(self.path, timeout=8)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            with connection:
                connection.execute("BEGIN IMMEDIATE" if write else "BEGIN")
                yield connection
        finally:
            connection.close()

    def migrate(self):
        with closing(sqlite3.connect(self.path)) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
        with self.db(write=True) as c:
            version = c.execute("PRAGMA user_version").fetchone()[0]
            if version == 1:
                return
            if version != 0:
                raise RuntimeError("Unsupported database version")
            raw = c.execute("SELECT data FROM snapshot WHERE id=1").fetchone()
            for statement in (
                """CREATE TABLE completion (
                    id TEXT PRIMARY KEY, mode TEXT NOT NULL CHECK(mode IN ('manual','automatic')),
                    updated TEXT NOT NULL, evidence TEXT,
                    CHECK(mode='manual' OR evidence IS NOT NULL))""",
                "CREATE TABLE favorites (id TEXT PRIMARY KEY)",
                "CREATE TABLE waypoints (id TEXT PRIMARY KEY, name TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL)",
                "CREATE TABLE config (key TEXT PRIMARY KEY, data TEXT NOT NULL)",
                """CREATE TABLE event (
                    id INTEGER PRIMARY KEY, objective INTEGER NOT NULL,
                    previous INTEGER NOT NULL, current INTEGER NOT NULL CHECK(current>previous),
                    created TEXT NOT NULL, UNIQUE(objective, current))""",
                """CREATE TABLE allocation (
                    event_id INTEGER NOT NULL REFERENCES event(id), unit INTEGER NOT NULL,
                    location TEXT UNIQUE REFERENCES completion(id) ON DELETE CASCADE,
                    PRIMARY KEY(event_id, unit))""",
                """CREATE TABLE sync_history (
                    id INTEGER PRIMARY KEY, created TEXT NOT NULL,
                    status TEXT NOT NULL, completion INTEGER, earned INTEGER, play_seconds INTEGER)""",
            ):
                c.execute(statement)
            c.execute("INSERT INTO completion (id, mode, updated) SELECT id, 'manual', updated_at FROM found")
            self.put(c, "progress", seed_snapshot(json.loads(raw[0])))
            c.execute("PRAGMA user_version=1")

    @staticmethod
    def get(c, key, default=None):
        row = c.execute("SELECT data FROM config WHERE key=?", (key,)).fetchone()
        return json.loads(row[0]) if row else default

    @staticmethod
    def put(c, key, value):
        c.execute("INSERT OR REPLACE INTO config VALUES (?, ?)", (key, json.dumps(value)))

    def preferences(self, value=None):
        with self.db(write=value is not None) as c:
            if value is not None:
                self.put(c, "preferences", value)
            return {**DEFAULT_PREFERENCES, **self.get(c, "preferences", {})}

    def save_story(self, key, value):
        with self.db(write=True) as c:
            story = self.get(c, "story", {})
            story[key] = value
            self.put(c, "story", story)

    def save_position(self, value):
        with self.db(write=True) as c:
            tracking = self.get(c, "tracking", {"visited": []})
            if value is None:
                self.put(c, "tracking", {"visited": []})
                return
            x, y = value["x"], value["y"]
            cell = (int(x // 24), int(y // 24))
            visited = [point for point in tracking["visited"]
                       if (int(point["x"] // 24), int(point["y"] // 24)) != cell]
            self.put(c, "tracking", {"position": {**value, "updated": now()},
                                     "visited": [*visited[-119:], {"x": x, "y": y}]})

    def status(self):
        with self.db() as c:
            progress = self.get(c, "progress")
            reported = self.get(c, "reportedCompletion")
            sync = self.get(c, "sync", {})
            events = [dict(row) for row in c.execute("""
                SELECT event.*, COUNT(allocation.unit) AS resolved,
                       SUM(allocation.unit IS NOT NULL AND allocation.location IS NULL) AS dismissed
                FROM event LEFT JOIN allocation ON event.id=allocation.event_id
                GROUP BY event.id ORDER BY event.id DESC""")]
            history = [dict(row) for row in c.execute("SELECT * FROM sync_history ORDER BY id DESC LIMIT 12")]
            confirmed = dict(c.execute("SELECT mode, COUNT(*) FROM completion GROUP BY mode").fetchall())
        public = {"objectives": [], **{k: progress[k] for k in
                  ("source", "updated", "playSeconds", "playUpdated", "earned", "total", "chapter")}}
        trophies = {row["id"]: row for row in progress["trophies"]}
        public["earnedTrophies"] = [row for row in trophies.values() if row["earned"]]
        for key, (label, target) in OBJECTIVES.items():
            trophy = trophies.get(key, {})
            if key == 47 and not trophy.get("earned"):
                continue
            value = progress["objectives"].get(str(key), {"value": None, "target": target})
            public["objectives"].append({"id": key, "label": label, **value,
                                         "officialName": trophy.get("name") if trophy.get("earned") else None,
                                         "description": trophy.get("description") if trophy.get("earned") else None})
        allowed = {item["id"]: item["label"] for item in public["objectives"]}
        events = [event for event in events if event["objective"] in allowed]
        for event in events:
            event["label"] = allowed[event["objective"]]
            event["kind"] = CANDIDATE_KINDS.get(event["objective"])
            event["pending"] = event["current"] - event["previous"] - event["resolved"] if event["kind"] else 0
        public["events"] = events[:30]
        public["pendingEvents"] = [event for event in events if event["pending"] > 0]
        public["history"] = history
        public["confirmed"] = confirmed
        public["reportedCompletion"] = reported
        public["sync"] = sync
        return public

    def map_state(self):
        with self.db() as c:
            progress = self.get(c, "progress")
            progress["story"] = self.get(c, "story", {})
            progress["tracking"] = self.get(c, "tracking", {"visited": []})
            completed = {row["id"]: row["mode"] for row in c.execute("SELECT id,mode FROM completion")}
            favorites = {row[0] for row in c.execute("SELECT id FROM favorites")}
            waypoints = [dict(row) for row in c.execute("SELECT * FROM waypoints ORDER BY name")]
            linked = dict(c.execute("SELECT location,event_id FROM allocation WHERE location IS NOT NULL").fetchall())
        return progress, completed, favorites, waypoints, linked

    def mark(self, location, completed):
        with self.db(write=True) as c:
            if completed:
                c.execute("INSERT OR IGNORE INTO completion VALUES (?, 'manual', ?, NULL)", (location, now()))
            else:
                # Foreign-key cascade restores any linked counter unit to the queue.
                c.execute("DELETE FROM completion WHERE id=?", (location,))

    def record_verified(self, location, evidence):
        """Trusted local writes only. Preserve existing manual confirmations."""
        if not evidence.strip():
            raise ValueError("Unique location evidence is required")
        with self.db(write=True) as c:
            c.execute("INSERT OR IGNORE INTO completion VALUES (?, 'automatic', ?, ?)", (location, now(), evidence))

    def favorite(self, location, enabled):
        with self.db(write=True) as c:
            if enabled:
                c.execute("INSERT OR IGNORE INTO favorites VALUES (?)", (location,))
            else:
                c.execute("DELETE FROM favorites WHERE id=?", (location,))

    def waypoint(self, identifier, value):
        with self.db(write=True) as c:
            if value is None:
                c.execute("DELETE FROM waypoints WHERE id=?", (identifier,))
            else:
                c.execute("INSERT INTO waypoints VALUES (?, ?, ?, ?)", (identifier, *value))

    def reconcile(self, event_id, candidate, dismiss=False):
        with self.db(write=True) as c:
            event = c.execute("SELECT * FROM event WHERE id=?", (event_id,)).fetchone()
            if not event or event["objective"] not in CANDIDATE_KINDS:
                raise ValueError("This event cannot be matched to a map location")
            if candidate and candidate["kind"] != CANDIDATE_KINDS[event["objective"]]:
                raise ValueError("Choose a location in the matching category")
            used = {row[0] for row in c.execute("SELECT unit FROM allocation WHERE event_id=?", (event_id,))}
            if not candidate and not dismiss:
                c.execute("""DELETE FROM allocation WHERE event_id=? AND unit=
                             (SELECT MAX(unit) FROM allocation WHERE event_id=? AND location IS NULL)""",
                          (event_id, event_id))
                return
            if candidate:
                prior = c.execute("SELECT event_id FROM allocation WHERE location=?", (candidate["id"],)).fetchone()
                if prior and prior[0] == event_id:
                    return
                if prior:
                    raise ValueError("That location is already linked to another event")
            free = next((index for index in range(event["current"] - event["previous"]) if index not in used), None)
            if free is None:
                raise ValueError("This event has no unresolved progress")
            identifier = candidate["id"] if candidate else None
            if identifier:
                c.execute("INSERT OR IGNORE INTO completion VALUES (?, 'manual', ?, NULL)", (identifier, now()))
            c.execute("INSERT INTO allocation VALUES (?, ?, ?)", (event_id, free, identifier))

    def unlink(self, event_id, location):
        with self.db(write=True) as c:
            c.execute("DELETE FROM allocation WHERE event_id=? AND location=?", (event_id, location))

    def commit_sync(self, snapshot, sync):
        with self.db(write=True) as c:
            old = self.get(c, "progress")
            for key, after in snapshot["objectives"].items():
                previous = old["objectives"].get(key, {}).get("value")
                current = after["value"]
                if previous is not None and current is not None and current > previous and key != "47":
                    c.execute("INSERT OR IGNORE INTO event (objective,previous,current,created) VALUES (?,?,?,?)",
                              (int(key), previous, current, snapshot["updated"]))
            self.put(c, "progress", snapshot)
            state = self.get(c, "sync", {})
            state.update(sync)
            self.put(c, "sync", state)
            c.execute("""INSERT INTO sync_history (created,status,completion,earned,play_seconds)
                         VALUES (?,?,?,?,?)""", (now(), sync["status"], snapshot["objectives"]["13"]["value"],
                                               snapshot["earned"], snapshot["playSeconds"]))

    def sync_state(self, changes=None, record=False):
        with self.db(write=changes is not None) as c:
            state = self.get(c, "sync", {})
            if changes is not None:
                state.update(changes)
                self.put(c, "sync", state)
                if record:
                    c.execute("INSERT INTO sync_history (created,status) VALUES (?,?)", (now(), state["status"]))
            return state


def backup(db, directory, keep=14):
    directory = Path(directory)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    name = datetime.now(UTC).strftime("leonida-%Y%m%dT%H%M%S%fZ.sqlite3")
    temporary = directory / ("." + name)
    try:
        with closing(sqlite3.connect(Path(db).resolve().as_uri() + "?mode=ro", uri=True)) as source:
            with closing(sqlite3.connect(temporary)) as target:
                source.backup(target)
                if target.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                    raise RuntimeError("Backup failed SQLite integrity check")
        temporary.chmod(0o600)
        os.replace(temporary, directory / name)
        for extra in sorted(directory.glob("leonida-*.sqlite3"), reverse=True)[keep:]:
            extra.unlink()
    finally:
        temporary.unlink(missing_ok=True)
    return directory / name

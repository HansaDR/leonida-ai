"""Unchanged v0.4 coordinates and local tile pyramid, with server-side visibility."""
import json
import math
import re
from collections import Counter
from pathlib import Path
from urllib.parse import urlsplit

from store import OBJECTIVES


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


class Catalog:
    def __init__(self, root, tile_root):
        self.tiles = Path(tile_root)
        self.tile_counts = {}
        for zoom in range(7):
            count = sum(1 for _ in (self.tiles / str(zoom)).glob("*.jpg"))
            if not count:
                break
            self.tile_counts[zoom] = count
        self.native_zoom = max(self.tile_counts)
        self.districts = [{key: row[key] for key in ("name", "x", "y")} for row in load(root / "districts.json")]
        self.rows = {}
        for filename in ("locations.json", "places.json"):
            for row in load(root / filename):
                identifier = row["id"]
                if identifier in self.rows or not all(math.isfinite(row[key]) for key in ("x", "y")):
                    raise ValueError("Duplicate location ID or invalid coordinates")
                self.rows[identifier] = row
        additions = root / "reviewed-locations.json"
        if additions.exists():
            for row in load(additions):
                anchor = self.rows.get(row["anchor"])
                if anchor is None or row["id"] in self.rows:
                    raise ValueError("Reviewed location requires an existing, unique anchor")
                self.rows[row["id"]] = {**row, "x": anchor["x"], "y": anchor["y"]}
        metadata = load(root / "categories.json")
        counts = Counter(row["kind"] for row in self.rows.values())
        self.categories = []
        for item in metadata["kinds"]:
            if item["key"] in counts:
                self.categories.append({"key": item["key"], "name": item["name"], "group": item["group"],
                                        "count": counts[item["key"]]})
        self.kinds = {item["key"] for item in self.categories}
        if self.kinds != set(counts):
            raise ValueError("Missing map category metadata")
        self.media = {}
        story = root / "story-milestones.json"
        self.missions = {m["id"]: m for m in load(story)["missions"]} if story.exists() else {}
        self.mission_names = {self.mission_key(name): identifier
                              for identifier, mission in self.missions.items()
                              for name in (mission["name"], *mission.get("aliases", []))}
        for identifier, mission in self.missions.items():
            self.prerequisites(identifier, set())
            if any(self.missions[r]["chapter"] > mission["chapter"] for r in mission.get("requires", [])):
                raise ValueError("A mission cannot require a later chapter")
        self.availability = {}
        if (root / "verified-availability.json").exists():
            for identifier, entry in load(root / "verified-availability.json").items():
                if identifier not in self.rows or not str(entry.get("source", "")).strip():
                    raise ValueError("Availability requires a known ID and documented evidence")
                if type(entry["chapter"]) is not int or not 0 <= entry["chapter"] <= 99:
                    raise ValueError("Invalid verified chapter")
                closes = entry.get("closedAfterChapter")
                if closes is not None and (type(closes) is not int or not entry["chapter"] <= closes <= 99):
                    raise ValueError("Invalid closing chapter")
                objective = entry.get("objective")
                minimum = entry.get("minimum")
                if (objective is not None or minimum is not None) and (
                    type(objective) is not int or objective not in OBJECTIVES or type(minimum) is not int or minimum < 1
                ):
                    raise ValueError("Invalid objective requirement")
                if "mission" in entry and (
                    entry["mission"] not in self.missions or self.missions[entry["mission"]]["chapter"] != entry["chapter"]
                ):
                    raise ValueError("Invalid mission requirement")
                if "closedAfterMission" in entry and entry["closedAfterMission"] not in self.missions:
                    raise ValueError("Invalid mission cutoff")
                display = {key: entry[key] for key in ("name", "type", "area") if key in entry}
                if "kind" in entry:
                    if entry["kind"] not in self.kinds:
                        raise ValueError("Unknown marker category")
                    display["kind"] = entry["kind"]
                if display:
                    self.rows[identifier] = {**self.rows[identifier], **display}
                if "duplicateOf" in entry and entry["duplicateOf"] not in self.rows:
                    raise ValueError("Unknown canonical marker")
                self.availability[identifier] = entry
        guides_file = root / "mission-guides.json"
        self.guides = {}
        for guide in load(guides_file) if guides_file.exists() else []:
            self.register_guide(guide)
        if any("guide" in entry and entry["guide"] not in self.guides for entry in self.availability.values()):
            raise ValueError("Unknown marker guide")
        counts = Counter(row["kind"] for row in self.rows.values())
        for item in self.categories:
            item["count"] = counts[item["key"]]
        if (root / "licensed-media.json").exists():
            for identifier, item in load(root / "licensed-media.json").items():
                if identifier not in self.rows or not all(str(item.get(k, "")).strip() for k in ("file", "credit", "license")):
                    raise ValueError("Media requires a known ID, attribution and license")
                media = (root / "licensed-media" / item["file"]).resolve()
                if media.is_relative_to((root / "licensed-media").resolve()) and media.is_file() and media.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}:
                    self.media[identifier] = (media, item["credit"], item["license"])

    @staticmethod
    def mission_key(title):
        return re.sub(r"[^a-z0-9]", "", title.lower())

    def register_guide(self, guide):
        required = guide["after"] if isinstance(guide["after"], list) else [guide["after"]]
        identifier = guide["id"]
        source = urlsplit(guide["source"])
        if (identifier in self.guides or any(key not in self.missions for key in required)
                or ("marker" in guide and guide["marker"] not in self.rows)
                or ("closedAfterMission" in guide and guide["closedAfterMission"] not in self.missions)
                or source.scheme != "https" or not source.hostname):
            raise ValueError("Invalid guide or prerequisite")
        self.guides[identifier] = {**guide, "requires": required,
                                   "terms": [self.mission_key(title) for title in
                                             [guide["title"], *guide.get("aliases", [])]]}

    def guide_results(self, progress, query="", identifier=None):
        if identifier is not None:
            candidates = [self.guides[identifier]] if identifier in self.guides else []
        else:
            candidates = sorted(self.guides.values(), key=lambda entry: -entry["chapter"])
        query_key = self.mission_key(query)
        results = []
        for guide in candidates:
            exact = query_key in guide["terms"]
            if query and (len(query_key) < 2 or not any(query_key in term for term in guide["terms"])):
                continue
            unlocked = progress["chapter"] >= guide["chapter"] or all(
                self.missions[key]["chapter"] <= progress["chapter"] or key in progress["reached"]
                for key in guide["requires"]
            )
            if not unlocked and not exact:
                continue
            result = {key: guide[key] for key in ("id", "title", "kind", "chapter")}
            result["locked"] = not unlocked
            if unlocked:
                if "closedAfterMission" in guide:
                    cutoff = guide["closedAfterMission"]
                    result["closed"] = cutoff in progress["reached"] or progress["chapter"] >= self.missions[cutoff]["chapter"]
                result["steps"] = guide["steps"]
                result["source"] = guide["source"]
                marker = self.rows.get(guide.get("marker"))
                if marker and self.visible(marker, progress, set()):
                    result["marker"] = marker["id"]
            results.append((not exact, result))
        return [result for _, result in sorted(results, key=lambda item: item[0])[:15]]

    def prerequisites(self, identifier, visited):
        if identifier in visited or identifier not in self.missions:
            raise ValueError("Invalid story prerequisite")
        required = self.missions[identifier].get("requires", [])
        return {identifier}.union(*(self.prerequisites(key, visited | {identifier}) for key in required))

    def context(self, progress):
        story = progress.get("story", {})
        identifier = story.get("checkpoint")
        mission = self.missions.get(identifier)
        chapter = (mission["chapter"] - (identifier != "discharge-time")) if mission else progress["chapter"]
        return {**progress, "chapter": chapter,
                "reached": self.prerequisites(identifier, set()) if mission else set()}

    def availability_for(self, row, progress):
        entry = self.availability.get(row["id"])
        if entry is None:
            return "unknown"
        chapter = progress["chapter"]
        reached = progress.get("reached", ())
        if chapter < entry["chapter"] and entry.get("mission") not in reached:
            return "locked"
        if progress.get("story", {}).get("kenton", 0) < entry.get("assignment", 0):
            return "locked"
        if "objective" in entry:
            value = progress["objectives"].get(str(entry["objective"]), {}).get("value")
            if value is None or value < entry["minimum"]:
                return "locked"
        if entry.get("closedAfterChapter") is not None and chapter >= entry["closedAfterChapter"]:
            return "closed"
        if entry.get("closedAfterMission") in reached:
            return "closed"
        if entry.get("closedOnMission"):
            return "closed"
        return "available"

    def visible(self, row, progress, reveal):
        availability = self.availability_for(row, progress)
        return "*" in reveal or availability in {"available", "closed"} or (availability == "unknown" and row["kind"] in reveal)

    def markers(self, progress, completed, favorites, reveal):
        markers = []
        for identifier, row in self.rows.items():
            if self.availability.get(identifier, {}).get("duplicateOf") and identifier not in completed and identifier not in favorites:
                continue
            if not self.visible(row, progress, reveal):
                continue
            markers.append(
                dict(id=identifier, kind=row["kind"], x=row["x"], y=row["y"],
                     name=row.get("name") or identifier, type=row.get("type") or row["kind"],
                     area=row.get("area") or row.get("region") or "",
                     availability=self.availability_for(row, progress),
                     completion=completed.get(identifier), favorite=identifier in favorites)
            )
        return markers

    def detail(self, row, progress, full=False):
        show_details = full or self.availability_for(row, progress) in {"available", "closed"}
        entry = self.availability.get(row["id"], {})
        result = {"description": entry.get("description", row.get("description")) if show_details else None,
                  "realLife": row.get("real_life") if show_details else None,
                  "confidence": row.get("confidence")}
        if show_details and row["id"] in self.media:
            _, credit, license_name = self.media[row["id"]]
            result["media"] = {"credit": credit, "license": license_name}
        if show_details and "guide" in entry:
            result["guide"] = entry["guide"]
        return result

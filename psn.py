"""Serial PSN refreshes with validated, monotonic progress and persistent backoff."""
import json
import logging
import re
import sqlite3
import subprocess
import threading
import time
from pathlib import Path

from store import CHAPTERS, OBJECTIVES, now

PERIOD = 1800
HERE = Path(__file__).resolve().parent
LOG = logging.getLogger("leonida")


def integer(value):
    if type(value) is int and 0 <= value <= 2**31:
        return value
    if isinstance(value, str) and re.fullmatch(r"[0-9]{1,9}", value):
        return int(value)
    return None


def unique_rows(rows):
    if not isinstance(rows, list):
        raise ValueError("Missing trophy list")
    result = {}
    for row in rows:
        if not isinstance(row, dict) or type(row.get("trophyId")) is not int or row["trophyId"] in result:
            raise ValueError("Invalid trophy list")
        result[row["trophyId"]] = row
    return result


def merge_progress(old, payload):
    if payload["communicationId"] != "NPWR21085_00" or payload["titleId"] != "PPSA01547_00":
        raise ValueError("Unexpected title")
    definition = unique_rows(payload["definitions"])
    earned = unique_rows(payload["earnedRows"])
    if (definition.keys() != earned.keys() or len(earned) < old["total"]
            or len(earned) != payload["total"] or not set(OBJECTIVES).issubset(earned)):
        raise ValueError("Incomplete trophy definitions")
    previous_earned = {row["id"] for row in old["trophies"] if row["earned"]}
    previous_earned.update(key for key, chapter in CHAPTERS.items() if chapter <= old["chapter"])
    current_earned = {key for key, row in earned.items() if row.get("earned") is True}
    if (not previous_earned.issubset(current_earned) or len(current_earned) < old["earned"]
            or len(current_earned) != payload["earnedCount"]):
        raise ValueError("Inconsistent earned trophies")
    updated = now()
    objectives = {}
    trophies = []
    for key, item in definition.items():
        is_earned = key in current_earned
        hidden = item.get("trophyHidden") is not False
        trophies.append({"id": key, "earned": is_earned, "hidden": hidden,
                         "name": item.get("trophyName"),
                         "description": item.get("trophyDetail")})
        if key not in OBJECTIVES:
            continue
        previous = old["objectives"].get(str(key), {})
        baseline = previous.get("value")
        verified_target = OBJECTIVES[key][1]
        upstream_target = integer(item.get("trophyProgressTargetValue"))
        target = verified_target or upstream_target
        value = target if is_earned else integer(earned[key].get("progress"))
        if key == 13 and value is None and upstream_target in (None, 100):
            value = integer(earned[key].get("progressRate"))
        if (verified_target and upstream_target not in (None, verified_target)
                or value is None or (target is not None and value > target)
                or (baseline is not None and value < baseline)):
            value = baseline
        objectives[str(key)] = {"target": target if key != 47 or is_earned else None, "value": value}
    play = integer(payload.get("playSeconds"))
    play_updated = old["playUpdated"]
    if play is None or (old["playSeconds"] is not None and play < old["playSeconds"]):
        play = old["playSeconds"]
    else:
        play_updated = updated
    return {"source": "PlayStation Network", "updated": updated, "playSeconds": play,
            "playUpdated": play_updated, "earned": len(current_earned), "total": len(earned),
            "chapter": max([old["chapter"], *(CHAPTERS[x] for x in current_earned if x in CHAPTERS)]),
            "trophies": trophies, "objectives": objectives}


class Synchronizer:
    def __init__(self, store, node):
        self.store = store
        self.node = node
        self.lock = threading.Lock()
        self.directory = store.path.parent

    def configured(self):
        return any((self.directory / file).is_file() for file in ("psn-bootstrap", "psn-tokens.json"))

    def public_state(self):
        return {"busy": self.lock.locked(), "configured": self.configured()}

    def start(self):
        def schedule():
            while True:
                time.sleep(30)
                state = self.store.sync_state()
                if state.get("automatic") and time.time() >= state.get("nextAuto", 0):
                    self.trigger()
        threading.Thread(target=schedule, daemon=True, name="psn-scheduler").start()

    def auto(self, enabled):
        state = self.store.sync_state()
        if enabled and (not state.get("verified") or not self.configured()):
            return "Run a successful manual sync before enabling automatic updates."
        self.store.sync_state({"automatic": enabled, "nextAuto": time.time() + PERIOD})
        return None

    def trigger(self):
        if not self.configured():
            return 409, "PSN sign-in is required. Cached progress is available."
        if not self.lock.acquire(blocking=False):
            return 409, "A synchronization is already running."
        started = False
        try:
            state = self.store.sync_state()
            if time.time() < state.get("nextAllowed", 0):
                return 429, "The next sync will be available after the cooldown."
            if state.get("status") == "auth_expired" and not self.has_new_bootstrap(state):
                return 409, "PSN authentication expired. Cached progress is available."
            threading.Thread(target=self.run, args=(state,), daemon=True, name="psn-sync").start()
            started = True
        finally:
            if not started:
                self.lock.release()
        return 202, "Synchronization started."

    def has_new_bootstrap(self, state):
        try:
            return (self.directory / "psn-bootstrap").stat().st_mtime_ns != state.get("bootstrapAttempt")
        except FileNotFoundError:
            return False

    def run(self, state):
        bootstrap = self.directory / "psn-bootstrap"
        try:
            attempted_bootstrap = bootstrap.stat().st_mtime_ns if bootstrap.exists() else None
            result = subprocess.run(
                [self.node, str(HERE / "psn_worker.mjs"), str(self.directory)],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=75, check=True,
            )
            response = json.loads(result.stdout)
            error = response.get("error")
            if error:
                self.failure(state, error, response.get("retryAfter"), attempted_bootstrap)
                return
            with self.store.db() as c:
                old = self.store.get(c, "progress")
            snapshot = merge_progress(old, response)
            timestamp = time.time()
            # Preserve the latest automatic-sync setting if it changed mid-request.
            sync = {"status": "ok" if snapshot["playUpdated"] == snapshot["updated"] else "playtime_cached",
                    "lastSuccess": snapshot["updated"], "failures": 0, "verified": True,
                    "nextAllowed": timestamp + max(60, integer(response.get("retryAfter")) or 0),
                    "nextAuto": timestamp + max(PERIOD, integer(response.get("retryAfter")) or 0)}
            self.store.commit_sync(snapshot, sync)
            LOG.info('{"event":"psn_sync","status":"%s"}', sync["status"])
        except (OSError, subprocess.SubprocessError, ValueError, TypeError, KeyError, sqlite3.Error):
            self.failure(state, "temporary_error")
        finally:
            self.lock.release()

    def failure(self, state, error, retry_after=None, bootstrap_attempt=None):
        status = error if error in {"auth_expired", "rate_limited", "temporary_error"} else "temporary_error"
        failures = state.get("failures", 0) + 1
        delay = max(min(PERIOD, 120 * 2 ** min(failures - 1, 5)), integer(retry_after) or 0)
        timestamp = time.time()
        changes = {"status": status, "failures": failures, "nextAllowed": timestamp + delay,
                   "nextAuto": timestamp + max(delay, PERIOD)}
        if status == "auth_expired":
            changes.update(verified=False, automatic=False, bootstrapAttempt=bootstrap_attempt)
        self.store.sync_state(changes, record=True)
        LOG.info('{"event":"psn_sync","status":"%s"}', status)

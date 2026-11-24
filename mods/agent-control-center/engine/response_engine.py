#!/usr/bin/env python3
"""Durable, opt-in response lines using Herdr's installed subscription adapter.

Only this engine's SQLite files are written. No transcript body is retained.
History expires after 30 days and is capped at 50 results per session incarnation;
inactive session metadata is removed after 30 days. Read acknowledgment is unrelated.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
import uuid

from summary_adapter import redact
from response_value import SCHEMA as VALUE_SCHEMA, INSTRUCTION as VALUE_INSTRUCTION, parse_value, grounded_analysis

MAX_AGENTS = 256
LEASE_MS = 180_000
RETENTION_MS = 30 * 24 * 60 * 60 * 1000
SETTLED = {"done", "idle"}
TRANSIENT_ERRORS = {"usage_limit", "provider_failed", "timeout"}
MAX_ATTEMPTS = 3
ERRORS = {"not_installed", "invalid_request", "provider_failed", "login_required",
          "usage_limit", "update_required", "timeout", "invalid_output", "native_unavailable",
          "native_identity_unavailable", "source_changed", "configuration_changed", "worker_lease_expired"}


def now():
    return int(time.time() * 1000)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def hash_of(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def identity_key(agent):
    """Matches the UI's JSON.stringify array; null/undefined both use ?? fallback."""
    def value(key, fallback=""):
        return agent.get(key) if agent.get(key) is not None else fallback
    foreground = (agent.get("foreground") or {}).get("pid")
    resume_id = (agent.get("resume") or {}).get("id")
    return encoded([agent.get("address"), value("created_ms", value("created")), value("pid"),
                    foreground if foreground is not None else "",
                    resume_id if resume_id is not None else ""])


def normalized_config(config):
    config = config if isinstance(config, dict) else {}
    provider = config.get("provider")
    provider = provider if provider in ("codex", "claude") else "none"
    model = config.get("model")
    if model is None:
        model = ""
    if not isinstance(model, str) or len(model) > 100 or any(ord(c) < 32 for c in model):
        raise ValueError("invalid_request")
    revision = config.get("authRevision", "")
    if not isinstance(revision, (str, int, float)) or isinstance(revision, bool):
        revision = ""
    return {"enabled": config.get("enabled") is True, "provider": provider, "model": model,
            "authRevision": str(revision)[:100]}


def safe_agent(agent):
    if not isinstance(agent, dict) or not isinstance(agent.get("address"), str) or not \
            re.fullmatch(r"(?:[^/\s]+/)?t[0-9a-z]+", agent["address"]):
        raise ValueError("invalid_request")
    result = {key: agent.get(key) for key in ("address", "status", "turn", "created_ms",
                                            "created", "pid", "cwd", "tab_name")}
    if any(value is not None and not isinstance(value, (str, int, float))
           for value in result.values()):
        raise ValueError("invalid_request")
    foreground = agent.get("foreground")
    result["foreground"] = {"pid": foreground.get("pid")} if isinstance(foreground, dict) else {}
    resume = agent.get("resume")
    if isinstance(resume, dict) and resume.get("agent") in ("codex", "claude") and \
            isinstance(resume.get("id"), str) and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", resume["id"]):
        if resume.get("pid") and resume["pid"] != result["foreground"].get("pid"):
            raise ValueError("invalid_request")
        result["resume"] = {key: resume.get(key) for key in ("agent", "id", "pid")}
    else:
        result["resume"] = None
    turn = agent.get("turn", 0)
    if not isinstance(turn, int) or isinstance(turn, bool) or turn < 0:
        raise ValueError("invalid_request")
    result["turn"] = turn
    result["status"] = result["status"] if result["status"] in ("working", "done", "idle", "blocked", "error") else "idle"
    return result


def load_native(app_home):
    path = Path(app_home).expanduser() / "mods" / "ai-context" / "bridge.py"
    if not path.is_file():
        raise RuntimeError("not_installed")
    spec = importlib.util.spec_from_file_location("herdr_response_native_adapter", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # Private adapter instance: preserve installed adapter and its authentication/tool isolation.
    module.SCHEMA = VALUE_SCHEMA
    module.INSTRUCTION = VALUE_INSTRUCTION
    module.summary_value = parse_value
    return module


def native_get(address):
    try:
        result = subprocess.run(["hc", "get", address, "--json"], capture_output=True,
                                text=True, timeout=5)
        if result.returncode or len(result.stdout) > 256 * 1024:
            raise RuntimeError("native_unavailable")
        data = json.loads(result.stdout)
    except (OSError, subprocess.TimeoutExpired, ValueError):
        raise RuntimeError("native_unavailable") from None
    if isinstance(data, dict) and isinstance(data.get("terminal"), dict):
        data = data["terminal"]
    if not isinstance(data, dict):
        raise RuntimeError("native_identity_unavailable")
    if isinstance(data.get("status"), dict):
        data = {**data, "app": data.get("app") or data["status"].get("app"),
                "status": data["status"].get("state")}
    return data


def validate_native(expected, actual):
    if all(expected.get(key) is None for key in ("created_ms", "created", "pid")) and \
            (expected.get("foreground") or {}).get("pid") is None:
        raise RuntimeError("native_identity_unavailable")
    for key in ("created_ms", "created", "pid"):
        if expected.get(key) is not None:
            if actual.get(key) is None:
                raise RuntimeError("native_identity_unavailable")
            if actual[key] != expected[key]:
                raise RuntimeError("source_changed")
    foreground = expected.get("foreground") or {}
    if foreground.get("pid") is not None:
        actual_fg = actual.get("foreground") or {}
        if actual_fg.get("pid") is None:
            raise RuntimeError("native_identity_unavailable")
        if actual_fg["pid"] != foreground["pid"]:
            raise RuntimeError("source_changed")
    if actual.get("turn") is None:
        raise RuntimeError("native_identity_unavailable")
    status = actual.get("status")
    actual_app = actual.get("app") or (status.get("app") if isinstance(status, dict) else None)
    status = status.get("state") if isinstance(status, dict) else status
    if actual["turn"] != expected["turn"] or not isinstance(status, str) or status not in SETTLED:
        raise RuntimeError("source_changed")
    if expected.get("resume") and actual_app in ("codex", "claude") and \
            actual_app != expected["resume"]["agent"]:
        raise RuntimeError("source_changed")
    if actual.get("address") and actual["address"] != expected["address"]:
        raise RuntimeError("source_changed")
    labels = actual.get("labels") or {}
    if expected.get("resume") and isinstance(labels, dict) and labels.get("herdr.resume"):
        try:
            current = json.loads(labels["herdr.resume"])
        except (ValueError, TypeError):
            raise RuntimeError("source_changed") from None
        if not isinstance(current, dict) or any(current.get(key) != expected["resume"].get(key)
                                              for key in ("agent", "id")):
            raise RuntimeError("source_changed")


def error_code(error):
    kind = getattr(error, "kind", str(error))
    return kind if kind in ERRORS else "provider_failed"


class Store:
    def __init__(self, state_dir):
        self.path = Path(state_dir).expanduser()
        self.path.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path / "response-summaries.sqlite3", timeout=5)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS sessions(
            identity TEXT PRIMARY KEY,address TEXT NOT NULL,agent TEXT NOT NULL,turn INTEGER NOT NULL,
            status TEXT NOT NULL,completion_turn INTEGER,current_target TEXT,current_job TEXT,
            active INTEGER NOT NULL,seen INTEGER NOT NULL,generation INTEGER NOT NULL DEFAULT 0);
          CREATE INDEX IF NOT EXISTS sessions_address ON sessions(address,active);
          CREATE TABLE IF NOT EXISTS jobs(
            id TEXT PRIMARY KEY,identity TEXT NOT NULL,turn INTEGER NOT NULL,
            provider TEXT NOT NULL,model TEXT NOT NULL,auth_revision TEXT NOT NULL,
            agent TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,at INTEGER NOT NULL,
            summary TEXT,source TEXT,error TEXT,response_hash TEXT,summary_hash TEXT,
            owner TEXT,expires INTEGER,attempts INTEGER NOT NULL DEFAULT 0,
            UNIQUE(identity,turn,provider,model));
          CREATE TABLE IF NOT EXISTS lease(
            id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT,job TEXT,expires INTEGER NOT NULL DEFAULT 0);
          INSERT OR IGNORE INTO lease(id,expires) VALUES(1,0);
          CREATE TABLE IF NOT EXISTS history(
            id TEXT PRIMARY KEY,identity TEXT NOT NULL,turn INTEGER NOT NULL,summary TEXT,
            at INTEGER NOT NULL,provider TEXT NOT NULL,model TEXT NOT NULL,source TEXT,
            state TEXT NOT NULL,error TEXT,response_hash TEXT,summary_hash TEXT,
            UNIQUE(identity,provider,model,response_hash,summary_hash,state,error));
          CREATE INDEX IF NOT EXISTS history_session ON history(identity,at DESC);
          CREATE TABLE IF NOT EXISTS provider_failures(
            key TEXT PRIMARY KEY,error TEXT NOT NULL,at INTEGER NOT NULL,expires INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS metrics(
            id INTEGER PRIMARY KEY CHECK(id=1),calls INTEGER NOT NULL DEFAULT 0,
            failures INTEGER NOT NULL DEFAULT 0);
          INSERT OR IGNORE INTO metrics(id) VALUES(1);
        """)
        if "generation" not in {row["name"] for row in self.db.execute("PRAGMA table_info(sessions)")}:
            self.db.execute("ALTER TABLE sessions ADD COLUMN generation INTEGER NOT NULL DEFAULT 0")
        for table in ("jobs", "history"):
            if "analysis" not in {row["name"] for row in self.db.execute(f"PRAGMA table_info({table})")}:
                self.db.execute(f"ALTER TABLE {table} ADD COLUMN analysis TEXT")
        self.db.commit()

    def close(self):
        self.db.close()

    def transaction(self):
        self.db.execute("BEGIN IMMEDIATE")

    def config(self):
        row = self.db.execute("SELECT value FROM settings WHERE id=1").fetchone()
        return json.loads(row[0]) if row else normalized_config({})

    def prune(self, at):
        cutoff = at - RETENTION_MS
        self.db.execute("DELETE FROM history WHERE at<?", (cutoff,))
        self.db.execute("""DELETE FROM history WHERE id IN (
          SELECT id FROM (SELECT id,ROW_NUMBER() OVER(PARTITION BY identity ORDER BY at DESC,id DESC) n FROM history)
          WHERE n>50)""")
        self.db.execute("DELETE FROM jobs WHERE state NOT IN ('pending','working') AND at<?", (cutoff,))
        self.db.execute("""DELETE FROM jobs WHERE state NOT IN ('pending','working')
          AND id NOT IN (SELECT current_job FROM sessions WHERE current_job IS NOT NULL)
          AND id IN (SELECT id FROM (
            SELECT id,ROW_NUMBER() OVER(PARTITION BY identity ORDER BY at DESC,id DESC) n FROM jobs) WHERE n>50)""")
        self.db.execute("DELETE FROM provider_failures WHERE at<?", (cutoff,))
        self.db.execute("DELETE FROM sessions WHERE active=0 AND seen<? AND identity NOT IN "
                        "(SELECT identity FROM jobs WHERE state IN ('pending','working'))", (cutoff,))

    def entries(self):
        result = {}
        for row in self.db.execute("SELECT * FROM sessions WHERE active=1 ORDER BY address"):
            job = self.db.execute("SELECT * FROM jobs WHERE id=?", (row["current_job"],)).fetchone()
            previous = self.db.execute("""SELECT * FROM history WHERE identity=? AND state='ready'
              AND turn<=? AND at>=? ORDER BY at DESC,rowid DESC LIMIT 1""",
              (row["identity"], row["turn"], now() - RETENTION_MS)).fetchone()
            state = "working" if row["status"] == "working" else job["state"] if job else "empty"
            if state not in ("pending", "working", "ready", "empty", "failed"):
                state = "empty"
            visible = row["status"] in SETTLED and job and job["state"] == "ready"
            retry_at, retry_state = self.retry_details(job, now()) if job else (None, None)
            result[row["address"]] = {
                "identityKey": row["identity"], "turn": row["turn"], "state": state,
                "summary": job["summary"] if visible else None,
                "analysis": json.loads(job["analysis"]) if visible and job["analysis"] else None,
                "provider": job["provider"] if job else None, "model": job["model"] if job else None,
                "at": job["at"] if job else None, "source": job["source"] if job else None,
                "error": job["error"] if job and state == "failed" else None,
                "phase": job["error"] if job and state == "failed" else state,
                "retryAt": retry_at, "retryState": retry_state,
                "previous": {key: previous[key] for key in ("turn", "summary", "at", "provider", "model", "source")}
                            if previous else None,
            }
        return result

    def provider_failure(self, provider, model, revision):
        return self.db.execute("SELECT * FROM provider_failures WHERE key=?",
                               (encoded([provider, model, revision]),)).fetchone()

    def retry_details(self, job, at):
        if job["state"] != "failed" or job["error"] not in TRANSIENT_ERRORS:
            return None, None
        if job["attempts"] >= MAX_ATTEMPTS:
            return None, "exhausted"
        failure = self.provider_failure(job["provider"], job["model"], job["auth_revision"])
        if not failure or failure["expires"] <= 0:
            return None, None
        return failure["expires"], "waiting" if failure["expires"] > at else "available"

    def pending(self):
        return self.db.execute("""SELECT COUNT(*) FROM jobs j JOIN sessions s ON s.current_job=j.id
          WHERE s.active=1 AND s.status IN ('done','idle') AND j.state IN ('pending','working')""").fetchone()[0]

    def stats(self):
        row = self.db.execute("SELECT * FROM metrics WHERE id=1").fetchone()
        config = self.config()
        ready = self.db.execute("""SELECT COUNT(*) FROM sessions s JOIN jobs j ON s.current_job=j.id
          WHERE s.active=1 AND s.status IN ('done','idle') AND j.state='ready'""").fetchone()[0]
        failure = self.provider_failure(config["provider"], config["model"], config["authRevision"])
        return {"calls": row["calls"], "failures": row["failures"],
                "ready": ready,
                "pending": self.pending(), "provider": config["provider"], "model": config["model"],
                "providerError": failure["error"] if failure else None,
                "retryAt": failure["expires"] if failure and failure["expires"] > 0 else None,
                "inputTokens": None, "outputTokens": None, "costUSD": None}

    def response(self, **extra):
        return {"ok": True, "entries": self.entries(), "pending": self.pending(), "stats": self.stats(), **extra}

    def job_current(self, job):
        session = self.db.execute("SELECT * FROM sessions WHERE identity=? AND active=1",
                                  (job["identity"],)).fetchone()
        return bool(session and session["current_job"] == job["id"] and session["turn"] == job["turn"] and
                    session["generation"] == job["session_generation"] and
                    session["status"] in SETTLED and self.config() == job["config"])

    def observe(self, request):
        config = normalized_config(request.get("config"))
        agents = request.get("agents", [])
        if not isinstance(agents, list) or len(agents) > MAX_AGENTS:
            raise ValueError("invalid_request")
        agents = [safe_agent(agent) for agent in agents]
        if len({agent["address"] for agent in agents}) != len(agents):
            raise ValueError("invalid_request")
        at = now()
        self.transaction()
        try:
            self.db.execute("INSERT OR REPLACE INTO settings(id,value) VALUES(1,?)", (encoded(config),))
            self.db.execute("UPDATE sessions SET active=0 WHERE active=1")
            for agent in agents:
                identity = identity_key(agent)
                previous = self.db.execute("SELECT * FROM sessions WHERE identity=?", (identity,)).fetchone()
                status, turn = agent["status"], agent["turn"]
                completed = previous["completion_turn"] if previous else None
                completion = status in SETTLED and (
                    (not previous and status == "done") or
                    previous and (turn > previous["turn"] or
                                  previous["status"] == "working" and turn == previous["turn"]))
                if completion:
                    completed = turn
                generation = (previous["generation"] if previous else 0) + int(bool(completion))
                current_job, target = None, None
                desired_target = encoded([turn, config["provider"], config["model"]])
                eligible_target = status == "done" or completion or previous and previous["current_target"] == desired_target
                if config["enabled"] and config["provider"] != "none" and completed == turn and \
                        status in SETTLED and eligible_target:
                    target = desired_target
                    job = self.db.execute("SELECT * FROM jobs WHERE identity=? AND turn=? AND provider=? AND model=?",
                                          (identity, turn, config["provider"], config["model"])).fetchone()
                    if not job and (not previous or previous["current_target"] != target or completion):
                        current_job = uuid.uuid4().hex
                        self.db.execute("""INSERT INTO jobs(id,identity,turn,provider,model,auth_revision,
                          agent,state,created,at) VALUES(?,?,?,?,?,?,?,'pending',?,?)""",
                          (current_job, identity, turn, config["provider"], config["model"],
                           config["authRevision"], encoded(agent), at, at))
                    elif job:
                        current_job = job["id"]
                        if job["state"] == "failed" and job["auth_revision"] != config["authRevision"] and \
                                job["attempts"] < MAX_ATTEMPTS:
                            self.db.execute("UPDATE jobs SET state='pending',error=NULL,agent=?,auth_revision=?,at=? "
                                            "WHERE id=?", (encoded(agent), config["authRevision"], at, current_job))
                        elif job["auth_revision"] == config["authRevision"] and \
                                self.retry_details(job, at)[1] == "available":
                            self.db.execute("UPDATE jobs SET state='pending',error=NULL,agent=?,created=?,at=? "
                                            "WHERE id=?", (encoded(agent), at, at, current_job))
                        elif completion and previous and previous["completion_turn"] == turn and \
                                job["state"] in ("ready", "empty"):
                            self.db.execute("UPDATE jobs SET state='pending',summary=NULL,error=NULL,agent=?,"
                                            "created=?,at=? WHERE id=?", (encoded(agent), at, at, current_job))
                self.db.execute("""INSERT INTO sessions(identity,address,agent,turn,status,completion_turn,
                  current_target,current_job,active,seen,generation) VALUES(?,?,?,?,?,?,?,?,1,?,?)
                  ON CONFLICT(identity) DO UPDATE SET agent=excluded.agent,turn=excluded.turn,
                  status=excluded.status,completion_turn=excluded.completion_turn,current_target=excluded.current_target,
                  current_job=excluded.current_job,active=1,seen=excluded.seen,generation=excluded.generation""",
                  (identity, agent["address"], encoded(agent), turn, status, completed, target, current_job, at, generation))
            # Removed or superseded jobs must never start a fresh provider call.
            self.db.execute("""UPDATE jobs SET state='failed',error='source_changed',at=?
              WHERE state='pending' AND id NOT IN (SELECT current_job FROM sessions
                WHERE active=1 AND current_job IS NOT NULL)""", (at,))
            self.prune(at)
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return self.response()

    def claim(self):
        at, owner = now(), uuid.uuid4().hex
        self.transaction()
        try:
            lease = self.db.execute("SELECT * FROM lease WHERE id=1").fetchone()
            if lease["expires"] > at:
                self.db.commit()
                return None
            if lease["job"]:
                expired = self.db.execute("UPDATE jobs SET state='failed',error='worker_lease_expired',at=? "
                                         "WHERE id=? AND state='working'", (at, lease["job"])).rowcount
                if expired:
                    self.db.execute("UPDATE metrics SET failures=failures+? WHERE id=1", (expired,))
            row = self.db.execute("""SELECT j.*,s.generation session_generation FROM jobs j JOIN sessions s ON s.current_job=j.id
              WHERE j.state='pending' AND s.active=1 AND s.status IN ('done','idle')
              ORDER BY j.created,j.id LIMIT 1""").fetchone()
            config = self.config()
            if not row or not config["enabled"] or config["provider"] == "none":
                self.db.execute("UPDATE lease SET owner=NULL,job=NULL,expires=0 WHERE id=1")
                self.db.commit()
                return None
            if row["provider"] != config["provider"] or row["model"] != config["model"]:
                self.db.commit()
                return None
            self.db.execute("UPDATE lease SET owner=?,job=?,expires=? WHERE id=1",
                            (owner, row["id"], at + LEASE_MS))
            self.db.execute("UPDATE jobs SET state='working',owner=?,expires=?,attempts=attempts+1,at=? "
                            "WHERE id=?", (owner, at + LEASE_MS, at, row["id"]))
            self.db.commit()
            return {**dict(row), "owner": owner, "config": config}
        except Exception:
            self.db.rollback()
            raise

    def finish(self, job, state, summary, source, error, response_hash=None, publish=True, analysis=None):
        at = now()
        summary_hash = hash_of(encoded([summary, analysis])) if analysis else hash_of(summary) if summary is not None else "null"
        self.transaction()
        try:
            row = self.db.execute("SELECT * FROM jobs WHERE id=?", (job["id"],)).fetchone()
            if not row or row["owner"] != job["owner"] or row["state"] != "working":
                self.db.commit()
                return False
            self.db.execute("""UPDATE jobs SET state=?,summary=?,source=?,error=?,response_hash=?,summary_hash=?,
              at=?,analysis=?,owner=NULL,expires=NULL WHERE id=?""",
              (state, summary, source, error, response_hash, summary_hash, at, encoded(analysis) if analysis else None, job["id"]))
            if state == "failed":
                self.db.execute("UPDATE metrics SET failures=failures+1 WHERE id=1")
            response_hash = response_hash or f"failure:{job['turn']}"
            duplicate = self.db.execute("""SELECT id FROM history WHERE identity=? AND provider=? AND model=?
              AND response_hash=? AND summary_hash=? AND state=? AND error IS ?""",
              (job["identity"], job["provider"], job["model"], response_hash, summary_hash, state, error)).fetchone()
            if not duplicate:
                self.db.execute("""INSERT INTO history(id,identity,turn,summary,at,provider,model,source,
                  state,error,response_hash,summary_hash,analysis) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                  (uuid.uuid4().hex, job["identity"], job["turn"], summary, at, job["provider"], job["model"],
                   source, state, error, response_hash, summary_hash, encoded(analysis) if analysis else None))
            session = self.db.execute("SELECT * FROM sessions WHERE identity=? AND active=1",
                                      (job["identity"],)).fetchone()
            config = self.config()
            published = bool(publish and session and session["current_job"] == job["id"] and
                             session["turn"] == job["turn"] and session["generation"] == job["session_generation"] and
                             session["status"] in SETTLED and
                             config["enabled"] and config["provider"] == job["provider"] and
                             config["model"] == job["model"] and
                             config["authRevision"] == job["config"]["authRevision"])
            if not published:
                newer_generation = session and session["current_job"] == job["id"] and \
                    session["turn"] == job["turn"] and session["generation"] > job["session_generation"] and \
                    session["status"] in SETTLED and config == job["config"]
                if newer_generation:
                    self.db.execute("UPDATE jobs SET state='pending',summary=NULL,error=NULL,agent=?,created=?,at=? "
                                    "WHERE id=?", (session["agent"], at, at, job["id"]))
                else:
                    self.db.execute("UPDATE sessions SET current_job=NULL WHERE identity=? AND current_job=?",
                                    (job["identity"], job["id"]))
            self.db.execute("UPDATE lease SET owner=NULL,job=NULL,expires=0 WHERE id=1 AND owner=?",
                            (job["owner"],))
            self.prune(at)
            self.db.commit()
            return published
        except Exception:
            self.db.rollback()
            raise

    def work(self, request, adapter=None, get=None):
        if request.get("config") is not None and normalized_config(request["config"]) != self.config():
            return self.response(claimed=False, reason="configuration_changed")
        job = self.claim()
        if not job:
            return self.response(claimed=False)
        state, summary, source, error, response_hash = "failed", None, None, None, None
        analysis = None
        publish, called, blocked_failure = True, False, False
        agent = json.loads(job["agent"])
        get = get or native_get
        provider_key = encoded([job["provider"], job["model"], job["config"]["authRevision"]])
        try:
            adapter = adapter or load_native(request.get("appHome", str(Path.home() / ".config/herdr-app")))
            validate_native(agent, get(agent["address"]))
            blocked = self.db.execute("SELECT * FROM provider_failures WHERE key=?", (provider_key,)).fetchone()
            if blocked and (blocked["expires"] == 0 or blocked["expires"] > now()):
                blocked_failure = True
                raise RuntimeError(blocked["error"])
            auth = adapter.auth_status(job["provider"])
            if not auth.get("subscription"):
                raise RuntimeError("login_required")
            excerpt, source = adapter.source_excerpt(agent)
            if source not in ("session", "terminal"):
                raise RuntimeError("invalid_output")
            validate_native(agent, get(agent["address"]))
            if excerpt:
                excerpt = redact(excerpt)[:12000]
                response_hash = hash_of("reading-value-v1:" + excerpt)
                cached = self.db.execute("""SELECT * FROM history WHERE identity=? AND provider=? AND model=?
                  AND response_hash=? AND state IN ('ready','empty') ORDER BY at DESC LIMIT 1""",
                  (job["identity"], job["provider"], job["model"], response_hash)).fetchone()
                if cached:
                    summary = cached["summary"]
                    analysis = json.loads(cached["analysis"]) if cached["analysis"] else None
                else:
                    if not self.job_current(job):
                        raise RuntimeError("configuration_changed")
                    called = True
                    with self.db:
                        self.db.execute("UPDATE metrics SET calls=calls+1 WHERE id=1")
                    summary = adapter.complete(job["provider"], job["model"], excerpt)
                    if isinstance(summary, dict):
                        value = parse_value(summary)
                        analysis = grounded_analysis(value, excerpt)
                        summary = value["summary"]
                    if summary is not None and (not isinstance(summary, str) or not summary.strip() or
                                               len(summary.strip()) > 80 or "\n" in summary or "\r" in summary or
                                               any(ord(c) < 32 for c in summary)):
                        raise RuntimeError("invalid_output")
                    summary = redact(summary.strip()) if summary is not None else None
                    if summary is not None and len(summary) > 80:
                        raise RuntimeError("invalid_output")
                state = "ready" if summary is not None else "empty"
                if called:
                    with self.db:
                        self.db.execute("DELETE FROM provider_failures WHERE key=?", (provider_key,))
            else:
                response_hash = "empty"
                state = "empty"
            # Reading and summarizing happen outside SQLite transactions.
            # A newer native turn can invalidate publishing even before the UI polls again.
            try:
                validate_native(agent, get(agent["address"]))
            except RuntimeError:
                publish = False
        except Exception as failure:
            error = error_code(failure)
            publish = error not in ("source_changed", "native_identity_unavailable", "configuration_changed")
            if not blocked_failure and error in ("not_installed", "login_required", "update_required", "usage_limit",
                         "provider_failed", "timeout"):
                expires = 0 if error in ("not_installed", "login_required", "update_required") else now() + (
                    3600000 if error == "usage_limit" else 60000)
                with self.db:
                    self.db.execute("INSERT OR REPLACE INTO provider_failures(key,error,at,expires) VALUES(?,?,?,?)",
                                    (provider_key, error, now(), expires))
        published = self.finish(job, state, summary, source, error, response_hash, publish, analysis)
        return self.response(claimed=True, published=published, modelCalled=called)

    def history(self, request):
        identity = request.get("identityKey")
        if not isinstance(identity, str) or len(identity) > 2000:
            raise ValueError("invalid_request")
        try:
            limit = max(1, min(50, int(request.get("limit", 30))))
        except (ValueError, TypeError):
            raise ValueError("invalid_request") from None
        items = [{key: row[key] for key in ("id", "turn", "summary", "at", "provider", "model", "source",
                                          "state", "error")}
                 for row in self.db.execute("SELECT * FROM history WHERE identity=? AND at>=? "
                                            "ORDER BY at DESC,rowid DESC LIMIT ?",
                                            (identity, now() - RETENTION_MS, limit))]
        return {"ok": True, "history": items, "entries": items}


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    try:
        if not argv or argv[0] not in ("observe", "work", "history"):
            raise ValueError("invalid_request")
        raw = argv[1] if len(argv) == 2 else sys.stdin.read(262145) if len(argv) == 1 else ""
        if not raw or len(raw.encode("utf-8")) > 262144:
            raise ValueError("invalid_request")
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ValueError("invalid_request")
        state_dir = request.get("stateDir")
        if not isinstance(state_dir, str) or not state_dir:
            raise ValueError("invalid_request")
        store = Store(state_dir)
        try:
            result = getattr(store, argv[0])(request)
        finally:
            store.close()
        print(encoded(result))
        return 0
    except (ValueError, OSError, sqlite3.Error):
        print(encoded({"ok": False, "error": "invalid_request"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())

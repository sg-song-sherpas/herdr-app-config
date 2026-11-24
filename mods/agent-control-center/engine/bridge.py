#!/usr/bin/env python3
"""Herdr Control Center: local, read-only observations and durable event memory.

Only SQLite and this engine's own directory are written. Git operations never
change the index, worktree, branches or refs. Transcript text is data, not code.
"""
from __future__ import annotations

import concurrent.futures
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import shlex
import sqlite3
import subprocess
import sys
import threading
import time

VERSION = 1
GIT_ANALYSIS_VERSION = 4
MAX_AGENTS = 256
MAX_WORKTREES = 48
MAX_FILES = 160
MAX_OUTPUT = 512 * 1024
MAX_LOG_READ = 512 * 1024
MAX_EVENTS = 300
MAX_RESPONSE_BYTES = 2 * 1024 * 1024
MAX_OBSERVED_HEAD_CHANGES = 8
UNKNOWN = "Unknown"
_budget = threading.local()


class GitError(RuntimeError):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def now():
    return int(time.time() * 1000)


def encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def safe_text(value, limit=800):
    if not isinstance(value, str):
        return ""
    return re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", value).strip()[:limit]


def secret_filtered(text):
    """Local display protection; no promise of exhaustive secret detection."""
    text = re.sub(r"(?i)\b(?:sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{16,})\b",
                  "[REDACTED]", text)
    return re.sub(r"(?i)((?:password|api[_-]?key|secret|token)\s*[=:]\s*)[^\s,;\"']+",
                  r"\1[REDACTED]", text)


def git_executable():
    candidate = shutil.which("git") or "git"
    clt_git = "/Library/Developer/CommandLineTools/usr/bin/git"
    # The system wrapper can require a newly installed Xcode's license even
    # when the existing Command Line Tools git remains available. This chooses
    # that executable only; it never changes license or xcode-select settings.
    if sys.platform == "darwin" and candidate == "/usr/bin/git" and os.access(clt_git, os.X_OK):
        return clt_git
    return candidate


def run_git(cwd, args, timeout=3, limit=MAX_OUTPUT):
    """Bound wall time and captured output; kill only our own read-only git child."""
    deadline = getattr(_budget, "deadline", None)
    if deadline:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Git collection budget exhausted; queued for next refresh")
        timeout = min(timeout, remaining)
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_TERMINAL_PROMPT="0",
               GIT_PAGER="cat", LC_ALL="C")
    proc = subprocess.Popen([git_executable(), "-c", "core.fsmonitor=false", "-C", cwd, *args],
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=env)
    selector = selectors.DefaultSelector()
    selector.register(proc.stdout, selectors.EVENT_READ, "stdout")
    selector.register(proc.stderr, selectors.EVENT_READ, "stderr")
    buffers = {"stdout": bytearray(), "stderr": bytearray()}
    end = time.monotonic() + timeout
    truncated = False
    try:
        while selector.get_map():
            if time.monotonic() > end:
                raise TimeoutError("Git observation timed out")
            for key, _ in selector.select(min(.1, max(0, end - time.monotonic()))):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    selector.unregister(key.fileobj)
                    continue
                remaining = limit - sum(len(v) for v in buffers.values())
                buffers[key.data].extend(data[:max(0, remaining)])
                if len(data) > remaining:
                    truncated = True
                    proc.kill()
                    break
            if truncated:
                break
        proc.wait(timeout=max(.1, end - time.monotonic()))
    except Exception:
        proc.kill()
        proc.wait()
        raise
    finally:
        selector.close()
        proc.stdout.close()
        proc.stderr.close()
    stdout = buffers["stdout"].decode("utf-8", "replace")
    stderr = buffers["stderr"].decode("utf-8", "replace")
    if proc.returncode and not truncated:
        raise GitError(proc.returncode, safe_text(stderr, 500) or f"git exit {proc.returncode}")
    return stdout, truncated


def git_text(cwd, args):
    return run_git(cwd, args)[0].strip()


def parse_status(text):
    parts = text.split("\0")
    files, conflicts = [], []
    index = 0
    while index < len(parts):
        record = parts[index]
        index += 1
        if len(record) < 4:
            continue
        status, path = record[:2], record[3:]
        files.append(path)
        if "R" in status or "C" in status:
            index += 1
        if status in ("DD", "AU", "UD", "UA", "DU", "AA", "UU"):
            conflicts.append(path)
    return sorted(set(files)), sorted(set(conflicts))


def symbols_from_diff(text):
    """Heuristics, explicitly potential; never claims compiler/AST certainty."""
    symbols, contracts, references = set(), set(), set()
    patterns = [
        r"(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|struct|trait|def|fn)\s+([A-Za-z_]\w*)",
        r"\(def(?:n|record|protocol|multi|method)?\s+([A-Za-z_][\w!?./-]*)",
        r"\b(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?[\"`]?([\w.]+)",
    ]
    contract_patterns = [
        r"\b(?:class|interface|type|enum|struct|trait)\s+([A-Za-z_]\w*)",
        r"\((?:defrecord|defprotocol|deftype)\s+([A-Za-z_][\w!?./-]*)",
        r"\b(?:CREATE|ALTER|DROP)\s+TABLE\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?[\"`]?([\w.]+)",
        r"\bexport\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_]\w*)",
        r"\bpub(?:\([^)]*\))?\s+(?:async\s+)?fn\s+([A-Za-z_]\w*)",
    ]
    primitives = {"string", "number", "boolean", "bool", "int", "float", "double", "void", "any",
                  "unknown", "object", "array", "null", "none", "never", "error", "exception",
                  "export", "interface", "type", "return", "class", "struct", "trait", "self", "this"}
    for line in text.splitlines():
        if line.startswith(("+", "-", "@@", " ")) and not line.startswith(("+++", "---")):
            for pattern in patterns:
                symbols.update(re.findall(pattern, line, re.I))
            for pattern in contract_patterns:
                contracts.update(re.findall(pattern, line, re.I))
            references.update(re.findall(r"\b[A-Za-z_]\w{2,}\b", line))
    symbols = {name for name in symbols if name.lower() not in primitives}
    contracts = {name for name in contracts if name.lower() not in primitives and len(name) > 1}
    return sorted(symbols)[:160], sorted(contracts)[:160], sorted(references)[:1000]


def definitions_by_file(text):
    """Keep declarations attached to their actual diff file, not a global bag."""
    output, old_path, current_path, lines = {}, None, None, []

    def decoded_path(raw):
        value = raw.strip()
        if value.startswith('"'):
            try:
                value = ast.literal_eval(value)
                try:
                    value = value.encode("latin1").decode("utf-8")
                except (UnicodeEncodeError, UnicodeDecodeError):
                    pass
            except (ValueError, SyntaxError):
                return None
        if value == "/dev/null":
            return None
        return value[2:] if value.startswith(("a/", "b/")) else value

    def finish():
        if not current_path or len(output) >= MAX_FILES:
            return
        symbols, contracts, _references = symbols_from_diff("\n".join(lines))
        if symbols or contracts:
            output[current_path] = {"symbols": symbols[:40], "contracts": contracts[:40]}

    for line in text.splitlines():
        if line.startswith("diff --git "):
            finish()
            old_path, current_path, lines = None, None, []
        elif line.startswith("--- "):
            old_path = decoded_path(line[4:])
        elif line.startswith("+++ "):
            current_path = decoded_path(line[4:]) or old_path
        else:
            lines.append(line)
    finish()
    return output


def observed_head_history(previous):
    history = previous.get("recentHistory", [])
    if not isinstance(history, list):
        history = []
    history = [change for change in history if isinstance(change, dict) and
               all(isinstance(change.get(key), str) and re.fullmatch(r"[0-9a-f]{40,64}", change[key])
                   for key in ("fromHead", "toHead"))][-MAX_OBSERVED_HEAD_CHANGES:]
    # Upgrade the previous single-transition cache without inventing a
    # transition from the branch's historical merge-base diff.
    if not history and "recentHistory" not in previous and all(isinstance(previous.get(key), str) and
                           re.fullmatch(r"[0-9a-f]{40,64}", previous[key])
                           for key in ("recentFromHead", "recentToHead")):
        history = [{"fromHead": previous["recentFromHead"], "toHead": previous["recentToHead"],
                    "files": previous.get("recentFiles", []),
                    "symbols": previous.get("recentSymbols", []),
                    "contracts": previous.get("recentContracts", []),
                    "references": previous.get("recentReferences", []),
                    "definitions": previous.get("recentDefinitions", {}),
                    "observedAt": previous.get("recentObservedAt")}]
    return history


def aggregate_observed_history(history, history_truncated=False):
    files, symbols, contracts, references, definitions = set(), set(), set(), set(), {}
    for change in history:
        files.update(change.get("files", []))
        symbols.update(change.get("symbols", []))
        contracts.update(change.get("contracts", []))
        references.update(change.get("references", []))
        for path, declaration in change.get("definitions", {}).items():
            entry = definitions.setdefault(path, {"symbols": set(), "contracts": set()})
            entry["symbols"].update(declaration.get("symbols", []))
            entry["contracts"].update(declaration.get("contracts", []))
    file_limit_reached = len(files) > MAX_FILES
    retained_files = sorted(files)[:MAX_FILES]
    return {"recentHistory": list(history), "recentFiles": retained_files,
            "recentSymbols": sorted(symbols)[:160], "recentContracts": sorted(contracts)[:160],
            "recentReferences": sorted(references)[:1000],
            "recentDefinitions": {path: {key: sorted(names)[:40] for key, names in declaration.items()}
                                  for path, declaration in definitions.items() if path in retained_files},
            "recentFromHead": history[0]["fromHead"], "recentToHead": history[-1]["toHead"],
            "recentObservedAt": history[-1].get("observedAt"),
            "recentHistoryTruncated": history_truncated or file_limit_reached}


def git_observation(path, deadline=None, previous=None):
    _budget.deadline = deadline
    observed_at = now()
    try:
        root = git_text(path, ["rev-parse", "--show-toplevel"])
        common = git_text(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
        head = git_text(path, ["rev-parse", "HEAD"])
        try:
            branch = git_text(path, ["symbolic-ref", "--quiet", "--short", "HEAD"])
        except RuntimeError:
            branch = f"detached@{head[:8]}"
        raw, truncated = run_git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"])
        dirty, actual = parse_status(raw)
        base = None
        for candidate in ("origin/main", "origin/master", "main", "master"):
            try:
                candidate_head = git_text(path, ["rev-parse", "--verify", candidate])
                if candidate_head != head:
                    base = git_text(path, ["merge-base", "HEAD", candidate])
                    break
            except (RuntimeError, TimeoutError, OSError):
                continue
        committed = []
        committed_diff = ""
        if base:
            names, cut = run_git(path, ["diff", "--name-only", "-z", base, "HEAD"])
            committed = [p for p in names.split("\0") if p]
            truncated |= cut
            committed_diff, cut = run_git(path, ["diff", "--no-ext-diff", "--no-textconv", "--unified=3",
                                               base, "HEAD", "--", *committed[:MAX_FILES]])
            truncated |= cut
        diff, cut = run_git(path, ["diff", "--no-ext-diff", "--no-textconv", "--unified=3", "HEAD",
                                 "--", *dirty[:MAX_FILES]])
        truncated |= cut or len(dirty) + len(committed) > MAX_FILES
        symbols, contracts, references = symbols_from_diff(diff + "\n" + committed_diff)
        dirty_symbols, dirty_contracts, dirty_references = symbols_from_diff(diff)
        dirty_definitions = definitions_by_file(diff)
        branch_symbols, branch_contracts, branch_references = symbols_from_diff(committed_diff)
        previous = previous or {}
        history = observed_head_history(previous)
        history_truncated = bool(previous.get("recentHistoryTruncated"))
        recent = aggregate_observed_history(history, history_truncated) if history else {}
        # Detailed transitions are bounded, but their current net effect is
        # measured from the first actually observed HEAD, never a merge-base.
        # This prevents unrelated later commits from evicting an API change.
        baseline = previous.get("recentBaselineHead") or previous.get("recentFromHead")
        if not isinstance(baseline, str) or not re.fullmatch(r"[0-9a-f]{40,64}", baseline):
            baseline = None
        if history or baseline:
            for key in ("recentHistory", "recentFiles", "recentSymbols", "recentContracts", "recentReferences",
                        "recentDefinitions", "recentFromHead", "recentBaselineHead",
                        "recentToHead", "recentObservedAt", "recentScopeTruncated", "recentError"):
                if key in previous:
                    recent[key] = previous[key]
        old_head = previous.get("head")
        if isinstance(old_head, str) and re.fullmatch(r"[0-9a-f]{40,64}", old_head) and old_head != head:
            try:
                baseline = baseline or old_head
                names, cut = run_git(path, ["diff", "--name-only", "-z", old_head, head])
                recent_files = [name for name in names.split("\0") if name]
                recent_diff, more = run_git(path, ["diff", "--no-ext-diff", "--no-textconv", "--unified=3",
                                                  old_head, head, "--", *recent_files[:MAX_FILES]])
                rs, rc, rr = symbols_from_diff(recent_diff)
                change = {"fromHead": old_head, "toHead": head, "files": recent_files[:MAX_FILES],
                          "symbols": rs, "contracts": rc, "references": rr,
                          "definitions": definitions_by_file(recent_diff), "observedAt": observed_at}
                history.append(change)
                history_truncated |= len(history) > MAX_OBSERVED_HEAD_CHANGES
                history = history[-MAX_OBSERVED_HEAD_CHANGES:]
                truncated |= cut or more or len(recent_files) > MAX_FILES
                if baseline != old_head:
                    names, cut = run_git(path, ["diff", "--name-only", "-z", baseline, head])
                    recent_files = [name for name in names.split("\0") if name]
                    recent_diff, more = run_git(path, ["diff", "--no-ext-diff", "--no-textconv", "--unified=3",
                                                      baseline, head, "--", *recent_files[:MAX_FILES]])
                    rs, rc, rr = symbols_from_diff(recent_diff)
                    truncated |= cut or more or len(recent_files) > MAX_FILES
                recent = {"recentHistory": history, "recentHistoryTruncated": history_truncated,
                          "recentFiles": recent_files[:MAX_FILES], "recentSymbols": rs,
                          "recentContracts": rc, "recentReferences": rr,
                          "recentDefinitions": definitions_by_file(recent_diff),
                          "recentFromHead": baseline, "recentBaselineHead": baseline,
                          "recentToHead": head, "recentObservedAt": observed_at,
                          "recentScopeTruncated": bool(cut or more or len(recent_files) > MAX_FILES)}
            except (RuntimeError, TimeoutError, OSError) as error:
                # Keep known observed evidence as repository context on an
                # analysis failure; do not pretend it describes the new HEAD.
                recent["recentError"] = safe_text(str(error), 200)
                recent["recentBaselineHead"] = baseline
        elif previous.get("recentError") and baseline and baseline != head:
            try:
                names, cut = run_git(path, ["diff", "--name-only", "-z", baseline, head])
                recent_files = [name for name in names.split("\0") if name]
                recent_diff, more = run_git(path, ["diff", "--no-ext-diff", "--no-textconv", "--unified=3",
                                                  baseline, head, "--", *recent_files[:MAX_FILES]])
                rs, rc, rr = symbols_from_diff(recent_diff)
                recent.update({"recentHistory": list(history),
                               "recentFiles": recent_files[:MAX_FILES], "recentSymbols": rs,
                               "recentContracts": rc, "recentReferences": rr,
                               "recentDefinitions": definitions_by_file(recent_diff),
                               "recentFromHead": baseline, "recentBaselineHead": baseline,
                               "recentToHead": head, "recentObservedAt": observed_at,
                               "recentScopeTruncated": bool(cut or more or len(recent_files) > MAX_FILES)})
                recent.pop("recentError", None)
                truncated |= cut or more or len(recent_files) > MAX_FILES
            except (RuntimeError, TimeoutError, OSError) as error:
                recent["recentError"] = safe_text(str(error), 200)
                recent["recentBaselineHead"] = baseline
        return {
            "ok": True, "observedAt": observed_at, "root": os.path.realpath(root),
            "commonDir": os.path.realpath(common), "head": head, "branch": branch,
            "files": sorted(set(dirty + committed))[:MAX_FILES],
            "dirtyFiles": dirty[:MAX_FILES], "branchFiles": committed[:MAX_FILES],
            "actualConflicts": actual[:MAX_FILES], "dirty": bool(dirty),
            "base": base, "symbols": symbols, "contracts": contracts,
            "references": references, "truncated": truncated,
            "dirtySymbols": dirty_symbols, "dirtyContracts": dirty_contracts, "dirtyReferences": dirty_references,
            "branchSymbols": branch_symbols, "branchContracts": branch_contracts,
            "branchReferences": branch_references, "analysisVersion": GIT_ANALYSIS_VERSION,
            "dirtyDefinitions": dirty_definitions, **recent,
            "fingerprint": digest([head, raw, diff, committed_diff]),
            "source": "git_observation",
        }
    except (RuntimeError, TimeoutError, OSError) as error:
        return {"ok": False, "observedAt": observed_at, "root": path, "files": [],
                "branch": UNKNOWN, "head": UNKNOWN, "error": safe_text(str(error), 300)}


def current_change_scope(task):
    """Current dirty paths and observed repository changes, independent of UI ACK."""
    git = task.get("git", {})
    dirty_files = {name for name in git.get("dirtyFiles", []) if not name.endswith("/")}
    baseline = git.get("recentBaselineHead")
    proven_baseline = isinstance(baseline, str) and re.fullmatch(r"[0-9a-f]{40,64}", baseline)
    recent_current = bool(git.get("recentToHead") == git.get("head") and
                          git.get("recentFiles") and (proven_baseline or observed_head_history(git)))
    recent_files = set(git.get("recentFiles", [])) if recent_current else set()
    definitions = {}
    for field in ("dirtyDefinitions", "recentDefinitions") if recent_current else ("dirtyDefinitions",):
        for path, declaration in git.get(field, {}).items():
            if path in dirty_files or path in recent_files:
                entry = definitions.setdefault(path, {"symbols": set(), "contracts": set()})
                entry["symbols"].update(declaration.get("symbols", []))
                entry["contracts"].update(declaration.get("contracts", []))
    return {"files": dirty_files | recent_files, "dirtyFiles": dirty_files, "recentFiles": recent_files,
            "symbols": set(git.get("dirtySymbols", [])) |
                       (set(git.get("recentSymbols", [])) if recent_current else set()),
            "contracts": set(git.get("dirtyContracts", [])) |
                         (set(git.get("recentContracts", [])) if recent_current else set()),
            "references": set(git.get("dirtyReferences", [])) |
                          (set(git.get("recentReferences", [])) if recent_current else set()),
            "definitions": definitions, "recentObserved": recent_current}


def resume_of(agent):
    value = agent.get("resume")
    if not value:
        try:
            value = json.loads(agent.get("labels", {}).get("herdr.resume", "null"))
        except (ValueError, TypeError):
            value = None
    if not isinstance(value, dict):
        return None
    if value.get("pid") and agent.get("foreground", {}).get("pid") and \
            value["pid"] != agent["foreground"]["pid"]:
        return None
    if value.get("agent") not in ("codex", "claude") or \
            not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", str(value.get("id", ""))):
        return None
    return value


def identity_of(agent):
    resume = resume_of(agent)
    born = agent.get("created_ms") or agent.get("created") or agent.get("identity")
    pid = agent.get("foreground", {}).get("pid") or agent.get("pid")
    # Never share state based solely on an address that the core can reuse.
    return digest([agent["address"], born or None, resume.get("id") if resume else pid or None,
                   agent.get("machine") or None,
                   agent.get("cwd") if not born and not resume and not pid else None])[:32]


def transcript_path(agent):
    if agent.get("machine") or "/" in agent["address"]:
        return None
    resume = resume_of(agent)
    if not resume:
        return None
    kind, session = resume["agent"], resume["id"]
    root = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "sessions" if kind == "codex" \
        else Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude")) / "projects"
    pattern = f"*{session}.jsonl" if kind == "codex" else f"{session}.jsonl"
    matches = []
    # Captured session only; do not parse unrelated conversations.
    for path in root.glob(f"**/{pattern}"):
        if path.is_file() and (path.stem == session or path.stem.endswith("-" + session)):
            matches.append(path)
            if len(matches) > 1:
                return None
    return (matches[0], kind) if len(matches) == 1 else None


def session_root(kind):
    return ((Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "sessions") if kind == "codex"
            else (Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude")) / "projects")).resolve()


def allowed_log_path(path, kind, session):
    try:
        resolved = Path(path).resolve()
        resolved.relative_to(session_root(kind))
        if resolved.is_file() and (resolved.stem == session or resolved.stem.endswith("-" + session)):
            return resolved
    except (OSError, ValueError):
        pass
    return None


def open_session_of(agent, runner=subprocess.run):
    """Recover pre-hook Codex association only from this exact foreground PID.

    No directory-recency guess, process traversal, hook installation or mutation.
    An ambiguous/mismatched candidate deliberately stays Unknown.
    """
    pid = agent.get("foreground", {}).get("pid")
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return None
    if agent.get("machine") or "/" in agent["address"]:
        return None
    name = str(agent.get("app") or agent.get("foreground", {}).get("name") or "").lower()
    if "codex" not in name:
        return None
    executable = shutil.which("lsof") or ("/usr/sbin/lsof" if Path("/usr/sbin/lsof").is_file() else None)
    if not executable:
        return None
    root = (Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "sessions").resolve()
    try:
        result = runner([executable, "-a", "-p", str(pid), "-Fn"], stdin=subprocess.DEVNULL,
                        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=.8, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    output = result.stdout.decode("utf-8", "replace") if isinstance(result.stdout, bytes) else result.stdout
    if not isinstance(output, str) or len(output) > MAX_OUTPUT:
        return None
    candidates = set()
    for line in output.splitlines():
        if not line.startswith("n") or not line.endswith(".jsonl"):
            continue
        path = Path(line[1:])
        try:
            resolved = path.resolve()
            resolved.relative_to(root)
            candidates.add(resolved)
        except (ValueError, OSError):
            continue
    if len(candidates) > 32:
        return None
    matches = []
    for path in candidates:
        try:
            with path.open("rb") as stream:
                first_line = stream.readline(65536)
            record = json.loads(first_line)
            metadata = record.get("payload", {})
            if record.get("type") != "session_meta" or metadata.get("source") != "cli":
                continue
            session = metadata.get("id")
            if not isinstance(session, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session):
                continue
            if not metadata.get("cwd") or os.path.realpath(metadata["cwd"]) != os.path.realpath(agent.get("cwd", "")):
                continue
            matches.append({"agent": "codex", "id": session, "cwd": metadata["cwd"], "pid": pid,
                            "associationSource": "foreground_open_file", "path": str(path)})
        except (OSError, ValueError, TypeError, AttributeError):
            continue
    return matches[0] if len(matches) == 1 else None


def message_text(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(c.get("text", "") for c in content if isinstance(c, dict) and
                     c.get("type") in ("text", "input_text", "output_text") and
                     isinstance(c.get("text"), str))


def protocol_setup(text):
    """Only known complete harness setup shapes, never generic mentions."""
    stripped = text.strip()
    if re.match(r"\A# AGENTS\.md instructions for [^\n]+\n", stripped) and \
            "<INSTRUCTIONS>" in stripped and "</INSTRUCTIONS>" in stripped:
        remainder = stripped.split("</INSTRUCTIONS>", 1)[1].strip()
        return not remainder or bool(re.fullmatch(r"<environment_context>[\s\S]*</environment_context>", remainder))
    return any(re.fullmatch(re.escape(opening) + r"[\s\S]*" + re.escape(closing), stripped)
               for opening, closing in (("<environment_context>", "</environment_context>"),
                                        ("<permissions instructions>", "</permissions instructions>")))


def transcript_events(record, kind):
    if kind == "codex":
        if record.get("type") == "response_item":
            item = record.get("payload", {})
            if item.get("type") == "message" and item.get("role") in ("user", "assistant"):
                text = message_text(item.get("content"))
                if text:
                    return [(item["role"], text, item.get("phase"))]
        return []
    item = record.get("message", {})
    if record.get("type") in ("user", "assistant") and not record.get("isMeta"):
        text = message_text(item.get("content"))
        if text:
            return [(record["type"], text, None)]
    return []


def rule_snapshot(text):
    """Extract explicitly labelled state; do not invent task semantics."""
    result = {}
    aliases = {
        "goal": ("Goal", "목표", "작업 목표"),
        "currentStep": ("Current", "Current step", "현재", "현재 단계"),
        "nextAction": ("Next", "Next action", "다음", "다음 작업"),
        "decisions": ("Decision", "결정", "설계 결정"),
        "blockers": ("Blocker", "Blocked", "차단", "차단 요인"),
        "completedSteps": ("Completed", "완료", "완료 작업"),
    }
    for field, names in aliases.items():
        found = []
        for name in names:
            found += re.findall(r"(?im)^\s*(?:[-*#]+\s*)?" + re.escape(name) +
                                r"\s*[:：]\s*(.{1,800})$", text)
        if found:
            result[field] = [safe_text(v) for v in found[:20]] if field in \
                ("decisions", "blockers", "completedSteps") else safe_text(found[-1])
    return result


def test_command(command):
    """Conservative known test executable, never a mention inside shell text."""
    if not isinstance(command, str) or len(command) > 8192 or \
            re.search(r"[|;&><\n\r`$]", command):
        return None
    try:
        arguments = shlex.split(command, posix=True)
    except ValueError:
        return None
    if not arguments:
        return None
    executable = Path(arguments[0]).name.lower()
    args = arguments[1:]
    if executable in ("pytest", "py.test"):
        return "pytest"
    if re.fullmatch(r"python(?:\d+(?:\.\d+)*)?", executable):
        while args and args[0] in ("-u", "-B", "-I"):
            args = args[1:]
        if args[:2] == ["-m", "pytest"]:
            return "pytest"
        if args[:2] == ["-m", "unittest"]:
            return "unittest"
        return None
    if executable == "cargo" and args[:1] == ["test"]:
        return "cargo"
    if executable == "cargo" and args[:2] == ["nextest", "run"]:
        return "cargo"
    if executable in ("npm", "pnpm", "yarn", "bun") and (
            args[:1] == ["test"] or args[:2] == ["run", "test"]):
        return executable
    if executable in ("vitest", "jest"):
        return executable
    if executable == "node" and args[:1] == ["--test"]:
        return "node"
    if executable == "go" and args[:1] == ["test"]:
        return "go"
    return None


def execution_envelope(output):
    """Read execution metadata only from known tool envelopes, before stdout."""
    if isinstance(output, dict):
        code = output.get("exit_code")
        stdout = output.get("stdout")
        if isinstance(code, int) and not isinstance(code, bool) and isinstance(stdout, str):
            return code, None, stdout
        return None
    if not isinstance(output, str):
        return None
    match = re.fullmatch(
        r"Chunk ID: [^\n]+\nWall time: [^\n]+\n"
        r"(?:Process exited with code (?P<code>-?\d+)|Process running with session ID (?P<session>\d+))\n"
        r"(?:Original token count: \d+\n)?(?:Final output|Output):\n(?P<body>[\s\S]*)", output)
    if match:
        return int(match["code"]) if match["code"] is not None else None, match["session"], match["body"]
    match = re.fullmatch(
        r"Wall time: [^\n]+\nExit code: (?P<code>-?\d+)\nOutput:\n(?P<body>[\s\S]*)", output)
    return (int(match["code"]), None, match["body"]) if match else None


def recorded_pass_count(body, runner, code):
    if code != 0:
        return UNKNOWN
    patterns = {
        "pytest": r"(?m)^=*\s*(\d+)\s+passed(?:[^\n]*?)\s+in\s+[\d.]+s",
        "cargo": r"(?m)^test result: ok\.\s+(\d+) passed;",
        "unittest": r"(?m)^Ran (\d+) tests? in [\d.]+s",
        "node": r"(?m)^# pass (\d+)\s*$",
        "jest": r"(?m)^\s*Tests:\s*(\d+) passed",
        "vitest": r"(?m)^\s*Tests\s+(\d+) passed",
    }
    pattern = patterns.get(runner)
    counts = re.findall(pattern, body) if pattern else []
    return sum(map(int, counts)) if counts else UNKNOWN


def recorded_test(record, cursor, evidence):
    """Match a known test tool call with its own recorded completion output.

    This proves what the recorded tool returned, not that tests were rerun by
    the collector or that the test command fully validates the implementation.
    """
    if record.get("type") != "response_item":
        return None
    item = record.get("payload", {})
    kind = item.get("type")
    calls = cursor.setdefault("testCalls", {})
    sessions = cursor.setdefault("testSessions", {})
    call_id = item.get("call_id")
    if kind == "function_call" and isinstance(call_id, str):
        try:
            arguments = json.loads(item.get("arguments", "{}"))
        except (ValueError, TypeError):
            return None
        name = str(item.get("name", "")).split(".")[-1]
        command = arguments.get("cmd") or arguments.get("command")
        runner = test_command(command)
        if name in ("exec_command", "exec") and runner:
            calls[call_id] = {"command": secret_filtered(safe_text(command, 800)), "runner": runner}
        elif name == "write_stdin" and str(arguments.get("session_id")) in sessions:
            calls[call_id] = dict(sessions[str(arguments["session_id"])])
        while len(calls) > 32:
            calls.pop(next(iter(calls)))
        return None
    if kind != "function_call_output" or call_id not in calls:
        return None
    test = calls.pop(call_id)
    envelope = execution_envelope(item.get("output"))
    if not envelope:
        return None
    code, session, body = envelope
    if code is None:
        if session:
            sessions[session] = test
            while len(sessions) > 32:
                sessions.pop(next(iter(sessions)))
        return None
    result = {**test, "name": test["command"], "result": "passed" if code == 0 else "failed",
              "exitCode": code, "testsPassed": recorded_pass_count(body, test.get("runner"), code),
              "source": "test_log", "verified": True, "verification": "recorded_tool_result",
              "evidence": {**evidence, "callId": call_id}, "outputExcerpt": secret_filtered(body[-2000:])}
    result["testKey"] = digest([test.get("runner"), shlex.split(test["command"])])
    return result


def latest_recorded_tests(tests):
    latest = {}
    for index, test in enumerate(tests or []):
        if not isinstance(test, dict):
            continue
        key = test.get("testKey") or test.get("command") or test.get("name")
        if key:
            latest[key] = (index, test)
    return [test for _index, test in sorted(latest.values(), key=lambda item: item[0])]


def bounded_value(value, string_limit=400, list_limit=12, depth=5):
    """A view projection only. Never writes shortened evidence back to SQLite."""
    if isinstance(value, str):
        return value if len(value) <= string_limit else value[:string_limit] + "…"
    if isinstance(value, list):
        return [bounded_value(item, string_limit, list_limit, depth - 1)
                for item in value[:list_limit]] if depth > 0 else {"items": len(value), "viewTruncated": True}
    if isinstance(value, dict):
        if depth <= 0:
            return {"viewTruncated": True}
        return {key: bounded_value(item, string_limit, list_limit, depth - 1)
                for key, item in list(value.items())[:32]}
    return value


def project_task(task, level):
    limits = ((400, 12), (200, 4), (120, 2))
    string_limit, list_limit = limits[min(level, 2)]
    # Navigation/identity and exact acknowledgment boundaries stay intact.
    preserve = {"taskId", "address", "pane", "tabName", "worktreePath", "branch", "repositoryId",
                "status", "snapshotVersion", "lastReviewedEventId", "updatedAt", "stale",
                "delta", "pendingCompletionEventId", "syncPending", "logLagBytes",
                "sourceCollectedThrough", "sourceCollectedAt", "sourceObservedSize", "sourceLog"}
    projected = {key: value if key in preserve or key == "events" else
                 bounded_value(value, string_limit, list_limit, 5 if level == 0 else 3)
                 for key, value in task.items()}
    projected["events"] = [
        {**event, "evidence": bounded_value(event.get("evidence", {}), string_limit, list_limit,
                                           5 if level == 0 else 3)}
        for event in task.get("events", [])
    ]
    projected["viewTruncated"] = projected != task or task.get("viewTruncated", False)
    return projected


def bounded_response(result, focus):
    """Bound GUI heap pressure, not just the exec stdout cap; SQLite stays complete."""
    original_tasks = result["tasks"]
    result["tasks"] = [task if task["address"] == focus else project_task(task, 0) for task in original_tasks]
    projection_level = 0
    target_bytes = MAX_RESPONSE_BYTES - 16384
    while len(encoded(result).encode("utf-8")) > target_bytes and projection_level < 3:
        projection_level += 1
        level = min(projection_level, 2)
        result["tasks"] = [project_task(task, level) for task in original_tasks]
        for task in result["tasks"]:
            task["events"] = [
                {**event, "evidence": bounded_value(event.get("evidence", {}), 200 if level == 1 else 80,
                                                   4 if level == 1 else 2, 3 if level == 1 else 2)}
                for event in task["events"]
            ]
            task["viewTruncated"] = True
        result["attention"] = bounded_value(result["attention"], 200 if level == 1 else 80,
                                             300, 3)
        result["conflicts"] = bounded_value(result["conflicts"], 200 if level == 1 else 80,
                                             300, 3)
    if len(encoded(result).encode("utf-8")) > target_bytes:
        # Absolute last resort: preserve every agent and its event IDs/summaries;
        # full provenance remains in the store/read-source route.
        fields = ("taskId", "address", "pane", "tabName", "worktreePath", "branch", "repositoryId",
                  "goal", "currentStep", "nextAction", "status", "lastReviewedEventId",
                  "snapshotVersion", "updatedAt", "stale", "syncPending", "delta")
        result["tasks"] = [
            {**{key: task.get(key) if key in ("taskId", "address", "pane", "worktreePath", "repositoryId")
                else bounded_value(task.get(key), 120, 2, 2) for key in fields if key != "delta"},
             "delta": task["delta"], "viewTruncated": True,
             "events": [{key: event.get(key) for key in ("id", "type", "source", "at", "summary")}
                        for event in task.get("events", [])]}
            for task in original_tasks
        ]
        result["attention"] = [{key: bounded_value(item.get(key), 120, 2, 2) for key in
                                ("id", "taskId", "address", "type", "summary", "reason", "action", "at", "priority")}
                               for item in result["attention"] if isinstance(item, dict)]
        result["conflicts"] = [bounded_value(item, 80, 2, 2) for item in result["conflicts"]
                               if isinstance(item, dict)]
        projection_level = 3
    result["viewTruncated"] = projection_level > 0 or any(task.get("viewTruncated") for task in result["tasks"])
    if result["viewTruncated"]:
        result["errors"].append("일부 화면 근거를 줄여 표시합니다. 전체 기록과 이벤트는 로컬 저장소에 보존됩니다.")
    result["viewProjection"] = {"level": projection_level, "focus": focus,
                                "fullStatePreserved": True, "maximumBytes": MAX_RESPONSE_BYTES}
    return result


class Store:
    def __init__(self, state_dir):
        self.directory = Path(state_dir).expanduser()
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(self.directory / "memory.sqlite3", timeout=12)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA busy_timeout=12000")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS tasks(
                id TEXT PRIMARY KEY, address TEXT NOT NULL, data TEXT NOT NULL,
                updated INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0,
                version INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1);
            CREATE TABLE IF NOT EXISTS events(
                id INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, kind TEXT NOT NULL,
                summary TEXT NOT NULL, source TEXT NOT NULL, evidence TEXT NOT NULL,
                at INTEGER NOT NULL, dedup TEXT NOT NULL,
                UNIQUE(task,dedup));
            CREATE INDEX IF NOT EXISTS events_task ON events(task,id);
            CREATE TABLE IF NOT EXISTS cursors(task TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS git_cache(path TEXT PRIMARY KEY,data TEXT NOT NULL,at INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS log_paths(key TEXT PRIMARY KEY,path TEXT,checked INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS session_bindings(key TEXT PRIMARY KEY,data TEXT,checked INTEGER NOT NULL);
            CREATE TABLE IF NOT EXISTS snapshots(task TEXT NOT NULL,boundary INTEGER NOT NULL,
                data TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(task,boundary));
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        """)
        self.db.commit()
        try:
            os.chmod(self.directory / "memory.sqlite3", 0o600)
        except OSError:
            pass

    def close(self):
        self.db.close()

    def prepare_agents(self, agents, focus=None):
        prepared, updates = [], []
        deadline = time.monotonic() + 2
        attempted = 0
        for original in sorted(agents, key=lambda a: a["address"] != focus):
            agent = dict(original)
            name = str(agent.get("app") or agent.get("foreground", {}).get("name") or "").lower()
            if not resume_of(agent) and "codex" in name and not agent.get("machine") and "/" not in agent["address"]:
                key = encoded([agent["address"], agent.get("created_ms") or agent.get("created"),
                               agent.get("foreground", {}).get("pid"), agent.get("cwd"), agent.get("machine")])
                cached = self.db.execute("SELECT * FROM session_bindings WHERE key=?", (key,)).fetchone()
                resume = json.loads(cached["data"]) if cached and cached["data"] else None
                if not cached or (not resume and now() - cached["checked"] > 300000):
                    if attempted < 8 and time.monotonic() < deadline:
                        resume = open_session_of(agent)
                        attempted += 1
                        updates.append((key, encoded(resume) if resume else None, now()))
                if resume:
                    agent["resume"] = resume
            prepared.append(agent)
        return prepared, updates

    def event(self, task, kind, summary, source, evidence, dedup_key):
        self.db.execute("INSERT OR IGNORE INTO events(task,kind,summary,source,evidence,at,dedup) "
                        "VALUES(?,?,?,?,?,?,?)",
                        (task, kind, safe_text(summary), source, encoded(evidence), now(), dedup_key))
        return self.db.execute("SELECT id FROM events WHERE task=? AND dedup=?", (task, dedup_key)).fetchone()["id"]

    def transition_key(self, task, value):
        latest = self.db.execute("SELECT MAX(id) FROM events WHERE task=?", (task,)).fetchone()[0] or 0
        return digest([value, latest])

    def checkpoint(self, task_id, data, boundary, version=None, at=None):
        checkpoint = {key: data.get(key) for key in ("goal", "currentStep", "completedSteps",
                      "decisions", "blockers", "nextAction", "status", "source", "branch", "worktreePath",
                      "goalSource")}
        checkpoint.update(snapshotVersion=version, updatedAt=at or now(), throughEventId=boundary)
        self.db.execute("INSERT OR REPLACE INTO snapshots(task,boundary,data,at) VALUES(?,?,?,?)",
                        (task_id, boundary, encoded(checkpoint), at or now()))

    def remember_pruning(self, rows):
        for task_id, boundary in rows:
            row = self.db.execute("SELECT data,seen FROM tasks WHERE id=?", (task_id,)).fetchone()
            if not row or boundary is None:
                continue
            data = json.loads(row["data"])
            previous = data.get("prunedThrough", 0)
            data["prunedThrough"] = max(previous, boundary)
            self.db.execute("UPDATE tasks SET data=? WHERE id=?", (encoded(data), task_id))
            if boundary > row["seen"] and boundary > previous:
                self.event(task_id, "resync", "보존 기간 또는 용량 제한으로 일부 미확인 이벤트가 정리됐습니다.",
                           "collector", {"prunedThrough": boundary, "reason": "retention"},
                           digest(["retention_gap", boundary]))

    def locate_transcripts(self, agents):
        """Index filenames once per provider, never recurse once per agent."""
        output = {}
        missing = {}
        for agent in agents:
            if agent.get("machine") or "/" in agent["address"]:
                continue
            resume = resume_of(agent)
            if not resume:
                continue
            kind = resume["agent"]
            if resume.get("associationSource") == "foreground_open_file" and resume.get("path"):
                path = allowed_log_path(resume["path"], kind, resume["id"])
                if path:
                    output[agent["address"]] = (path, kind)
                    continue
            root = session_root(kind)
            key = encoded([str(root), kind, resume["id"]])
            row = self.db.execute("SELECT * FROM log_paths WHERE key=?", (key,)).fetchone()
            cached_path = allowed_log_path(row["path"], kind, resume["id"]) if row and row["path"] else None
            if cached_path:
                output[agent["address"]] = (cached_path, kind)
            elif not row or now() - row["checked"] > 60000:
                missing.setdefault((str(root), kind), {})[resume["id"]] = (key, agent["address"])
        updates = []
        for (root, kind), wanted in missing.items():
            found = {session: [] for session in wanted}
            # The basename contains the captured session ID. Inspect filenames only.
            for directory, _dirs, files in os.walk(root):
                for filename in files:
                    if not filename.endswith(".jsonl"):
                        continue
                    stem = filename[:-6]
                    if kind == "claude":
                        session = stem if stem in wanted else None
                    else:
                        session = next((s for s in wanted if stem == s or stem.endswith("-" + s)), None)
                    if session:
                        path = allowed_log_path(Path(directory) / filename, kind, session)
                        if path:
                            found[session].append(path)
            for session, paths in found.items():
                key, address = wanted[session]
                path = paths[0] if len(paths) == 1 else None
                updates.append((key, str(path) if path else None, now()))
                if path:
                    output[address] = (path, kind)
        return output, updates

    def seed_initial_request(self, task_id, snapshot, path, kind, file_id, size):
        """One bounded head read, alongside the existing bounded recent tail.

        This is explicitly the quoted first request, not an inference about
        which natural-language followup began a different task.
        """
        if snapshot.get("initialRequestScanned"):
            return
        if snapshot.get("goal", UNKNOWN) not in (None, "", UNKNOWN):
            snapshot["initialRequestScanned"] = True
            return
        with path.open("rb") as stream:
            head = stream.read(MAX_LOG_READ)
        snapshot["initialRequestScanned"] = True
        snapshot["initialRequestScanBytes"] = len(head)
        offset = 0
        for raw in head.splitlines(keepends=True):
            start = offset
            offset += len(raw)
            if not raw.endswith(b"\n"):
                break
            try:
                record = json.loads(raw)
                messages = transcript_events(record, kind)
            except (ValueError, TypeError, AttributeError):
                continue
            for role, text, _phase in messages:
                if role != "user" or protocol_setup(text):
                    continue
                text = secret_filtered(text)
                first = next((line.strip() for line in text.splitlines() if line.strip()), UNKNOWN)
                if first == UNKNOWN:
                    continue
                snapshot["goal"] = safe_text(first, 300)
                snapshot["goalSource"] = "initial_user_request"
                evidence = {"path": str(path), "byteOffset": start,
                            "recordHash": hashlib.sha256(raw).hexdigest(), "role": "user",
                            "initialRequest": True, "meaning": "quoted_first_request_not_inferred_current_goal"}
                event_id = self.event(task_id, "task_started", f"초기 요청: {snapshot['goal']}",
                                      "user_request", evidence,
                                      digest([file_id, start, role, evidence["recordHash"]]))
                snapshot["goalEvidence"] = {**evidence, "eventId": event_id, "source": "user_request"}
                self.checkpoint(task_id, snapshot, event_id)
                break
            else:
                continue
            break
        skipped = max(0, size - 2 * MAX_LOG_READ)
        if skipped:
            snapshot["partialHistory"] = True
            snapshot["historySkippedBytes"] = skipped
            self.event(task_id, "resync", "초기 요청과 최근 대화만 읽었습니다. 중간 이력은 원본에 남아 있습니다.",
                       "collector", {"path": str(path), "headReadBytes": len(head),
                                     "tailFrom": max(0, size-MAX_LOG_READ), "skippedMiddleBytes": skipped,
                                     "reason": "bounded_bootstrap_history"},
                       digest(["bounded_bootstrap_history", file_id]))

    def ingest_transcript(self, task_id, agent, snapshot, location=None):
        if not location:
            snapshot["transcriptAvailable"] = False
            return
        path, kind = location
        resume = resume_of(agent)
        path = allowed_log_path(path, kind, resume["id"]) if resume else None
        if not path:
            snapshot["transcriptAvailable"] = False
            return
        snapshot["transcriptAvailable"] = True
        snapshot["sourceLog"] = str(path)
        stat = path.stat()
        row = self.db.execute("SELECT data FROM cursors WHERE task=?", (task_id,)).fetchone()
        cursor = json.loads(row["data"]) if row else {}
        offset = int(cursor.get("offset", 0))
        file_id = [str(path), stat.st_dev, stat.st_ino]
        self.seed_initial_request(task_id, snapshot, path, kind, file_id, stat.st_size)
        replaced = bool(cursor) and (cursor.get("file") != file_id or stat.st_size < offset)
        if replaced:
            self.event(task_id, "resync", "대화 로그가 교체되거나 잘렸습니다. 다시 동기화합니다.",
                       "collector", {"path": str(path)}, digest(["resync", file_id, stat.st_size, offset]))
            offset = max(0, stat.st_size - MAX_LOG_READ)
            cursor = {}
        elif not cursor and stat.st_size > MAX_LOG_READ:
            offset = stat.st_size - MAX_LOG_READ
            self.event(task_id, "resync", "긴 대화의 최근 기록부터 수집했습니다. 이전 기록은 원본에서 확인하세요.",
                       "collector", {"path": str(path), "skippedBytes": offset}, "initial-tail")
        start = offset
        with path.open("rb") as stream:
            stream.seek(offset)
            if offset and (replaced or not cursor):
                stream.readline(MAX_LOG_READ)
                start = stream.tell()
            data = stream.read(MAX_LOG_READ)
        if cursor.get("skippingRecord"):
            newline = data.find(b"\n")
            if newline < 0:
                self.db.execute("INSERT OR REPLACE INTO cursors(task,data) VALUES(?,?)",
                                (task_id, encoded({**cursor, "file": file_id, "offset": start + len(data),
                                                  "collectedAt": now()})))
                return
            start += newline + 1
            data = data[newline + 1:]
            cursor.pop("skippingRecord", None)
        # Partial last line remains for the next exchange.
        complete_end = data.rfind(b"\n")
        if complete_end < 0:
            # A normal partial append is retried intact. A complete chunk with
            # no record boundary is oversized: skip it incrementally rather
            # than rereading the same bytes forever.
            if len(data) >= MAX_LOG_READ:
                cursor["skippingRecord"] = True
                self.event(task_id, "resync", "너무 큰 대화 기록 한 건을 건너뜁니다. 다음 줄부터 수집을 이어갑니다.",
                           "collector", {"path": str(path), "byteOffset": start,
                                         "reason": "oversized_record", "chunkBytes": len(data)},
                           digest(["oversized_record", file_id, start]))
                snapshot["logGapEventId"] = self.db.execute(
                    "SELECT MAX(id) FROM events WHERE task=?", (task_id,)).fetchone()[0]
                start += len(data)
            self.db.execute("INSERT OR REPLACE INTO cursors(task,data) VALUES(?,?)",
                            (task_id, encoded({**cursor, "file": file_id, "offset": start,
                                              "collectedAt": now()})))
            return
        data = data[:complete_end + 1]
        at = start
        for raw in data.splitlines(keepends=True):
            line_offset = at
            at += len(raw)
            try:
                record = json.loads(raw)
                messages = transcript_events(record, kind)
            except (ValueError, TypeError, AttributeError):
                continue
            tool_evidence = {"path": str(path), "byteOffset": line_offset,
                             "recordHash": hashlib.sha256(raw).hexdigest()}
            test = recorded_test(record, cursor, tool_evidence) if kind == "codex" else None
            if test:
                recorded = snapshot.get("recordedTests", [])
                test_id = self.event(task_id, "test", f"기록된 테스트: {test['result']} · exit {test['exitCode']}",
                                     "test_log", test,
                                     digest(["test", file_id, line_offset, tool_evidence["recordHash"]]))
                test["eventId"] = test_id
                test["recordedAt"] = now()
                recorded.append(test)
                snapshot["recordedTests"] = recorded[-30:]
                self.checkpoint(task_id, snapshot, test_id)
            for role, text, phase in messages:
                text = secret_filtered(text)
                evidence = {"path": str(path), "byteOffset": line_offset,
                            "recordHash": hashlib.sha256(raw).hexdigest(), "role": role}
                if role == "user":
                    # User directives are quoted, never executed by this engine.
                    if protocol_setup(text):
                        setup_id = self.event(
                            task_id, "protocol_context", "세션 시작 설정을 읽었습니다. 작업 요청으로 분류하지 않습니다.",
                            "collector", evidence, digest([file_id, line_offset, role, evidence["recordHash"]]))
                        self.checkpoint(task_id, snapshot, setup_id)
                        continue
                    initial = snapshot.get("goal", UNKNOWN) in ("", UNKNOWN, None)
                    if initial:
                        first = next((v.strip() for v in text.splitlines() if v.strip()), UNKNOWN)
                        snapshot["goal"] = safe_text(first, 300)
                        snapshot["goalSource"] = "user_request"
                    snapshot["latestRequest"] = safe_text(text, 1600)
                    request_id = self.event(
                        task_id, "task_started" if initial else "user_message",
                        f"첫 요청: {snapshot['goal']}" if initial else f"후속 요청: {safe_text(text, 300)}",
                        "user_request", evidence, digest([file_id, line_offset, role, evidence["recordHash"]]))
                    self.checkpoint(task_id, snapshot, request_id)
                else:
                    fields = rule_snapshot(text)
                    snapshot.update(fields)
                    if fields.get("goal"):
                        snapshot["goalSource"] = "agent_report"
                    snapshot["latestResponse"] = safe_text(text, 4000)
                    snapshot["source"] = "agent_report"
                    event_kind = "agent_response" if phase in (None, "final_answer", "final") else "progress"
                    event_id = self.event(task_id, event_kind, safe_text(text, 300), "agent_report", evidence,
                                          digest([file_id, line_offset, role, evidence["recordHash"]]))
                    if fields.get("blockers"):
                        snapshot["blockerCauseEventId"] = event_id
                    if event_kind == "agent_response" and (phase in ("final_answer", "final") or
                            snapshot.get("status") in ("done", "idle")):
                        snapshot["pendingCompletionEventId"] = event_id
                        snapshot["completionSource"] = "agent_report"
                        snapshot["lastCompletedResponse"] = safe_text(text, 4000)
                    self.checkpoint(task_id, snapshot, event_id)
        self.db.execute("INSERT OR REPLACE INTO cursors(task,data) VALUES(?,?)",
                        (task_id, encoded({**cursor, "file": file_id, "offset": at, "lastSize": stat.st_size,
                                          "collectedAt": now()})))

    def exchange(self, request):
        incoming = request.get("agents", [])
        if not isinstance(incoming, list) or len(incoming) > MAX_AGENTS:
            raise ValueError("agents must be a bounded array")
        agents = [a for a in incoming if isinstance(a, dict) and
                  re.fullmatch(r"(?:[^/\s]+/)?t[0-9a-z]+", str(a.get("address", "")))]
        agents, session_binding_updates = self.prepare_agents(agents, request.get("focus"))
        config = request.get("config") or {}
        action = request.get("action") or {}
        action_error = None
        errors = []
        git_map = {}
        locations, log_path_updates = self.locate_transcripts(agents)
        paths = sorted({os.path.realpath(a["cwd"]) for a in agents if a.get("cwd") and
                        not a.get("machine") and "/" not in a["address"]})
        if config.get("gitMonitoring", True):
            cached = {r["path"]: (json.loads(r["data"]), r["at"])
                      for r in self.db.execute("SELECT * FROM git_cache")}
            selected = next((a for a in agents if a["address"] == request.get("focus")), None)
            focus_path = os.path.realpath(selected["cwd"]) if selected and selected.get("cwd") else None
            focus_common = cached.get(focus_path, ({}, 0))[0].get("commonDir")
            paths.sort(key=lambda p: (p != focus_path,
                                     bool(focus_common) and cached.get(p, ({}, 0))[0].get("commonDir") != focus_common,
                                     cached.get(p, ({}, 0))[1], p))
            due = []
            for path in paths:
                old = cached.get(path)
                if old and old[0].get("analysisVersion") == GIT_ANALYSIS_VERSION and \
                        now() - old[1] < 15000 and action.get("type") != "refresh":
                    git_map[path] = old[0]
                else:
                    due.append(path)
                    if old:
                        git_map[path] = dict(old[0], stale=True, pending=True)
            # Rotate across repositories while always prioritizing the selected worktree.
            batch = due[:16]
            deadline = time.monotonic() + 8
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                for path, observation in zip(batch, pool.map(
                        lambda p: git_observation(p, deadline, cached.get(p, ({}, 0))[0]), batch)):
                    if not observation["ok"] and cached.get(path):
                        git_map[path] = dict(cached[path][0], stale=True, pending=False,
                                             error=observation["error"], attemptedAt=now())
                    else:
                        git_map[path] = observation
            if len(due) > len(batch):
                errors.append(f"{len(due)-len(batch)} worktrees queued; collection is limited to 16 worktrees / 8 seconds per exchange.")
        else:
            batch = []
        timestamp = now()
        with self.db:
            for key, data, checked in session_binding_updates:
                self.db.execute("INSERT OR REPLACE INTO session_bindings(key,data,checked) VALUES(?,?,?)",
                                (key, data, checked))
            for key, path, checked in log_path_updates:
                self.db.execute("INSERT OR REPLACE INTO log_paths(key,path,checked) VALUES(?,?,?)",
                                (key, path, checked))
            for path in batch:
                observation = git_map[path]
                self.db.execute("INSERT OR REPLACE INTO git_cache(path,data,at) VALUES(?,?,?)",
                                (path, encoded(observation), timestamp))
            # Bound incremental parsing. Focus goes first, then oldest log cursor;
            # subsequent exchanges make progress through every live session.
            cursor_times = {r["task"]: json.loads(r["data"]).get("collectedAt", 0)
                            for r in self.db.execute("SELECT * FROM cursors")}
            log_candidates = sorted([a for a in agents if a["address"] in locations],
                                    key=lambda a: (a["address"] != request.get("focus"),
                                                   cursor_times.get(identity_of(a), 0), a["address"]))
            log_batch = {a["address"] for a in log_candidates[:16]}
            # An exchange is the collector's complete visible scope, not terminal deletion.
            # Mark absent records inactive without immediately deleting recoverable memory.
            self.db.execute("UPDATE tasks SET active=0")
            for agent in agents:
                task_id = identity_of(agent)
                row = self.db.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
                previous = json.loads(row["data"]) if row else {}
                data = dict(previous)
                native_report = agent.get("report") if isinstance(agent.get("report"), dict) else {}
                status_kind = native_report.get("kind")
                if status_kind not in ("permission", "question", "auth", "none"):
                    status_kind = None
                status_message = secret_filtered(safe_text(
                    native_report.get("message") or native_report.get("msg"), 800))
                data.update({
                    "taskId": task_id, "address": agent["address"], "pane": agent.get("pane"),
                    "tabName": safe_text(agent.get("tab_name") or agent.get("tabName") or agent["address"]),
                    "worktreePath": agent.get("cwd") or UNKNOWN,
                    "status": agent.get("status") if agent.get("status") in
                    ("working", "blocked", "done", "idle", "error") else "idle",
                    "goal": previous.get("goal", UNKNOWN), "currentStep": previous.get("currentStep", UNKNOWN),
                    "completedSteps": previous.get("completedSteps", []), "decisions": previous.get("decisions", []),
                    "blockers": previous.get("blockers", []), "nextAction": previous.get("nextAction", UNKNOWN),
                    "source": previous.get("source", "collector"), "turn": agent.get("turn", 0),
                    "needsDecision": previous.get("needsDecision", False),
                    "lastObservedAt": timestamp,
                    "statusKind": status_kind, "statusMessage": status_message,
                    "sessionAssociation": resume_of(agent).get("associationSource", "hook_label")
                        if resume_of(agent) else "Unknown",
                })
                if not row:
                    self.event(task_id, "session_observed", "세션 수집을 시작했습니다.", "collector",
                               {"address": agent["address"], "identity": task_id}, "observed")
                    data["firstEventId"] = self.db.execute(
                        "SELECT MIN(id) FROM events WHERE task=?", (task_id,)).fetchone()[0]
                state_marker = [data["status"] if data["status"] not in ("done", "idle") else "settled",
                                agent.get("turn", 0)]
                if data["status"] == "blocked" and (status_kind not in (None, "none") or status_message):
                    state_marker.extend([status_kind if status_kind != "none" else None, digest(status_message)])
                if state_marker != previous.get("stateMarker"):
                    # Do not generate an event for done -> idle acknowledgment by Herdr.
                    status_event_id = self.event(task_id, "status", f"에이전트 상태: {data['status']}", "core_status",
                                                 {"status": data["status"], "turn": data["turn"],
                                                  "kind": status_kind, "message": status_message},
                                                 self.transition_key(task_id, ["status", state_marker,
                                                                              previous.get("stateMarker"),
                                                                              agent.get("seq")]))
                    data["statusEventId"] = status_event_id
                    if data["status"] == "done" or data["status"] == "idle" and int(data.get("turn") or 0) > 0:
                        data["pendingCompletionEventId"] = status_event_id
                        data["completionSource"] = "core_status"
                    self.checkpoint(task_id, data, status_event_id)
                data["stateMarker"] = state_marker
                path = os.path.realpath(agent["cwd"]) if agent.get("cwd") else ""
                git = git_map.get(path, {"ok": False, "files": [], "head": UNKNOWN, "branch": UNKNOWN,
                                         "error": "Git monitoring disabled or remote path unavailable"})
                data["git"] = git
                data["branch"] = git.get("branch", UNKNOWN)
                data["repositoryId"] = digest(git["commonDir"])[:24] if git.get("commonDir") else UNKNOWN
                git_changed = git.get("ok") and git.get("fingerprint") != previous.get("git", {}).get("fingerprint")
                if git_changed:
                    old_files = set(previous.get("git", {}).get("files", []))
                    summary = f"Git 변경: {len(git['files'])}개 파일 · {git['branch']}"
                    git_id = self.event(task_id, "git", summary, "git_observation",
                                        {"files": git["files"], "newFiles": sorted(set(git["files"]) - old_files),
                                         "head": git["head"], "worktree": git["root"],
                                         "truncated": git.get("truncated", False)},
                                        self.transition_key(task_id, ["git", git["fingerprint"],
                                                                     previous.get("git", {}).get("fingerprint")]))
                    data["gitEventId"] = git_id
                    previous_head = previous.get("git", {}).get("head")
                    if previous_head and previous_head != UNKNOWN and previous_head != git.get("head"):
                        data["recentCommitEventId"] = git_id
                        data["recentCommitHead"] = git.get("head")
                    self.checkpoint(task_id, data, git_id)
                elif not data.get("gitEventId"):
                    old_git = self.db.execute("SELECT id FROM events WHERE task=? AND kind='git' "
                                              "ORDER BY id DESC LIMIT 1", (task_id,)).fetchone()
                    data["gitEventId"] = old_git["id"] if old_git else 0
                if (config.get("autoSnapshot", True) or action.get("type") == "refresh") and \
                        (agent["address"] in log_batch or agent["address"] not in locations):
                    try:
                        self.ingest_transcript(task_id, agent, data, locations.get(agent["address"]))
                    except (OSError, ValueError, TypeError) as error:
                        errors.append(f"{agent['address']}: transcript unavailable ({safe_text(str(error), 120)})")
                        data["transcriptAvailable"] = False
                location = locations.get(agent["address"])
                if location:
                    path, _kind = location
                    cursor_row = self.db.execute("SELECT data FROM cursors WHERE task=?", (task_id,)).fetchone()
                    source_cursor = json.loads(cursor_row["data"]) if cursor_row else {}
                    through = source_cursor.get("offset", 0)
                    try:
                        observed_size = path.stat().st_size
                    except OSError:
                        observed_size = None
                    data["sourceLog"] = str(path)
                    data["transcriptAvailable"] = observed_size is not None
                    data["sourceCollectedThrough"] = through
                    data["sourceCollectedAt"] = source_cursor.get("collectedAt")
                    data["sourceObservedSize"] = observed_size
                    data["logLagBytes"] = max(0, observed_size - through) if observed_size is not None else None
                    data["syncPending"] = bool(data["logLagBytes"] or source_cursor.get("skippingRecord") or
                                               observed_size is None)
                else:
                    data["syncPending"] = False
                    data["logLagBytes"] = None
                    data["sourceCollectedThrough"] = None
                    data["sourceCollectedAt"] = None
                    data["sourceObservedSize"] = None
                if not data.get("pendingCompletionEventId") and data["status"] in ("done", "idle"):
                    # Upgrade old stores without losing an already captured completion.
                    for event in self.db.execute(
                            "SELECT id,kind,source,evidence FROM events WHERE task=? AND "
                            "id>? AND kind IN ('agent_response','status') ORDER BY id DESC LIMIT 60",
                            (task_id, data.get("completionFloorEventId", 0))):
                        evidence = json.loads(event["evidence"])
                        if event["kind"] == "agent_response" or event["kind"] == "status" and (
                                evidence.get("status") == "done" or evidence.get("status") == "idle" and
                                int(evidence.get("turn") or 0) > 0):
                            data["pendingCompletionEventId"] = event["id"]
                            data["completionSource"] = event["source"]
                            break
                observation_fields = ("lastObservedAt", "git", "syncPending", "logLagBytes",
                                      "sourceCollectedThrough", "sourceCollectedAt", "sourceObservedSize",
                                      "initialRequestScanned", "initialRequestScanBytes")
                content_changed = digest({k: v for k, v in data.items() if k not in observation_fields}) != \
                    digest({k: v for k, v in previous.items() if k not in observation_fields})
                updated = timestamp if content_changed or git_changed or not row else row["updated"]
                version = (row["version"] if row else 0) + int(content_changed or git_changed or not row)
                self.db.execute(
                    "INSERT INTO tasks(id,address,data,updated,seen,version,active) VALUES(?,?,?,?,?,?,1) "
                    "ON CONFLICT(id) DO UPDATE SET address=excluded.address,data=excluded.data,"
                    "updated=excluded.updated,version=excluded.version,active=1",
                    (task_id, agent["address"], encoded(data), updated, row["seen"] if row else 0, version))
                boundary = self.db.execute("SELECT MAX(id) FROM events WHERE task=?", (task_id,)).fetchone()[0] or 0
                self.checkpoint(task_id, data, boundary, version, updated)
            self.db.execute("SAVEPOINT requested_action")
            try:
                self.apply_action(action)
            except ValueError as error:
                self.db.execute("ROLLBACK TO requested_action")
                action_error = {"nonce": action.get("nonce"), "type": action.get("type"),
                                "taskId": action.get("taskId"), "error": safe_text(str(error), 300)}
            finally:
                self.db.execute("RELEASE requested_action")
            retention = max(1, min(365, int(config.get("retentionDays", 30))))
            cutoff = timestamp - retention * 86400000
            pruned = list(self.db.execute("SELECT task,MAX(id) FROM events WHERE at<? GROUP BY task", (cutoff,)))
            self.db.execute("DELETE FROM events WHERE at<?", (cutoff,))
            self.remember_pruning(pruned)
            self.db.execute("DELETE FROM snapshots WHERE at<?", (cutoff,))
            stale_ids = [r["id"] for r in self.db.execute(
                "SELECT id FROM tasks WHERE active=0 AND updated<?", (cutoff,))]
            for task_id in stale_ids:
                self.db.execute("DELETE FROM cursors WHERE task=?", (task_id,))
                self.db.execute("DELETE FROM events WHERE task=?", (task_id,))
                self.db.execute("DELETE FROM tasks WHERE id=?", (task_id,))
                self.db.execute("DELETE FROM snapshots WHERE task=?", (task_id,))
                self.db.execute("DELETE FROM meta WHERE key=?", ("summary:" + task_id,))
            self.db.execute("DELETE FROM git_cache WHERE at<?", (cutoff,))
            self.db.execute("DELETE FROM log_paths WHERE checked<?", (cutoff,))
            self.db.execute("DELETE FROM session_bindings WHERE checked<?", (cutoff,))
            # Bound long-lived sessions: keep the newest 2000 source events. A gap is explicit.
            pruned = list(self.db.execute("SELECT task,MAX(id) FROM (SELECT task,id,"
                                         "ROW_NUMBER() OVER (PARTITION BY task ORDER BY id DESC) n "
                                         "FROM events) WHERE n>2000 GROUP BY task"))
            self.db.execute("DELETE FROM events WHERE id IN (SELECT id FROM (SELECT id,"
                            "ROW_NUMBER() OVER (PARTITION BY task ORDER BY id DESC) n FROM events) WHERE n>2000)")
            self.remember_pruning(pruned)
            self.db.execute("DELETE FROM snapshots WHERE (task,boundary) IN (SELECT task,boundary FROM ("
                            "SELECT task,boundary,ROW_NUMBER() OVER (PARTITION BY task ORDER BY boundary DESC) n "
                            "FROM snapshots) WHERE n>2000)")
        tasks = self.tasks(request.get("focus"), exchange_view=True)
        shared = {}
        for task in tasks:
            path = task.get("worktreePath")
            if path and path != UNKNOWN:
                machine = task["address"].split("/", 1)[0] if "/" in task["address"] else "local"
                key = (machine, task["repositoryId"], path)
                shared.setdefault(key, []).append(task)
        shared_worktrees = [
            {"path": path, "repositoryId": repository, "machine": machine,
             "verifiedWorktree": repository != UNKNOWN,
             "taskIds": [task["taskId"] for task in members],
             "addresses": [task["address"] for task in members],
             "dirty": any(task.get("git", {}).get("dirtyFiles") for task in members),
             "advice": "독립 worktree 사용을 권장합니다. 기존 세션의 디렉터리는 변경하지 않습니다."}
            for (machine, repository, path), members in shared.items() if len(members) >= 2
        ]
        conflicts = self.conflicts(tasks, config)
        attention = self.attention(tasks, conflicts)
        metrics = [json.loads(r["value"]) for r in self.db.execute(
            "SELECT value FROM meta WHERE key LIKE 'summary:%'")]
        calls = sum(m.get("calls", 0) for m in metrics)
        failures = sum(m.get("failures", 0) for m in metrics)
        known_tokens = sum(m.get("inputTokensTotal", 0) + m.get("outputTokensTotal", 0) for m in metrics)
        usage_observed = sum(m.get("usageObservedCalls", 0) for m in metrics)
        cost_observed = sum(m.get("costObservedCalls", 0) for m in metrics)
        known_cost = sum(m.get("costUSDTotal", 0) for m in metrics)
        for task in tasks:
            task["git"] = {k: v for k, v in task.get("git", {}).items() if k != "references"}
        result = {"ok": True, "tasks": tasks, "attention": attention, "conflicts": conflicts,
                  "sharedWorktrees": shared_worktrees,
                "stats": {"agents": len(tasks), "attention": len(attention), "conflicts": len(conflicts),
                          "llmCalls": calls, "llmFailures": failures,
                          "tokens": known_tokens if usage_observed == calls else None,
                          "tokensKnown": known_tokens, "usageObservedCalls": usage_observed,
                          "cost": known_cost if cost_observed == calls else None,
                          "costKnownUSD": known_cost, "costObservedCalls": cost_observed,
                          "strategy": "local_rules_and_opt_in_summary",
                          "eventCount": self.db.execute("SELECT COUNT(*) FROM events").fetchone()[0]},
                "errors": errors, "actionError": action_error, "version": VERSION, "generatedAt": timestamp}
        return bounded_response(result, request.get("focus"))

    def apply_action(self, action):
        kind = action.get("type")
        task_id = action.get("taskId")
        if kind == "ack":
            row = self.db.execute("SELECT seen,data FROM tasks WHERE id=?", (task_id,)).fetchone()
            if not row:
                raise ValueError("Unknown task")
            through = action.get("throughEventId")
            if not isinstance(through, int) or isinstance(through, bool) or through < 0:
                raise ValueError("Invalid acknowledgment boundary")
            maximum = self.db.execute("SELECT MAX(id) FROM events WHERE task=?", (task_id,)).fetchone()[0] or 0
            if through > maximum:
                raise ValueError("Acknowledgment boundary belongs to another task or future event")
            if through > row["seen"] and not self.db.execute(
                    "SELECT 1 FROM events WHERE task=? AND id=?", (task_id, through)).fetchone():
                raise ValueError("Acknowledgment boundary does not belong to this task")
            if through > row["seen"]:
                checkpoint = self.db.execute("SELECT data FROM snapshots WHERE task=? AND boundary<=? "
                                             "ORDER BY boundary DESC LIMIT 1", (task_id, through)).fetchone()
                data = json.loads(row["data"])
                data["lastReviewedSnapshot"] = json.loads(checkpoint["data"]) if checkpoint else None
                completion = data.get("pendingCompletionEventId", 0)
                if completion and through >= completion:
                    data["reviewedCompletionEventId"] = completion
                self.db.execute("UPDATE tasks SET seen=?,data=? WHERE id=?", (through, encoded(data), task_id))
        elif kind == "report":
            row = self.db.execute("SELECT data FROM tasks WHERE id=?", (task_id,)).fetchone()
            if not row:
                raise ValueError("Unknown task")
            data = json.loads(row["data"])
            report = action.get("report", {})
            if not isinstance(report, dict):
                raise ValueError("report must be an object")
            fields = ("goal", "currentStep", "nextAction")
            lists = ("completedSteps", "decisions", "blockers")
            clean = {}
            for field in fields:
                if isinstance(report.get(field), str):
                    clean[field] = secret_filtered(safe_text(report[field]))
            for field in lists:
                if isinstance(report.get(field), list):
                    clean[field] = [secret_filtered(safe_text(v)) for v in report[field][:30]
                                    if isinstance(v, str)]
            if isinstance(report.get("needsDecision"), bool):
                clean["needsDecision"] = report["needsDecision"]
            if isinstance(report.get("tests"), list):
                clean["reportedTests"] = [
                    {"name": safe_text(t.get("name")), "result": safe_text(t.get("result")),
                     "source": "agent_report", "verified": False}
                    for t in report["tests"][:30] if isinstance(t, dict)]
            changed = any(data.get(key) != value for key, value in clean.items())
            if not changed:
                return
            data.update(clean)
            data["source"] = "agent_report"
            report_id = self.event(task_id, "report", "구조화된 작업 보고가 갱신됐습니다.", "agent_report",
                                   clean, self.transition_key(task_id, ["report", clean]))
            data["reportCauseEventId"] = report_id
            if "goal" in clean:
                data["goalSource"] = "agent_report"
                data["goalEvidence"] = {"eventId": report_id, "source": "agent_report"}
            if clean.get("needsDecision"):
                data["decisionCauseEventId"] = report_id
            if clean.get("blockers"):
                data["blockerCauseEventId"] = report_id
            self.checkpoint(task_id, data, report_id)
            self.db.execute("UPDATE tasks SET data=?,updated=?,version=version+1 WHERE id=?",
                            (encoded(data), now(), task_id))
        elif kind == "start_task":
            row = self.db.execute("SELECT data FROM tasks WHERE id=?", (task_id,)).fetchone()
            goal = safe_text(action.get("goal"))
            if not row or not goal:
                raise ValueError("start_task requires an existing task and an explicit goal")
            data = json.loads(row["data"])
            data.update(goal=secret_filtered(goal), currentStep=UNKNOWN, completedSteps=[], decisions=[],
                        blockers=[], nextAction=UNKNOWN, recordedTests=[], reportedTests=[],
                        latestResponse="", lastCompletedResponse="", needsDecision=False, source="user_request",
                        pendingCompletionEventId=0, goalSource="explicit_user_goal")
            data.pop("llmSnapshot", None)
            data["completionFloorEventId"] = self.event(
                task_id, "task_started", f"명시적으로 새 작업을 시작했습니다: {data['goal']}",
                "user_request", {"goal": data["goal"], "explicit": True},
                self.transition_key(task_id, ["start_task", data["goal"]]))
            self.checkpoint(task_id, data, data["completionFloorEventId"])
            data["goalEvidence"] = {"eventId": data["completionFloorEventId"], "source": "user_request",
                                    "explicit": True}
            self.db.execute("UPDATE tasks SET data=?,updated=?,version=version+1 WHERE id=?",
                            (encoded(data), now(), task_id))

    def summarize(self, request):
        """Separate opt-in path: no provider work inside collector or a SQL transaction."""
        config = request.get("config") or {}
        if config.get("summaryProvider", "off") in ("off", "none", "", None):
            return {"ok": True, "status": "disabled", "source": "llm-unverified"}
        if config.get("summaryConsent") is not True:
            return {"ok": False, "status": "consent_required", "source": "llm-unverified"}
        task_id = request.get("taskId")
        row = self.db.execute("SELECT * FROM tasks WHERE id=? AND active=1", (task_id,)).fetchone()
        if not row:
            return {"ok": False, "status": "unknown_task", "source": "llm-unverified"}
        data = json.loads(row["data"])
        key = "summary:" + task_id
        stored = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        state = json.loads(stored["value"]) if stored else {}
        if state.get("leaseUntil", 0) > time.time():
            return {"ok": True, "status": "busy", "source": "llm-unverified"}
        records = list(self.db.execute("SELECT * FROM events WHERE task=? ORDER BY id DESC LIMIT 60", (task_id,)))
        records.reverse()
        events = [{"id": r["id"], "type": r["kind"], "summary": r["summary"], "source": r["source"],
                   "at": r["at"], "evidence": json.loads(r["evidence"])} for r in records]
        boundary = records[-1]["id"] if records else 0
        # BEGIN IMMEDIATE protects the claim from simultaneous mod copies.
        with self.db:
            self.db.execute("BEGIN IMMEDIATE")
            stored = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
            state = json.loads(stored["value"]) if stored else {}
            if state.get("leaseUntil", 0) > time.time():
                return {"ok": True, "status": "busy", "source": "llm-unverified"}
            previous_calls = state.get("calls", 0)
            state["leaseUntil"] = time.time() + 55
            self.db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)", (key, encoded(state)))
        try:
            import summary_adapter
            result = summary_adapter.summarize(config, data, events, state,
                                                settled=data.get("status") != "working",
                                                manual=request.get("manual", True) is True)
        except Exception as error:
            result = {"ok": False, "status": "summary_failed", "error": safe_text(str(error), 200),
                      "state": state, "source": "llm-unverified"}
        result["state"]["leaseUntil"] = 0
        returned_metrics = result.get("metrics") or {}
        if result["state"].get("calls", 0) > previous_calls:
            for metric, total in (("inputTokens", "inputTokensTotal"), ("outputTokens", "outputTokensTotal"),
                                  ("costUSD", "costUSDTotal")):
                value = returned_metrics.get(metric)
                if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
                    result["state"][total] = result["state"].get(total, 0) + value
            if all(isinstance(returned_metrics.get(k), int) and not isinstance(returned_metrics.get(k), bool)
                   for k in ("inputTokens", "outputTokens")):
                result["state"]["usageObservedCalls"] = result["state"].get("usageObservedCalls", 0) + 1
            if isinstance(returned_metrics.get("costUSD"), (int, float)):
                result["state"]["costObservedCalls"] = result["state"].get("costObservedCalls", 0) + 1
        result["totals"] = {k: result["state"].get(k, 0) for k in
                            ("calls", "failures", "inputTokensTotal", "outputTokensTotal",
                             "usageObservedCalls", "costUSDTotal", "costObservedCalls")}
        with self.db:
            self.db.execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)",
                            (key, encoded(result["state"])))
            if result.get("summary") and result.get("status") in ("generated", "cached"):
                latest = self.db.execute("SELECT * FROM tasks WHERE id=? AND active=1", (task_id,)).fetchone()
                last_event = self.db.execute("SELECT MAX(id) FROM events WHERE task=?", (task_id,)).fetchone()[0] or 0
                if latest and last_event == boundary:
                    current = json.loads(latest["data"])
                    snapshot = {"fields": result["summary"], "source": "llm-unverified", "at": now(),
                                "throughEventId": boundary, "metrics": result.get("metrics")}
                    current["llmSnapshot"] = snapshot
                    self.db.execute("UPDATE tasks SET data=? WHERE id=?", (encoded(current), task_id))
                    self.event(task_id, "summary", "별도 모델이 작업 맥락을 요약했습니다. 검증되지 않은 보고입니다.",
                               "llm-unverified", {"throughEventId": boundary},
                               digest(["llm-summary", result["state"].get("cachedDigest")]))
                else:
                    result["status"] = "source_changed"
        return {k: v for k, v in result.items() if k != "state"}

    def read_source(self, request):
        """Only the exact task's collector-captured log, with a bounded tail."""
        row = self.db.execute("SELECT data FROM tasks WHERE id=?", (request.get("taskId"),)).fetchone()
        if not row:
            return {"ok": False, "error": "Unknown task", "source": "captured_session_log"}
        data = json.loads(row["data"])
        if "/" in data.get("address", "") or not data.get("sourceLog"):
            return {"ok": False, "error": "No captured local session log", "source": "captured_session_log"}
        path = Path(data["sourceLog"]).resolve()
        roots = [(Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "sessions").resolve(),
                 (Path(os.environ.get("CLAUDE_CONFIG_DIR", Path.home() / ".claude")) / "projects").resolve()]
        if not any(path == root or root in path.parents for root in roots):
            return {"ok": False, "error": "Captured path is outside supported session roots",
                    "source": "captured_session_log"}
        try:
            size = path.stat().st_size
            offset = max(0, size - 32768)
            event_id = request.get("eventId")
            if event_id is not None:
                if not isinstance(event_id, int) or isinstance(event_id, bool):
                    return {"ok": False, "error": "Invalid event ID", "source": "captured_session_log"}
                event = self.db.execute("SELECT evidence FROM events WHERE task=? AND id=?",
                                        (request.get("taskId"), event_id)).fetchone()
                if not event:
                    return {"ok": False, "error": "Event does not belong to this task",
                            "source": "captured_session_log"}
                evidence = json.loads(event["evidence"])
                if not evidence.get("path") and isinstance(evidence.get("evidence"), dict):
                    evidence = evidence["evidence"]
                recorded_offset = evidence.get("byteOffset")
                if not evidence.get("path") or Path(evidence["path"]).resolve() != path or \
                        not isinstance(recorded_offset, int) or not 0 <= recorded_offset < size:
                    return {"ok": False, "error": "No captured source record for this event",
                            "source": "captured_session_log"}
                offset = recorded_offset
                if evidence.get("recordHash"):
                    with path.open("rb") as stream:
                        stream.seek(offset)
                        original = stream.readline(MAX_LOG_READ + 1)
                    if hashlib.sha256(original).hexdigest() != evidence["recordHash"]:
                        return {"ok": False, "error": "Source log changed; the recorded event no longer matches",
                                "source": "captured_session_log"}
            with path.open("rb") as stream:
                stream.seek(offset)
                raw = stream.read(32768)
            text = raw.decode("utf-8", "replace")
            try:
                import summary_adapter
                excerpt = summary_adapter.redact(text)
            except ImportError:
                excerpt = secret_filtered(text)
            return {"ok": True, "path": str(path), "excerpt": excerpt[:32768],
                    "truncated": offset > 0 or size - offset > 32768, "source": "captured_session_log",
                    "redacted": excerpt != text, "bytesTotal": size, "offset": offset}
        except OSError as error:
            return {"ok": False, "error": safe_text(str(error), 200), "source": "captured_session_log"}

    def tasks(self, focus=None, exchange_view=False):
        output = []
        rows = list(self.db.execute("SELECT * FROM tasks WHERE active=1 ORDER BY address"))
        for row in rows:
            data = json.loads(row["data"])
            event_limit = MAX_EVENTS if not exchange_view or data["address"] == focus else 12
            total_unread = self.db.execute("SELECT COUNT(*) FROM events WHERE task=? AND id>?",
                                          (row["id"], row["seen"])).fetchone()[0]
            if total_unread:
                records = list(self.db.execute("SELECT * FROM events WHERE task=? AND id>? ORDER BY id ASC LIMIT ?",
                                               (row["id"], row["seen"], event_limit)))
            else:
                records = list(self.db.execute("SELECT * FROM events WHERE task=? ORDER BY id DESC LIMIT ?",
                                               (row["id"], min(30, event_limit))))
                records.reverse()
            events = [{"id": r["id"], "type": r["kind"], "summary": r["summary"], "source": r["source"],
                       "at": r["at"], "evidence": json.loads(r["evidence"])} for r in records]
            unread = [e for e in events if e["id"] > row["seen"]]
            earliest = self.db.execute("SELECT MIN(id) FROM events WHERE task=?", (row["id"],)).fetchone()[0]
            previous_seen_exists = row["seen"] == 0 or self.db.execute(
                "SELECT 1 FROM events WHERE id=? AND task=?", (row["seen"], row["id"])).fetchone() is not None
            delta = {"events": len(unread), "totalUnreviewed": total_unread,
                     "filesModified": len({file for e in unread if e["source"] == "git_observation"
                                           for file in e["evidence"].get("files", [])}),
                     "completedSteps": sum(e["type"] == "agent_response" for e in unread),
                     "decisions": sum(e["type"] == "report" and bool(e["evidence"].get("decisions")) for e in unread),
                     "testsPassed": sum(e["evidence"].get("testsPassed", 0) for e in unread
                                        if e["source"] == "test_log" and
                                        isinstance(e["evidence"].get("testsPassed"), int)) or UNKNOWN,
                     "boundaryEventId": events[-1]["id"] if events else row["seen"],
                     "gap": not previous_seen_exists or data.get("prunedThrough", 0) > row["seen"] or
                             data.get("logGapEventId", 0) > row["seen"] or bool(earliest and
                             earliest > data.get("firstEventId", earliest) and row["seen"] < earliest),
                     "prunedThrough": data.get("prunedThrough", 0),
                     "hasMore": total_unread > len(unread),
                     "earliestAvailableEventId": earliest}
            # 'completedSteps' counts source final responses, not claims of completed implementation.
            delta["agentResponses"] = delta.pop("completedSteps")
            data.update({"lastReviewedEventId": row["seen"], "snapshotVersion": row["version"],
                         "updatedAt": row["updated"], "stale": now() - row["updated"] > 30 * 60000,
                         "events": events, "delta": delta})
            data["latestRecordedTests"] = latest_recorded_tests(data.get("recordedTests", []))
            data["reviewDigest"] = {
                "goal": data["goal"], "changes": data.get("completedSteps", []),
                "files": data.get("git", {}).get("files", []),
                "decisions": data.get("decisions", []),
                "tests": data["latestRecordedTests"] + data.get("reportedTests", []),
                "unverified": ["수집기는 테스트를 다시 실행하지 않았습니다. 기록된 테스트 명령과 결과를 확인하세요."]
                    if data.get("recordedTests") else ["기록된 테스트 실행 결과를 확인하지 못했습니다."],
                "risks": data.get("blockers", []), "nextAction": data.get("nextAction", UNKNOWN),
                "sourceLog": data.get("sourceLog"),
                "latestResponse": data.get("lastCompletedResponse") or data.get("latestResponse", ""),
                "source": "agent_report_and_git", "completionVerified": False}
            output.append(data)
        return output

    def conflicts(self, tasks, config):
        if not config.get("conflictDetection", True):
            return []
        output = []
        deadline = time.monotonic() + 2
        for task in tasks:
            git = task.get("git", {})
            if git.get("actualConflicts"):
                stale = git.get("stale") or git.get("pending")
                active_agent = task.get("status") in ("working", "blocked", "error")
                active = active_agent and bool(current_change_scope(task)["files"])
                output.append({"id": digest(["actual", task["taskId"], git["actualConflicts"],
                                            task.get("gitEventId", 0)])[:24],
                               "level": 1, "kind": "potential" if stale else "actual",
                               "agents": [task["taskId"]],
                               "activeWriter": active, "activeAgent": active_agent,
                               "sharedDirty": False, "dirtyOverlap": False,
                               "files": git["actualConflicts"], "symbols": [], "integrated": "unknown",
                               "perAgentIntegrated": {task["taskId"]: "unknown"},
                               "summary": "이전 Git 관측에서 충돌이 있었습니다. 현재 상태를 다시 확인해야 합니다."
                                   if stale else "Git index에 해결되지 않은 충돌이 있습니다.",
                               "evidence": {"source": "git_status", "worktree": task["worktreePath"],
                                            "observedAt": git.get("observedAt"),
                                            "currentObservation": "Unknown" if stale else "observed"}})
        integration_cache = {}
        ordered = sorted(tasks, key=lambda task: (task.get("status") not in ("working", "blocked", "error"),
                                                 task["address"]))
        for index, first in enumerate(ordered):
            if first["repositoryId"] == UNKNOWN or not first["git"].get("ok"):
                continue
            for second in ordered[index + 1:]:
                if len(output) >= 300:
                    return output
                if second["repositoryId"] != first["repositoryId"] or not second["git"].get("ok"):
                    continue
                a, b = first["git"], second["git"]
                current_a, current_b = current_change_scope(first), current_change_scope(second)
                same = first["worktreePath"] == second["worktreePath"]
                active_agent_first = first.get("status") in ("working", "blocked", "error")
                active_agent_second = second.get("status") in ("working", "blocked", "error")
                active_first = active_agent_first and bool(current_a["files"])
                active_second = active_agent_second and bool(current_b["files"])
                active_writer = active_first or active_second
                dirty_overlap = sorted(current_a["dirtyFiles"] & current_b["dirtyFiles"])
                shared_dirty = bool(same and (current_a["dirtyFiles"] or current_b["dirtyFiles"]))
                actual_unmerged = bool(a.get("actualConflicts") or b.get("actualConflicts"))
                # Old completed branches stay available in task.git as repository
                # context; they are not active collision alerts merely for existing.
                if not active_writer and not dirty_overlap and not actual_unmerged:
                    continue
                overlap = sorted(current_a["files"] & current_b["files"])
                common_symbols = set()
                symbol_files = []
                for path in overlap:
                    left = current_a["definitions"].get(path, {})
                    right = current_b["definitions"].get(path, {})
                    named = set(left.get("symbols", [])) & set(right.get("symbols", []))
                    if named:
                        common_symbols.update(named)
                        symbol_files.append({"file": path, "symbols": sorted(named),
                                             "firstScopes": [scope for scope in ("dirty", "recent")
                                                             if path in current_a[scope + "Files"]],
                                             "secondScopes": [scope for scope in ("dirty", "recent")
                                                              if path in current_b[scope + "Files"]]})
                common_symbols = sorted(common_symbols)
                level = 0
                symbols = []
                evidence = {}
                if same:
                    level = 1
                    summary = "두 세션이 같은 worktree를 공유합니다. 변경 작성자를 구분할 수 없습니다."
                    evidence["sharedWorktree"] = first["worktreePath"]
                elif overlap:
                    level = 2 if common_symbols else 1
                    summary = "동일 심볼·계약 변경 가능성" if common_symbols else "여러 worktree에서 동일 파일을 변경했습니다."
                    symbols = common_symbols
                elif active_writer and config.get("dependencyAnalysis", True):
                    # Old caches may contain raw interface-line words. Restrict
                    # them to names proven by the declaration extractor.
                    changed_a = current_a["contracts"] & current_a["symbols"]
                    changed_b = current_b["contracts"] & current_b["symbols"]
                    match = (changed_a & current_b["references"]) | (changed_b & current_a["references"])
                    match = {name for name in match if name.lower() not in
                             {"string", "number", "boolean", "bool", "int", "float", "double", "void",
                              "any", "unknown", "object", "array", "null", "none", "never", "error",
                              "exception", "export", "interface", "type", "return", "class", "struct",
                              "trait", "self", "this"}}
                    if match:
                        level = 3
                        symbols = sorted(match)[:20]
                        summary = "다른 파일에서 변경된 심볼·계약을 참조할 가능성이 있습니다."
                if not level:
                    continue
                per_agent = {}
                for target, source, target_id in ((a, b, first["taskId"]), (b, a, second["taskId"])):
                    integration_key = (target["root"], source["head"], target["head"])
                    integrated = integration_cache.get(integration_key)
                    if integrated is None:
                        if target.get("stale") or target.get("pending") or source.get("stale") or source.get("pending"):
                            integrated = "unknown"
                        elif target["head"] == source["head"]:
                            integrated = "yes"
                        elif time.monotonic() >= deadline:
                            integrated = "unknown"
                        else:
                            try:
                                run_git(target["root"], ["merge-base", "--is-ancestor", source["head"], target["head"]],
                                        timeout=min(1, max(.01, deadline-time.monotonic())))
                                integrated = "yes"
                            except GitError as error:
                                integrated = "no" if error.code == 1 else "unknown"
                            except RuntimeError:
                                integrated = "unknown"
                            except (TimeoutError, OSError):
                                integrated = "unknown"
                        integration_cache[integration_key] = integrated
                    per_agent[target_id] = integrated
                integrated = per_agent[first["taskId"]]
                evidence.update({"source": "git_diff_heuristic", "firstHead": a["head"],
                                 "secondHead": b["head"], "firstWorktree": a["root"],
                                 "secondWorktree": b["root"], "scope": "current_dirty_and_observed_HEAD_transition",
                                 "firstCurrentFiles": sorted(current_a["files"])[:MAX_FILES],
                                 "secondCurrentFiles": sorted(current_b["files"])[:MAX_FILES],
                                 "symbolFileEvidence": symbol_files[:40],
                                 "firstRecentObserved": current_a["recentObserved"],
                                 "secondRecentObserved": current_b["recentObserved"],
                                 "firstObservedAt": a.get("observedAt"), "secondObservedAt": b.get("observedAt"),
                                 "currentObservation": "Unknown" if
                                     a.get("stale") or a.get("pending") or b.get("stale") or b.get("pending")
                                     else "observed",
                                 "integrationScope": "observed_committed_HEAD_only",
                                 "activeWriter": active_writer,
                                 "activeWriterAgents": [task["taskId"] for task in (first, second)
                                                        if task.get("status") in ("working", "blocked", "error") and
                                                        current_change_scope(task)["files"]],
                                 "activeWriterMeaning": "active_core_status_with_observed_changes; file_authorship_unknown",
                                 "sharedDirty": shared_dirty, "dirtyOverlapFiles": dirty_overlap,
                                 "uncommittedChangesIntegrated": "unknown",
                                 "advice": "Git diff와 호출부를 확인하세요. 자동 병합은 수행하지 않습니다."})
                output.append({"id": digest([sorted([first["taskId"], second["taskId"]]), level, overlap, symbols,
                                            a.get("fingerprint"), b.get("fingerprint"),
                                            first.get("gitEventId", 0), second.get("gitEventId", 0),
                                            first.get("statusEventId", 0) if active_first else None,
                                            second.get("statusEventId", 0) if active_second else None])[:24],
                               "level": level, "kind": "potential", "agents": [first["taskId"], second["taskId"]],
                               "activeWriter": active_writer, "activeAgent": active_agent_first or active_agent_second,
                               "sharedDirty": shared_dirty,
                               "dirtyOverlap": bool(dirty_overlap),
                               "files": overlap or sorted(current_a["files"] | current_b["files"])[:20],
                               "symbols": symbols,
                               "integrated": integrated, "perAgentIntegrated": per_agent,
                               "summary": summary, "evidence": evidence})
        return output[:300]

    def attention(self, tasks, conflicts):
        items = []
        for task in tasks:
            status = task["status"]
            types = []
            if status in ("blocked", "error") or task.get("needsDecision") or task.get("blockers"):
                sources, causes = [], []
                if status in ("blocked", "error"):
                    sources.append("core_status")
                    causes.append(task.get("statusEventId", 0))
                if task.get("needsDecision"):
                    sources.append("agent_report")
                    causes.append(task.get("decisionCauseEventId") or task.get("reportCauseEventId", 0))
                if task.get("blockers"):
                    sources.append("agent_report")
                    causes.append(task.get("blockerCauseEventId") or task.get("reportCauseEventId", 0))
                blocked_kind = task.get("statusKind") if status == "blocked" else None
                kind = "error" if status == "error" else "approval" if blocked_kind == "permission" else \
                    "user_info" if blocked_kind in ("question", "auth") else "decision" if task.get("needsDecision") else \
                    "blocked" if status == "blocked" else "blocker_report"
                labels = []
                if status == "blocked":
                    labels.append("승인 필요" if blocked_kind == "permission" else
                                  "로그인 필요" if blocked_kind == "auth" else
                                  "사용자 정보 필요" if blocked_kind == "question" else "사용자 입력 대기")
                elif status == "error":
                    labels.append("에이전트 오류")
                if task.get("needsDecision"):
                    labels.append("설계 결정 필요")
                if task.get("blockers"):
                    labels.append(safe_text(task["blockers"][0], 200))
                cause_id = max(causes or [0])
                advice = "원본 터미널에서 로그인 절차를 진행하세요." if blocked_kind == "auth" else \
                    "원본 요청과 보고된 차단 요인을 확인하세요."
                types.append((kind, 100 if status in ("blocked", "error") else 95 if
                              task.get("needsDecision") else 90, " · ".join(labels),
                              "+".join(sorted(set(sources))), advice,
                              cause_id, {"sources": sorted(set(sources)), "causeEventIds": sorted(set(causes)),
                                         "coreStatus": status, "needsDecision": bool(task.get("needsDecision")),
                                         "statusKind": task.get("statusKind"),
                                         "statusMessage": task.get("statusMessage", ""),
                                         "reportedBlockers": task.get("blockers", [])}))
            pending_completion = task.get("pendingCompletionEventId", 0)
            if pending_completion > task["lastReviewedEventId"]:
                types.append(("review", 60, "응답이 완료됐습니다. 구현·검증 결과를 리뷰하세요.",
                              task.get("completionSource", "core_status"),
                              "Review Digest와 Git diff를 확인하세요.", pending_completion,
                              {"completionEventId": pending_completion, "completionVerified": False}))
            failed = [test for test in latest_recorded_tests(task.get("recordedTests", []))
                      if test.get("exitCode") not in (None, 0)]
            if failed:
                types.append(("test_failure", 85, f"기록된 테스트 실패: {failed[-1]['name']}",
                              "test_log", "테스트 로그의 명령과 종료 코드를 확인하세요.",
                              failed[-1].get("eventId", 0), {"tests": failed}))
            for kind, priority, summary, source, advice, cause_id, extra in types:
                cause = self.db.execute("SELECT at FROM events WHERE id=? AND task=?",
                                        (cause_id, task["taskId"])).fetchone() if cause_id else None
                items.append({"id": digest([task["taskId"], kind, cause_id])[:24], "taskId": task["taskId"],
                              "address": task["address"], "type": kind, "summary": summary,
                              "reason": f"근거: {source}", "action": advice,
                              "evidence": {"source": source, "eventId": cause_id, "log": task.get("sourceLog"),
                                           "latestResponse": ((task.get("lastCompletedResponse") or
                                                               task.get("latestResponse") or "") if kind == "review"
                                                              else task.get("latestResponse") or "")[:600], **extra},
                              "at": cause["at"] if cause else task["updatedAt"], "priority": priority})
        groups = {}
        task_map = {task["taskId"]: task for task in tasks}
        for conflict in conflicts:
            active = conflict.get("activeWriter", False)
            shared_dirty = conflict.get("sharedDirty", False)
            if conflict["kind"] != "actual" and not active and not shared_dirty:
                continue
            if conflict["kind"] != "actual" and not conflict.get("files"):
                continue
            evidence = conflict.get("evidence", {})
            observed = evidence.get("currentObservation") != "Unknown"
            priority = 98 if conflict["kind"] == "actual" else 30 if not observed else \
                85 if shared_dirty else 80 if conflict["level"] == 2 and active else \
                40 if conflict["level"] == 3 else 70
            for task_id in conflict["agents"]:
                if task_id in task_map:
                    groups.setdefault(task_id, []).append((priority, conflict))
        for task_id, entries in groups.items():
            task = task_map[task_id]
            entries.sort(key=lambda entry: (-entry[0], entry[1]["id"]))
            priority, highest = entries[0]
            radar_ids = sorted({conflict["id"] for _priority, conflict in entries})
            related = sorted({other for _priority, conflict in entries for other in conflict["agents"]
                              if other != task_id})
            observed_times = [conflict.get("evidence", {}).get(key) for _priority, conflict in entries
                              for key in ("observedAt", "firstObservedAt", "secondObservedAt")]
            at = max((value for value in observed_times if isinstance(value, int)), default=task["updatedAt"])
            items.append({"id": digest(["conflict-group", task_id, radar_ids])[:24],
                          "taskId": task_id, "taskIds": [task_id], "address": task["address"],
                          "relatedTaskIds": related, "groupedRadarIds": radar_ids,
                          "activeWriter": any(conflict.get("activeWriter") for _priority, conflict in entries),
                          "type": "conflict", "summary": highest["summary"],
                          "reason": highest["kind"],
                          "action": "Conflict Radar에서 관련 worktree의 근거를 확인하세요.",
                          "evidence": {**highest["evidence"], "groupedRadarIds": radar_ids,
                                       "relatedTaskIds": related, "groupedCount": len(radar_ids)},
                          "at": at, "priority": priority})
        return sorted(items, key=lambda i: (-i["priority"], i["at"], i["id"]))[:300]


def main():
    arguments = sys.argv[1:]
    if not arguments or arguments[0] not in ("exchange", "summarize", "read-source"):
        print(encoded({"ok": False, "error": "Usage: bridge.py exchange|summarize|read-source JSON (or - for stdin)"}))
        return 2
    try:
        raw = sys.stdin.read(1024 * 1024 + 1) if len(arguments) < 2 or arguments[1] == "-" else arguments[1]
        if len(raw) > 1024 * 1024:
            raise ValueError("Request exceeds 1 MiB")
        request = json.loads(raw)
        if not isinstance(request, dict):
            raise ValueError("Request must be an object")
        directory = request.get("stateDir") or str(Path.home() / ".config/herdr-app/data/agent-control-center")
        store = Store(directory)
        try:
            result = store.exchange(request) if arguments[0] == "exchange" else \
                store.summarize(request) if arguments[0] == "summarize" else store.read_source(request)
        finally:
            store.close()
        print(encoded(result))
        return 0
    except Exception as error:
        print(encoded({"ok": False, "error": safe_text(str(error), 500), "version": VERSION}))
        return 1


if __name__ == "__main__":
    sys.exit(main())

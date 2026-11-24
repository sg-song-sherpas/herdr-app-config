"""Read exact local Codex session settings; never infer from global defaults."""
import json
import importlib.util
import os
from pathlib import Path
import re
import sqlite3
import sys

BUDGET = 4 * 1024 * 1024
MISSING = object()


def latest_setting(file, start, end):
    file.seek(start)
    if start:
        file.readline()  # Do not parse a record that begins before this window.
    data = file.read(max(0, end - file.tell()))
    for line in reversed(data.splitlines()):
        if b'"thread_settings_applied"' not in line:
            continue
        try:
            record = json.loads(line)
            payload = record.get('payload', {})
            settings = payload.get('thread_settings', {})
            if record.get('type') == 'event_msg' and payload.get('type') == 'thread_settings_applied' and 'service_tier' in settings:
                return settings['service_tier'] in ('priority', 'fast')
        except (ValueError, AttributeError, TypeError):
            continue
    return MISSING


def read_mode(path, previous):
    with path.open('rb') as file:
        stat = os.fstat(file.fileno())
        size = stat.st_size
        if previous.get('path') != str(path) or previous.get('inode') != stat.st_ino or previous.get('offset', 0) > size:
            previous = {}
        state = dict(previous)
        state.update(path=str(path), inode=stat.st_ino, offset=size)
        # New records win over historical settings. Leave an incomplete final
        # JSONL record for the next refresh instead of consuming it.
        file.seek(max(0, size - 1))
        complete = size == 0 or file.read(1) == b'\n'
        if not complete:
            file.seek(max(0, size - BUDGET))
            tail = file.read()
            size = max(0, stat.st_size - len(tail) + tail.rfind(b'\n') + 1)
            state['offset'] = size
        offset = previous.get('offset', size)
        if size > offset:
            start = max(offset - 1, size - BUDGET)
            value = latest_setting(file, start, size)
            if value is not MISSING:
                state.update(fast=value, search_end=0)
                return state
            if start > offset:
                state['search_end'] = size
                state.pop('fast', None)
        end = state.get('search_end', size if not previous else 0)
        if end:
            start = max(0, end - BUDGET)
            value = latest_setting(file, start, end)
            if value is not MISSING:
                state.update(fast=value, search_end=0)
            else:
                # Overlap one record boundary so a settings line split at the
                # chunk edge is included on the next backward pass.
                file.seek(start)
                boundary = file.readline()
                state['search_end'] = min(end - 1, start + len(boundary)) if start else 0
        return state


def collect(request, codex_home):
    sessions = request.get('sessions', [])
    previous = request.get('previous', {})
    result = {}
    # State DB is read-only and only supplies exact session-to-file paths.
    databases = sorted(codex_home.glob('state_*.sqlite'), key=lambda p: int(p.stem.split('_')[-1]), reverse=True)
    for db in databases:
        try:
            with sqlite3.connect(db.as_uri() + '?mode=ro', uri=True, timeout=0.2) as connection:
                for session in sessions:
                    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,128}', session):
                        continue
                    row = connection.execute('SELECT rollout_path FROM threads WHERE id = ?', (session,)).fetchone()
                    if not row:
                        continue
                    try:
                        result[session] = read_mode(Path(row[0]), previous.get(session, {}))
                    except (OSError, ValueError):
                        pass
            break
        except sqlite3.Error:
            continue
    return result


def resolve_unlabeled(targets, codex_home):
    unresolved = [t for t in targets if not t.get('session')]
    if not unresolved:
        return {}
    # Reuse the existing read-only live-thread resolver: cwd + exact title must
    # identify one loaded, non-child conversation. Ambiguous matches stay unknown.
    spec = importlib.util.spec_from_file_location('codex_rename', Path(__file__).with_name('codex-rename.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    rpc = None
    resolved = {}
    try:
        rpc = module.Rpc(codex_home / 'app-server-control/app-server-control.sock')
        pages = {}
        for target in unresolved:
            cwd = target.get('cwd')
            if not cwd:
                continue
            try:
                if cwd not in pages:
                    threads, cursor = [], None
                    while True:
                        page = rpc.call('thread/list', {'cwd': cwd, 'limit': 100, 'useStateDbOnly': True, 'cursor': cursor})
                        threads.extend(page['data'])
                        cursor = page.get('nextCursor')
                        if not cursor:
                            break
                    pages[cwd] = threads
                resolved[target['address']] = module.resolve_thread(target, pages[cwd])
            except (ValueError, OSError, KeyError):
                continue
    except (ValueError, OSError):
        pass
    finally:
        if rpc:
            rpc.close()
    return resolved


if __name__ == '__main__':
    request = json.loads(sys.argv[1])
    codex_home = Path(os.environ.get('CODEX_HOME', str(Path.home() / '.codex'))).resolve()
    targets = request.get('targets', [])
    resolved = resolve_unlabeled(targets, codex_home)
    for target in targets:
        if target.get('session'):
            resolved[target['address']] = target['session']
    request['sessions'] = list(set(request.get('sessions', []) + list(resolved.values())))
    print(json.dumps({'states': collect(request, codex_home), 'resolved': resolved}, separators=(',', ':')))

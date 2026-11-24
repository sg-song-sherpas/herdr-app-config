"""Reapply an owned, minimal toast filter after Herdr restores shipped mods.
Only patch an exact shipped file. Never overwrite custom toast edits.
"""
import json
from pathlib import Path
import sys

MARKER = '// Control Center completion notification filter v2.'
GUARD = '''    // Control Center completion notification filter v2.
    if (shared("acc.config")?.sidebarCompletionNotifications === false &&
        p.level === "success" && typeof p.title === "string" &&
        p.title.startsWith("finished: ") && p.action?.name === "agent.focus" &&
        p.action?.args?.terminal) {
      if (!this.dismissQueued) {
        this.dismissQueued = true;
        cx.spawn(async () => { closeOverlay(p.overlay); });
      }
      return div().w(0).h(0);
    }
'''

def fingerprint(raw):
    value = 0xcbf29ce484222325
    for byte in raw:
        value = ((value ^ byte) * 0x100000001b3) & 0xffffffffffffffff
    return f'{value:016x}'

def ensure(home):
    home = Path(home)
    path = home / 'mods/toast/main.js'
    raw = path.read_bytes()
    text = raw.decode('utf-8')
    if MARKER in text:
        return {'ok': True, 'changed': False}
    recorded = json.loads((home / 'installed.json').read_text()).get('toast', {}).get('main.js')
    if fingerprint(raw) != recorded:
        raise ValueError('사용자가 수정한 알림 파일은 덮어쓰지 않았습니다.')
    before = 'import { props, closeOverlay, run, theme } from "herdr";'
    anchor = '    const p = props() ?? {};\n'
    if text.count(before) != 1 or text.count(anchor) != 1:
        raise ValueError('Herdr 알림 구조가 변경되어 필터를 적용하지 않았습니다.')
    updated = text.replace(before, 'import { props, closeOverlay, run, theme, shared } from "herdr";').replace(anchor, anchor + GUARD)
    backup = home / 'data/agent-control-center/notification-backups' / (fingerprint(raw) + '.js')
    backup.parent.mkdir(parents=True, exist_ok=True)
    if not backup.exists():
        backup.write_bytes(raw)
    if path.read_bytes() != raw:
        raise ValueError('알림 파일이 동시에 변경되어 적용하지 않았습니다.')
    temp = path.with_suffix('.control-center.tmp')
    temp.write_text(updated)
    temp.replace(path)
    return {'ok': True, 'changed': True}

if __name__ == '__main__':
    try:
        print(json.dumps(ensure(sys.argv[1]), ensure_ascii=False))
    except (OSError, ValueError, IndexError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}, ensure_ascii=False))
        sys.exit(1)

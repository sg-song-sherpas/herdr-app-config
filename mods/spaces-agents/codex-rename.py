"""Rename loaded Codex threads via the existing local server; never start one.

Vendored identically in tabs-linear (Herdr mods cannot import each other).
Only exact, unique terminal-title + cwd matches are accepted. No DB writes,
terminal input, turn submission, daemon restart, or credentials are involved.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import struct
import subprocess
import sys
import time


def terminal(address):
    if not re.fullmatch(r"t[0-9a-z]+", address):
        raise ValueError("원격 터미널의 Codex 이름 동기화는 지원하지 않습니다.")
    result = subprocess.run(["hc", "get", address, "--json"], capture_output=True,
                            text=True, timeout=5, check=True)
    value = json.loads(result.stdout)
    if value.get("state") != "live" or value.get("status", {}).get("app") != "codex":
        raise ValueError("이 터미널에서 실행 중인 Codex를 찾지 못했습니다.")
    return value


def matches_title(title, name):
    title = re.sub(r"^[\u2800-\u28ff✳●◦•✓✔⏺]\s+", "", title.strip())
    return bool(name) and (title == name or title.startswith(name + " | "))


def resolve_thread(term, threads):
    cwd = term.get("foreground", {}).get("cwd") or term.get("cwd")
    matches = [t for t in threads if cwd and t.get("cwd")
               and os.path.realpath(t["cwd"]) == os.path.realpath(cwd)
               and t.get("status", {}).get("type") in ("idle", "active")
               and not t.get("parentThreadId") and not t.get("ephemeral")
               and matches_title(term.get("title", ""), t.get("name"))]
    if len(matches) != 1:
        raise ValueError("Codex 대화를 고유하게 찾지 못했습니다. 대화 이름 중복 또는 연결 상태를 확인해 주세요.")
    return matches[0]["id"]


class Rpc:
    """Small RFC 6455 client for Codex's private Unix control socket."""
    def __init__(self, path):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(5)
        self.reader = None
        self.seq = 0
        try:
            self.sock.connect(str(path))
            self.reader = self.sock.makefile("rb")
            key = base64.b64encode(os.urandom(16)).decode()
            self.sock.sendall(("GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
                               "Connection: Upgrade\r\nSec-WebSocket-Version: 13\r\n"
                               f"Sec-WebSocket-Key: {key}\r\n\r\n").encode())
            status = self.reader.readline(4096)
            headers = {}
            for _ in range(64):
                line = self.reader.readline(4096)
                if line == b"\r\n":
                    break
                if not line or b":" not in line:
                    raise ValueError("Invalid Codex WebSocket handshake")
                k, v = line.decode().split(":", 1)
                headers[k.lower()] = v.strip()
            else:
                raise ValueError("Oversized Codex WebSocket handshake")
            accept = base64.b64encode(hashlib.sha1(
                (key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()).decode()
            if b" 101 " not in status or headers.get("sec-websocket-accept") != accept:
                raise ValueError("Codex 서버 연결을 확인하지 못했습니다.")
            self.call("initialize", {"clientInfo": {"name": "herdr-tab-rename", "version": "1.0"}})
            self.send({"method": "initialized"})
        except Exception:
            self.close()
            raise

    def close(self):
        if self.reader:
            self.reader.close()
        self.sock.close()

    def frame(self, data, opcode=1):
        mask = os.urandom(4)
        n = len(data)
        size = bytes([n | 128]) if n < 126 else (b"\xfe" + struct.pack("!H", n)
                if n < 65536 else b"\xff" + struct.pack("!Q", n))
        self.sock.sendall(bytes([128 | opcode]) + size + mask
                          + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def send(self, value):
        self.frame(json.dumps(value, ensure_ascii=False).encode())

    def exact(self, n):
        result = self.reader.read(n)
        if len(result) != n:
            raise ConnectionError("Codex 서버 연결이 닫혔습니다.")
        return result

    def receive(self, deadline):
        data = bytearray()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Codex 서버 응답 시간이 초과되었습니다.")
            self.sock.settimeout(remaining)
            a, b = self.exact(2)
            n = b & 127
            if n == 126:
                n = struct.unpack("!H", self.exact(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self.exact(8))[0]
            if n + len(data) > 8 * 1024 * 1024 or b & 128:
                raise ValueError("Invalid Codex WebSocket frame")
            payload = self.exact(n)
            opcode = a & 15
            if opcode == 8:
                raise ConnectionError("Codex 서버 연결이 닫혔습니다.")
            if opcode == 9:
                self.frame(payload, 10)
                continue
            if opcode == 10:
                continue
            if opcode not in (0, 1):
                raise ValueError("Unexpected Codex WebSocket frame")
            data.extend(payload)
            if a & 128:
                return json.loads(data)

    def call(self, method, params):
        self.seq += 1
        self.send({"id": self.seq, "method": method, "params": params})
        deadline = time.monotonic() + 5
        while True:
            value = self.receive(deadline)
            if value.get("id") != self.seq:
                continue
            if "error" in value:
                raise ValueError(value["error"].get("message", "Codex 이름 변경 실패"))
            return value["result"]


def sync(request, rpc, get_terminal=terminal, resolve_only=False):
    name = request["name"].strip()
    if not name:
        raise ValueError("이름을 입력해 주세요.")
    targets = []
    for address in dict.fromkeys(request["terminals"]):
        before = get_terminal(address)
        cwd = before.get("foreground", {}).get("cwd") or before.get("cwd")
        threads, cursor = [], None
        while True:
            page = rpc.call("thread/list", {"cwd": cwd, "limit": 100,
                            "useStateDbOnly": True, "cursor": cursor})
            threads.extend(page["data"])
            cursor = page.get("nextCursor")
            if not cursor:
                break
        thread_id = resolve_thread(before, threads)
        # The person may have switched conversations while the lookup ran.
        after = get_terminal(address)
        if (before.get("foreground", {}).get("pid") != after.get("foreground", {}).get("pid")
                or resolve_thread(after, threads) != thread_id):
            raise ValueError("대화가 변경되어 이름 동기화를 중단했습니다. 다시 시도해 주세요.")
        targets.append(thread_id)
    for thread_id in dict.fromkeys(targets):
        if resolve_only:
            continue
        rpc.call("thread/name/set", {"threadId": thread_id, "name": name})
        actual = rpc.call("thread/read", {"threadId": thread_id})["thread"]
        if actual.get("name") != name:
            raise ValueError("Codex 이름 저장을 확인하지 못했습니다.")
    return {"threadIds": list(dict.fromkeys(targets)), "name": name}


def main():
    rpc = None
    try:
        request = json.loads(sys.argv[1])
        codex_home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
        rpc = Rpc(codex_home / "app-server-control/app-server-control.sock")
        print(json.dumps(sync(request, rpc, resolve_only="--resolve" in sys.argv[2:]), ensure_ascii=False))
    except Exception as error:
        print(str(error), file=sys.stderr)
        return 1
    finally:
        if rpc:
            rpc.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

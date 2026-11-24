import copy
import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[2] / "mods/spaces-agents/codex-rename.py"
spec = importlib.util.spec_from_file_location("bridge", path)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class FakeRpc:
    def __init__(self, threads):
        self.threads = copy.deepcopy(threads)
        self.calls = []

    def call(self, method, params):
        self.calls.append((method, params))
        if method == "thread/list":
            return {"data": self.threads, "nextCursor": None}
        thread = next(t for t in self.threads if t["id"] == params["threadId"])
        if method == "thread/name/set":
            thread["name"] = params["name"]
            return {}
        if method == "thread/read":
            return {"thread": thread}
        raise AssertionError(method)


class RenameTests(unittest.TestCase):
    def setUp(self):
        self.term = {"cwd": "/repo", "title": "⠴ 로그인 수정 | songseongwon",
                     "foreground": {"pid": 123, "cwd": "/repo"}}
        self.thread = {"id": "one", "name": "로그인 수정", "cwd": "/repo",
                       "status": {"type": "active"}}

    def test_exact_name_and_folder_avoid_other_conversations(self):
        threads = [dict(self.thread, id="other-folder", cwd="/other"),
                   dict(self.thread, id="other-name", name="로그인"), self.thread]
        self.assertEqual(bridge.resolve_thread(self.term, threads), "one")

    def test_ambiguous_titles_fail_closed(self):
        with self.assertRaises(ValueError):
            bridge.resolve_thread(self.term, [self.thread, dict(self.thread, id="two")])

    def test_unloaded_or_subagent_or_missing_title_never_match(self):
        for overrides in [{"status": {"type": "notLoaded"}}, {"parentThreadId": "parent"},
                          {"ephemeral": True}, {"name": None}]:
            with self.assertRaises(ValueError):
                bridge.resolve_thread(self.term, [dict(self.thread, **overrides)])

    def test_title_suffix_and_unicode_name_are_preserved(self):
        for title in ["로그인 수정", "⠴ 로그인 수정 | songseongwon", "✓ 로그인 수정 | songseongwon"]:
            self.assertTrue(bridge.matches_title(title, "로그인 수정"))
        self.assertFalse(bridge.matches_title("로그인 수정 추가 | songseongwon", "로그인 수정"))

    def test_saving_renames_only_target_and_verifies_name_without_resuming(self):
        rpc = FakeRpc([self.thread, dict(self.thread, id="two", name="다른 대화")])
        result = bridge.sync({"terminals": ["t1", "t1"], "name": "새 이름 ' $() 😀"},
                             rpc, lambda _: self.term)
        self.assertEqual(result["threadIds"], ["one"])
        self.assertEqual(rpc.threads[0]["name"], "새 이름 ' $() 😀")
        self.assertEqual(rpc.threads[1]["name"], "다른 대화")
        self.assertEqual([m for m, _ in rpc.calls], ["thread/list", "thread/name/set", "thread/read"])

    def test_switching_conversation_mid_lookup_prevents_mutation(self):
        rpc = FakeRpc([self.thread])
        states = iter([self.term, dict(self.term, title="다른 대화 | songseongwon")])
        with self.assertRaises(ValueError):
            bridge.sync({"terminals": ["t1"], "name": "new"}, rpc, lambda _: next(states))
        self.assertEqual([m for m, _ in rpc.calls], ["thread/list"])

    def test_resolve_only_does_not_mutate(self):
        rpc = FakeRpc([self.thread])
        bridge.sync({"terminals": ["t1"], "name": "new"}, rpc, lambda _: self.term, True)
        self.assertEqual([m for m, _ in rpc.calls], ["thread/list"])

    def test_remote_address_is_rejected_before_any_local_lookup(self):
        with self.assertRaises(ValueError):
            bridge.terminal("remote/t1")


if __name__ == "__main__":
    unittest.main()

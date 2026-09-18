#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""提交闸 + 当日 active + 备注 的离线测试（纯 stdlib，不联网、绝不真提交）。

提交是最不可逆的动作，所以这里用假 HTTP 把官方论坛实测的两段式协议逐条钉死：
  201 → 轮询到没 Retry-After 才算成功；403 = check 没过；400 = 重复 POST；
  429/Retry-After 要会退避；轮询超预算要标 pending（而不是假装失败）。

跑法：
    ~/qianxun-devkit/run/venv-engine/bin/python -m unittest discover \
        -s ~/qianxun-devkit/engine/tests -t engine -v
"""
from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import alpha_pool_service as ap  # noqa: E402


class _Resp:
    """模拟 httpx.Response 里提交状态机用到的三个属性。"""

    def __init__(self, status_code: int = 200, *, payload: dict | None = None,
                 text: str = "", retry_after: str | None = None) -> None:
        self.status_code = status_code
        self.text = text if payload is None else json.dumps(payload)
        self.headers: dict[str, str] = {}
        if retry_after is not None:
            self.headers["Retry-After"] = retry_after

    def json(self) -> dict:
        return json.loads(self.text) if self.text else {}


class _FakeHttp:
    """按脚本逐次返回响应；脚本用完后默认返回「200 无 Retry-After = 成功」。"""

    def __init__(self, script: list) -> None:
        self.script = list(script)
        self.calls: list[tuple[str, str]] = []

    def request(self, method: str, url: str) -> _Resp:
        self.calls.append((method, url))
        if not self.script:
            return _Resp(200)
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


class _FakeBrainClient:
    def __init__(self, script: list) -> None:
        self.http = _FakeHttp(script)

    def _ensure_authed(self) -> _FakeHttp:
        return self.http


_BLOCKED_BODY = {"is": {"checks": [
    {"name": "LOW_SHARPE", "result": "FAIL", "value": 1.29, "limit": 1.58},
    {"name": "SELF_CORRELATION", "result": "PASS", "value": 0.6906},
]}}


class _PoolBase(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.pool_path = Path(self._tmp.name) / "alpha_pool.json"
        self.client = None
        ap.configure(client_factory=lambda: self._client(),
                     pool_path=self.pool_path,
                     db_path=Path(self._tmp.name) / "nope.db",
                     active_ids_getter=lambda force=False: self.active)
        self.active = ["ACTIVE01"]
        self._orig_budget = ap._SUBMIT_POLL_BUDGET_S

    def tearDown(self) -> None:
        ap._SUBMIT_POLL_BUDGET_S = self._orig_budget
        self._tmp.cleanup()

    def _client(self):
        if self.client is None:
            raise RuntimeError("no fake client scripted")
        return self.client

    # ---- helpers ----

    def _script(self, responses: list) -> _FakeBrainClient:
        self.client = _FakeBrainClient(responses)
        return self.client

    def _submit(self, ids, *, confirm=ap._SUBMIT_CONFIRM, path="/api/alpha-pool/submit"):
        return ap.route("POST", path, {"ids": ids, "confirm": confirm})

    def _wait(self, job_id, timeout=8.0) -> dict:
        end = time.time() + timeout
        while time.time() < end:
            code, payload = ap.route("GET", f"/api/alpha-pool/submit/{job_id}")
            self.assertEqual(code, 200, payload)
            if not payload["running"]:
                return payload
            time.sleep(0.02)
        self.fail("提交任务没在超时前结束")

    def _pool_item(self, alpha_id) -> dict:
        code, payload = ap.route("GET", "/api/alpha-pool")
        self.assertEqual(code, 200)
        return {i["alpha_id"]: i for i in payload["items"]}[alpha_id]


class SubmitGuardTest(_PoolBase):
    def test_requires_confirm_token(self) -> None:
        """缺 confirm 直接 400，且绝不发任何请求。"""
        self.client = _FakeBrainClient([])
        code, payload = self._submit(["YPbZLxMA"], confirm="")
        self.assertEqual(code, 400)
        self.assertIn("confirm", payload["error"])
        self.assertEqual(self.client.http.calls, [])

    def test_wrong_confirm_token_rejected(self) -> None:
        self.client = _FakeBrainClient([])
        code, _ = self._submit(["YPbZLxMA"], confirm="yes")
        self.assertEqual(code, 400)
        self.assertEqual(self.client.http.calls, [])

    def test_caps_ids_per_call(self) -> None:
        self.client = _FakeBrainClient([])
        code, payload = self._submit(["AABB%04d" % i for i in range(6)])
        self.assertEqual(code, 400)
        self.assertIn("最多", payload["error"])
        self.assertEqual(self.client.http.calls, [])

    def test_empty_ids_rejected(self) -> None:
        self.client = _FakeBrainClient([])
        self.assertEqual(self._submit("!!!")[0], 400)


class SubmitProtocolTest(_PoolBase):
    def test_happy_path_post_201_then_clean_poll(self) -> None:
        """POST 201 → GET 200 无 Retry-After = 提交成功。"""
        c = self._script([_Resp(201), _Resp(200)])
        code, payload = self._submit("YPbZLxMA")
        self.assertEqual(code, 202, payload)
        self.assertEqual(payload["mode"], "submit")
        self.assertIn("YPbZLxMA", payload["auto_added"])   # 自动进池追踪
        job = self._wait(payload["job_id"])
        item = job["items"]["YPbZLxMA"]
        self.assertEqual(item["state"], "submitted", item)
        self.assertEqual([m for m, _ in c.http.calls], ["POST", "GET"])
        # 结论要落回池子条目
        self.assertEqual(self._pool_item("YPbZLxMA")["submit"]["state"], "submitted")
        self.assertEqual(self._pool_item("YPbZLxMA")["status"], "active")

    def test_post_403_is_blocked_with_fail_names(self) -> None:
        """POST 403 = check 没过：要带回 FAIL 项，且不再轮询。"""
        c = self._script([_Resp(403, payload=_BLOCKED_BODY)])
        _, payload = self._submit("YPbZLxMA")
        job = self._wait(payload["job_id"])
        item = job["items"]["YPbZLxMA"]
        self.assertEqual(item["state"], "blocked", item)
        self.assertEqual(item["fails"], ["LOW_SHARPE"])
        self.assertEqual([m for m, _ in c.http.calls], ["POST"])

    def test_post_400_then_poll_403_is_failed(self) -> None:
        """400 = 已在提交队列（重复 POST）→ 继续轮询；轮询 403 = 判失败。"""
        c = self._script([_Resp(400), _Resp(403, payload=_BLOCKED_BODY)])
        _, payload = self._submit("YPbZLxMA")
        job = self._wait(payload["job_id"])
        item = job["items"]["YPbZLxMA"]
        self.assertEqual(item["state"], "failed", item)
        self.assertEqual(item["http"], 403)
        self.assertEqual([m for m, _ in c.http.calls], ["POST", "GET"])

    def test_retry_after_is_honoured_then_succeeds(self) -> None:
        """200 + Retry-After → 平台还在算，睡完再来；第二次无 Retry-After = 成功。"""
        c = self._script([_Resp(201), _Resp(200, retry_after="0.01"), _Resp(200)])
        _, payload = self._submit("YPbZLxMA")
        job = self._wait(payload["job_id"])
        item = job["items"]["YPbZLxMA"]
        self.assertEqual(item["state"], "submitted", item)
        self.assertEqual(item["polls"], 1)
        self.assertEqual([m for m, _ in c.http.calls], ["POST", "GET", "GET"])

    def test_poll_404_is_timeout(self) -> None:
        self._script([_Resp(201), _Resp(404, text="not found")])
        _, payload = self._submit("YPbZLxMA")
        job = self._wait(payload["job_id"])
        self.assertEqual(job["items"]["YPbZLxMA"]["state"], "timeout")

    def test_post_429_backs_off_then_succeeds(self) -> None:
        self._script([_Resp(429, retry_after="0.01"), _Resp(201), _Resp(200)])
        _, payload = self._submit("YPbZLxMA")
        job = self._wait(payload["job_id"])
        self.assertEqual(job["items"]["YPbZLxMA"]["state"], "submitted")

    def test_post_network_error_twice_then_ok(self) -> None:
        """POST 网络异常要重试；真实现里每次退避 3s，测试里压掉以免拖慢套件。"""
        from unittest.mock import patch
        self._script([ConnectionError("boom"), ConnectionError("boom"), _Resp(201), _Resp(200)])
        with patch.object(ap.time, "sleep", lambda *_: None):
            _, payload = self._submit("YPbZLxMA")
            job = self._wait(payload["job_id"])
        self.assertEqual(job["items"]["YPbZLxMA"]["state"], "submitted")
        self.assertEqual(len([m for m, _ in self.client.http.calls if m == "POST"]), 3)

    def test_poll_budget_exhausted_is_pending_not_failed(self) -> None:
        """轮询超预算必须标 pending（可续查），不能谎报失败。"""
        ap._SUBMIT_POLL_BUDGET_S = 0.05
        self._script([_Resp(201)] + [_Resp(200, retry_after="0.01")] * 100)
        _, payload = self._submit("YPbZLxMA")
        job = self._wait(payload["job_id"])
        item = job["items"]["YPbZLxMA"]
        self.assertEqual(item["state"], "pending", item)
        self.assertIn("续查", item["error"])

    def test_poll_only_mode_never_posts(self) -> None:
        """续查只 GET，绝不重复 POST（重复 POST 会撞 400 / 浪费额度）。"""
        c = self._script([_Resp(200, retry_after="0.01"), _Resp(200)])
        _, payload = self._submit("YPbZLxMA", path="/api/alpha-pool/submit/poll")
        self.assertEqual(payload["mode"], "poll")
        job = self._wait(payload["job_id"])
        self.assertEqual(job["items"]["YPbZLxMA"]["state"], "submitted")
        self.assertEqual([m for m, _ in c.http.calls], ["GET", "GET"])

    def test_request_goes_to_the_right_url(self) -> None:
        c = self._script([_Resp(201), _Resp(200)])
        _, payload = self._submit("mLmOw2op")
        self._wait(payload["job_id"])
        self.assertEqual(c.http.calls[0], ("POST", "/alphas/mLmOw2op/submit"))

    def test_multiple_ids_run_sequentially(self) -> None:
        c = self._script([_Resp(201), _Resp(200), _Resp(403, payload=_BLOCKED_BODY)])
        _, payload = self._submit("YPbZLxMA,mLmOw2op")
        job = self._wait(payload["job_id"])
        self.assertEqual(job["items"]["YPbZLxMA"]["state"], "submitted")
        self.assertEqual(job["items"]["mLmOw2op"]["state"], "blocked")
        self.assertEqual([m for m, _ in c.http.calls], ["POST", "GET", "POST"])
        self.assertEqual(c.http.calls[2][1], "/alphas/mLmOw2op/submit")

    def test_unknown_job_id_is_404(self) -> None:
        self.client = _FakeBrainClient([])
        self.assertEqual(ap.route("GET", "/api/alpha-pool/submit/nope-1")[0], 404)

    def test_thread_object_is_not_serialized(self) -> None:
        self._script([_Resp(201), _Resp(200)])
        _, payload = self._submit("YPbZLxMA")
        job = self._wait(payload["job_id"])
        self.assertNotIn("thread", job)
        json.dumps(job)   # 必须可 JSON 序列化（前端要能吃）


class NoteTest(_PoolBase):
    def test_note_roundtrip_and_persist(self) -> None:
        self.client = _FakeBrainClient([])
        ap.route("POST", "/api/alpha-pool", {"action": "add", "ids": "YPbZLxMA"})
        code, payload = ap.route("POST", "/api/alpha-pool",
                                 {"action": "note", "alpha_id": "YPbZLxMA",
                                  "note": "GLB crowding 母体，等 decay 再调"})
        self.assertEqual(code, 200, payload)
        self.assertEqual(payload["items"][0]["note"], "GLB crowding 母体，等 decay 再调")
        ap._state["ids"] = []      # 模拟进程重启
        ap._load()
        code, payload = ap.route("GET", "/api/alpha-pool")
        self.assertEqual(payload["items"][0]["note"], "GLB crowding 母体，等 decay 再调")

    def test_note_on_unknown_id_is_404(self) -> None:
        self.client = _FakeBrainClient([])
        self.assertEqual(ap.route("POST", "/api/alpha-pool",
                                  {"action": "note", "alpha_id": "YPbZLxMA",
                                   "note": "x"})[0], 404)

    def test_note_too_long_is_400(self) -> None:
        self.client = _FakeBrainClient([])
        ap.route("POST", "/api/alpha-pool", {"action": "add", "ids": "YPbZLxMA"})
        self.assertEqual(ap.route("POST", "/api/alpha-pool",
                                  {"action": "note", "alpha_id": "YPbZLxMA",
                                   "note": "x" * (ap._NOTE_MAX + 1)})[0], 400)

    def test_note_is_local_only_no_brain_calls(self) -> None:
        c = self._script([])
        ap.route("POST", "/api/alpha-pool", {"action": "add", "ids": "YPbZLxMA"})
        ap.route("POST", "/api/alpha-pool", {"action": "note", "alpha_id": "YPbZLxMA", "note": "hi"})
        self.assertEqual(c.http.calls, [])


class ActiveStatsTest(_PoolBase):
    def _stats(self, force: bool = False) -> dict:
        code, payload = ap.route("GET", f"/api/alpha-pool/active-stats?force={'1' if force else '0'}")
        self.assertEqual(code, 200, payload)
        return payload

    def test_first_observation_sets_baseline_and_reports_zero(self) -> None:
        """没有历史基准线时当日新增记 0——宁可漏算，绝不把存量当新增。"""
        self.active = ["A1", "A2", "A3"]
        stats = self._stats()
        self.assertEqual(stats["daily_new"], 0)
        self.assertEqual(stats["active_count"], 3)
        self.assertEqual(stats["baseline_count"], 3)
        self.assertFalse(stats["stale"])

    def test_newly_active_are_counted(self) -> None:
        self.active = ["A1", "A2"]
        self._stats()
        self.active = ["A1", "A2", "A3", "A4"]
        stats = self._stats()
        self.assertEqual(stats["daily_new"], 2)
        self.assertEqual(sorted(stats["daily_new_ids"]), ["A3", "A4"])
        self.assertEqual(stats["active_count"], 4)

    def test_dropped_ids_do_not_reduce_baseline(self) -> None:
        """中途被踢出 ACTIVE 不会让基准线变小，也不会虚增当日新增。"""
        self.active = ["A1", "A2", "A3"]
        self._stats()
        self.active = ["A1", "A4"]
        stats = self._stats()
        self.assertEqual(stats["daily_new"], 1)
        self.assertEqual(stats["daily_new_ids"], ["A4"])
        self.assertEqual(stats["active_count"], 2)

    def test_crossing_noon_resets_the_baseline(self) -> None:
        """跨过一个 12:00 边界 → 基准线重打，当日新增归零。"""
        self.active = ["A1", "A2"]
        self._stats()
        # 把基准线时间戳推到「上一个 12:00 之前」，模拟已经跨天
        with ap._lock:
            ap._state["active"]["baseline_reset_at_ts"] = ap._noon_boundary() - 86400
        self.active = ["A1", "A2", "A3"]
        stats = self._stats()
        self.assertEqual(stats["daily_new"], 0, "跨过 12:00 后应重置")
        self.assertEqual(stats["baseline_count"], 3)

    def test_noon_boundary_before_and_after_noon(self) -> None:
        import datetime as dt
        def ts(h, m):
            return dt.datetime(2026, 9, 18, h, m).timestamp()
        # 11:59 → 当日边界是【昨天】12:00；12:00 及之后 → 今天 12:00
        self.assertEqual(ap._noon_boundary(ts(11, 59)), ts(12, 0) - 86400)
        self.assertEqual(ap._noon_boundary(ts(0, 0)), ts(12, 0) - 86400)
        self.assertEqual(ap._noon_boundary(ts(12, 0)), ts(12, 0))
        self.assertEqual(ap._noon_boundary(ts(23, 30)), ts(12, 0))
        # 下一次重置 = 边界 + 24h
        self.assertEqual(ap._next_noon(ts(12, 0)), ts(12, 0) + 86400)
        self.assertEqual(ap._next_noon(ts(13, 0)), ts(12, 0) + 86400)

    def test_unavailable_active_list_is_stale_not_zero(self) -> None:
        """ACTIVE 拿不到时标 stale 并沿用上次观察值，不假装是 0。"""
        self.active = ["A1", "A2"]
        self._stats()
        self.active = None                      # getter 返回 None = 没拿到
        stats = self._stats()
        self.assertTrue(stats["stale"])
        self.assertFalse(stats["ok"])
        self.assertEqual(stats["active_count"], 2)
        self.assertEqual(stats["daily_new"], 0)

    def test_next_reset_is_reported(self) -> None:
        self.active = ["A1"]
        stats = self._stats()
        self.assertEqual(stats["reset_hour"], 12)
        self.assertGreater(
            time.mktime(time.strptime(stats["next_reset_at"], "%Y-%m-%dT%H:%M:%SZ")) - time.time(),
            0, "next_reset_at 必须在未来")
        self.assertEqual(stats["next_reset_at"][11:16], "04:00",  # 本地 12:00 = UTC 04:00
                         "next_reset_at 是 UTC 12:00-8h")


if __name__ == "__main__":
    unittest.main(verbosity=2)

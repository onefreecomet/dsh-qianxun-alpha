#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""alpha_pool_service 的离线测试（纯 stdlib，不联网、不碰 BRAIN、不碰生产库）。

跑法（用引擎自己的 venv 解释器，因为它带了 loguru）：

    ~/qianxun-devkit/run/venv-engine/bin/python -m unittest discover \
        -s ~/qianxun-devkit/engine/tests -v

覆盖的是「引擎侧唯一有逻辑的部分」：
  · 池子的增 / 删 / 清空 / 覆盖，脏输入与去重
  · 落盘 + 重新加载（进程重启后名单还在）
  · 状态二值归一：active / unsubmit
  · ACTIVE 列表「拿不到」时绝不能被当成「空集合」——否则 BRAIN 一抖动就把整池误标 unsubmit
  · BRAIN 单点失败（429 / 404 / check 仍 PENDING）只进 item['errors']，不炸整次 sync
  · BRAIN 全挂时用引擎本地 alphas 表兜底，表格不至于空着
"""
from __future__ import annotations

import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import alpha_pool_service as ap  # noqa: E402  (必须在 sys.path 调整之后)


class _FakeClient:
    """按 alpha_id 给不同结果的假 BRAIN。"""

    def get_alpha_details(self, alpha_id: str) -> dict:
        if alpha_id == "BOOM0001":
            raise RuntimeError("BRAIN 429 rate limited")
        if alpha_id == "GONE0001":
            raise RuntimeError("BRAIN 404 not found")
        return {
            "id": alpha_id,
            "status": "UNSUBMITTED",
            "dateCreated": "2026-09-01T00:00:00-04:00",
            "regular": {"code": "rank(x)"},
            "settings": {"region": "GLB"},
            "is": {"sharpe": 1.29, "fitness": 0.81, "returns": 0.0699,
                   "turnover": 0.1786, "margin": 0.000783},
        }

    def get_alpha_check(self, alpha_id: str) -> dict:
        if alpha_id == "BOOM0001":
            raise RuntimeError("BRAIN 429 rate limited")
        if alpha_id == "NOCHK001":
            return {"is": {"checks": [{"name": "LOW_SHARPE", "result": "PASS"}]}}
        return {"is": {"checks": [
            {"name": "SELF_CORRELATION", "result": "PASS", "value": 0.6906},
            {"name": "PROD_CORRELATION", "result": "FAIL", "value": 0.7755},
        ]}}


class _BrokenClient:
    """BRAIN 完全不可用。"""

    def get_alpha_details(self, alpha_id: str) -> dict:
        raise RuntimeError("BRAIN down")

    def get_alpha_check(self, alpha_id: str) -> dict:
        raise RuntimeError("BRAIN down")


class AlphaPoolTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        tmp = Path(self._tmp.name)
        self.pool_path = tmp / "alpha_pool.json"
        self.db_path = tmp / "fake.db"
        con = sqlite3.connect(self.db_path)
        con.execute(
            "create table alphas (alpha_id text primary key, expression text,"
            " sharpe real, fitness real, returns real, turnover real, margin real,"
            " region text, date_created text, check_pc real)"
        )
        con.execute(
            "insert into alphas values ('LOCAL111','rank(close)',1.5,1.1,0.12,0.2,"
            "0.0011,'USA','2026-01-01',0.42)"
        )
        con.commit()
        con.close()
        self.client = _FakeClient()
        ap.configure(client_factory=lambda: self.client, pool_path=self.pool_path,
                     db_path=self.db_path, active_ids_getter=lambda force=False: ["ACTIVE01"])

    def tearDown(self) -> None:
        self._tmp.cleanup()

    # ---- 工具 ----

    def _get(self) -> dict:
        code, payload = ap.route("GET", "/api/alpha-pool")
        self.assertEqual(code, 200, payload)
        return payload

    def _post(self, action: str, ids) -> dict:
        code, payload = ap.route("POST", "/api/alpha-pool", {"action": action, "ids": ids})
        self.assertEqual(code, 200, payload)
        return payload

    def _sync(self, body: dict | None = None) -> dict:
        code, payload = ap.route("POST", "/api/alpha-pool/sync", body or {})
        self.assertEqual(code, 200, payload)
        return payload

    @staticmethod
    def _by_id(payload: dict) -> dict:
        return {i["alpha_id"]: i for i in payload["items"]}

    # ---- 用例 ----

    def test_empty_pool(self) -> None:
        self.assertEqual(self._get()["count"], 0)

    def test_add_dedupes_and_rejects_dirty_input(self) -> None:
        r = self._post("add", "YPbZLxMA, mLmOw2op\nACTIVE01, YPbZLxMA, bad!")
        self.assertEqual(r["ids"], ["YPbZLxMA", "mLmOw2op", "ACTIVE01"])

    def test_bad_action_and_empty_ids_are_400(self) -> None:
        self.assertEqual(ap.route("POST", "/api/alpha-pool", {"action": "nope"})[0], 400)
        self.assertEqual(ap.route("POST", "/api/alpha-pool", {"action": "add", "ids": "!"})[0], 400)

    def test_pool_survives_reload(self) -> None:
        self._post("add", "YPbZLxMA,mLmOw2op")
        ap._state["ids"] = []          # 模拟进程重启丢掉内存态
        ap._load()
        self.assertEqual(self._get()["ids"], ["YPbZLxMA", "mLmOw2op"])

    def test_sync_metrics_corr_and_status(self) -> None:
        self._post("add", "YPbZLxMA,ACTIVE01")
        r = self._sync()
        by = self._by_id(r)
        self.assertEqual(by["ACTIVE01"]["status"], "active")
        self.assertEqual(by["YPbZLxMA"]["status"], "unsubmit")
        item = by["YPbZLxMA"]
        self.assertEqual(item["metrics"], {"sharpe": 1.29, "fitness": 0.81,
                                          "returns": 0.0699, "turnover": 0.1786,
                                          "margin": 0.000783})
        self.assertAlmostEqual(item["self_corr"], 0.6906)
        self.assertAlmostEqual(item["prod_corr"], 0.7755)
        self.assertEqual(item["region"], "GLB")
        self.assertEqual(item["errors"], [])
        self.assertFalse(r["partial"])

    def test_active_list_unavailable_is_not_treated_as_empty(self) -> None:
        """最容易踩的坑：BRAIN 抖动拿不到 ACTIVE 列表 → 不能把整池标成 unsubmit。"""
        self._post("add", "YPbZLxMA")
        ap.configure(active_ids_getter=lambda force=False: None)
        ap._state["items"].pop("YPbZLxMA", None)
        r = self._sync({"ids": ["YPbZLxMA"]})
        self.assertFalse(r["active_ok"])
        # 靠 BRAIN 单 alpha 的 status 兜住，而不是「不在 ACTIVE 集合里」→ unsubmit
        self.assertEqual(self._by_id(r)["YPbZLxMA"]["status"], "unsubmit")

    def test_db_fallback_when_brain_down(self) -> None:
        ap.configure(client_factory=lambda: _BrokenClient(),
                     active_ids_getter=lambda force=False: None)
        self._post("add", "LOCAL111")
        r = self._sync({"ids": ["LOCAL111"]})
        item = self._by_id(r)["LOCAL111"]
        self.assertEqual(item["metrics"]["sharpe"], 1.5)
        self.assertIn("db", item["source"])

    def test_per_alpha_failures_do_not_break_sync(self) -> None:
        ap.configure(client_factory=lambda: self.client)
        self._post("add", "BOOM0001,NOCHK001,GONE0001")
        r = self._sync()
        by = self._by_id(r)
        self.assertTrue(any("429" in e for e in by["BOOM0001"]["errors"]))
        self.assertTrue(any("PENDING" in e for e in by["NOCHK001"]["errors"]))
        self.assertTrue(any("404" in e for e in by["GONE0001"]["errors"]))

    def test_remove_set_clear(self) -> None:
        self._post("add", "YPbZLxMA,mLmOw2op,ACTIVE01")
        r = self._post("remove", "ACTIVE01")
        self.assertNotIn("ACTIVE01", r["ids"])
        self.assertNotIn("ACTIVE01", {i["alpha_id"] for i in r["items"]})
        r = self._post("set", "YPbZLxMA,mLmOw2op")
        self.assertEqual(r["ids"], ["YPbZLxMA", "mLmOw2op"])
        r = self._post("clear", None)
        self.assertEqual((r["count"], r["items"]), (0, []))

    def test_unknown_route_and_trailing_slash(self) -> None:
        self.assertEqual(ap.route("GET", "/api/alpha-pool/nope")[0], 404)
        self.assertEqual(ap.route("GET", "/api/alpha-pool/")[0], 200)

    def test_sync_empty_pool_is_a_noop(self) -> None:
        r = self._sync()
        self.assertEqual(r["refreshed"], 0)
        self.assertIn("message", r)


if __name__ == "__main__":
    unittest.main(verbosity=2)

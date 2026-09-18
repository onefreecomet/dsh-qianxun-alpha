#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""get_alpha_check 空响应重试的回归测试（纯离线，不联网）。

背景（2026-09-18 实测）：BRAIN 的 `GET /alphas/{id}/check` **首次调用常返回 HTTP 200
但 body 为空**（平台后台现算 check）。原实现直接 `resp.json()`，于是：
  · 侧边栏 🔍「BRAIN check」面板第一次点永远是空的，再点一次才有；
  · 自选池的 selfcorr / prodcorr 列第一次同步永远是 `—`。
同一文件里 `get_alpha_correlations_prod` 早就对同一个毛病做了 3 次重试，
这里补上同款处理，并把它钉成测试。

跑法：
    ~/qianxun-devkit/run/venv-engine/bin/python -m unittest discover \
        -s ~/qianxun-devkit/engine/tests -t engine -v
"""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from qianxun_engine.api.client import APIClient  # noqa: E402


class _FakeResponse:
    """只需要 .text —— get_alpha_check 不碰别的属性。"""

    def __init__(self, text: str) -> None:
        self.text = text


_PAYLOAD = {"is": {"checks": [
    {"name": "SELF_CORRELATION", "result": "PASS", "value": 0.6906},
    {"name": "PROD_CORRELATION", "result": "FAIL", "value": 0.7755},
]}}


class AlphaCheckRetryTest(unittest.TestCase):
    def setUp(self) -> None:
        # 跳过 __init__：不需要真凭据，也不需要 httpx 会话。
        self.client = APIClient.__new__(APIClient)
        self.calls: list[str] = []

    def _stub(self, bodies: list[str]):
        """第 N 次调用返回 bodies[N]（超出则重复最后一个）。"""
        def fake(method: str, url: str, **kwargs: object) -> _FakeResponse:
            self.calls.append(url)
            idx = min(len(self.calls) - 1, len(bodies) - 1)
            return _FakeResponse(bodies[idx])
        self.client._request_with_retry = fake  # type: ignore[method-assign]

    def test_first_empty_then_valid_is_retried(self) -> None:
        """首次空 body（真实 BRAIN 行为）→ 重试后拿到 checks。"""
        self._stub(["", json.dumps(_PAYLOAD)])
        with patch("qianxun_engine.api.client.time.sleep", lambda *_: None):
            out = self.client.get_alpha_check("YPbZLxMA")
        self.assertEqual(out, _PAYLOAD)
        self.assertEqual(len(self.calls), 2, "空的第一次必须触发重试")

    def test_valid_first_call_does_not_sleep(self) -> None:
        """正常情况不该白白多打一次 BRAIN。"""
        self._stub([json.dumps(_PAYLOAD)])
        slept: list[float] = []
        with patch("qianxun_engine.api.client.time.sleep", lambda s: slept.append(s)):
            out = self.client.get_alpha_check("YPbZLxMA")
        self.assertEqual(out, _PAYLOAD)
        self.assertEqual((len(self.calls), slept), (1, []))

    def test_all_empty_raises_clearly(self) -> None:
        """三次都空：必须明确报错，不能返回空壳冒充「这个 alpha 没有 check」。"""
        self._stub([""])
        with patch("qianxun_engine.api.client.time.sleep", lambda *_: None):
            with self.assertRaises(RuntimeError) as ctx:
                self.client.get_alpha_check("YPbZLxMA")
        self.assertIn("三次都拿不到", str(ctx.exception))
        self.assertEqual(len(self.calls), 3)

    def test_garbage_body_is_retried_then_raises(self) -> None:
        """返回非 JSON（例如网关 HTML 错误页）也要重试，而不是直接抛 JSONDecodeError。"""
        self._stub(["<html>502 Bad Gateway</html>"])
        with patch("qianxun_engine.api.client.time.sleep", lambda *_: None):
            with self.assertRaises(RuntimeError):
                self.client.get_alpha_check("YPbZLxMA")
        self.assertEqual(len(self.calls), 3)


if __name__ == "__main__":
    unittest.main(verbosity=2)

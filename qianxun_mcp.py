#!/usr/bin/env python3
"""qianxun_mcp.py — 千寻融合 MCP 桥（stdio，基于 mcp 2.x lowlevel API）

让任意 MCP 客户端（opencode / Claude Desktop / Cursor / deepseek harness 等）
直接驱动千寻并行接口：提交批次、看进度、等结果、取消、断点续跑、查配额。

接入方式（以 opencode 为例）：
    "qianxun": {
      "type": "stdio",
      "command": "python3",
      "args": ["/Users/libing/QianXun/qianxun_mcp.py"],
      "env": { "QIANXUND_URL": "http://127.0.0.1:8765" }
    }

工具清单：
  qx_start_batch(settings, expressions, name?, producer?, cap?)  提交批次 → {batch_no, total}
  qx_list_batches()                               批次列表（状态/进度）
  qx_batch_status(batch_no)                       单批详情（逐条 + 指标）
  qx_wait_batch(batch_no, timeout_s)              阻塞到终态
  qx_pause_batch / qx_resume_batch / qx_cancel_batch
  qx_resume_batch_back(batch_no)                  断点续跑
  qx_analyze(batch_no, limit)                     读库按 |sharpe| 降序输出
  qx_quota()                                      查配额/今日模拟数
"""
import asyncio
import json
import os
import time
import urllib.request

import mcp.types as types
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

BASE = os.environ.get("QIANXUND_URL", "http://127.0.0.1:8765")
TOKEN = os.environ.get("QIANXUND_TOKEN", "")


def _req(method, path, body=None, timeout=60):
    url = BASE + path
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if TOKEN:
        req.add_header("X-Api-Token", TOKEN)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _wait(batch_no, timeout_s):
    deadline = time.time() + timeout_s
    while True:
        try:
            d = _req("GET", f"/api/jobs/{batch_no}")
        except Exception:
            time.sleep(2); continue
        j = d.get("job") or d
        if j.get("state") in ("COMPLETE", "STOPPED", "ERROR"):
            return _req("GET", f"/api/jobs/{batch_no}/result")
        if time.time() > deadline:
            raise TimeoutError(f"batch {batch_no} still {j.get('state')} after {timeout_s}s")
        time.sleep(3)


TOOL_DEFS = [
    ("qx_start_batch", "提交一个回测批次。settings=BRAIN 模拟设置(region/universe/delay/neutralization 等);expressions=表达式列表(每项 {expression, decay?, rationale?}) 或字符串列表。返回 {batch_no, total}。", {
        "type": "object",
        "properties": {
            "settings": {"type": "object", "description": "BRAIN 模拟 settings"},
            "expressions": {"type": "array", "items": {"type": ["string", "object"]}, "description": "表达式列表"},
            "name": {"type": "string", "description": "批次名"},
            "producer": {"type": "string", "description": "生产者标识，如 阿法"},
            "cap": {"type": "integer", "description": "只跑前 N 条"},
        },
        "required": ["settings", "expressions"],
    }),
    ("qx_list_batches", "列出全部批次(状态/进度),最新在前。", {"type": "object", "properties": {}}),
    ("qx_batch_status", "查看单个批次详情:状态、逐条表达式结果与指标。", {
        "type": "object", "properties": {"batch_no": {"type": "string"}}, "required": ["batch_no"]}),
    ("qx_wait_batch", "阻塞等待批次到终态,返回完整结果。agent 迭代闭环用这个。", {
        "type": "object", "properties": {
            "batch_no": {"type": "string"},
            "timeout_s": {"type": "integer", "description": "最长等待秒数,默认 3600"}},
        "required": ["batch_no"]}),
    ("qx_cancel_batch", "停止批次队列(在跑跑完即收)。", {
        "type": "object", "properties": {"batch_no": {"type": "string"}}, "required": ["batch_no"]}),
    ("qx_pause_batch", "暂停批次调度。", {
        "type": "object", "properties": {"batch_no": {"type": "string"}}, "required": ["batch_no"]}),
    ("qx_resume_batch", "恢复已暂停的批次调度。", {
        "type": "object", "properties": {"batch_no": {"type": "string"}}, "required": ["batch_no"]}),
    ("qx_resume_batch_back", "断点续跑:补跑某批次未完成的模拟。", {
        "type": "object", "properties": {"batch_no": {"type": "string"}}, "required": ["batch_no"]}),
    ("qx_analyze", "读库按 |sharpe| 降序输出批次结果(带 check 状态)。", {
        "type": "object", "properties": {
            "batch_no": {"type": "string"}, "limit": {"type": "integer"}}, "required": ["batch_no"]}),
    ("qx_quota", "查看系统状态/配额. ", {"type": "object", "properties": {}}),
]


async def _list_tools(ctx, params):
    return types.ListToolsResult(tools=[
        types.Tool(name=n, description=d, inputSchema=s) for n, d, s in TOOL_DEFS
    ])


async def _call_tool(ctx, params):
    try:
        result = _dispatch(params.name, params.arguments or {})
        text = json.dumps(result, ensure_ascii=False, indent=1)
        return types.CallToolResult(content=[types.TextContent(type="text", text=text)])
    except Exception as e:
        return types.CallToolResult(
            isError=True,
            content=[types.TextContent(type="text", text=f"error: {e}")],
        )


server = Server("qianxun", on_list_tools=_list_tools, on_call_tool=_call_tool)


def _norm_exprs(exprs):
    out = []
    for e in exprs:
        if isinstance(e, str):
            out.append({"expression": e})
        else:
            out.append(e)
    return out


def _dispatch(name, args):
    if name == "qx_start_batch":
        body = {"settings": args["settings"],
                "expressions": _norm_exprs(args["expressions"])}
        if args.get("name"): body["name"] = args["name"]
        if args.get("producer"): body["producer"] = args["producer"]
        if args.get("cap") is not None: body["cap"] = int(args["cap"])
        return _req("POST", "/api/jobs", body)
    if name == "qx_list_batches":
        return _req("GET", "/api/jobs")
    if name == "qx_batch_status":
        return _req("GET", f"/api/jobs/{args['batch_no']}")
    if name == "qx_wait_batch":
        return _wait(args["batch_no"], int(args.get("timeout_s", 3600)))
    if name == "qx_cancel_batch":
        return _req("POST", f"/api/jobs/{args['batch_no']}", {"action": "cancel"})
    if name == "qx_pause_batch":
        return _req("POST", f"/api/jobs/{args['batch_no']}", {"action": "pause"})
    if name == "qx_resume_batch":
        return _req("POST", f"/api/jobs/{args['batch_no']}", {"action": "resume"})
    if name == "qx_resume_batch_back":
        return _req("POST", f"/api/jobs/{args['batch_no']}/resume", {})
    if name == "qx_analyze":
        return _req("GET", f"/api/jobs/{args['batch_no']}/result")
    if name == "qx_quota":
        return {"health": _req("GET", "/health"), "quota": _req("GET", "/api/quota")}
    raise ValueError(f"unknown tool: {name}")


async def main():
    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream, write_stream,
            server.create_initialization_options(),
        )


if __name__ == "__main__":
    asyncio.run(main())

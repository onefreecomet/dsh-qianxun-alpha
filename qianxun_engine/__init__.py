"""千寻 headless 核心引擎（Mac 移植版）。

从 project026_AlphaMachine/wq_engine 裁剪：只保留平台无关的
api（BRAIN 封装）/ storage（SQLite）/ scheduler（批量回测调度），
不含任何 PySide6 UI 依赖。与 Windows 千寻共享同一套 schema 与 AI 批次协议。
"""
__version__ = "1.62-mac"

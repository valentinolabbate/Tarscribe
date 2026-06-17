"""Tarscribe MCP server.

A stdio MCP server that lets agents drive the *running* Tarscribe app: upload a
recording, transcribe it, diarize it and match speakers. Ships inside the
backend package and is launched via ``python -m tarscribe_backend.mcp_server``
(using the app's runtime venv interpreter).
"""

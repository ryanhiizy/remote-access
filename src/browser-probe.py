"""Check Helium's native WebSocket endpoint without issuing browser commands."""

import base64
import hashlib
import os
from pathlib import Path
import re
import socket
import sys


def ready(port):
    metadata = Path.home() / ".local/share/codex-browser/mac-profile/DevToolsActivePort"
    lines = metadata.read_text().splitlines()
    if len(lines) != 2 or lines[0] != str(port):
        return False
    endpoint = lines[1]
    if not re.fullmatch(r"/devtools/browser/[A-Za-z0-9-]+", endpoint):
        return False
    key = base64.b64encode(os.urandom(16)).decode()
    request = (
        f"GET {endpoint} HTTP/1.1\r\nHost: localhost:{port}\r\n"
        "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
    )
    with socket.create_connection(("127.0.0.1", port), timeout=3) as connection:
        connection.sendall(request.encode())
        response = b""
        while b"\r\n\r\n" not in response and len(response) < 16384:
            chunk = connection.recv(4096)
            if not chunk:
                return False
            response += chunk
    headers = response.decode("ascii", errors="replace").split("\r\n")
    expected = base64.b64encode(
        hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
    ).decode()
    return headers[0].split(" ")[1:2] == ["101"] and any(
        line.lower().startswith("sec-websocket-accept:")
        and line.split(":", 1)[1].strip() == expected
        for line in headers[1:]
    )


try:
    available = ready(int(sys.argv[1]))
except (OSError, ValueError, IndexError):
    available = False
print("browser ready" if available else "browser unavailable")

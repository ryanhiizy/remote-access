"""Read shared-service status, or check a legacy tunnel without requesting control."""

import json
from pathlib import Path
import re
import socket
import sys


def state(port, shared):
    if not shared:
        metadata = Path.home() / ".local/share/codex-browser/mac-profile/DevToolsActivePort"
        lines = metadata.read_text().splitlines()
        if len(lines) != 2 or lines[0] != str(port) or not re.fullmatch(
            r"/devtools/browser/[A-Za-z0-9-]+", lines[1]
        ):
            return "unavailable"
    with socket.create_connection(("127.0.0.1", port), timeout=3) as connection:
        if not shared:
            # Reachability only: never upgrade the connection to WebSocket.
            return "available"
        connection.sendall(b'{"jsonrpc":"2.0","id":1,"method":"remote-access/status"}\n')
        response = b""
        while b"\n" not in response and len(response) < 16384:
            chunk = connection.recv(4096)
            if not chunk:
                return "unavailable"
            response += chunk
        value = json.loads(response.split(b"\n")[0])["result"]["state"]
        return value if value in ("ready", "available", "waiting-for-approval", "unavailable") else "unavailable"


try:
    result = state(int(sys.argv[1]), len(sys.argv) > 2 and sys.argv[2] == "shared")
except (OSError, ValueError, IndexError, KeyError, TypeError):
    result = "unavailable"
print("browser " + result)

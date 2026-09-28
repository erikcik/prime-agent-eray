#!/usr/bin/env python3
"""Direct mode's stand-in for the SSH tunnel: 127.0.0.1:<port> -> the M1's llama-server.

  python3 forward.py --listen 18080 --target 'fe80::1%en5' --target m902154.example.ac.uk --port 8080

Targets are tried in order for every new connection, so a USB-C / Thunderbolt link-local address
can come first with the campus hostname as fallback. Scoped IPv6 (fe80::...%en5) is supported here
even though URLs in Node cannot carry a zone id, which is why the provider keeps pointing at loopback.
"""

import argparse
import asyncio
import socket
import sys

p = argparse.ArgumentParser()
p.add_argument("--listen", type=int, default=18080)
p.add_argument("--target", action="append", required=True)
p.add_argument("--port", type=int, default=8080)
a = p.parse_args()


async def pipe(reader, writer):
    try:
        while data := await reader.read(65536):
            writer.write(data)
            await writer.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        try:
            writer.close()
        except OSError:
            pass


async def open_target():
    last = None
    for host in a.target:
        try:
            return await asyncio.wait_for(asyncio.open_connection(host, a.port), timeout=4)
        except (OSError, asyncio.TimeoutError) as e:
            last = f"{host}: {e}"
    raise ConnectionError(last)


async def handle(client_r, client_w):
    try:
        up_r, up_w = await open_target()
    except ConnectionError as e:
        print(f"no target reachable ({e})", file=sys.stderr, flush=True)
        client_w.close()
        return
    up_w.get_extra_info("socket").setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
    await asyncio.gather(pipe(client_r, up_w), pipe(up_r, client_w))


async def main():
    server = await asyncio.start_server(handle, "127.0.0.1", a.listen)
    print(f"forwarding 127.0.0.1:{a.listen} -> {a.target} port {a.port}", flush=True)
    async with server:
        await server.serve_forever()


asyncio.run(main())

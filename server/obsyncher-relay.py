#!/usr/bin/env python3
"""Obsyncher WebSocket -> TCP relay (Python 3.8+, standard library only).

Obsidian on Android cannot open raw TCP sockets, so the plugin tunnels its SSH
byte stream through a WebSocket. This relay accepts WebSocket connections and
forwards the bytes to the local SSH server. It never sees plaintext: SSH is
end-to-end encrypted between the phone and sshd, and the plugin pins the host key.

Usage:
    python3 obsyncher-relay.py [--listen 0.0.0.0:8022] [--target 127.0.0.1:22]
                               [--cert fullchain.pem --key privkey.pem]

Plugin setting "WebSocket relay URL": ws://<server>:8022, or wss://<server>:8022
when --cert/--key are given (a certificate the phone trusts, e.g. Let's Encrypt),
or put the relay behind an HTTPS reverse proxy (Caddy, nginx).
Equivalent alternative: `websockify 8022 127.0.0.1:22`.
"""

import argparse
import asyncio
import base64
import hashlib
import logging
import ssl
import struct

GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_FRAME = 16 * 1024 * 1024

log = logging.getLogger("obsyncher-relay")


class Closed(Exception):
    pass


async def read_http_request(reader):
    data = await reader.readuntil(b"\r\n\r\n")
    lines = data.decode("latin-1").split("\r\n")
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    return lines[0], headers


async def ws_to_tcp(reader, tcp_writer, ws_writer):
    """Reads client frames (masked) and forwards payloads to the TCP socket."""
    while True:
        head = await reader.readexactly(2)
        opcode = head[0] & 0x0F
        masked = head[1] & 0x80
        length = head[1] & 0x7F
        if length == 126:
            length = struct.unpack(">H", await reader.readexactly(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", await reader.readexactly(8))[0]
        if length > MAX_FRAME:
            raise Closed("frame too large")
        mask = await reader.readexactly(4) if masked else b""
        payload = await reader.readexactly(length) if length else b""
        if masked:
            payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload)) if length < 4096 else _unmask(payload, mask)
        if opcode in (0x0, 0x1, 0x2):  # continuation / text(base64 legacy) / binary
            if opcode == 0x1:
                payload = base64.b64decode(payload)
            tcp_writer.write(payload)
            await tcp_writer.drain()
        elif opcode == 0x8:  # close
            send_frame(ws_writer, 0x8, payload[:2])
            raise Closed("client closed")
        elif opcode == 0x9:  # ping
            send_frame(ws_writer, 0xA, payload)
        # 0xA pong: ignore


def _unmask(payload, mask):
    n = len(payload)
    key = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(payload, "big") ^ int.from_bytes(key, "big")).to_bytes(n, "big")


def send_frame(writer, opcode, payload):
    n = len(payload)
    if n < 126:
        head = struct.pack(">BB", 0x80 | opcode, n)
    elif n < 65536:
        head = struct.pack(">BBH", 0x80 | opcode, 126, n)
    else:
        head = struct.pack(">BBQ", 0x80 | opcode, 127, n)
    writer.write(head + payload)


async def tcp_to_ws(tcp_reader, ws_writer):
    while True:
        data = await tcp_reader.read(65536)
        if not data:
            send_frame(ws_writer, 0x8, struct.pack(">H", 1000))
            await ws_writer.drain()
            raise Closed("target closed")
        send_frame(ws_writer, 0x2, data)
        await ws_writer.drain()


async def handle(reader, writer, target):
    peer = writer.get_extra_info("peername")
    tcp_writer = None
    try:
        request_line, headers = await asyncio.wait_for(read_http_request(reader), 15)
        key = headers.get("sec-websocket-key")
        if not request_line.startswith("GET ") or "websocket" not in headers.get("upgrade", "").lower() or not key:
            writer.write(b"HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            await writer.drain()
            return
        accept = base64.b64encode(hashlib.sha1(key.encode() + GUID).digest()).decode()
        protocols = [p.strip() for p in headers.get("sec-websocket-protocol", "").split(",") if p.strip()]
        response = (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n"
        )
        if "binary" in protocols:
            response += "Sec-WebSocket-Protocol: binary\r\n"
        writer.write((response + "\r\n").encode())
        await writer.drain()

        tcp_reader, tcp_writer = await asyncio.open_connection(*target)
        log.info("%s connected -> %s:%s", peer, *target)
        tasks = [
            asyncio.ensure_future(ws_to_tcp(reader, tcp_writer, writer)),
            asyncio.ensure_future(tcp_to_ws(tcp_reader, writer)),
        ]
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for t in pending:
            t.cancel()
    except (asyncio.IncompleteReadError, asyncio.TimeoutError, ConnectionError, Closed, OSError) as e:
        log.debug("%s: %s", peer, e)
    finally:
        for w in (tcp_writer, writer):
            if w is not None:
                try:
                    w.close()
                except Exception:
                    pass
        log.info("%s disconnected", peer)


def hostport(s, default_host):
    host, _, port = s.rpartition(":")
    return (host or default_host, int(port))


async def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--listen", default="0.0.0.0:8022", help="address:port to listen on (default 0.0.0.0:8022)")
    ap.add_argument("--target", default="127.0.0.1:22", help="SSH server address:port (default 127.0.0.1:22)")
    ap.add_argument("--cert", help="TLS certificate chain (PEM) to serve wss://")
    ap.add_argument("--key", help="TLS private key (PEM) for --cert")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(message)s")
    listen = hostport(args.listen, "0.0.0.0")
    target = hostport(args.target, "127.0.0.1")
    tls = None
    if args.cert:
        tls = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        tls.load_cert_chain(args.cert, args.key)
    server = await asyncio.start_server(lambda r, w: handle(r, w, target), *listen, ssl=tls)
    log.info("listening on %s://%s:%s, forwarding to %s:%s", "wss" if tls else "ws", *listen, *target)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass

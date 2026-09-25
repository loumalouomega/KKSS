"""Keep a child MCP server's stdio connected through a Python pipe."""
import subprocess
import sys
import threading


def copy_stream(source, destination):
    try:
        while True:
            chunk = source.read1(65536) if hasattr(source, "read1") else source.read(65536)
            if not chunk:
                break
            destination.write(chunk)
            destination.flush()
    finally:
        try:
            destination.close()
        except OSError:
            pass


server = subprocess.Popen(sys.argv[1:], stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0)
output = threading.Thread(target=copy_stream, args=(server.stdout, sys.stdout.buffer), daemon=True)
output.start()
copy_stream(sys.stdin.buffer, server.stdin)
try:
    server.wait(timeout=2)
except subprocess.TimeoutExpired:
    server.terminate()
    try:
        server.wait(timeout=2)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait()
output.join(timeout=2)

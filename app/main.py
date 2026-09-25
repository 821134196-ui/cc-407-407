"""单条本地启动入口：python -m app.main

自动迁移数据库并写入装钞、清机和差额处置样例，然后启动 Web 服务。
"""
from __future__ import annotations

import argparse

from . import db, seed, web


def bootstrap(reseed: bool = False):
    conn = db.connect()
    db.migrate(conn)
    seed.seed(conn, force=reseed)
    conn.close()


def main():
    parser = argparse.ArgumentParser(description="ATM 现金清分与钞箱交接平台")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--reseed", action="store_true", help="重置并重新写入演示数据")
    args = parser.parse_args()

    bootstrap(args.reseed)
    web.serve(args.host or __import__("os").environ.get("ATM_HOST", "127.0.0.1"),
              args.port or int(__import__("os").environ.get("ATM_PORT", "8000")))


if __name__ == "__main__":
    main()

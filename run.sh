#!/usr/bin/env bash
# 单条本地启动命令：自动迁移 + 写入演示样例 + 启动服务
# 用法: ./run.sh            # 默认 127.0.0.1:8000
#       ATM_PORT=9000 ./run.sh
#       ./run.sh --reseed   # 重置演示数据
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"
export ATM_HOST="${ATM_HOST:-127.0.0.1}"
export ATM_PORT="${ATM_PORT:-8000}"
export ATM_DATA_DIR="${ATM_DATA_DIR:-$(pwd)/data}"

exec "$PYTHON" -m app.main "$@"

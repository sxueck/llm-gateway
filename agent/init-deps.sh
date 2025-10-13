#!/bin/bash

set -e

echo "初始化 Go 依赖..."

cd "$(dirname "$0")"

go mod tidy

echo "依赖初始化完成！"


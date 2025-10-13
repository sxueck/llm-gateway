#!/bin/bash

set -e

VERSION="1.0.0"
BINARY_NAME="llm-gateway-agent"
LDFLAGS="-s -w -X main.Version=${VERSION}"

echo "=========================================="
echo "构建 LLM Gateway Agent"
echo "版本: ${VERSION}"
echo "=========================================="
echo ""

if ! command -v go &> /dev/null; then
    echo "错误: Go 未安装"
    echo "请安装 Go 1.21+: https://golang.org/dl/"
    exit 1
fi

GO_VERSION=$(go version | awk '{print $3}' | sed 's/go//')
echo "Go 版本: ${GO_VERSION}"
echo ""

echo "清理旧文件..."
rm -f ${BINARY_NAME} ${BINARY_NAME}-*

echo ""
echo "初始化依赖..."
go mod tidy

echo ""
echo "构建 Linux AMD64..."
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o ${BINARY_NAME}-linux-amd64 -ldflags="${LDFLAGS}" .

echo "构建 macOS AMD64..."
CGO_ENABLED=0 GOOS=darwin GOARCH=amd64 go build -o ${BINARY_NAME}-darwin-amd64 -ldflags="${LDFLAGS}" .

echo "构建 macOS ARM64..."
CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -o ${BINARY_NAME}-darwin-arm64 -ldflags="${LDFLAGS}" .

echo "构建 Windows AMD64..."
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -o ${BINARY_NAME}-windows-amd64.exe -ldflags="${LDFLAGS}" .

echo ""
echo "=========================================="
echo "构建完成！"
echo "=========================================="
echo ""
ls -lh ${BINARY_NAME}-*
echo ""


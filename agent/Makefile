.PHONY: build clean run install test deps build-all

BINARY_NAME=llm-gateway-agent
VERSION=1.0.0
LDFLAGS=-s -w -X main.Version=$(VERSION)

deps:
	@echo "初始化 Go 依赖..."
	go mod tidy
	@echo "依赖初始化完成"

build:
	CGO_ENABLED=0 go build -o $(BINARY_NAME) -ldflags="$(LDFLAGS)" .

build-linux:
	@echo "构建 Linux AMD64..."
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o $(BINARY_NAME)-linux-amd64 -ldflags="$(LDFLAGS)" .

build-all: clean deps build-linux
	@echo ""
	@echo "构建完成！"
	@ls -lh $(BINARY_NAME)-*

clean:
	@echo "清理构建文件..."
	rm -f $(BINARY_NAME) $(BINARY_NAME)-*

run:
	go run .

install: deps

test:
	go test -v ./...


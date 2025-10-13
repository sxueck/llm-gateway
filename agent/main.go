package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/joho/godotenv"
)

const Version = "1.0.0"

func main() {
	if err := godotenv.Load(); err != nil {
		log.Println("未找到 .env 文件，使用环境变量")
	}

	config := LoadConfig()

	if err := config.Validate(); err != nil {
		log.Fatalf("配置验证失败: %v", err)
	}

	logger := NewLogger(config.LogLevel)
	logger.Info("LLM Gateway Agent 启动中...", "version", Version)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	dockerClient, err := NewDockerClient()
	if err != nil {
		logger.Error("Docker 客户端初始化失败", "error", err)
		os.Exit(1)
	}
	defer dockerClient.Close()

	configManager := NewConfigManager(config, logger)
	containerManager := NewContainerManager(config, dockerClient, logger)
	gatewayClient := NewGatewayClient(config, logger)

	agent := &Agent{
		config:           config,
		logger:           logger,
		configManager:    configManager,
		containerManager: containerManager,
		gatewayClient:    gatewayClient,
	}

	if err := agent.Start(ctx); err != nil {
		logger.Error("Agent 启动失败", "error", err)
		os.Exit(1)
	}

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	<-sigChan
	logger.Info("收到停止信号，正在关闭...")

	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer shutdownCancel()

	if err := agent.Stop(shutdownCtx); err != nil {
		logger.Error("Agent 停止失败", "error", err)
	}

	logger.Info("Agent 已停止")
}

type Agent struct {
	config           *Config
	logger           *Logger
	configManager    *ConfigManager
	containerManager *ContainerManager
	gatewayClient    *GatewayClient
}

func (a *Agent) Start(ctx context.Context) error {
	a.logger.Info("正在注册到 LLM Gateway...")

	hostname, _ := os.Hostname()
	if err := a.gatewayClient.Register(hostname, Version); err != nil {
		return fmt.Errorf("注册失败: %w", err)
	}

	a.logger.Info("注册成功")

	a.logger.Info("正在同步配置...")
	if err := a.configManager.SyncConfig(); err != nil {
		a.logger.Warn("配置同步失败", "error", err)
	}

	a.logger.Info("正在启动 Portkey Gateway 容器...")
	if err := a.containerManager.EnsureRunning(ctx); err != nil {
		return fmt.Errorf("容器启动失败: %w", err)
	}

	go a.heartbeatLoop(ctx)
	go a.configSyncLoop(ctx)

	a.logger.Info("Agent 启动完成")

	return nil
}

func (a *Agent) Stop(ctx context.Context) error {
	a.logger.Info("正在停止 Agent...")
	return nil
}

func (a *Agent) heartbeatLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Duration(a.config.HeartbeatInterval) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			go func() {
				if err := a.gatewayClient.Heartbeat(); err != nil {
					a.logger.Error("心跳失败", "error", err)
				} else {
					a.logger.Debug("心跳成功")
				}
			}()
		}
	}
}

func (a *Agent) configSyncLoop(ctx context.Context) {
	ticker := time.NewTicker(time.Duration(a.config.ConfigSyncInterval) * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.logger.Debug("正在同步配置...")
			if err := a.configManager.SyncConfig(); err != nil {
				a.logger.Error("配置同步失败", "error", err)
				continue
			}

			if a.configManager.HasChanged() {
				a.logger.Info("配置已更新，正在重启容器...")
				if err := a.containerManager.Restart(ctx); err != nil {
					a.logger.Error("容器重启失败", "error", err)
				} else {
					a.logger.Info("容器重启成功")
				}
			}
		}
	}
}

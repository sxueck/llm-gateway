package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/http"
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

	if config.GatewayID == "" || config.APIKey == "" {
		log.Fatalf("GATEWAY_ID 和 API_KEY 不能为空，请检查配置")
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
	httpServer       *http.Server
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

	proxyHandler := NewProxyHandler(a.config, a.logger)
	a.httpServer = &http.Server{
		Addr:         fmt.Sprintf(":%d", a.config.AgentPort),
		Handler:      proxyHandler,
		ReadTimeout:  5 * time.Minute,
		WriteTimeout: 5 * time.Minute,
		IdleTimeout:  2 * time.Minute,
	}

	go func() {
		a.logger.Info("准备启动 Agent HTTPS 代理服务器", "port", a.config.AgentPort)
		if err := ensureTLSConfig(a.config.CertFile, a.config.KeyFile, a.logger); err != nil {
			a.logger.Error("TLS 配置失败", "error", err)
			return
		}

		a.logger.Info("启动 Agent HTTPS 代理服务器", "port", a.config.AgentPort)
		err := a.httpServer.ListenAndServeTLS(a.config.CertFile, a.config.KeyFile)
		if err != nil && err != http.ErrServerClosed {
			a.logger.Error("HTTPS 服务器启动失败", "error", err)
		}
	}()

	go a.heartbeatLoop(ctx)
	go a.configSyncLoop(ctx)

	a.logger.Info("Agent 启动完成")

	return nil
}

func (a *Agent) Stop(ctx context.Context) error {
	a.logger.Info("正在停止 Agent...")

	if a.httpServer != nil {
		shutdownCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()

		if err := a.httpServer.Shutdown(shutdownCtx); err != nil {
			a.logger.Error("HTTP 服务器停止失败", "error", err)
			return err
		}
		a.logger.Info("HTTP 服务器已停止")
	}

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

func ensureTLSConfig(certFile, keyFile string, logger *Logger) error {
	if _, err := os.Stat(certFile); os.IsNotExist(err) {
		logger.Info("证书文件不存在，正在生成自签名证书...", "cert", certFile, "key", keyFile)
		return generateSelfSignedCert(certFile, keyFile)
	}
	logger.Info("找到现有 TLS 证书文件")
	return nil
}

func generateSelfSignedCert(certFile, keyFile string) error {
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return fmt.Errorf("生成 RSA 密钥失败: %w", err)
	}

	hostname, _ := os.Hostname()
	dnsNames := []string{"localhost"}
	if hostname != "" && hostname != "localhost" {
		dnsNames = append(dnsNames, hostname)
	}

	ipAddresses := []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}

	addrs, err := net.InterfaceAddrs()
	if err == nil {
		for _, addr := range addrs {
			if ipNet, ok := addr.(*net.IPNet); ok && !ipNet.IP.IsLoopback() {
				if ipNet.IP.To4() != nil || ipNet.IP.To16() != nil {
					ipAddresses = append(ipAddresses, ipNet.IP)
				}
			}
		}
	}

	template := x509.Certificate{
		SerialNumber: big.NewInt(time.Now().Unix()),
		Subject: pkix.Name{
			Organization: []string{"LLM Gateway Agent"},
			CommonName:   hostname,
		},
		NotBefore: time.Now(),
		NotAfter:  time.Now().Add(365 * 24 * time.Hour),

		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              dnsNames,
		IPAddresses:           ipAddresses,
	}

	derBytes, err := x509.CreateCertificate(rand.Reader, &template, &template, &priv.PublicKey, priv)
	if err != nil {
		return fmt.Errorf("创建证书失败: %w", err)
	}

	certOut, err := os.Create(certFile)
	if err != nil {
		return fmt.Errorf("创建证书文件失败: %w", err)
	}
	defer certOut.Close()
	pem.Encode(certOut, &pem.Block{Type: "CERTIFICATE", Bytes: derBytes})

	keyOut, err := os.Create(keyFile)
	if err != nil {
		return fmt.Errorf("创建密钥文件失败: %w", err)
	}
	defer keyOut.Close()
	pem.Encode(keyOut, &pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(priv)})

	return nil
}

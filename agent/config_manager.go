package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type ConfigManager struct {
	config        *Config
	logger        *Logger
	gatewayClient *GatewayClient
	configPath    string
	lastHash      string
	lastSync      time.Time
}

func NewConfigManager(config *Config, logger *Logger) *ConfigManager {
	configDir := "/tmp/portkey-config-" + config.GatewayID
	os.MkdirAll(configDir, 0755)

	return &ConfigManager{
		config:        config,
		logger:        logger,
		gatewayClient: NewGatewayClient(config, logger),
		configPath:    filepath.Join(configDir, "conf.json"),
	}
}

func (cm *ConfigManager) SyncConfig() error {
	config, err := cm.gatewayClient.GetPortkeyConfig()
	if err != nil {
		return fmt.Errorf("获取配置失败: %w", err)
	}

	configJSON, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("序列化配置失败: %w", err)
	}

	hash := cm.calculateHash(configJSON)

	if hash != cm.lastHash {
		if err := os.WriteFile(cm.configPath, configJSON, 0644); err != nil {
			return fmt.Errorf("写入配置文件失败: %w", err)
		}

		cm.lastHash = hash
		cm.lastSync = time.Now()
		cm.logger.Info("配置已更新", "hash", hash[:8])
	} else {
		cm.logger.Debug("配置未变化")
	}

	return nil
}

func (cm *ConfigManager) HasChanged() bool {
	return time.Since(cm.lastSync) < 5*time.Second
}

func (cm *ConfigManager) GetConfigPath() string {
	return cm.configPath
}

func (cm *ConfigManager) calculateHash(data []byte) string {
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}


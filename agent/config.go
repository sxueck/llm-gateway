package main

import (
	"fmt"
	"os"
	"strconv"
)

type Config struct {
	GatewayID          string
	APIKey             string
	LLMGatewayURL      string
	PortkeyContainerName string
	PortkeyPort        int
	AgentPort          int
	LogLevel           string
	ConfigSyncInterval int
	HeartbeatInterval  int
	CertFile           string
	KeyFile            string
}

func LoadConfig() *Config {
	return &Config{
		GatewayID:          getEnv("GATEWAY_ID", ""),
		APIKey:             getEnv("API_KEY", ""),
		LLMGatewayURL:      getEnv("LLM_GATEWAY_URL", "http://localhost:3000"),
		PortkeyContainerName: getEnv("PORTKEY_CONTAINER_NAME", "portkey-gateway"),
		PortkeyPort:        getEnvInt("PORTKEY_PORT", 8787),
		AgentPort:          getEnvInt("AGENT_PORT", 8788),
		LogLevel:           getEnv("LOG_LEVEL", "info"),
		ConfigSyncInterval: getEnvInt("CONFIG_SYNC_INTERVAL", 300),
		HeartbeatInterval:  getEnvInt("HEARTBEAT_INTERVAL", 30),
		CertFile:           getEnv("CERT_FILE", "cert.pem"),
		KeyFile:            getEnv("KEY_FILE", "key.pem"),
	}
}

func (c *Config) Validate() error {
	if c.GatewayID == "" {
		return fmt.Errorf("GATEWAY_ID 不能为空")
	}
	if c.APIKey == "" {
		return fmt.Errorf("API_KEY 不能为空")
	}
	if c.LLMGatewayURL == "" {
		return fmt.Errorf("LLM_GATEWAY_URL 不能为空")
	}
	return nil
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value := os.Getenv(key); value != "" {
		if intValue, err := strconv.Atoi(value); err == nil {
			return intValue
		}
	}
	return defaultValue
}


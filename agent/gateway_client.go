package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type GatewayClient struct {
	config     *Config
	logger     *Logger
	httpClient *http.Client
}

func NewGatewayClient(config *Config, logger *Logger) *GatewayClient {
	return &GatewayClient{
		config: config,
		logger: logger,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

func (g *GatewayClient) Register(hostname, version string) error {
	url := fmt.Sprintf("%s/api/agent/register", g.config.LLMGatewayURL)

	payload := map[string]interface{}{
		"version":  version,
		"hostname": hostname,
	}

	return g.makeRequest("POST", url, payload, nil)
}

func (g *GatewayClient) Heartbeat() error {
	url := fmt.Sprintf("%s/api/agent/heartbeat", g.config.LLMGatewayURL)
	return g.makeRequest("POST", url, nil, nil)
}

func (g *GatewayClient) GetPortkeyConfig() (map[string]interface{}, error) {
	url := fmt.Sprintf("%s/api/agent/portkey-config", g.config.LLMGatewayURL)

	var config map[string]interface{}
	if err := g.makeRequest("GET", url, nil, &config); err != nil {
		return nil, err
	}

	return config, nil
}

func (g *GatewayClient) ReportStatus(status string) error {
	url := fmt.Sprintf("%s/api/agent/report-status", g.config.LLMGatewayURL)

	payload := map[string]interface{}{
		"status": status,
		"port":   g.config.PortkeyPort,
	}

	return g.makeRequest("POST", url, payload, nil)
}

func (g *GatewayClient) makeRequest(method, url string, payload interface{}, result interface{}) error {
	var body io.Reader
	if payload != nil {
		jsonData, err := json.Marshal(payload)
		if err != nil {
			return fmt.Errorf("JSON 序列化失败: %w", err)
		}
		body = bytes.NewBuffer(jsonData)
	}

	req, err := http.NewRequest(method, url, body)
	if err != nil {
		return fmt.Errorf("创建请求失败: %w", err)
	}

	if payload != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("X-Gateway-ID", g.config.GatewayID)
	req.Header.Set("X-API-Key", g.config.APIKey)

	resp, err := g.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("请求失败: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("请求失败: HTTP %d - %s", resp.StatusCode, string(bodyBytes))
	}

	if result != nil {
		if err := json.NewDecoder(resp.Body).Decode(result); err != nil {
			return fmt.Errorf("解析响应失败: %w", err)
		}
	}

	return nil
}

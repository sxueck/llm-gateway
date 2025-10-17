package main

import (
	"fmt"
	"io"
	"net/http"
	"time"
)

type ProxyHandler struct {
	config *Config
	logger *Logger
}

func NewProxyHandler(config *Config, logger *Logger) *ProxyHandler {
	return &ProxyHandler{
		config: config,
		logger: logger,
	}
}

func (p *ProxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	startTime := time.Now()

	gatewayID := r.Header.Get("X-Gateway-ID")
	apiKey := r.Header.Get("X-API-Key")

	if gatewayID != p.config.GatewayID || apiKey != p.config.APIKey {
		p.logger.Warn("认证失败", "remote", r.RemoteAddr, "gateway_id", gatewayID)
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}

	if r.URL.Path == "/health" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"status":"ok","agent":"running"}`))
		return
	}

	targetURL := fmt.Sprintf("http://127.0.0.1:%d%s", p.config.PortkeyPort, r.URL.Path)
	if r.URL.RawQuery != "" {
		targetURL += "?" + r.URL.RawQuery
	}

	proxyReq, err := http.NewRequest(r.Method, targetURL, r.Body)
	if err != nil {
		p.logger.Error("创建代理请求失败", "error", err)
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	for key, values := range r.Header {
		if key != "X-Gateway-ID" && key != "X-API-Key" {
			for _, value := range values {
				proxyReq.Header.Add(key, value)
			}
		}
	}

	client := &http.Client{
		Timeout: 5 * time.Minute,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	resp, err := client.Do(proxyReq)
	if err != nil {
		p.logger.Error("代理请求失败", "error", err, "target", targetURL)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()

	for key, values := range resp.Header {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}

	w.WriteHeader(resp.StatusCode)

	written, err := io.Copy(w, resp.Body)
	if err != nil {
		p.logger.Error("响应传输失败", "error", err)
		return
	}

	duration := time.Since(startTime)
	p.logger.Info("代理请求完成",
		"method", r.Method,
		"path", r.URL.Path,
		"status", resp.StatusCode,
		"bytes", written,
		"duration", duration,
	)
}

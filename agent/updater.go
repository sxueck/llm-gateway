package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

type Updater struct {
	currentVersion string
	gatewayURL     string
	logger         *Logger
}

func NewUpdater(currentVersion, gatewayURL string, logger *Logger) *Updater {
	return &Updater{
		currentVersion: currentVersion,
		gatewayURL:     gatewayURL,
		logger:         logger,
	}
}

func (u *Updater) CheckForUpdate(ctx context.Context) (string, bool, error) {
	url := fmt.Sprintf("%s/api/agent/version", u.gatewayURL)
	
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return "", false, err
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", false, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", false, fmt.Errorf("检查更新失败: %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", false, err
	}

	latestVersion := strings.TrimSpace(string(body))
	
	if latestVersion != u.currentVersion {
		return latestVersion, true, nil
	}

	return latestVersion, false, nil
}

func (u *Updater) DownloadUpdate(ctx context.Context, version string) (string, error) {
	binaryName := u.getBinaryName()
	url := fmt.Sprintf("%s/downloads/%s", u.gatewayURL, binaryName)

	u.logger.Info("下载更新", "version", version, "url", url)

	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return "", err
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("下载失败: %d", resp.StatusCode)
	}

	tmpFile := filepath.Join(os.TempDir(), fmt.Sprintf("llm-gateway-agent-update-%s", version))
	
	out, err := os.Create(tmpFile)
	if err != nil {
		return "", err
	}
	defer out.Close()

	if _, err := io.Copy(out, resp.Body); err != nil {
		os.Remove(tmpFile)
		return "", err
	}

	if err := os.Chmod(tmpFile, 0755); err != nil {
		os.Remove(tmpFile)
		return "", err
	}

	return tmpFile, nil
}

func (u *Updater) ApplyUpdate(newBinaryPath string) error {
	currentBinary, err := os.Executable()
	if err != nil {
		return err
	}

	backupPath := currentBinary + ".backup"
	
	if err := os.Rename(currentBinary, backupPath); err != nil {
		return fmt.Errorf("备份失败: %w", err)
	}

	if err := os.Rename(newBinaryPath, currentBinary); err != nil {
		os.Rename(backupPath, currentBinary)
		return fmt.Errorf("替换失败: %w", err)
	}

	if err := os.Chmod(currentBinary, 0755); err != nil {
		return err
	}

	u.logger.Info("更新成功，准备重启...")

	if err := u.restart(); err != nil {
		u.logger.Error("重启失败", "error", err)
		return err
	}

	return nil
}

func (u *Updater) restart() error {
	currentBinary, err := os.Executable()
	if err != nil {
		return err
	}

	cmd := exec.Command(currentBinary, os.Args[1:]...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin

	if err := cmd.Start(); err != nil {
		return err
	}

	os.Exit(0)
	return nil
}

func (u *Updater) getBinaryName() string {
	goos := runtime.GOOS
	goarch := runtime.GOARCH

	name := fmt.Sprintf("llm-gateway-agent-%s-%s", goos, goarch)
	
	if goos == "windows" {
		name += ".exe"
	}

	return name
}

func (u *Updater) AutoUpdate(ctx context.Context) error {
	latestVersion, hasUpdate, err := u.CheckForUpdate(ctx)
	if err != nil {
		return fmt.Errorf("检查更新失败: %w", err)
	}

	if !hasUpdate {
		u.logger.Debug("已是最新版本", "version", u.currentVersion)
		return nil
	}

	u.logger.Info("发现新版本", "current", u.currentVersion, "latest", latestVersion)

	tmpFile, err := u.DownloadUpdate(ctx, latestVersion)
	if err != nil {
		return fmt.Errorf("下载更新失败: %w", err)
	}
	defer os.Remove(tmpFile)

	if err := u.ApplyUpdate(tmpFile); err != nil {
		return fmt.Errorf("应用更新失败: %w", err)
	}

	return nil
}


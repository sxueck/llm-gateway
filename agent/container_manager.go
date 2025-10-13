package main

import (
	"context"
	"fmt"
	"io"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/go-connections/nat"
)

type ContainerManager struct {
	config       *Config
	dockerClient *DockerClient
	logger       *Logger
	configManager *ConfigManager
}

func NewContainerManager(config *Config, dockerClient *DockerClient, logger *Logger) *ContainerManager {
	return &ContainerManager{
		config:       config,
		dockerClient: dockerClient,
		logger:       logger,
		configManager: NewConfigManager(config, logger),
	}
}

func (cm *ContainerManager) EnsureRunning(ctx context.Context) error {
	cli := cm.dockerClient.GetClient()

	containers, err := cli.ContainerList(ctx, types.ContainerListOptions{All: true})
	if err != nil {
		return fmt.Errorf("列出容器失败: %w", err)
	}

	var existingContainer *types.Container
	for _, c := range containers {
		for _, name := range c.Names {
			if name == "/"+cm.config.PortkeyContainerName || name == cm.config.PortkeyContainerName {
				existingContainer = &c
				break
			}
		}
	}

	if existingContainer != nil {
		if existingContainer.State == "running" {
			cm.logger.Info("容器已在运行", "container", cm.config.PortkeyContainerName)
			return nil
		}

		cm.logger.Info("启动已存在的容器", "container", cm.config.PortkeyContainerName)
		if err := cli.ContainerStart(ctx, existingContainer.ID, types.ContainerStartOptions{}); err != nil {
			return fmt.Errorf("启动容器失败: %w", err)
		}

		return nil
	}

	return cm.createAndStart(ctx)
}

func (cm *ContainerManager) createAndStart(ctx context.Context) error {
	cli := cm.dockerClient.GetClient()

	cm.logger.Info("拉取镜像", "image", "portkeyai/gateway:latest")
	reader, err := cli.ImagePull(ctx, "portkeyai/gateway:latest", types.ImagePullOptions{})
	if err != nil {
		return fmt.Errorf("拉取镜像失败: %w", err)
	}
	defer reader.Close()
	if _, err := io.Copy(io.Discard, reader); err != nil {
		return fmt.Errorf("读取镜像拉取输出失败: %w", err)
	}

	configDir := "/tmp/portkey-config-" + cm.config.GatewayID

	portBinding := nat.PortBinding{
		HostIP:   "0.0.0.0",
		HostPort: fmt.Sprintf("%d", cm.config.PortkeyPort),
	}

	containerConfig := &container.Config{
		Image: "portkeyai/gateway:latest",
		Env: []string{
			"CONFIG_PATH=/app/config/conf.json",
			fmt.Sprintf("GATEWAY_ID=%s", cm.config.GatewayID),
			fmt.Sprintf("GATEWAY_API_KEY=%s", cm.config.APIKey),
			fmt.Sprintf("LLM_GATEWAY_URL=%s", cm.config.LLMGatewayURL),
		},
		ExposedPorts: nat.PortSet{
			"8787/tcp": struct{}{},
		},
	}

	hostConfig := &container.HostConfig{
		PortBindings: nat.PortMap{
			"8787/tcp": []nat.PortBinding{portBinding},
		},
		Mounts: []mount.Mount{
			{
				Type:   mount.TypeBind,
				Source: configDir,
				Target: "/app/config",
			},
		},
		RestartPolicy: container.RestartPolicy{
			Name: "unless-stopped",
		},
	}

	cm.logger.Info("创建容器", "container", cm.config.PortkeyContainerName)
	resp, err := cli.ContainerCreate(ctx, containerConfig, hostConfig, nil, nil, cm.config.PortkeyContainerName)
	if err != nil {
		return fmt.Errorf("创建容器失败: %w", err)
	}

	cm.logger.Info("启动容器", "container", cm.config.PortkeyContainerName)
	if err := cli.ContainerStart(ctx, resp.ID, types.ContainerStartOptions{}); err != nil {
		return fmt.Errorf("启动容器失败: %w", err)
	}

	cm.logger.Info("容器启动成功", "container", cm.config.PortkeyContainerName)
	return nil
}

func (cm *ContainerManager) Restart(ctx context.Context) error {
	cli := cm.dockerClient.GetClient()

	timeout := 10
	cm.logger.Info("重启容器", "container", cm.config.PortkeyContainerName)

	if err := cli.ContainerRestart(ctx, cm.config.PortkeyContainerName, container.StopOptions{Timeout: &timeout}); err != nil {
		return fmt.Errorf("重启容器失败: %w", err)
	}

	time.Sleep(2 * time.Second)

	return nil
}

func (cm *ContainerManager) Stop(ctx context.Context) error {
	cli := cm.dockerClient.GetClient()

	timeout := 10
	cm.logger.Info("停止容器", "container", cm.config.PortkeyContainerName)

	if err := cli.ContainerStop(ctx, cm.config.PortkeyContainerName, container.StopOptions{Timeout: &timeout}); err != nil {
		return fmt.Errorf("停止容器失败: %w", err)
	}

	return nil
}

func (cm *ContainerManager) IsRunning(ctx context.Context) (bool, error) {
	cli := cm.dockerClient.GetClient()

	containers, err := cli.ContainerList(ctx, types.ContainerListOptions{})
	if err != nil {
		return false, err
	}

	for _, c := range containers {
		for _, name := range c.Names {
			if name == "/"+cm.config.PortkeyContainerName || name == cm.config.PortkeyContainerName {
				return c.State == "running", nil
			}
		}
	}

	return false, nil
}


package main

import (
	"context"

	"github.com/docker/docker/client"
)

type DockerClient struct {
	client *client.Client
}

func NewDockerClient() (*DockerClient, error) {
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		return nil, err
	}

	return &DockerClient{
		client: cli,
	}, nil
}

func (d *DockerClient) Close() error {
	return d.client.Close()
}

func (d *DockerClient) Ping(ctx context.Context) error {
	_, err := d.client.Ping(ctx)
	return err
}

func (d *DockerClient) GetClient() *client.Client {
	return d.client
}


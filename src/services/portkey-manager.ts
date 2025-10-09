import { exec } from 'child_process';
import { promisify } from 'util';
import { resolve } from 'path';
import { appConfig } from '../config/index.js';
import { memoryLogger } from './logger.js';

const execAsync = promisify(exec);

export interface PortkeyGatewayStatus {
  running: boolean;
  containerId?: string;
  containerName?: string;
  status?: string;
  ports?: string;
  image?: string;
  error?: string;
}

export interface PortkeyGatewayConfig {
  containerName: string;
  port: number;
  configPath: string;
  image: string;
}

const DEFAULT_CONFIG: PortkeyGatewayConfig = {
  containerName: 'portkey-gateway',
  port: 8787,
  configPath: resolve(appConfig.portkeyConfigPath),
  image: 'portkeyai/gateway:latest',
};

export class PortkeyManager {
  private config: PortkeyGatewayConfig;

  constructor(config?: Partial<PortkeyGatewayConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async getStatus(): Promise<PortkeyGatewayStatus> {
    try {
      const { stdout } = await execAsync(
        `docker ps -a --filter "name=${this.config.containerName}" --format "{{.ID}}|{{.Names}}|{{.Status}}|{{.Ports}}|{{.Image}}"`
      );

      if (!stdout.trim()) {
        return {
          running: false,
          error: '容器不存在',
        };
      }

      const [containerId, containerName, status, ports, image] = stdout.trim().split('|');
      const isRunning = status.toLowerCase().includes('up');

      return {
        running: isRunning,
        containerId,
        containerName,
        status,
        ports,
        image,
      };
    } catch (error: any) {
      memoryLogger.error(`获取 Portkey Gateway 状态失败: ${error.message}`, 'PortkeyManager');
      return {
        running: false,
        error: error.message,
      };
    }
  }

  async getDetailedInfo(): Promise<any> {
    try {
      const status = await this.getStatus();

      if (!status.containerId) {
        return {
          exists: false,
          message: '容器不存在',
        };
      }

      const { stdout } = await execAsync(`docker inspect ${status.containerId}`);
      const info = JSON.parse(stdout)[0];

      return {
        exists: true,
        running: status.running,
        info: {
          id: info.Id,
          name: info.Name,
          image: info.Config.Image,
          created: info.Created,
          state: info.State,
          ports: info.NetworkSettings.Ports,
          mounts: info.Mounts,
          env: info.Config.Env,
        },
      };
    } catch (error: any) {
      memoryLogger.error(`获取容器详细信息失败: ${error.message}`, 'PortkeyManager');
      return {
        exists: false,
        error: error.message,
      };
    }
  }

  async start(): Promise<{ success: boolean; message: string; containerId?: string }> {
    try {
      const status = await this.getStatus();

      if (status.running) {
        return {
          success: true,
          message: 'Portkey Gateway 已在运行中',
          containerId: status.containerId,
        };
      }

      if (status.containerId) {
        memoryLogger.info('启动已存在的 Portkey Gateway 容器', 'PortkeyManager');
        const { stdout } = await execAsync(`docker start ${this.config.containerName}`);
        
        await this.waitForHealthy(5000);
        
        return {
          success: true,
          message: 'Portkey Gateway 已启动',
          containerId: stdout.trim(),
        };
      }

      memoryLogger.info('创建并启动新的 Portkey Gateway 容器', 'PortkeyManager');
      
      const configDir = resolve(this.config.configPath, '..');
      const isWindows = process.platform === 'win32';
      const volumePath = isWindows
        ? configDir.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, drive) => `/${drive.toLowerCase()}`)
        : configDir;

      const filePathRaw = resolve(this.config.configPath);
      const fileVolumePath = isWindows
        ? filePathRaw.replace(/\\/g, '/').replace(/^([A-Z]):/, (_, drive) => `/${drive.toLowerCase()}`)
        : filePathRaw;

      const command = [
        'docker run -d',
        `--name ${this.config.containerName}`,
        `-p 127.0.0.1:${this.config.port}:8787`,
        `-v "${volumePath}:/app/config"`,
        `-v "${fileVolumePath}:/app/conf.json"`,
        '-e CONFIG_PATH=/app/config/conf.json',
        '--restart unless-stopped',
        this.config.image,
      ].join(' ');

      memoryLogger.debug(`执行命令: ${command}`, 'PortkeyManager');
      
      const { stdout } = await execAsync(command);
      const containerId = stdout.trim();

      await this.waitForHealthy(10000);

      memoryLogger.info(`Portkey Gateway 已启动: ${containerId}`, 'PortkeyManager');

      return {
        success: true,
        message: 'Portkey Gateway 已成功启动',
        containerId,
      };
    } catch (error: any) {
      const errorMessage = `启动 Portkey Gateway 失败: ${error.message}`;
      memoryLogger.error(errorMessage, 'PortkeyManager');
      
      return {
        success: false,
        message: errorMessage,
      };
    }
  }

  async stop(): Promise<{ success: boolean; message: string }> {
    try {
      const status = await this.getStatus();

      if (!status.running) {
        return {
          success: true,
          message: 'Portkey Gateway 未在运行',
        };
      }

      memoryLogger.info('停止 Portkey Gateway', 'PortkeyManager');
      await execAsync(`docker stop ${this.config.containerName}`);

      return {
        success: true,
        message: 'Portkey Gateway 已停止',
      };
    } catch (error: any) {
      const errorMessage = `停止 Portkey Gateway 失败: ${error.message}`;
      memoryLogger.error(errorMessage, 'PortkeyManager');
      
      return {
        success: false,
        message: errorMessage,
      };
    }
  }

  async restart(): Promise<{ success: boolean; message: string }> {
    try {
      memoryLogger.info('重启 Portkey Gateway', 'PortkeyManager');
      
      const stopResult = await this.stop();
      if (!stopResult.success) {
        return stopResult;
      }

      await new Promise(resolve => setTimeout(resolve, 2000));

      const startResult = await this.start();
      return startResult;
    } catch (error: any) {
      const errorMessage = `重启 Portkey Gateway 失败: ${error.message}`;
      memoryLogger.error(errorMessage, 'PortkeyManager');
      
      return {
        success: false,
        message: errorMessage,
      };
    }
  }

  async remove(): Promise<{ success: boolean; message: string }> {
    try {
      const status = await this.getStatus();

      if (!status.containerId) {
        return {
          success: true,
          message: '容器不存在',
        };
      }

      if (status.running) {
        await this.stop();
      }

      memoryLogger.info('删除 Portkey Gateway 容器', 'PortkeyManager');
      await execAsync(`docker rm ${this.config.containerName}`);

      return {
        success: true,
        message: 'Portkey Gateway 容器已删除',
      };
    } catch (error: any) {
      const errorMessage = `删除 Portkey Gateway 容器失败: ${error.message}`;
      memoryLogger.error(errorMessage, 'PortkeyManager');
      
      return {
        success: false,
        message: errorMessage,
      };
    }
  }

  async getLogs(lines: number = 100): Promise<{ success: boolean; logs?: string; message?: string }> {
    try {
      const status = await this.getStatus();

      if (!status.containerId) {
        return {
          success: false,
          message: '容器不存在',
        };
      }

      const { stdout } = await execAsync(`docker logs --tail ${lines} ${this.config.containerName}`);

      return {
        success: true,
        logs: stdout,
      };
    } catch (error: any) {
      const errorMessage = `获取 Portkey Gateway 日志失败: ${error.message}`;
      memoryLogger.error(errorMessage, 'PortkeyManager');
      
      return {
        success: false,
        message: errorMessage,
      };
    }
  }

  private async waitForHealthy(timeout: number = 10000): Promise<boolean> {
    const startTime = Date.now();
    const checkInterval = 500;

    while (Date.now() - startTime < timeout) {
      try {
        const response = await fetch(`http://localhost:${this.config.port}/health`, {
          signal: AbortSignal.timeout(1000),
        });

        if (response.ok || response.status === 404) {
          memoryLogger.info('Portkey Gateway 健康检查通过', 'PortkeyManager');
          return true;
        }
      } catch (error) {
        // 继续等待
      }

      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }

    memoryLogger.warn('Portkey Gateway 健康检查超时', 'PortkeyManager');
    return false;
  }
}

export const portkeyManager = new PortkeyManager();


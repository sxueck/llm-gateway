import mysql from 'mysql2/promise';
import { appConfig } from '../config/index.js';

let pool: mysql.Pool;

export async function initDatabase() {
  try {
    pool = mysql.createPool({
      host: appConfig.mysql.host,
      port: appConfig.mysql.port,
      user: appConfig.mysql.user,
      password: appConfig.mysql.password,
      database: appConfig.mysql.database,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      enableKeepAlive: true,
      keepAliveInitialDelay: 0,
    });

    const connection = await pool.getConnection();
    console.log('[数据库] MySQL 连接成功');
    connection.release();

    return pool;
  } catch (error: any) {
    console.error('[数据库] 初始化失败:', error.message);
    console.error('[数据库] 错误详情:', error);
    throw new Error(`数据库初始化失败: ${error.message}`);
  }
}

export function getDatabase() {
  if (!pool) {
    throw new Error('Database not initialized');
  }
  return pool;
}

export function getPool() {
  return pool;
}

export async function shutdownDatabase() {
  if (pool) {
    await pool.end();
  }
}

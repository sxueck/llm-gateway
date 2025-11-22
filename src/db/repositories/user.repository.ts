import { getDatabase } from '../connection.js';
import { User } from '../../types/index.js';

export const userRepository = {
  async create(user: Omit<User, 'created_at' | 'updated_at'>): Promise<User> {
    const now = Date.now();
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.query(
        'INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [user.id, user.username, user.password_hash, now, now]
      );
      return { ...user, created_at: now, updated_at: now };
    } finally {
      conn.release();
    }
  },

  async findByUsername(username: string): Promise<User | undefined> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM users WHERE username = ?', [username]);
      const users = rows as any[];
      if (users.length === 0) return undefined;
      return users[0];
    } finally {
      conn.release();
    }
  },

  async findById(id: string): Promise<User | undefined> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM users WHERE id = ?', [id]);
      const users = rows as any[];
      if (users.length === 0) return undefined;
      return users[0];
    } finally {
      conn.release();
    }
  },

  async getAll(): Promise<User[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM users ORDER BY created_at DESC');
      return rows as User[];
    } finally {
      conn.release();
    }
  },
};

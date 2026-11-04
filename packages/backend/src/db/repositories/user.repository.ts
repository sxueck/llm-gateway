import { getDatabase } from '../connection.js';
import { User } from '../../types/index.js';

/** users.role 取值：admin=管理员，user=普通用户。 */
export type UserRole = 'admin' | 'user';

/** users 表完整行：在 User 之上补充角色列（SELECT * 恒返回 role）。 */
export interface UserRow extends User {
  role: UserRole;
}

/**
 * 首个用户判定的串行锁。空表上 InnoDB 拿不到能互斥插入的行锁
 * （gap 锁彼此兼容，两个并发事务都能判定“我是第一个”），
 * GET_LOCK 是连接级互斥，跨池连接也成立。
 */
const FIRST_ADMIN_LOCK_KEY = 'llm_gateway:users:first_admin';
const FIRST_ADMIN_LOCK_TIMEOUT_SECONDS = 10;

export const userRepository = {
  /**
   * 创建用户并自动分配角色：空表（新库首用户）→ admin，其余 → user。
   * 判定在 GET_LOCK 串行化下进行，并发注册不会产生两个 admin。
   */
  async create(user: Omit<User, 'created_at' | 'updated_at'>): Promise<UserRow> {
    const now = Date.now();
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [lockRows] = await conn.query('SELECT GET_LOCK(?, ?) AS acquired', [
        FIRST_ADMIN_LOCK_KEY,
        FIRST_ADMIN_LOCK_TIMEOUT_SECONDS,
      ]);
      if (Number((lockRows as Array<{ acquired: number }>)[0]?.acquired ?? 0) !== 1) {
        throw new Error('首个管理员判定锁获取失败');
      }
      try {
        const [rows] = await conn.query('SELECT COUNT(*) AS count FROM users');
        const role: UserRole =
          Number((rows as Array<{ count: number }>)[0]?.count ?? 0) === 0 ? 'admin' : 'user';
        await conn.query(
          'INSERT INTO users (id, username, password_hash, role, updated_at) VALUES (?, ?, ?, ?, ?)',
          [user.id, user.username, user.password_hash, role, now]
        );
        return { ...user, role, created_at: now, updated_at: now };
      } finally {
        try {
          const [rows] = await conn.query('SELECT RELEASE_LOCK(?) AS released', [FIRST_ADMIN_LOCK_KEY]);
          if (Number((rows as Array<{ released: number | null }>)[0]?.released) !== 1) {
            throw new Error('首个管理员判定锁释放失败');
          }
        } catch (error) {
          conn.destroy();
          throw error;
        }
      }
    } finally {
      conn.release();
    }
  },

  async findByUsername(username: string): Promise<UserRow | undefined> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM users WHERE username = ?', [username]);
      const users = rows as UserRow[];
      if (users.length === 0) return undefined;
      return users[0];
    } finally {
      conn.release();
    }
  },

  async findById(id: string): Promise<UserRow | undefined> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM users WHERE id = ?', [id]);
      const users = rows as UserRow[];
      if (users.length === 0) return undefined;
      return users[0];
    } finally {
      conn.release();
    }
  },

  async getAll(): Promise<UserRow[]> {
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query('SELECT * FROM users ORDER BY created_at DESC');
      return rows as UserRow[];
    } finally {
      conn.release();
    }
  },

  /**
   * 修改用户角色（管理员入口）。降级 admin 前在事务里锁住全部 admin 行再计数，
   * 保证任何时刻至少保留一个 admin；并发降级在同一行锁集上排队，天然互斥且无死锁。
   */
  async setRole(id: string, role: UserRole): Promise<void> {
    if (role !== 'admin' && role !== 'user') {
      throw new Error(`非法角色: ${String(role)}`);
    }
    const pool = getDatabase();
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      try {
        // 先锁 admin 行集：所有改角色的会话都从同一锁集排队，避免交叉加锁死锁。
        const [adminRows] = await conn.query(
          "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' FOR UPDATE"
        );
        const adminCount = Number((adminRows as Array<{ count: number }>)[0]?.count ?? 0);
        const [rows] = await conn.query('SELECT id, role FROM users WHERE id = ? FOR UPDATE', [id]);
        const target = (rows as Array<{ id: string; role: UserRole }>)[0];
        if (!target) {
          throw new Error('用户不存在');
        }
        if (target.role !== role) {
          if (target.role === 'admin' && adminCount <= 1) {
            throw new Error('不能移除最后一个管理员');
          }
          await conn.query('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', [
            role,
            Date.now(),
            id,
          ]);
        }
        await conn.commit();
      } catch (error) {
        await conn.rollback();
        throw error;
      }
    } finally {
      conn.release();
    }
  },
};

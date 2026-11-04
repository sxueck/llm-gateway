import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { authApi } from '@/api/auth';
import { isAdminUser } from '@/utils/role';
import type { User, LoginRequest, RegisterRequest } from '@/types';

// 刷新后 role 需要立即可用：侧栏菜单和路由守卫都依赖它，
// 否则会先按 admin 闪一帧管理菜单再纠正。快照仅作展示兜底，权限仍以后端为准。
const USER_STORAGE_KEY = 'authUser';

function readStoredUser(): User | null {
  try {
    const raw = localStorage.getItem(USER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<User>;
    return typeof candidate.id === 'string' && typeof candidate.username === 'string'
      ? (candidate as User)
      : null;
  // A corrupt display snapshot must not grant admin access.
  // ast-grep-ignore: no-catch-swallow
  } catch {
    return null;
  }
}

function persistUser(user: User | null) {
  if (user) {
    localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
  } else {
    localStorage.removeItem(USER_STORAGE_KEY);
  }
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(localStorage.getItem('token'));
  const user = ref<User | null>(readStoredUser());

  const isAdmin = computed(() => isAdminUser(user.value));

  function applySession(nextToken: string, nextUser: User) {
    token.value = nextToken;
    user.value = nextUser;
    localStorage.setItem('token', nextToken);
    persistUser(nextUser);
  }

  async function login(data: LoginRequest) {
    const response = await authApi.login(data);
    applySession(response.token, response.user);
  }

  async function register(data: RegisterRequest) {
    const response = await authApi.register(data);
    applySession(response.token, response.user);
  }

  async function fetchProfile() {
    const sessionToken = token.value;
    if (!sessionToken) return;
    try {
      const profile = await authApi.getProfile();
      if (token.value !== sessionToken) return;
      user.value = profile;
      persistUser(profile);
    } catch {
      // 401 已由请求拦截器退出；网络或 5xx 保留 token，避免一次失败把登录态清掉
    }
  }

  let profileInFlight: { token: string; promise: Promise<void> } | null = null;

  function ensureProfileLoaded(): Promise<void> {
    const sessionToken = token.value;
    if (!sessionToken) return Promise.resolve();
    if (profileInFlight?.token !== sessionToken) {
      const promise = fetchProfile().finally(() => {
        if (profileInFlight?.promise === promise) profileInFlight = null;
      });
      profileInFlight = { token: sessionToken, promise };
    }
    return profileInFlight.promise;
  }

  function logout() {
    token.value = null;
    user.value = null;
    localStorage.removeItem('token');
    persistUser(null);
  }

  return {
    token,
    user,
    isAdmin,
    login,
    register,
    fetchProfile,
    ensureProfileLoaded,
    logout,
  };
});

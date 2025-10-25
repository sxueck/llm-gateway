import request from '@/utils/request';
import type { LoginRequest, RegisterRequest, AuthResponse, User } from '@/types';

export const authApi = {
  login(data: LoginRequest): Promise<AuthResponse> {
    return request.post('/auth/login', data);
  },

  register(data: RegisterRequest): Promise<AuthResponse> {
    return request.post('/auth/register', data);
  },

  getProfile(): Promise<User> {
    return request.get('/auth/profile');
  },

  getAllUsers(): Promise<User[]> {
    return request.get('/auth/users');
  },
};


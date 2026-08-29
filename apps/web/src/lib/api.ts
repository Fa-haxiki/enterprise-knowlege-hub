import { useAuthStore } from '@/store/auth';

const BASE = '/api/v1';

export class ApiError extends Error {
  constructor(
    public code: number,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit, retry = true): Promise<T> {
  const { accessToken, refreshToken, setTokens, clear } = useAuthStore.getState();

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init?.headers,
    },
  });

  // Access Token 过期：尝试刷新后重试一次
  if (res.status === 401 && retry && refreshToken) {
    const refreshed = await fetch(`${BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    });
    if (refreshed.ok) {
      const json = await refreshed.json();
      setTokens(json.data.access_token, json.data.refresh_token, json.data.user);
      return request<T>(path, init, false);
    }
    clear();
    window.location.href = '/login';
    throw new ApiError(40101, '登录已过期', 401);
  }

  const json = await res.json();
  if (!res.ok || json.code !== 0) {
    throw new ApiError(json.code ?? res.status, json.message ?? '请求失败', res.status);
  }
  return json.data as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

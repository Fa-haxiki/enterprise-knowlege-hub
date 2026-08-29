import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/store/auth';

export default function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const setTokens = useAuthStore((s) => s.setTokens);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data =
        mode === 'login'
          ? await api.post<{ access_token: string; refresh_token: string; user: never }>(
              '/auth/login',
              { email, password },
            )
          : await api.post<{ access_token: string; refresh_token: string; user: never }>(
              '/auth/register',
              { email, password, name },
            );
      setTokens(data.access_token, data.refresh_token, data.user);
      navigate('/chat');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100">
      <div className="w-full max-w-sm rounded-xl bg-white p-8 shadow-sm">
        <h1 className="mb-1 text-xl font-semibold">企业知识库</h1>
        <p className="mb-6 text-sm text-slate-500">
          {mode === 'login' ? '登录以继续' : '注册新账号'}
        </p>
        <form onSubmit={submit} className="space-y-4">
          {mode === 'register' && (
            <input
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
              placeholder="姓名"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          )}
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
            type="email"
            placeholder="邮箱"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          <input
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
            type="password"
            placeholder="密码（至少 8 位）"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-slate-900 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {loading ? '请稍候…' : mode === 'login' ? '登录' : '注册'}
          </button>
        </form>
        <button
          onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
          className="mt-4 w-full text-center text-xs text-slate-500 hover:text-slate-700"
        >
          {mode === 'login' ? '没有账号？注册' : '已有账号？登录'}
        </button>
      </div>
    </div>
  );
}

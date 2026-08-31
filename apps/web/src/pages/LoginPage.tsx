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
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const setTokens = useAuthStore((s) => s.setTokens);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    setLoading(true);
    try {
      if (mode === 'register') {
        // 申请制：注册不签发 token，等待管理员审核
        const res = await api.post<{ pending: boolean; message: string }>(
          '/auth/register',
          { email, password, name },
        );
        setNotice(res.message);
        setMode('login');
        setPassword('');
        return;
      }
      const data = await api.post<{ access_token: string; refresh_token: string; user: never }>(
        '/auth/login',
        { email, password },
      );
      setTokens(data.access_token, data.refresh_token, data.user);
      navigate('/chat');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误');
    } finally {
      setLoading(false);
    }
  };

  const inputCls =
    'w-full rounded-lg border border-border bg-card px-3.5 py-2.5 text-sm outline-none transition-colors placeholder:text-ink-400 focus:border-brand-500 focus:ring-2 focus:ring-brand-500/15';

  return (
    <div className="flex min-h-screen">
      {/* 品牌区 */}
      <div className="relative hidden flex-1 flex-col justify-between overflow-hidden bg-gradient-to-br from-brand-700 via-brand-600 to-brand-500 p-12 text-white lg:flex">
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-white/15 backdrop-blur">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
            </svg>
          </div>
          <span className="text-lg font-semibold">企业知识库</span>
        </div>
        <div>
          <h1 className="text-3xl font-bold leading-snug">
            企业知识，
            <br />
            一问即达。
          </h1>
          <p className="mt-4 max-w-md text-sm leading-6 text-white/70">
            基于 Agentic RAG 的企业级知识中枢：混合检索、图谱推理、分层记忆，
            让每一份制度文档都成为可对话的知识资产。
          </p>
        </div>
        <p className="text-xs text-white/40">Agentic RAG · 图谱推理 · 流式问答 · 语音播报</p>
        {/* 装饰 */}
        <div className="pointer-events-none absolute -right-24 -top-24 h-96 w-96 rounded-full bg-white/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -left-16 h-80 w-80 rounded-full bg-black/10 blur-3xl" />
      </div>

      {/* 表单区 */}
      <div className="flex flex-1 items-center justify-center bg-surface p-6">
        <div className="w-full max-w-sm animate-fadeUp">
          <div className="mb-8 lg:hidden">
            <h1 className="text-xl font-semibold text-ink-900">企业知识库</h1>
          </div>
          <h2 className="text-xl font-semibold text-ink-900">
            {mode === 'login' ? '欢迎回来' : '创建账号'}
          </h2>
          <p className="mb-6 mt-1 text-sm text-ink-400">
            {mode === 'login' ? '登录以继续使用智能问答' : '提交申请，管理员审核通过后开通'}
          </p>
          <form onSubmit={submit} className="space-y-3.5">
            {mode === 'register' && (
              <input
                className={inputCls}
                placeholder="姓名"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            )}
            <input
              className={inputCls}
              type="email"
              placeholder="邮箱"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <input
              className={inputCls}
              type="password"
              placeholder="密码（至少 8 位）"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={8}
              required
            />
            {notice && (
              <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-600 dark:text-emerald-400">
                {notice}
              </p>
            )}
            {error && (
              <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-brand-600 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-brand-700 disabled:opacity-50"
            >
              {loading ? '请稍候…' : mode === 'login' ? '登录' : '提交申请'}
            </button>
          </form>
          <button
            onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
            className="mt-5 w-full text-center text-xs text-ink-400 transition-colors hover:text-brand-600"
          >
            {mode === 'login' ? '没有账号？申请注册' : '已有账号？登录'}
          </button>
        </div>
      </div>
    </div>
  );
}

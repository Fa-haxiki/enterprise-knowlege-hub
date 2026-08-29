import { FormEvent, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';

interface Workspace {
  id: string;
  name: string;
  description: string | null;
  role: 'owner' | 'editor' | 'viewer';
  created_at: string;
}

const ROLE_LABEL = { owner: '所有者', editor: '编辑者', viewer: '查看者' } as const;

export default function WorkspacesPage() {
  const [list, setList] = useState<Workspace[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  const load = () => api.get<Workspace[]>('/workspaces').then(setList).catch(() => setList([]));

  useEffect(() => {
    void load();
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api.post('/workspaces', { name, description: description || undefined });
      setName('');
      setDescription('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '创建失败');
    }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-4 text-lg font-semibold">知识空间</h1>

        <form onSubmit={create} className="mb-6 flex gap-2 rounded-lg border border-slate-200 bg-white p-4">
          <input
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
            placeholder="空间名称，如：财务部制度库"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <input
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-slate-500"
            placeholder="描述（可选）"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <button className="rounded-md bg-slate-900 px-4 py-2 text-sm text-white hover:bg-slate-800">
            创建
          </button>
        </form>
        {error && <p className="mb-4 text-sm text-red-600">{error}</p>}

        <div className="grid gap-3">
          {list.map((ws) => (
            <Link
              key={ws.id}
              to={`/workspaces/${ws.id}/documents`}
              className="flex items-center justify-between rounded-lg border border-slate-200 bg-white p-4 hover:border-slate-400"
            >
              <div>
                <div className="font-medium">{ws.name}</div>
                {ws.description && <div className="mt-0.5 text-sm text-slate-500">{ws.description}</div>}
              </div>
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs text-slate-600">
                {ROLE_LABEL[ws.role]}
              </span>
            </Link>
          ))}
          {list.length === 0 && (
            <p className="py-12 text-center text-sm text-slate-400">暂无空间，先创建一个吧</p>
          )}
        </div>
      </div>
    </div>
  );
}

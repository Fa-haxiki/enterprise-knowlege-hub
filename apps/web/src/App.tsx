import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuthStore } from '@/store/auth';
import LoginPage from '@/pages/LoginPage';
import WorkspacesPage from '@/pages/WorkspacesPage';
import DocumentsPage from '@/pages/DocumentsPage';
import ChatPage from '@/pages/ChatPage';
import AdminPage from '@/pages/AdminPage';
import SearchPage from '@/pages/SearchPage';
import DepartmentPage from '@/pages/DepartmentPage';
import GraphPage from '@/pages/GraphPage';
import Layout from '@/components/Layout';

function RequireAuth({ children }: { children: JSX.Element }) {
  const accessToken = useAuthStore((s) => s.accessToken);
  if (!accessToken) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/chat" replace />} />
        <Route path="chat" element={<ChatPage />} />
        <Route path="chat/:conversationId" element={<ChatPage />} />
        <Route path="workspaces" element={<WorkspacesPage />} />
        <Route path="workspaces/:workspaceId/documents" element={<DocumentsPage />} />
        {/* 审核入口已并入知识空间文档页（?tab=review），旧链接重定向到待审优先视图 */}
        <Route path="review" element={<Navigate to="/workspaces?pending=1" replace />} />
        <Route path="search" element={<SearchPage />} />
        {/* 知识图谱页：graph_explorer 开关关闭时页面内重定向回 /chat */}
        <Route path="graph" element={<GraphPage />} />
        <Route path="department" element={<DepartmentPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Route>
    </Routes>
  );
}

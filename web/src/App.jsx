import { Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout.jsx';
import Login from './pages/Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Conversations from './pages/Conversations.jsx';
import ConversationDetail from './pages/ConversationDetail.jsx';
import Kanban from './pages/Kanban.jsx';
import Accounts from './pages/Accounts.jsx';
import AccountEdit from './pages/AccountEdit.jsx';
import Providers from './pages/Providers.jsx';
import Playground from './pages/Playground.jsx';
import SettingsPage from './pages/Settings.jsx';
import UsersPage from './pages/Users.jsx';
import PortalRegister from './pages/PortalRegister.jsx';

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/registro-portal" element={<PortalRegister />} />
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/conversaciones" element={<Conversations />} />
        <Route path="/conversaciones/:id" element={<ConversationDetail />} />
        <Route path="/etiquetas" element={<Kanban />} />
        <Route path="/cuentas" element={<Accounts />} />
        <Route path="/cuentas/:id" element={<AccountEdit />} />
        <Route path="/apis" element={<Providers />} />
        <Route path="/prueba" element={<Playground />} />
        <Route path="/configuracion" element={<SettingsPage />} />
        <Route path="/usuarios" element={<UsersPage />} />
        <Route path="/usuario" element={<Navigate to="/usuarios" replace />} />
      </Route>
    </Routes>
  );
}

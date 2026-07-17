import { Outlet } from 'react-router-dom';
import { KimiSidebar } from './KimiSidebar';
import { NotifyStack } from '../components/NotifyStack';

export function KimiApp() {
  return (
    <div className="kx-app">
      <KimiSidebar />
      <main className="kx-view"><Outlet /></main>
      <NotifyStack />
    </div>
  );
}

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ProfileProvider } from "./components/profiles/ProfileProvider";
import App from './App';
import { WorkspaceProvider } from './chat/WorkspaceProvider';
import { ThemeProvider } from './theme/ThemeProvider';
import 'virtual:uno.css';
import './styles.css';
import { consumePairHandoff } from './chat/connection';
import { Notifications } from './components/Notifications';
import { AuthGate } from './components/AuthGate';

consumePairHandoff();
const workspace = <><WorkspaceProvider><ProfileProvider><App /></ProfileProvider></WorkspaceProvider><Notifications /></>;
// The separately built website pairs with agents; only a directly served WebUI has local password endpoints.
createRoot(document.getElementById('root')!).render(<StrictMode><ThemeProvider>{import.meta.env.MODE === 'hosted' ? workspace : <AuthGate>{workspace}</AuthGate>}</ThemeProvider></StrictMode>);

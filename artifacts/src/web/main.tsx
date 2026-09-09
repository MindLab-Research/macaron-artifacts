import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ProfileProvider } from "./components/profiles/ProfileProvider";
import App from './App';
import { WorkspaceProvider } from './chat/WorkspaceProvider';
import { ThemeProvider } from './theme/ThemeProvider';
import 'virtual:uno.css';
import './styles.css';
import { consumePairHandoff } from './chat/connection';

consumePairHandoff();
createRoot(document.getElementById('root')!).render(<StrictMode><ThemeProvider><WorkspaceProvider><ProfileProvider><App /></ProfileProvider></WorkspaceProvider></ThemeProvider></StrictMode>);

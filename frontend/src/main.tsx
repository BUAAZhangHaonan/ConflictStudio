import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './locales';
import { App } from './app/App';
import { RepositoryProvider } from './store';
import { ToastProvider } from './components';
import './styles/tokens.css';
import './styles/global.css';
import './styles/components.css';
import './styles/responsive.css';

const root = document.getElementById('root');
if (!root) throw new Error('Application root is missing.');

createRoot(root).render(
  <StrictMode>
    <RepositoryProvider>
      <BrowserRouter>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </RepositoryProvider>
  </StrictMode>,
);

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
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

const router = createBrowserRouter([{
  path: '*',
  element: (
    <ToastProvider>
      <App />
    </ToastProvider>
  ),
}]);

createRoot(root).render(
  <StrictMode>
    <RepositoryProvider>
      <RouterProvider router={router} />
    </RepositoryProvider>
  </StrictMode>,
);

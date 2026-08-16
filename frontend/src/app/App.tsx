import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '../components/AppShell';
import { StateView } from '../components';
import { FirstReviewerDialog } from './FirstReviewerDialog';

const ArchivePage = lazy(() => import('../pages/ArchivePage').then(module => ({ default: module.ArchivePage })));
const GeneratePage = lazy(() => import('../pages/GeneratePage').then(module => ({ default: module.GeneratePage })));
const NotFoundPage = lazy(() => import('../pages/NotFoundPage').then(module => ({ default: module.NotFoundPage })));
const ReviewPage = lazy(() => import('../pages/ReviewPage').then(module => ({ default: module.ReviewPage })));
const SettingsPage = lazy(() => import('../pages/SettingsPage').then(module => ({ default: module.SettingsPage })));
const StatisticsPage = lazy(() => import('../pages/StatisticsPage').then(module => ({ default: module.StatisticsPage })));
const WorkspacePage = lazy(() => import('../pages/WorkspacePage').then(module => ({ default: module.WorkspacePage })));

export function App() {
  return (
    <AppShell>
      <Suspense fallback={<StateView state="loading" />}>
        <Routes>
          <Route path="/" element={<Navigate to="/workspace" replace />} />
          <Route path="/workspace" element={<WorkspacePage />} />
          <Route path="/generate/batches" element={<GeneratePage section="batches" />} />
          <Route path="/generate/test" element={<GeneratePage section="test" />} />
          <Route path="/generate/content" element={<GeneratePage section="content" />} />
          <Route path="/generate/scenes" element={<GeneratePage section="scenes" />} />
          <Route path="/generate/template-versions" element={<GeneratePage section="templateVersions" />} />
          <Route path="/generate/jobs" element={<GeneratePage section="jobs" />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/archive" element={<ArchivePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/me/statistics" element={<StatisticsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
      <FirstReviewerDialog />
    </AppShell>
  );
}

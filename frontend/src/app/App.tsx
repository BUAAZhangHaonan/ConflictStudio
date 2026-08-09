import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from '../components/AppShell';
import { ArchivePage } from '../pages/ArchivePage';
import { GeneratePage } from '../pages/GeneratePage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { ReviewPage } from '../pages/ReviewPage';
import { SettingsPage } from '../pages/SettingsPage';
import { StatisticsPage } from '../pages/StatisticsPage';
import { WorkspacePage } from '../pages/WorkspacePage';
import { FirstReviewerDialog } from './FirstReviewerDialog';

export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<Navigate to="/workspace" replace />} />
        <Route path="/workspace" element={<WorkspacePage />} />
        <Route path="/generate/batches" element={<GeneratePage section="batches" />} />
        <Route path="/generate/test" element={<GeneratePage section="test" />} />
        <Route path="/generate/content" element={<GeneratePage section="content" />} />
        <Route path="/generate/presets" element={<GeneratePage section="presets" />} />
        <Route path="/generate/jobs" element={<GeneratePage section="jobs" />} />
        <Route path="/review" element={<ReviewPage />} />
        <Route path="/archive" element={<ArchivePage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/me/statistics" element={<StatisticsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      <FirstReviewerDialog />
    </AppShell>
  );
}

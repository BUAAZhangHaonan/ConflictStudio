import { useEffect } from 'react';
import { BatchesPage } from './generate/BatchesPage';
import { JobsPage } from './generate/JobsPage';
import { TestPage } from './generate/TestPage';
import './generate/GenerationPage.css';

type GenerateSection = 'test' | 'production' | 'results';

export function GeneratePage({ section }: { section: GenerateSection }) {
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [section]);

  return (
    <>
      {section === 'test' ? <TestPage /> : null}
      {section === 'production' ? <BatchesPage /> : null}
      {section === 'results' ? <JobsPage /> : null}
    </>
  );
}

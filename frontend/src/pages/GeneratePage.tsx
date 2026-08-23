import { useEffect } from 'react';
import { ProductionPage } from './generate/ProductionPage';
import { ResourcesPage } from './generate/ResourcesPage';
import { ResultsPage } from './generate/ResultsPage';
import { TestPage } from './generate/TestPage';
import './generate/GenerationPage.css';

type GenerateSection = 'resources' | 'test' | 'production' | 'results';

export function GeneratePage({ section }: { section: GenerateSection }) {
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [section]);

  return (
    <>
      {section === 'resources' ? <ResourcesPage /> : null}
      {section === 'test' ? <TestPage /> : null}
      {section === 'production' ? <ProductionPage /> : null}
      {section === 'results' ? <ResultsPage /> : null}
    </>
  );
}

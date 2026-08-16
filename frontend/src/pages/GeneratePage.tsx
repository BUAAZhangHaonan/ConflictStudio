import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { BatchesPage } from './generate/BatchesPage';
import { ScenesPage } from './generate/ScenesPage';
import { ContentPage } from './generate/ContentPage';
import { JobsPage } from './generate/JobsPage';
import { PromptTemplateVersionsPage } from './generate/PromptTemplateVersionsPage';
import { TestPage } from './generate/TestPage';
import { useGenerationCopy } from './generate/shared';
import './generate/GenerationPage.css';

type GenerateSection = 'batches' | 'test' | 'content' | 'scenes' | 'templateVersions' | 'jobs';

const generateSections = [
  { section: 'batches', to: '/generate/batches', label: 'generate.sectionBatches' as const },
  { section: 'test', to: '/generate/test', label: 'generate.sectionTest' as const },
  { section: 'content', to: '/generate/content', label: 'generate.sectionContent' as const },
  { section: 'scenes', to: '/generate/scenes', label: 'generate.sectionScenes' as const },
  { section: 'templateVersions', to: '/generate/template-versions', label: 'generate.sectionTemplateVersions' as const },
  { section: 'jobs', to: '/generate/jobs', label: 'generate.sectionJobs' as const },
] as const;

export function GeneratePage({ section }: { section: GenerateSection }) {
  const g = useGenerationCopy();
  const navigate = useNavigate();
  const current = generateSections.find(item => item.section === section)?.section ?? 'batches';

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [section]);

  return (
    <>
      <div className="generate-section-select">
        <label htmlFor="generate-section-select">{g('generate.sectionLabel')}</label>
        <select
          id="generate-section-select"
          value={current}
          onChange={event => {
            const next = generateSections.find(item => item.section === event.target.value)?.to;
            if (next) navigate(next);
          }}
          aria-label={g('generate.sectionAriaLabel')}
        >
          {generateSections.map(item => (
            <option key={item.section} value={item.section}>{g(item.label)}</option>
          ))}
        </select>
      </div>
      {section === 'batches' ? <BatchesPage /> : null}
      {section === 'test' ? <TestPage /> : null}
      {section === 'content' ? <ContentPage /> : null}
      {section === 'scenes' ? <ScenesPage /> : null}
      {section === 'templateVersions' ? <PromptTemplateVersionsPage /> : null}
      {section === 'jobs' ? <JobsPage /> : null}
    </>
  );
}

import { useNavigate } from 'react-router-dom';
import { BatchesPage } from './generate/BatchesPage';
import { ContentPage } from './generate/ContentPage';
import { JobsPage } from './generate/JobsPage';
import { PresetsPage } from './generate/PresetsPage';
import { TestPage } from './generate/TestPage';
import { useGenerationCopy } from './generate/shared';
import './generate/GenerationPage.css';

type GenerateSection = 'batches' | 'test' | 'content' | 'presets' | 'jobs';

const generateSections = [
  { section: 'batches', to: '/generate/batches', label: 'generate.sectionBatches' as const },
  { section: 'test', to: '/generate/test', label: 'generate.sectionTest' as const },
  { section: 'content', to: '/generate/content', label: 'generate.sectionContent' as const },
  { section: 'presets', to: '/generate/presets', label: 'generate.sectionPresets' as const },
  { section: 'jobs', to: '/generate/jobs', label: 'generate.sectionJobs' as const },
] as const;

export function GeneratePage({ section }: { section: GenerateSection }) {
  const g = useGenerationCopy();
  const navigate = useNavigate();
  const current = generateSections.find(item => item.section === section)?.section ?? 'batches';

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
      {section === 'presets' ? <PresetsPage /> : null}
      {section === 'jobs' ? <JobsPage /> : null}
    </>
  );
}

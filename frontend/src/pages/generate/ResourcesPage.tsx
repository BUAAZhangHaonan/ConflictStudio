import { GenerationScaffold } from './shared';
import { ResourceAssistantPanel } from './ResourceAssistantPanel';
import { ResourceEditors } from './TestResources';

export function ResourcesPage() {
  return <GenerationScaffold title="resources.title" subtitle="resources.subtitle">
    <ResourceAssistantPanel />
    <ResourceEditors />
  </GenerationScaffold>;
}

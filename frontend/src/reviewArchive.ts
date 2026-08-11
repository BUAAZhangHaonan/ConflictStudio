import type { ConflictDirection, Sample } from './types';

export const ARCHIVE_PAGE_SIZE = 20;

export function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / ARCHIVE_PAGE_SIZE));
}

export function clampPage(page: number, total: number): number {
  return Math.min(Math.max(1, page), pageCount(total));
}

export function pageItems<T>(items: readonly T[], page: number): T[] {
  const safePage = clampPage(page, items.length);
  const start = (safePage - 1) * ARCHIVE_PAGE_SIZE;
  return items.slice(start, start + ARCHIVE_PAGE_SIZE);
}

export function reviewLocation(displayId: string, returnTo: string): string {
  const params = new URLSearchParams({ sample: displayId, returnTo });
  return `/review?${params.toString()}`;
}

function readableModality(direction: ConflictDirection | null): 'visual' | 'audio' | 'text' | null {
  if (direction === 'Vision') return 'visual';
  if (direction === 'Audio') return 'audio';
  if (direction === 'Text') return 'text';
  return null;
}

function readableEthnicity(value: Sample['ethnicity']): string {
  if (value === 'EastAsian') return 'east asian';
  if (value === 'SouthAsian') return 'south asian';
  if (value === 'Black') return 'black';
  if (value === 'Latino') return 'latino';
  return 'white';
}

export function archiveJsonl(datasetName: string, samples: readonly Sample[]): string {
  return `${samples.map(sample => {
    const protocol = sample.category.endsWith('-VA') ? 'VA' : 'VT';
    return JSON.stringify({
      sample_id: sample.displayId,
      dataset_name: datasetName,
      category: sample.category,
      protocol,
      true_emotion_modality: readableModality(sample.conflictDirection),
      true_emotion: sample.trueEmotion,
      apparent_emotion: sample.apparentEmotion,
      true_emotion_description: sample.trueEmotionDescription,
      dialogue: sample.dialogue,
      display_text: sample.displayText,
      positive_prompt: sample.videoPrompt,
      negative_prompt: sample.negativePrompt,
      content_plan: sample.contentPlanName,
      model: sample.model,
      seed: sample.seed,
      person: {
        age: sample.age,
        gender: sample.gender === 'Female' ? 'female' : 'male',
        ethnicity: readableEthnicity(sample.ethnicity),
      },
      media: {
        primary_asset_id: sample.primaryAssetId,
      },
      updated_at: sample.updatedAt,
    });
  }).join('\n')}\n`;
}

export function archiveFileName(datasetName: string): string {
  return `${datasetName.trim().replace(/[<>:"/\\|?*\u0000-\u001F]/gu, '_')}.jsonl`;
}

export function archiveReturnTarget(value: string | null): string | null {
  if (!value) return null;
  const target = new URL(value, 'https://conflictstudio.local');
  return target.origin === 'https://conflictstudio.local' && target.pathname === '/archive'
    ? `${target.pathname}${target.search}`
    : null;
}

export function applyConflictDirectionChange(
  sample: Sample,
  conflictDirection: ConflictDirection,
  updatedAt: string,
): Sample {
  return {
    ...sample,
    conflictDirection,
    reviewDecision: 'Pending',
    reviewRevision: sample.reviewRevision + 1,
    archiveStatus: 'NeedsUpdate',
    revision: sample.revision + 1,
    updatedAt,
  };
}

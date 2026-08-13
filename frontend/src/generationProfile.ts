import type { ModelName, ModelPrecision } from './types';

export const models = ['LTX-2.3', 'LTX-2.5', 'MiniMax H3'] as const satisfies readonly ModelName[];
export const ltx25Precisions = ['BF16', 'INT8'] as const satisfies readonly ModelPrecision[];

export const defaultGenerationProfile = {
  model: 'LTX-2.5',
  precision: 'INT8',
} as const satisfies GenerationProfile;

export interface GenerationProfile {
  model: ModelName;
  precision: ModelPrecision | null;
}

export function precisionForModel(
  model: ModelName,
  current: ModelPrecision | null = null,
): ModelPrecision | null {
  return model === 'LTX-2.5' ? current ?? defaultGenerationProfile.precision : null;
}

export function buildGenerationProfile(
  model: ModelName,
  precision: ModelPrecision | null | undefined,
): GenerationProfile | null {
  if (model === 'LTX-2.5') {
    return precision && ltx25Precisions.includes(precision) ? { model, precision } : null;
  }
  return precision == null ? { model, precision: null } : null;
}

export function profileKey(profile: GenerationProfile): string {
  return profile.model === 'LTX-2.5'
    ? `${profile.model}:${profile.precision}`
    : profile.model;
}

export function comparisonEntriesAreValid(entries: readonly GenerationProfile[]): boolean {
  if (entries.length < 1 || entries.length > 2) return false;
  const profiles = entries.map(entry => buildGenerationProfile(entry.model, entry.precision));
  if (profiles.some(profile => profile === null)) return false;
  const keys = profiles.map(profile => profileKey(profile!));
  return new Set(keys).size === keys.length;
}

export function defaultTestComparisons(): GenerationProfile[] {
  return [{ ...defaultGenerationProfile }];
}

export function addSecondTestComparison(
  entries: readonly GenerationProfile[],
): GenerationProfile[] {
  if (entries.length >= 2) return [...entries];
  const precision = entries[0]?.model === 'LTX-2.5' && entries[0].precision === 'BF16'
    ? 'INT8'
    : 'BF16';
  return [...entries, { model: 'LTX-2.5', precision }];
}

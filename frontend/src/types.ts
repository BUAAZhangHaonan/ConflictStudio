export type Locale = 'zh-CN' | 'en-US';
export type Category = 'A-VA' | 'A-VT' | 'C-VA' | 'C-VT';
export type Protocol = 'VA' | 'VT';
export type ConflictDirection = 'Vision' | 'Audio' | 'Text';
export type ContentStatus = 'Draft' | 'Active' | 'Disabled';
export type ContentMode = 'Fixed' | 'Generative';
export type ModelName = 'LTX-2.3' | 'LTX-2.5' | 'MiniMax H3';
export type ModelPrecision = 'BF16' | 'INT8';

export function protocolForCategory(category: Category): Protocol {
  return category.endsWith('-VA') ? 'VA' : 'VT';
}

export function allowedDirections(category: Category): readonly ConflictDirection[] {
  if (category === 'C-VA') return ['Vision', 'Audio'];
  if (category === 'C-VT') return ['Vision', 'Text'];
  return [];
}

let nextPrototypeIdCounter = 0;

function normalizePrototypeIdPrefix(explicitPrefix: string): string {
  const normalized = explicitPrefix.trim().replace(/\s+/g, '-');
  if (!normalized) {
    throw new Error('ID prefix is required.');
  }
  return normalized;
}

export function allocatePrototypeId(explicitPrefix: string): string {
  const prefix = normalizePrototypeIdPrefix(explicitPrefix);
  const counter = nextPrototypeIdCounter++;
  return `${prefix}-${Date.now()}-${counter}`;
}

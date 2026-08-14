let nextClientIdCounter = 0;

function normalizeClientIdPrefix(explicitPrefix: string): string {
  const normalized = explicitPrefix.trim().replace(/\s+/g, '-');
  if (!normalized) {
    throw new Error('ID prefix is required.');
  }
  return normalized;
}

export function allocateClientId(explicitPrefix: string): string {
  const prefix = normalizeClientIdPrefix(explicitPrefix);
  const counter = nextClientIdCounter++;
  return `${prefix}-${Date.now()}-${counter}`;
}

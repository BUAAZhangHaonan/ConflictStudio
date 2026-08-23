const mutationProperties = Object.freeze([
  'sampleId',
  'reviewerId',
  'expectedRevision',
  'expectedReviewRevision',
  'expectedNoteDraftRevision',
  'decision',
]);

export const reviewOpenApiFixture = Object.freeze({
  ReviewCreate: Object.freeze({
    additionalProperties: false,
    properties: Object.freeze([...mutationProperties, 'queue']),
    required: Object.freeze([...mutationProperties, 'queue']),
  }),
  ReviewBatchItem: Object.freeze({
    additionalProperties: false,
    properties: mutationProperties,
    required: mutationProperties,
  }),
  ReviewBatchCreate: Object.freeze({
    additionalProperties: false,
    properties: Object.freeze(['items']),
    required: Object.freeze(['items']),
  }),
});

export function validateReviewOpenApiPayload(schemaName, payload) {
  const schema = reviewOpenApiFixture[schemaName];
  if (!schema) throw new Error(`Unknown review OpenAPI schema: ${schemaName}`);
  const value = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const keys = Object.keys(value);
  const unknown = keys.filter(key => !schema.properties.includes(key));
  const missing = schema.required.filter(key => !Object.hasOwn(value, key));
  return { valid: unknown.length === 0 && missing.length === 0, unknown, missing };
}

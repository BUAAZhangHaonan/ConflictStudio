import { useSearchParams } from 'react-router-dom';
import type { ExamplePageState } from '../types';

const allowedStates = new Set<ExamplePageState>([
  'ready',
  'loading',
  'empty',
  'filtered',
  'error',
  'conflict',
]);

export function useExamplePageState(): ExamplePageState {
  const [searchParams] = useSearchParams();
  const value = searchParams.get('state') ?? 'ready';
  return allowedStates.has(value as ExamplePageState) ? (value as ExamplePageState) : 'ready';
}

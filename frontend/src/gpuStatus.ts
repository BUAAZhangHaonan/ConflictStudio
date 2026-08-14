import type { GpuSlot } from './api/contracts';

export type GpuStatusReason =
  | 'activeJob'
  | 'external'
  | 'unknown'
  | 'reserved'
  | 'busy'
  | 'notInstalled'
  | 'notConfigured'
  | 'loaded'
  | 'ready';

export function gpuStatusReason(gpu: GpuSlot): GpuStatusReason {
  if (gpu.activeJobId !== null) return 'activeJob';
  if (gpu.availability === 'ExternalOccupied') return 'external';
  if (gpu.availability === 'Unknown') return 'unknown';
  if (gpu.availability === 'Reserved') return 'reserved';
  if (gpu.availability === 'Busy') return 'busy';
  if (gpu.serviceStatus === 'notInstalled') return 'notInstalled';
  if (gpu.serviceStatus === 'notConfigured') return 'notConfigured';
  return gpu.loadedModel ? 'loaded' : 'ready';
}

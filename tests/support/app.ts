import { createApp } from '../../server/app.js';
import { IsolatedCollector } from './collector-runner.js';

/** Explicit test import only; main.ts never imports this module or enables these routes. */
export function createTestApp(options: Parameters<typeof createApp>[0] = {}) {
  return createApp({ ...options, adapter: options.adapter ?? new IsolatedCollector(), testSupport: true });
}

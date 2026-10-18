import { Worker } from 'node:worker_threads';
import { DiscoveryCollector } from '../../server/discovery-runner.js';
import { localInterfaces } from '../../server/discovery-scope.js';
/** This module is never imported by server/main.ts or any production module. */
export class TestDiscoveryCollector extends DiscoveryCollector {
  constructor(_testMode = true, interfaces = localInterfaces, fixtureScenario = 'complete') {
    super(interfaces, (workerData, options) => new Worker(new URL('./discovery-worker.mjs', import.meta.url), {
      ...options, workerData: { ...(workerData as Record<string, unknown>), fixtureScenario },
    }), true);
  }
}

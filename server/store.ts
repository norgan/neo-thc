import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Asset, Job, Observation, ObservationInput } from '../shared/types.js';

export const MAX_OBSERVATIONS = 10_000;
export const MAX_JOBS = 200;
const realEvidence = "json_extract(payload, '$.synthetic') = 0 AND json_extract(payload, '$.source') = 'discovery-v1'";
export const isRealObservation = (value: ObservationInput): boolean => value.synthetic === false && value.source === 'discovery-v1';
export const isRealJob = (job: Job): boolean => job.synthetic !== true && !!job.spec.discovery && job.spec.scope.length === 1 && job.spec.scope[0] === 'discovery:ipv4';

/** Synchronous SQLite is deliberately limited to this small single-process demo. */
export class Store {
  private readonly db: DatabaseSync;

  constructor(path = ':memory:', private readonly realOnly = false) {
    this.db = new DatabaseSync(path, { timeout: 1_000 });
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
    if (version.user_version > 1) {
      this.db.close();
      throw new Error('Database schema is newer than this application');
    }
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS assets (' +
      'id TEXT PRIMARY KEY, subject_key TEXT NOT NULL UNIQUE, label TEXT NOT NULL, kind TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS observations (' +
      'id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id), observed_at INTEGER NOT NULL, payload TEXT NOT NULL);' +
      'CREATE INDEX IF NOT EXISTS observations_asset_time ON observations(asset_id, observed_at DESC);' +
      'CREATE TABLE IF NOT EXISTS jobs (' +
      'id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, payload TEXT NOT NULL);' +
      'PRAGMA user_version = 1;'
    );
  }

  ingest(inputs: ObservationInput[], receivedAt = Date.now()): number {
    this.db.exec('BEGIN IMMEDIATE');
    let added = 0;
    try {
      let count = this.observationCount();
      for (const input of inputs) {
        if (this.realOnly && !isRealObservation(input)) throw new Error('Non-network evidence is not accepted by the runtime');
        if (this.db.prepare('SELECT id FROM observations WHERE id = ?').get(input.id)) continue;
        if (count >= MAX_OBSERVATIONS) throw new Error('Observation capacity reached');
        // Identity is source + stable subject key. Never merge on an IP or a MAC.
        const key = input.source + '/' + input.subjectKey;
        let row = this.db.prepare('SELECT id FROM assets WHERE subject_key = ?').get(key) as { id: string } | undefined;
        if (!row) {
          row = { id: randomUUID() };
          this.db.prepare('INSERT INTO assets (id, subject_key, label, kind) VALUES (?, ?, ?, ?)')
            .run(row.id, key, input.label, input.kind);
        }
        const observation: Observation = { ...input, assetId: row.id, receivedAt };
        this.db.prepare('INSERT INTO observations (id, asset_id, observed_at, payload) VALUES (?, ?, ?, ?)')
          .run(input.id, row.id, input.observedAt, JSON.stringify(observation));
        count++;
        added++;
      }
      this.db.exec('COMMIT');
      return added;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  observationCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS count FROM observations' + (this.realOnly ? ' WHERE ' + realEvidence : '')).get() as { count: number };
    return row.count;
  }

  observations(assetId: string, limit = 100): Observation[] {
    const rows = this.db.prepare('SELECT payload FROM observations WHERE asset_id = ?' + (this.realOnly ? ' AND ' + realEvidence : '') + ' ORDER BY observed_at DESC, rowid DESC LIMIT ?')
      .all(assetId, limit) as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as Observation);
  }

  assets(now = Date.now()): Asset[] {
    const rows = this.db.prepare('SELECT * FROM assets ORDER BY label').all() as {
      id: string; subject_key: string; label: string; kind: string;
    }[];
    const assets: Asset[] = rows.map((row) => {
      const latest = this.observations(row.id, 1)[0] ?? null;
      const freshness = !latest ? 'unknown' as const
        : now - latest.observedAt > latest.ttlMs ? 'stale' as const : 'fresh' as const;
      return {
        id: row.id,
        subjectKey: row.subject_key,
        label: latest?.label ?? row.label,
        kind: latest?.kind ?? row.kind,
        identityConfidence: 'source-scoped',
        identityWarnings: [],
        freshness,
        // A stale or missing observation is not evidence of current failure.
        health: freshness === 'fresh' && latest ? latest.status : 'unknown',
        latest,
      };
    });
    // Filter before summaries and ambiguity grouping; hidden historical examples cannot leak names.
    const visible = this.realOnly ? assets.filter((asset) => asset.latest !== null) : assets;
    // Keep a bounded sample per address instead of repeatedly scanning all job-scoped candidates.
    const claims = new Map<string, { count: number; sample: Asset[] }>();
    for (const asset of visible) {
      const keys = new Set((asset.latest?.identifiers ?? [])
        .filter((item) => item.kind === 'ip' || item.kind === 'mac').map((item) => item.kind + '/' + item.value));
      for (const key of keys) {
        const group = claims.get(key) ?? { count: 0, sample: [] };
        group.count++;
        if (group.sample.length < 4) group.sample.push(asset);
        claims.set(key, group);
      }
    }
    for (const asset of visible) {
      for (const identifier of asset.latest?.identifiers ?? []) {
        if (identifier.kind !== 'ip' && identifier.kind !== 'mac') continue;
        const group = claims.get(identifier.kind + '/' + identifier.value)!;
        const peerCount = group.count - 1;
        const peers = group.sample.filter((other) => other.id !== asset.id).slice(0, 3);
        if (peerCount) {
          asset.identityWarnings.push(identifier.kind + ' ' + identifier.value +
            ' also appears on ' + peers.map((other) => other.label).join(', ') +
            (peerCount > 3 ? ' and ' + (peerCount - 3) + ' other entries' : '') +
            '; claims may be historical. Assets were not merged.');
        }
      }
    }
    return visible;
  }

  jobs(): Job[] {
    const rows = this.db.prepare('SELECT payload FROM jobs ORDER BY created_at DESC, rowid DESC').all() as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as Job).filter((job) => !this.realOnly || isRealJob(job));
  }

  job(id: string): Job | undefined {
    const row = this.db.prepare('SELECT payload FROM jobs WHERE id = ?').get(id) as { payload: string } | undefined;
    const job = row ? JSON.parse(row.payload) as Job : undefined;
    return job && (!this.realOnly || isRealJob(job)) ? job : undefined;
  }

  jobByRequest(requestId: string): Job | undefined {
    const row = this.db.prepare('SELECT payload FROM jobs WHERE request_id = ?').get(requestId) as { payload: string } | undefined;
    const job = row ? JSON.parse(row.payload) as Job : undefined;
    return job && (!this.realOnly || isRealJob(job)) ? job : undefined;
  }

  hasRequestId(requestId: string): boolean {
    return !!this.db.prepare('SELECT id FROM jobs WHERE request_id = ?').get(requestId);
  }

  saveJob(job: Job): void {
    this.db.prepare(
      'INSERT INTO jobs (id, request_id, created_at, payload) VALUES (?, ?, ?, ?) ' +
      'ON CONFLICT(id) DO UPDATE SET payload = excluded.payload'
    ).run(job.id, job.requestId, job.createdAt, JSON.stringify(job));
  }

  close(): void { this.db.close(); }
}

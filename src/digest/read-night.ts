import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DigestRow, DigestStatus, NightDigest, ReadNight } from './types.js';

interface RunEvent {
  at: string;
  job: string;
  owner: string | null;
  status: DigestStatus;
  error: string | null;
  time: number;
}

interface Aggregate {
  row: DigestRow;
  firstTime: number;
  lastTime: number;
  errorTime: number;
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

function parseEvent(line: string): RunEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (!('job' in value) || typeof value.job !== 'string' || !value.job.trim()) return null;
  if (!('owner' in value) || (value.owner !== null && typeof value.owner !== 'string')) return null;
  if (!('status' in value) || (value.status !== 'ok' && value.status !== 'retry' && value.status !== 'fail')) return null;
  if (!('at' in value) || typeof value.at !== 'string') return null;
  // Require an explicit timezone so ordering never depends on the host timezone.
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value.at)) return null;
  const time = Date.parse(value.at);
  if (!Number.isFinite(time) || !validDate(value.at.slice(0, 10))) return null;
  const error = 'error' in value ? value.error : null;
  if (error !== null && typeof error !== 'string') return null;
  return { at: value.at, job: value.job, owner: value.owner, status: value.status, error, time };
}

export const readNight: ReadNight = (runsDir, night) => {
  if (!validDate(night)) return null;
  let content: string;
  try {
    content = readFileSync(join(runsDir, `${night}.jsonl`), 'utf8');
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }

  const digest: NightDigest = { night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } };
  const jobs = new Map<string, Aggregate>();
  const lines = content === '' ? [] : content.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();

  for (const line of lines) {
    const event = parseEvent(line);
    if (!event) {
      digest.badLines += 1;
      continue;
    }
    digest.counts[event.status] += 1;
    let aggregate = jobs.get(event.job);
    if (!aggregate) {
      aggregate = {
        row: {
          job: event.job, owner: event.owner, runs: 0, retries: 0, failures: 0,
          lastStatus: event.status, lastError: null, firstAt: event.at, lastAt: event.at,
        },
        firstTime: event.time,
        lastTime: event.time,
        errorTime: -Infinity,
      };
      jobs.set(event.job, aggregate);
    }
    const row = aggregate.row;
    row.runs += 1;
    if (event.status === 'retry') row.retries += 1;
    if (event.status === 'fail') row.failures += 1;
    if (event.time < aggregate.firstTime) {
      aggregate.firstTime = event.time;
      row.firstAt = event.at;
    }
    // For equal timestamps, the later log entry supplies the final values.
    if (event.time >= aggregate.lastTime) {
      aggregate.lastTime = event.time;
      row.lastAt = event.at;
      row.lastStatus = event.status;
      row.owner = event.owner;
    }
    if (event.error?.trim() && event.time >= aggregate.errorTime) {
      aggregate.errorTime = event.time;
      row.lastError = event.error;
    }
  }

  digest.rows = Array.from(jobs.values(), aggregate => aggregate.row)
    .sort((a, b) => a.job < b.job ? -1 : a.job > b.job ? 1 : 0);
  return digest;
};

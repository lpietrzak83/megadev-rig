import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNight } from '../src/digest/read-night.js';

const temporaryDirs: string[] = [];
const night = '2026-10-28';

function temporaryNight(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'rig-digest-'));
  temporaryDirs.push(dir);
  writeFileSync(join(dir, `${night}.jsonl`), content);
  return dir;
}

function event(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ at: '2026-10-29T01:00:00+01:00', job: 'job', owner: 'rook', status: 'ok', ...overrides });
}

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readNight', () => {
  it('aggregates the real night, retaining recovered errors and null owners', () => {
    expect(readNight('runs', night)).toEqual({
      night,
      badLines: 1,
      counts: { ok: 10, retry: 4, fail: 1 },
      rows: [
        { job: 'digest/render', owner: null, runs: 1, retries: 0, failures: 0, lastStatus: 'ok', lastError: null, firstAt: '2026-10-29T05:41:09+01:00', lastAt: '2026-10-29T05:41:09+01:00' },
        { job: 'fixtures/refresh', owner: 'rook', runs: 4, retries: 3, failures: 0, lastStatus: 'ok', lastError: 'upstream 503', firstAt: '2026-10-29T01:30:00+01:00', lastAt: '2026-10-29T01:37:00+01:00' },
        { job: 'lane/sync', owner: 'rook', runs: 8, retries: 1, failures: 0, lastStatus: 'ok', lastError: 'lock held', firstAt: '2026-10-28T23:00:06+01:00', lastAt: '2026-10-29T05:00:04+01:00' },
        { job: 'notes/backup', owner: 'lane-07', runs: 1, retries: 0, failures: 1, lastStatus: 'fail', lastError: 'quota exceeded', firstAt: '2026-10-29T04:00:01+01:00', lastAt: '2026-10-29T04:00:01+01:00' },
        { job: 'rig/rotate-logs', owner: 'lane-07', runs: 1, retries: 0, failures: 0, lastStatus: 'ok', lastError: null, firstAt: '2026-10-28T23:00:02+01:00', lastAt: '2026-10-28T23:00:02+01:00' },
      ],
    });
  });

  it('distinguishes a missing night from an empty file', () => {
    const dir = temporaryNight('');
    expect(readNight(dir, '2026-10-27')).toBeNull();
    expect(readNight(dir, night)).toEqual({ night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } });
  });

  it.each(['../2026-10-28', '/2026-10-28', '2026-1-28', '2026-10-28.jsonl', '2026-02-30', '2026-13-01'])('rejects invalid night %s', invalid => {
    const dir = temporaryNight('');
    const runsDir = join(dir, 'inside');
    mkdirSync(runsDir);
    writeFileSync(join(runsDir, `${invalid}.jsonl`), event());
    expect(readNight(runsDir, invalid)).toBeNull();
  });

  it('propagates filesystem errors other than missing files', () => {
    const dir = temporaryNight('');
    mkdirSync(join(dir, '2026-10-27.jsonl'));
    expect(() => readNight(dir, '2026-10-27')).toThrow();
  });

  it('uses chronological timestamps across offsets and input order', () => {
    const dir = temporaryNight([
      event({ at: '2026-10-29T02:00:00+01:00', owner: null, status: 'ok' }),
      event({ at: '2026-10-29T00:30:00Z', owner: 'middle', status: 'fail', error: 'new error' }),
      event({ at: '2026-10-29T01:00:00+02:00', owner: 'first', status: 'retry', error: 'old error' }),
    ].join('\n'));
    expect(readNight(dir, night)?.rows).toEqual([
      { job: 'job', owner: null, runs: 3, retries: 1, failures: 1, lastStatus: 'ok', lastError: 'new error', firstAt: '2026-10-29T01:00:00+02:00', lastAt: '2026-10-29T02:00:00+01:00' },
    ]);
  });

  it('keeps the last non-empty error through absent, null and blank errors', () => {
    const dir = temporaryNight([
      event({ at: '2026-10-29T00:00:00Z', error: 'failure' }),
      event({ at: '2026-10-29T01:00:00Z', error: '' }),
      event({ at: '2026-10-29T02:00:00Z', error: null }),
      event({ at: '2026-10-29T03:00:00Z', error: '   ' }),
      event({ at: '2026-10-29T04:00:00Z' }),
    ].join('\n'));
    expect(readNight(dir, night)?.rows[0]).toMatchObject({ runs: 5, lastError: 'failure' });
  });

  it('counts malformed JSON and invalid shapes without losing valid records', () => {
    const invalid = [
      '{broken', 'null', '[]', '42', '{}',
      event({ job: null }), event({ job: '' }), event({ owner: 12 }), event({ owner: undefined }),
      event({ status: 'pending' }), event({ at: 'nonsense' }), event({ at: 0 }),
      event({ at: '2026-02-30T01:00:00Z' }), event({ at: '2026-10-28' }),
      event({ error: {} }),
    ];
    const result = readNight(temporaryNight([event(), ...invalid, event({ status: 'retry' })].join('\n')), night);
    expect(result?.badLines).toBe(15);
    expect(result?.counts).toEqual({ ok: 1, retry: 1, fail: 0 });
    expect(result?.rows[0]?.runs).toBe(2);
  });

  it('ignores one final newline but counts actual blank lines', () => {
    expect(readNight(temporaryNight(`${event()}\r\n`), night)?.badLines).toBe(0);
    expect(readNight(temporaryNight(`${event()}\n\n`), night)?.badLines).toBe(1);
    expect(readNight(temporaryNight(`\n${event()}\n`), night)?.badLines).toBe(1);
  });

  it('safely groups arbitrary names in deterministic lexical order', () => {
    const dir = temporaryNight(['toString', '__proto__', 'constructor', 'A', 'a', '__proto__'].map(job => event({ job })).join('\n'));
    const rows = readNight(dir, night)?.rows;
    expect(rows?.map(row => row.job)).toEqual(['A', '__proto__', 'a', 'constructor', 'toString']);
    expect(rows?.find(row => row.job === '__proto__')?.runs).toBe(2);
  });
});

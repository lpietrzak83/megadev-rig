import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const night = '2026-10-28';
let runsDir: string;

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'rig-digest-json-'));
});

afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
});

function app() {
  return createApp({ adapter: 'shim', installed: '2026-10-29T14:06:00+01:00', beatEverySeconds: 60, runsDir });
}

describe('GET /api/digest/:night', () => {
  it('returns the complete digest with rows sorted by job and malformed lines counted', async () => {
    writeFileSync(join(runsDir, `${night}.jsonl`), [
      JSON.stringify({ at: '2026-10-28T23:00:00+01:00', job: 'z/job', status: 'retry', owner: 'rook', error: 'upstream 503' }),
      'not json',
      JSON.stringify({ at: '2026-10-28T23:01:00+01:00', job: 'a/job', status: 'fail', owner: null, error: 'timeout' }),
      JSON.stringify({ at: '2026-10-28T23:02:00+01:00', job: 'z/job', status: 'ok', owner: null }),
      '',
    ].join('\n'));

    const res = await app().request(`/api/digest/${night}`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({
      night,
      rows: [
        { job: 'a/job', owner: null, runs: 1, retries: 0, failures: 1, lastStatus: 'fail', lastError: 'timeout', firstAt: '2026-10-28T23:01:00+01:00', lastAt: '2026-10-28T23:01:00+01:00' },
        { job: 'z/job', owner: null, runs: 2, retries: 1, failures: 0, lastStatus: 'ok', lastError: 'upstream 503', firstAt: '2026-10-28T23:00:00+01:00', lastAt: '2026-10-28T23:02:00+01:00' },
      ],
      badLines: 1,
      counts: { ok: 1, retry: 1, fail: 1 },
    });
  });

  it('returns 404 for a missing night', async () => {
    const res = await app().request(`/api/digest/${night}`);
    expect(res.status).toBe(404);
  });

  it('returns 200 with an empty digest for an existing empty night', async () => {
    writeFileSync(join(runsDir, `${night}.jsonl`), '');
    const res = await app().request(`/api/digest/${night}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } });
  });
});

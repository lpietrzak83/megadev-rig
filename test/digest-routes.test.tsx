import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import type { DigestRow, NightDigest } from '../src/digest/types.js';

const night = '2026-10-28';
const temporaryDirs: string[] = [];

function appForNight(lines: string[] = []) {
  const runsDir = mkdtempSync(join(tmpdir(), 'rig-digest-routes-'));
  temporaryDirs.push(runsDir);
  writeFileSync(join(runsDir, `${night}.jsonl`), lines.join('\n'));
  return createApp({ adapter: 'shim', installed: '2026-10-29T14:06:00+01:00', beatEverySeconds: 60, runsDir });
}

function event(job: string, status = 'ok', at = '2026-10-29T01:00:00+01:00', owner: string | null = 'rook', error?: string) {
  return JSON.stringify({ job, status, at, owner, ...(error === undefined ? {} : { error }) });
}

function textContent(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
}

function tableRows(html: string) {
  const headings = [...html.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map(match => textContent(match[1]));
  return [...html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].flatMap(match => {
    const cells = [...match[0].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(cell => textContent(cell[1]));
    if (cells.length) expect(cells).toHaveLength(headings.length);
    return cells.length ? [{ values: Object.fromEntries(headings.map((heading, index) => [heading, cells[index]])), html: match[0] }] : [];
  });
}

function displayed(row: DigestRow) {
  return {
    job: row.job, owner: row.owner ?? '—', runs: String(row.runs), retries: String(row.retries),
    failures: String(row.failures), 'last status': row.lastStatus, 'last error': row.lastError ?? '—',
    'first at': row.firstAt, 'last at': row.lastAt,
  };
}

function hasWarning(html: string) {
  return [...html.matchAll(/class=["']([^"']*)["']/g)].some(match => match[1].split(/\s+/).includes('warn'));
}

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('digest routes through the real reader', () => {
  it('serves the same sorted jobs and values to a human and an API consumer', async () => {
    const app = appForNight([
      event('zeta/retries', 'retry', '2026-10-29T01:00:00+02:00', 'rook', 'busy'),
      event('gamma/recovered', 'ok', '2026-10-29T03:00:00+01:00', 'new-owner'),
      event('beta/two-retries', 'retry'),
      event('alpha/unowned', 'ok', '2026-10-29T05:00:00+01:00', null),
      event('zeta/retries', 'retry', '2026-10-29T00:10:00Z'),
      event('gamma/recovered', 'fail', '2026-10-29T01:00:00+02:00', 'old-owner', 'quota exceeded'),
      event('beta/two-retries', 'retry', '2026-10-29T02:00:00+01:00'),
      event('zeta/retries', 'retry', '2026-10-29T02:00:00+01:00'),
    ]);
    const htmlResponse = await app.request(`/digest/${night}`);
    const apiResponse = await app.request(`/api/digest/${night}`);
    expect(htmlResponse.status).toBe(200);
    expect(apiResponse.status).toBe(200);
    expect(htmlResponse.headers.get('content-type')).toContain('text/html');
    expect(apiResponse.headers.get('content-type')).toContain('application/json');
    const digest: NightDigest = await apiResponse.json();
    expect(digest).toEqual({
      night, badLines: 0, counts: { ok: 2, retry: 5, fail: 1 },
      rows: [
        { job: 'alpha/unowned', owner: null, runs: 1, retries: 0, failures: 0, lastStatus: 'ok', lastError: null, firstAt: '2026-10-29T05:00:00+01:00', lastAt: '2026-10-29T05:00:00+01:00' },
        { job: 'beta/two-retries', owner: 'rook', runs: 2, retries: 2, failures: 0, lastStatus: 'retry', lastError: null, firstAt: '2026-10-29T01:00:00+01:00', lastAt: '2026-10-29T02:00:00+01:00' },
        { job: 'gamma/recovered', owner: 'new-owner', runs: 2, retries: 0, failures: 1, lastStatus: 'ok', lastError: 'quota exceeded', firstAt: '2026-10-29T01:00:00+02:00', lastAt: '2026-10-29T03:00:00+01:00' },
        { job: 'zeta/retries', owner: 'rook', runs: 3, retries: 3, failures: 0, lastStatus: 'retry', lastError: 'busy', firstAt: '2026-10-29T01:00:00+02:00', lastAt: '2026-10-29T02:00:00+01:00' },
      ],
    });
    const html = await htmlResponse.text();
    const rows = tableRows(html);
    expect(rows.map(row => row.values)).toEqual(digest.rows.map(displayed));
    expect(rows.map(row => hasWarning(row.html))).toEqual([false, false, true, true]);
    expect(html).not.toMatch(/<script\b/i);
  });

  it('returns 404 from both routes for a missing night', async () => {
    const app = appForNight();
    for (const path of ['/digest/2026-10-27', '/api/digest/2026-10-27']) {
      expect((await app.request(path)).status).toBe(404);
    }
  });

  it('distinguishes an empty night from a missing file for both consumers', async () => {
    const app = appForNight();
    const htmlResponse = await app.request(`/digest/${night}`);
    const apiResponse = await app.request(`/api/digest/${night}`);
    expect(htmlResponse.status).toBe(200);
    expect(apiResponse.status).toBe(200);
    const html = await htmlResponse.text();
    expect(html).toContain('nothing ran');
    expect(tableRows(html)).toEqual([]);
    expect(await apiResponse.json()).toEqual({ night, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } });
  });

  it('tolerates and counts malformed JSON while preserving surrounding valid rows', async () => {
    const app = appForNight([event('z-last'), '{bad json', event('a-first', 'fail', '2026-10-29T02:00:00+02:00', null, 'disk full')]);
    const htmlResponse = await app.request(`/digest/${night}`);
    const apiResponse = await app.request(`/api/digest/${night}`);
    expect(htmlResponse.status).toBe(200);
    expect(apiResponse.status).toBe(200);
    const digest: NightDigest = await apiResponse.json();
    expect(digest.badLines).toBe(1);
    expect(digest.counts).toEqual({ ok: 1, retry: 0, fail: 1 });
    expect(digest.rows.map(row => row.job)).toEqual(['a-first', 'z-last']);
    const html = await htmlResponse.text();
    expect(tableRows(html).map(row => row.values)).toEqual(digest.rows.map(displayed));
    expect(textContent(html)).toMatch(/bad lines\s*:?\s*1|1\s+bad line/i);
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { DigestRow, NightDigest } from '../src/digest/types.js';
import { DigestPage } from '../src/views/digest.js';

const row: DigestRow = {
  job: 'zeta', owner: null, runs: 7, retries: 3, failures: 0,
  lastStatus: 'ok', lastError: null,
  firstAt: '2026-10-28T22:00:00+02:00', lastAt: '2026-10-29T06:00:00+01:00',
};
const digest: NightDigest = {
  night: '2026-10-28', rows: [row], badLines: 2, counts: { ok: 4, retry: 3, fail: 0 },
};
const render = (data: NightDigest) => DigestPage({ digest: data }).toString();

// Protect the complete breakfast summary against omitted fields and UTC conversion.
describe('digest view', () => {
  it('shows all row fields, offsets, missing values and event totals', () => {
    const html = render(digest);
    expect(html).toContain('2026-10-28');
    expect(html).toContain('<td>zeta</td><td>—</td><td>7</td><td>3</td><td>0</td><td>ok</td><td>—</td><td>2026-10-28T22:00:00+02:00</td><td>2026-10-29T06:00:00+01:00</td>');
    expect(html).toContain('ok: 4 · retry: 3 · fail: 0');
    expect(html).toContain('bad lines: 2');
    expect(html.match(/<table/g)).toHaveLength(1);
    expect(html).not.toContain('<script');
  });

  it('sorts jobs lexically without mutating the digest and escapes log content', () => {
    const data = { ...digest, rows: [row, { ...row, job: 'alpha', owner: '<operator>', lastError: '<script>bad</script>' }] };
    const html = render(data);
    expect(html.indexOf('<td>alpha</td>')).toBeLessThan(html.indexOf('<td>zeta</td>'));
    expect(data.rows[0].job).toBe('zeta');
    expect(html).toContain('&lt;operator&gt;');
    expect(html).toContain('&lt;script&gt;bad&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it.each([
    [2, 0, false], [3, 0, true], [4, 0, true], [0, 1, true],
  ])('marks retries=%i failures=%i with warning=%s even after recovery', (retries, failures, warn) => {
    const html = render({ ...digest, rows: [{ ...row, retries, failures }] });
    const renderedRow = html.match(/<tr[^>]*><td>zeta<\/td>/)?.[0];
    expect(renderedRow).toBeDefined();
    expect(renderedRow?.includes('class="warn"')).toBe(warn);
  });

  it('says nothing ran for an empty night', () => {
    const html = render({ ...digest, rows: [], badLines: 0, counts: { ok: 0, retry: 0, fail: 0 } });
    expect(html).toContain('nothing ran');
    expect(html).not.toContain('<table');
  });
});

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const config = { adapter: 'shim', installed: '2026-10-29T14:06:00+01:00', beatEverySeconds: 60, runsDir: 'runs' };

describe('digest page route', () => {
  it('renders the real night using the shared layout and reader', async () => {
    const response = await createApp(config).request('/digest/2026-10-28');
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<header>');
    expect(html).toContain('lane-07');
    expect(html).toContain('<td>digest/render</td><td>—</td>');
    expect(html).toContain('<tr class="warn"><td>fixtures/refresh</td>');
    expect(html).toContain('<tr class="warn"><td>notes/backup</td>');
    expect(html).toContain('bad lines: 1');
    expect(html).not.toContain('<script');
  });

  it('distinguishes an empty existing night from a missing night', async () => {
    const runsDir = mkdtempSync(join(tmpdir(), 'rig-digest-page-'));
    tempDirs.push(runsDir);
    writeFileSync(join(runsDir, '2026-10-28.jsonl'), '');
    const app = createApp({ ...config, runsDir });
    const empty = await app.request('/digest/2026-10-28');
    expect(empty.status).toBe(200);
    expect(await empty.text()).toContain('nothing ran');
    const missing = await app.request('/digest/2026-10-27');
    expect(missing.status).toBe(404);
  });
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const config = { adapter: 'shim', installed: '2026-10-29T14:06:00+01:00', beatEverySeconds: 60, runsDir: 'runs' };
const tempDirs: string[] = [];

function tempRuns() {
  const dir = mkdtempSync(join(tmpdir(), 'rig-board-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('digest links on the status board', () => {
  it('links both fixture nights with raw event totals, excluding the malformed line', async () => {
    const res = await createApp(config).request('/');
    const html = await res.text();
    expect(res.status).toBe(200);
    const nights = [...html.matchAll(/<li>(.*?)<\/li>/gs)].map(match => match[1]);
    expect(nights).toEqual([
      '<a href="/digest/2026-10-28">2026-10-28</a> · ok 10 · retry 4 · fail 1',
      '<a href="/digest/2026-10-27">2026-10-27</a> · ok 7 · retry 0 · fail 0',
    ]);
  });

  it('reads the configured runs directory and shows zero counts for an empty night', async () => {
    const runsDir = tempRuns();
    writeFileSync(join(runsDir, '2026-10-30.jsonl'), '');
    const res = await createApp({ ...config, runsDir }).request('/');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('<a href="/digest/2026-10-30">2026-10-30</a> · ok 0 · retry 0 · fail 0');
    expect(html).not.toContain('/digest/2026-10-28');
  });

  it('keeps the empty-directory message without inventing a digest link', async () => {
    const res = await createApp({ ...config, runsDir: tempRuns() }).request('/');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('nothing in runs/');
    expect(html).not.toContain('href="/digest/');
  });
});

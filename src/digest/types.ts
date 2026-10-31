export type DigestStatus = 'ok' | 'retry' | 'fail';

export interface DigestRow {
  job: string;
  owner: string | null;
  runs: number;
  retries: number;
  failures: number;
  lastStatus: DigestStatus;
  lastError: string | null;
  firstAt: string;
  lastAt: string;
}

export interface NightDigest {
  night: string;
  rows: DigestRow[];
  badLines: number;
  counts: { ok: number; retry: number; fail: number };
}

export type ReadNight = (runsDir: string, night: string) => NightDigest | null;

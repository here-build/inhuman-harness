import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function assertGcExposed() {
  if (typeof globalThis.gc !== "function") {
    throw new Error(
      "Benchmarks must run with --expose-gc (e.g. `node --expose-gc benchmarks/run.mjs`) so heap baselines are deterministic.",
    );
  }
}

export async function forceGc() {
  assertGcExposed();
  globalThis.gc();
  await new Promise((resolve) => setTimeout(resolve, 0));
  globalThis.gc();
}

/**
 * Generates genuinely flat V8 string bytes (never `str.repeat()` ConsString ropes)
 * so JSON serialization, SQLite writes, and heap measurements reflect real payloads.
 */
export function flatTextOfBytes(bytes, label = "row") {
  if (bytes <= 0) return "";
  const unit = `${label}: alpha beta gamma delta epsilon zeta 0123456789abcdef\n`;
  const count = Math.max(1, Math.ceil(bytes / unit.length));
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = `${label}#${i}: alpha beta gamma delta 0123456789abcdef\n`;
  }
  return out.join("").slice(0, bytes);
}

export function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

export function summarizeSamples(samplesMs) {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const totalMs = samplesMs.reduce((acc, v) => acc + v, 0);
  const meanMs = samplesMs.length > 0 ? totalMs / samplesMs.length : 0;
  const minMs = sorted[0] ?? 0;
  const maxMs = sorted.at(-1) ?? 0;
  const p50Ms = percentile(sorted, 50);
  const p95Ms = percentile(sorted, 95);
  const p99Ms = percentile(sorted, 99);
  const opsPerSec = meanMs > 0 ? 1000 / meanMs : Infinity;
  return {
    samples: samplesMs.length,
    minMs: round3(minMs),
    p50Ms: round3(p50Ms),
    p95Ms: round3(p95Ms),
    p99Ms: round3(p99Ms),
    maxMs: round3(maxMs),
    meanMs: round3(meanMs),
    totalMs: round3(totalMs),
    opsPerSec: round2(opsPerSec),
  };
}

export async function measureTimed({ warmup = 3, iterations = 20, fn }) {
  for (let i = 0; i < warmup; i++) {
    await fn(i, true);
  }
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn(i, false);
    samples.push(performance.now() - start);
  }
  return summarizeSamples(samples);
}

export function compareAgainstFloor(floorStats, actualStats) {
  const floorBase = Math.max(floorStats.p50Ms, 0.001);
  const actualBase = Math.max(actualStats.p50Ms, 0.001);
  return {
    floorP50Ms: floorStats.p50Ms,
    actualP50Ms: actualStats.p50Ms,
    floorP95Ms: floorStats.p95Ms,
    actualP95Ms: actualStats.p95Ms,
    overheadFactor: round2(actualBase / floorBase),
    efficiencyPct: round2((floorBase / actualBase) * 100),
  };
}

export function lastWindowSlope(series, window = 15) {
  const tail = series.slice(-window);
  const n = tail.length;
  if (n < 2) return 0;
  const meanX = (n - 1) / 2;
  const meanY = tail.reduce((acc, v) => acc + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    num += dx * (tail[i] - meanY);
    den += dx * dx;
  }
  return den === 0 ? 0 : round4(num / den);
}

export function withTempDir(prefix, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  const finish = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup races
    }
  };
  try {
    const res = fn(dir);
    if (res && typeof res.then === "function") {
      return res.finally(finish);
    }
    finish();
    return res;
  } catch (err) {
    finish();
    throw err;
  }
}

export function mb(bytes) {
  return round3(bytes / (1024 * 1024));
}

export function kb(bytes) {
  return round2(bytes / 1024);
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

export function round3(n) {
  return Math.round(n * 1000) / 1000;
}

export function round4(n) {
  return Math.round(n * 10000) / 10000;
}

export function systemMetadata() {
  const cpus = os.cpus();
  return {
    node: process.version,
    v8: process.versions.v8,
    platform: `${process.platform}-${process.arch}`,
    cpuModel: cpus[0]?.model ?? "unknown",
    cpuCores: cpus.length,
    totalMemGb: round2(os.totalmem() / 1024 ** 3),
    timestamp: new Date().toISOString(),
  };
}

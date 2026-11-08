import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { tick } from './engine.js';

const port = Number(process.env.PORT ?? 3000);
const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');

const db = openDb();
const app = createApp({ db, publicBaseUrl });

// FR-008: re-evaluate the 20-day window every 5 minutes, since it opens with the calendar too.
const TICK_MS = 5 * 60_000;
let ticking = false;
const runTick = async () => {
  if (ticking) return;
  ticking = true;
  try {
    await tick({ db });
  } catch (err) {
    console.error('tick failed', err instanceof Error ? err.message : err);
  } finally {
    ticking = false;
  }
};
setInterval(runTick, TICK_MS).unref();
void runTick();

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(distDir));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

app.listen(port, () => {
  console.log(`Batchday listening on ${publicBaseUrl}`);
});

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { openDb } from './db.js';

const port = Number(process.env.PORT ?? 3000);
const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');

const app = createApp({ db: openDb(), publicBaseUrl });

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(distDir));
  app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

app.listen(port, () => {
  console.log(`Batchday listening on ${publicBaseUrl}`);
});

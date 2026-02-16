/**
 * Job API Routes
 * POST /api/jobs          - Create a new job
 * GET  /api/jobs/:id      - Get job status
 * POST /api/jobs/:id/upload - Upload files
 * POST /api/jobs/:id/run  - Execute processing
 * GET  /api/jobs/:id/result - Get results
 */

import { Hono } from 'hono';
import type { HonoEnv } from '../types/index';

const jobRoutes = new Hono<HonoEnv>();

// Create a new job
jobRoutes.post('/', async (c) => {
  const body = await c.req.json<{ year: number; month: number }>();
  const { year, month } = body;

  if (!year || !month || month < 1 || month > 12) {
    return c.json({ error: '年月を正しく指定してください' }, 400);
  }

  const db = c.env.DB;
  const jobId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const nurseryId = 'ayukko_001';

  await db.prepare(`
    INSERT INTO jobs (id, nursery_id, year, month, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).bind(jobId, nurseryId, year, month).run();

  return c.json({
    id: jobId,
    status: 'pending',
    year,
    month,
  });
});

// Get job status
jobRoutes.get('/:id', async (c) => {
  const jobId = c.req.param('id');
  const db = c.env.DB;

  const job = await db.prepare(`
    SELECT * FROM jobs WHERE id = ?
  `).bind(jobId).first();

  if (!job) {
    return c.json({ error: 'ジョブが見つかりません' }, 404);
  }

  return c.json(job);
});

// Upload files for a job
jobRoutes.post('/:id/upload', async (c) => {
  const jobId = c.req.param('id');
  const db = c.env.DB;
  const r2 = c.env.R2;

  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first();
  if (!job) {
    return c.json({ error: 'ジョブが見つかりません' }, 404);
  }

  const formData = await c.req.formData();
  const uploadedFiles: { name: string; type: string; r2Key: string; size: number }[] = [];

  for (const [key, value] of formData.entries()) {
    if (value instanceof File) {
      const r2Key = `uploads/${jobId}/${key}/${value.name}`;
      const arrayBuffer = await value.arrayBuffer();
      await r2.put(r2Key, arrayBuffer, {
        customMetadata: {
          originalName: value.name,
          uploadType: key,
          jobId,
        },
      });
      uploadedFiles.push({
        name: value.name,
        type: key,
        r2Key,
        size: arrayBuffer.byteLength,
      });
    }
  }

  // Update job with file info
  const existingFiles = job.input_files_json ? JSON.parse(job.input_files_json as string) : [];
  const allFiles = [...existingFiles, ...uploadedFiles];

  await db.prepare(`
    UPDATE jobs SET input_files_json = ? WHERE id = ?
  `).bind(JSON.stringify(allFiles), jobId).run();

  return c.json({
    uploaded: uploadedFiles.length,
    files: uploadedFiles,
    total_files: allFiles.length,
  });
});

// Execute job processing
jobRoutes.post('/:id/run', async (c) => {
  const jobId = c.req.param('id');
  const db = c.env.DB;

  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first();
  if (!job) {
    return c.json({ error: 'ジョブが見つかりません' }, 404);
  }

  if (job.status !== 'pending') {
    return c.json({ error: `ジョブは現在 ${job.status} 状態です` }, 400);
  }

  // Update status to parsing
  await db.prepare(`
    UPDATE jobs SET status = 'parsing', started_at = datetime('now'), progress_pct = 5
    WHERE id = ?
  `).bind(jobId).run();

  // TODO: Phase B/C/D - Full pipeline implementation
  // For now, return estimated time
  return c.json({
    id: jobId,
    status: 'parsing',
    message: '処理を開始しました',
    estimated_time_sec: 30,
  });
});

// Get job results
jobRoutes.get('/:id/result', async (c) => {
  const jobId = c.req.param('id');
  const db = c.env.DB;

  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first();
  if (!job) {
    return c.json({ error: 'ジョブが見つかりません' }, 404);
  }

  const outputs = await db.prepare(`
    SELECT * FROM output_files WHERE job_id = ?
  `).bind(jobId).all();

  const warnings = job.warnings_json ? JSON.parse(job.warnings_json as string) : [];

  return c.json({
    id: jobId,
    status: job.status,
    outputs: outputs.results,
    warnings,
    stats: {
      children_processed: 0,
      children_skipped: 0,
      days_processed: 0,
      total_warnings: warnings.length,
      total_errors: 0,
    },
  });
});

export default jobRoutes;

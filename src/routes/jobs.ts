/**
 * Job API Routes — v3.2
 * POST /api/jobs                - Create a new job
 * GET  /api/jobs/:id            - Get job status
 * POST /api/jobs/generate       - Direct generate (proxy to Python Generator)
 * POST /api/jobs/preview        - Quick preview (parse + match check)
 * GET  /api/jobs/:id/result     - Get results
 */

import { Hono } from 'hono';
import type { HonoEnv } from '../types/index';

const GENERATOR_URL = 'http://127.0.0.1:8787';

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

  return c.json({ id: jobId, status: 'pending', year, month });
});

// Get job status
jobRoutes.get('/:id', async (c) => {
  const jobId = c.req.param('id');
  const db = c.env.DB;
  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first();
  if (!job) return c.json({ error: 'ジョブが見つかりません' }, 404);
  return c.json(job);
});

// Proxy generate request to Python Generator
jobRoutes.post('/generate', async (c) => {
  try {
    const formData = await c.req.formData();
    const pyFormData = new FormData();

    for (const [key, value] of formData.entries()) {
      if (value instanceof File) {
        pyFormData.append(key, value);
      } else {
        pyFormData.append(key, value);
      }
    }

    const response = await fetch(`${GENERATOR_URL}/generate`, {
      method: 'POST',
      body: pyFormData,
    });

    // Handle fatal corruption (422)
    if (response.status === 422) {
      const errorData = await response.json() as Record<string, unknown>;
      return c.json({
        error: errorData.error || 'テンプレート破損検出',
        fatal: true,
        warnings: errorData.warnings || [],
        stats: errorData.stats || {},
        submission_report: errorData.submission_report || null,
      }, 422);
    }

    if (!response.ok) {
      const errorData = await response.json() as Record<string, unknown>;
      return c.json({
        error: errorData.error || 'Generation failed',
        warnings: errorData.warnings || [],
        stats: errorData.stats || {},
      }, 500);
    }

    // Return the ZIP response with meta headers
    const zipBlob = await response.blob();
    const metaJson = response.headers.get('X-Meta-Json') || '{}';

    return new Response(zipBlob, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': response.headers.get('Content-Disposition') ||
          'attachment; filename="output.zip"',
        'X-Warnings-Count': response.headers.get('X-Warnings-Count') || '0',
        'X-Children-Processed': response.headers.get('X-Children-Processed') || '0',
        'X-Meta-Json': metaJson,
      },
    });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({
      error: `Generator接続エラー: ${message}`,
      suggestion: 'Python Generator APIが起動しているか確認してください (port 8787)',
    }, 502);
  }
});

// Preview endpoint (quick parse + matching check, no generation)
jobRoutes.post('/preview', async (c) => {
  try {
    const formData = await c.req.formData();
    const pyFormData = new FormData();

    for (const [key, value] of formData.entries()) {
      pyFormData.append(key, value instanceof File ? value : value);
    }

    const response = await fetch(`${GENERATOR_URL}/preview`, {
      method: 'POST',
      body: pyFormData,
    });

    const data = await response.json();
    return c.json(data, response.status);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: `Preview接続エラー: ${message}` }, 502);
  }
});

// Get job results
jobRoutes.get('/:id/result', async (c) => {
  const jobId = c.req.param('id');
  const db = c.env.DB;

  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first();
  if (!job) return c.json({ error: 'ジョブが見つかりません' }, 404);

  const outputs = await db.prepare('SELECT * FROM output_files WHERE job_id = ?').bind(jobId).all();
  const warnings = job.warnings_json ? JSON.parse(job.warnings_json as string) : [];

  return c.json({
    id: jobId,
    status: job.status,
    outputs: outputs.results,
    warnings,
  });
});

export default jobRoutes;

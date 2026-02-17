/**
 * Job API Routes — v3.3
 * POST /api/jobs                - Create a new job
 * GET  /api/jobs/:id            - Get job status
 * POST /api/jobs/generate       - Direct generate (proxy to Python Generator)
 * POST /api/jobs/preview        - Quick preview (parse + match check)
 * GET  /api/jobs/:id/result     - Get results
 *
 * v3.3: Generator URL 環境変数化, yearバウンダリ, JSON parse安全化, エラーレスポンス統一
 */

import { Hono } from 'hono';
import type { HonoEnv } from '../types/index';

// Generator URL: configurable via environment variable, fallback to local
const DEFAULT_GENERATOR_URL = 'http://127.0.0.1:8787';

function getGeneratorUrl(env?: Record<string, unknown>): string {
  return (env as any)?.GENERATOR_URL || DEFAULT_GENERATOR_URL;
}

/** Standardized error response helper */
function errorJson(c: any, status: number, error: string, detail?: string, suggestion?: string) {
  return c.json({
    error,
    ...(detail && { detail }),
    ...(suggestion && { suggestion }),
  }, status);
}

const jobRoutes = new Hono<HonoEnv>();

// Create a new job
jobRoutes.post('/', async (c) => {
  let body: { year: number; month: number };
  try {
    body = await c.req.json<{ year: number; month: number }>();
  } catch {
    return errorJson(c, 400, 'リクエストのJSONが不正です');
  }
  const year = Number(body.year);
  const month = Number(body.month);

  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return errorJson(c, 400, '年を正しく指定してください (2000-2100)');
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return errorJson(c, 400, '月を正しく指定してください (1-12)');
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
  if (!job) return errorJson(c, 404, 'ジョブが見つかりません');
  return c.json(job);
});

// Dashboard endpoint (proxy to Python Generator)
jobRoutes.post('/dashboard', async (c) => {
  const generatorUrl = getGeneratorUrl(c.env);
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

    const response = await fetch(`${generatorUrl}/dashboard`, {
      method: 'POST',
      body: pyFormData,
    });

    let data;
    try {
      data = await response.json();
    } catch {
      return errorJson(c, 502, 'Generatorからのレスポンスを解析できませんでした',
        undefined, 'Python Generatorが正常に動作しているか確認してください (port 8787)');
    }
    return c.json(data, response.status);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const isConnectionRefused = message.includes('ECONNREFUSED') || message.includes('fetch failed');
    return errorJson(c, 502, `Dashboard接続エラー: ${message}`,
      undefined,
      isConnectionRefused
        ? 'Python Generator APIが起動していない可能性があります (port 8787)'
        : 'ネットワーク接続を確認してください');
  }
});

// Proxy generate request to Python Generator
jobRoutes.post('/generate', async (c) => {
  const generatorUrl = getGeneratorUrl(c.env);
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

    const response = await fetch(`${generatorUrl}/generate`, {
      method: 'POST',
      body: pyFormData,
    });

    // Handle fatal corruption (422)
    if (response.status === 422) {
      let errorData: Record<string, unknown>;
      try {
        errorData = await response.json() as Record<string, unknown>;
      } catch {
        errorData = { error: 'テンプレート破損検出（詳細取得失敗）' };
      }
      return c.json({
        error: errorData.error || 'テンプレート破損検出',
        fatal: true,
        warnings: errorData.warnings || [],
        stats: errorData.stats || {},
        submission_report: errorData.submission_report || null,
      }, 422);
    }

    if (!response.ok) {
      let errorData: Record<string, unknown>;
      try {
        errorData = await response.json() as Record<string, unknown>;
      } catch {
        errorData = { error: `Generatorエラー (HTTP ${response.status})` };
      }
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
    const isConnectionRefused = message.includes('ECONNREFUSED') || message.includes('fetch failed');
    return errorJson(c, 502, `Generator接続エラー: ${message}`,
      undefined,
      isConnectionRefused
        ? 'Python Generator APIが起動しているか確認してください (port 8787)'
        : 'ネットワーク接続を確認してください');
  }
});

// Preview endpoint (quick parse + matching check, no generation)
jobRoutes.post('/preview', async (c) => {
  const generatorUrl = getGeneratorUrl(c.env);
  try {
    const formData = await c.req.formData();
    const pyFormData = new FormData();

    for (const [key, value] of formData.entries()) {
      pyFormData.append(key, value instanceof File ? value : value);
    }

    const response = await fetch(`${generatorUrl}/preview`, {
      method: 'POST',
      body: pyFormData,
    });

    let data;
    try {
      data = await response.json();
    } catch {
      return errorJson(c, 502, 'Generatorからのレスポンスを解析できませんでした',
        undefined, 'Python Generatorが正常に動作しているか確認してください (port 8787)');
    }
    return c.json(data, response.status);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return errorJson(c, 502, `Preview接続エラー: ${message}`);
  }
});

// Get job results
jobRoutes.get('/:id/result', async (c) => {
  const jobId = c.req.param('id');
  const db = c.env.DB;

  const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first();
  if (!job) return errorJson(c, 404, 'ジョブが見つかりません');

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

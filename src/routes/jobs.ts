/**
 * Job API Routes — v3.4
 * POST /api/jobs                - Create a new job
 * GET  /api/jobs/:id            - Get job status
 * POST /api/jobs/generate       - Direct generate (proxy to Python Generator)
 * POST /api/jobs/preview        - Quick preview (parse + match check)
 * GET  /api/jobs/:id/result     - Get results
 *
 * v3.4: dashboard ロジックを dashboard-builder.ts に統合、重複コード解消
 */

import { Hono } from 'hono';
import type { HonoEnv } from '../types/index';
import { buildDashboardFromFormData } from '../lib/dashboard-builder';

// Generator URL: configurable via environment variable, fallback to local
// TODO: 要確認 — 本番環境では GENERATOR_URL 環境変数が必要。127.0.0.1 は Workers から到達不可
const DEFAULT_GENERATOR_URL = 'http://127.0.0.1:8787';

function getGeneratorUrl(env?: Record<string, unknown>): string {
  return (env as Record<string, string | undefined>)?.GENERATOR_URL || DEFAULT_GENERATOR_URL;
}

/** Standardized error response helper */
function errorJson(c: { json: (data: Record<string, unknown>, status: number) => Response }, status: number, error: string, detail?: string, suggestion?: string) {
  return c.json({
    error,
    ...(detail && { detail }),
    ...(suggestion && { suggestion }),
  }, status);
}

const jobRoutes = new Hono<HonoEnv>();

// Create a new job
jobRoutes.post('/', async (c) => {
  try {
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
    // TODO: 要確認 — nursery_id はハードコード。マルチテナント時に環境変数化が必要
    const nurseryId = 'ayukko_001';

    await db.prepare(`
      INSERT INTO jobs (id, nursery_id, year, month, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).bind(jobId, nurseryId, year, month).run();

    return c.json({ id: jobId, status: 'pending', year, month });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('Job create error:', message);
    return errorJson(c, 500, 'ジョブ作成エラー');
  }
});

// Get job status
jobRoutes.get('/:id', async (c) => {
  try {
    const jobId = c.req.param('id');
    const db = c.env.DB;
    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first();
    if (!job) return errorJson(c, 404, 'ジョブが見つかりません');
    return c.json(job);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('Job get error:', message);
    return errorJson(c, 500, 'ジョブ取得エラー');
  }
});

// Dashboard endpoint — 互換レイヤー: 古い app.js が /api/jobs/dashboard を呼ぶ場合
// dashboard-builder.ts の共通関数を使用
jobRoutes.post('/dashboard', async (c) => {
  try {
    const formData = await c.req.formData();
    const year = parseInt(formData.get('year') as string, 10);
    const month = parseInt(formData.get('month') as string, 10);

    if (isNaN(year) || year < 2000 || year > 2100) {
      return c.json({ error: `年が範囲外です: ${year}` }, 400);
    }
    if (isNaN(month) || month < 1 || month > 12) {
      return c.json({ error: `月が範囲外です: ${month}` }, 400);
    }

    const result = await buildDashboardFromFormData({ formData, year, month });
    return c.json(result);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('Jobs/dashboard error:', message);
    return c.json({ error: message || 'ダッシュボード生成エラー', warnings: [] }, 500);
  }
});

// Generate endpoint — 提出物ZIP生成
// 本番(Cloudflare Pages)ではPython Generatorが使えないため、
// サンドボックス環境のみPythonプロキシ、本番は未対応メッセージを返す
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
    // 本番環境ではPython Generatorが動かないため、明確なメッセージを返す
    const isConnectionError = message.includes('ECONNREFUSED') || message.includes('fetch failed') || message.includes('connect');
    if (isConnectionError) {
      return c.json({
        error: '提出物生成は現在サンドボックス環境でのみ利用可能です',
        detail: 'Cloudflare Pages本番環境ではPython Generatorが動作しません。サンドボックス環境からご利用ください。',
        suggestion: 'ダッシュボード表示機能は本番環境でもご利用いただけます。',
        warnings: [],
        stats: {},
      }, 503);
    }
    return errorJson(c, 502, `Generator接続エラー: ${message}`,
      undefined, 'ネットワーク接続を確認してください');
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
  try {
    const jobId = c.req.param('id');
    const db = c.env.DB;

    const job = await db.prepare('SELECT * FROM jobs WHERE id = ?').bind(jobId).first();
    if (!job) return errorJson(c, 404, 'ジョブが見つかりません');

    const outputs = await db.prepare('SELECT * FROM output_files WHERE job_id = ?').bind(jobId).all();

    // ⚠️ 懸念点: warnings_json の JSON パースが失敗する可能性
    let warnings: unknown[] = [];
    if (job.warnings_json) {
      try {
        warnings = JSON.parse(job.warnings_json as string);
      } catch {
        console.error(`Job ${jobId}: warnings_json の JSON パースに失敗しました`);
        warnings = [{ level: 'error', message: '警告データの読み込みに失敗しました' }];
      }
    }

    return c.json({
      id: jobId,
      status: job.status,
      outputs: outputs.results,
      warnings,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('Job result error:', message);
    return errorJson(c, 500, 'ジョブ結果取得エラー');
  }
});

export default jobRoutes;

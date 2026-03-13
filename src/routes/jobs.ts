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

// Dashboard endpoint — 互換レイヤー: 古い app.js が /api/jobs/dashboard を呼ぶ場合、
// TypeScript の /api/upload/dashboard に内部転送する
jobRoutes.post('/dashboard', async (c) => {
  try {
    // 新しい TypeScript パーサーで直接処理
    const { parseLukumi, parseSchedule, matchChildren, computeUsageFacts, normalizeName } = await import('../lib/excel-parser');
    const formData = await c.req.formData();
    const year = parseInt(formData.get('year') as string);
    const month = parseInt(formData.get('month') as string);

    if (isNaN(year) || year < 2000 || year > 2100) {
      return c.json({ error: `年が範囲外です: ${year}` }, 400);
    }
    if (isNaN(month) || month < 1 || month > 12) {
      return c.json({ error: `月が範囲外です: ${month}` }, 400);
    }

    const warnings: any[] = [];
    let attendance: any[] = [];
    let lukumiChildren: any[] = [];
    const lukumiFile = formData.get('lukumi_file') as File | null;
    if (lukumiFile && lukumiFile.size > 0) {
      const buf = await lukumiFile.arrayBuffer();
      const result = parseLukumi(buf, lukumiFile.name, year, month);
      attendance = result.attendance;
      lukumiChildren = result.children;
      warnings.push(...result.warnings);
    }

    const allPlans = new Map<string, Record<number, any>>();
    const scheduleChildNames: string[] = [];
    const scheduleFiles = formData.getAll('schedule_files') as File[];
    for (const sf of scheduleFiles) {
      if (!sf || sf.size === 0) continue;
      const buf = await sf.arrayBuffer();
      const result = parseSchedule(buf, sf.name, year, month);
      warnings.push(...result.warnings);
      for (const { plans, childName } of result.results) {
        if (childName) {
          scheduleChildNames.push(childName);
          allPlans.set(childName, plans);
        }
      }
    }

    let { children, warnings: matchWarnings, unmatched } = matchChildren(lukumiChildren, scheduleChildNames);
    warnings.push(...matchWarnings);

    const isScheduleOnly = lukumiChildren.length === 0;
    if (isScheduleOnly && scheduleChildNames.length > 0) {
      children = scheduleChildNames.map(sname => {
        const normName = normalizeName(sname);
        return {
          id: `sched_${normName.replace(/ /g, '_')}`, lukumi_id: `sched_${normName.replace(/ /g, '_')}`,
          name: normName, name_norm: normName, name_kana: null, age_class: null,
          enrollment_type: '月極', birth_date: null, class_name: '', has_schedule: true,
          schedule_file: sname, is_allergy: 0, child_order: 1,
        };
      });
      warnings.push({ level: 'info', child_name: null,
        message: `ルクミーデータなし — 予定表から${children.length}名の園児を検出しました（予定プレビューモード）`,
        suggestion: '実績データを表示するにはルクミー登降園データもアップロードしてください',
      });
    }

    const usageFacts = computeUsageFacts(children, allPlans, attendance, year, month);
    const daysInMonth = new Date(year, month, 0).getDate();
    const weekdaysJp = ['日', '月', '火', '水', '木', '金', '土'];

    const dailySummary = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const dayFacts = usageFacts.filter((f: any) => f.day === day && ['present', 'late_arrive', 'early_leave'].includes(f.attendance_status));
      const planOnly = usageFacts.filter((f: any) => f.day === day && f.attendance_status === 'absent' && f.planned_start);
      const allDayFacts = [...dayFacts, ...planOnly];
      const childrenDetail = allDayFacts.map((f: any) => {
        const childInfo: any = children.find((c: any) => c.lukumi_id === f.child_id) || {};
        let status = f.attendance_status;
        if (isScheduleOnly && status === 'absent') status = 'planned';
        return {
          name: f.child_name, child_id: f.child_id, class_name: childInfo.class_name || '',
          age_class: childInfo.age_class ?? null, birth_date: childInfo.birth_date || null,
          planned_start: f.planned_start, planned_end: f.planned_end,
          actual_checkin: f.actual_checkin, actual_checkout: f.actual_checkout,
          billing_start: f.billing_start, billing_end: f.billing_end,
          billing_minutes: f.billing_minutes, status,
          enrollment_type: childInfo.enrollment_type || '月極',
          has_breakfast: f.has_breakfast, has_lunch: f.has_lunch,
          has_am_snack: f.has_am_snack, has_pm_snack: f.has_pm_snack,
          has_dinner: f.has_dinner, is_early_morning: f.is_early_morning,
          is_extension: f.is_extension, is_night: f.is_night,
          is_sick: f.is_sick, exception_notes: f.exception_notes,
        };
      });
      const d = new Date(year, month - 1, day);
      const countBase = isScheduleOnly ? allDayFacts : dayFacts;
      const ageCounts: Record<number, number> = {};
      let tempCount = 0;
      for (const cd of childrenDetail) {
        if (cd.enrollment_type === '一時') tempCount++;
        else if (cd.age_class != null) ageCounts[cd.age_class] = (ageCounts[cd.age_class] || 0) + 1;
      }
      dailySummary.push({
        day, weekday: weekdaysJp[d.getDay()], is_weekend: d.getDay() === 0 || d.getDay() === 6,
        total_children: countBase.length, planned_absent: isScheduleOnly ? 0 : planOnly.length,
        total_with_plans: allDayFacts.length, is_schedule_only: isScheduleOnly,
        age_0_count: ageCounts[0] || 0, age_1_count: ageCounts[1] || 0, age_2_count: ageCounts[2] || 0,
        age_3_count: ageCounts[3] || 0, age_4_count: ageCounts[4] || 0, age_5_count: ageCounts[5] || 0,
        temp_count: tempCount,
        breakfast_count: countBase.filter((f: any) => f.has_breakfast).length,
        lunch_count: countBase.filter((f: any) => f.has_lunch).length,
        am_snack_count: countBase.filter((f: any) => f.has_am_snack).length,
        pm_snack_count: countBase.filter((f: any) => f.has_pm_snack).length,
        dinner_count: countBase.filter((f: any) => f.has_dinner).length,
        early_morning_count: countBase.filter((f: any) => f.is_early_morning).length,
        extension_count: countBase.filter((f: any) => f.is_extension).length,
        night_count: countBase.filter((f: any) => f.is_night).length,
        sick_count: countBase.filter((f: any) => f.is_sick).length,
        children: childrenDetail,
      });
    }

    const childrenSummary = children.map((ch: any) => {
      const cFacts = usageFacts.filter((f: any) => f.child_id === ch.lukumi_id && ['present', 'late_arrive', 'early_leave'].includes(f.attendance_status));
      const cPlanDays = usageFacts.filter((f: any) => f.child_id === ch.lukumi_id && f.planned_start);
      return { name: ch.name, child_id: ch.lukumi_id, class_name: ch.class_name || '',
        age_class: ch.age_class, birth_date: ch.birth_date, enrollment_type: ch.enrollment_type,
        has_schedule: ch.has_schedule, attendance_days: cFacts.length, planned_days: cPlanDays.length,
      };
    });

    return c.json({
      year, month, days_in_month: daysInMonth, total_children: children.length,
      is_schedule_only: isScheduleOnly, daily_summary: dailySummary, children_summary: childrenSummary,
      submission_report: {
        submitted: children.filter((ch: any) => ch.has_schedule).map((ch: any) => ({ name: ch.name, lukumi_id: ch.lukumi_id })),
        not_submitted: children.filter((ch: any) => !ch.has_schedule).map((ch: any) => ({ name: ch.name, lukumi_id: ch.lukumi_id, reason: '利用予定表が未提出です' })),
        unmatched_schedules: unmatched.map((s: string) => ({ schedule_name: s, reason: 'ルクミー登降園データに該当する園児なし' })),
        summary: { total_children: children.length, submitted: children.filter((ch: any) => ch.has_schedule).length,
          not_submitted: children.filter((ch: any) => !ch.has_schedule).length, unmatched: unmatched.length },
      },
      warnings,
    });
  } catch (e: any) {
    console.error('Jobs/dashboard error:', e);
    return c.json({ error: e.message || 'ダッシュボード生成エラー', warnings: [] }, 500);
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

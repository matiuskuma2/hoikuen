/**
 * Schedule Plans API Routes — v1.0
 *
 * GET    /api/schedules?year=&month=         - List all plans for a month
 * GET    /api/schedules/:childId?year=&month= - List plans for one child
 * POST   /api/schedules                       - Upsert schedule plans (bulk)
 * DELETE /api/schedules/:childId?year=&month= - Delete all plans for a child/month
 * 
 * POST   /api/schedules/dashboard?year=&month= - Get dashboard data from DB schedules
 */

import { Hono } from 'hono';
import { DEFAULT_NURSERY_ID, type HonoEnv } from '../types/index';
import { toMinutes, safeToMinutes, TIME_BOUNDARIES } from '../types/index';
import { getAgeClassFromBirthDate, getFiscalYear, ageClassToLabel } from '../lib/age-class';

const scheduleRoutes = new Hono<HonoEnv>();

// ── List all schedule plans for a month ──
scheduleRoutes.get('/', async (c) => {
  try {
    const year = parseInt(c.req.query('year') || '0', 10);
    const month = parseInt(c.req.query('month') || '0', 10);

    if (isNaN(year) || year < 2000 || year > 2100) {
      return c.json({ error: 'year を正しく指定してください (2000-2100)' }, 400);
    }
    if (isNaN(month) || month < 1 || month > 12) {
      return c.json({ error: 'month を正しく指定してください (1-12)' }, 400);
    }

    const db = c.env.DB;
    if (!db) return c.json({ error: 'データベース接続が利用できません' }, 500);

    const result = await db.prepare(`
      SELECT sp.*, c.name, c.birth_date, c.age_class, c.enrollment_type
      FROM schedule_plans sp
      JOIN children c ON sp.child_id = c.id
      WHERE sp.year = ? AND sp.month = ?
      ORDER BY sp.day ASC, c.name ASC
    `).bind(year, month).all();

    return c.json({
      plans: result.results,
      year,
      month,
      total: result.results.length,
    });
  } catch (e: any) {
    console.error('Schedules list error:', e);
    return c.json({ error: e.message || 'スケジュール一覧取得エラー' }, 500);
  }
});

// ── List plans for a single child in a month ──
scheduleRoutes.get('/:childId', async (c) => {
  try {
    const childId = c.req.param('childId');
    const year = parseInt(c.req.query('year') || '0', 10);
    const month = parseInt(c.req.query('month') || '0', 10);

    if (isNaN(year) || year < 2000 || year > 2100) {
      return c.json({ error: 'year を正しく指定してください (2000-2100)' }, 400);
    }
    if (isNaN(month) || month < 1 || month > 12) {
      return c.json({ error: 'month を正しく指定してください (1-12)' }, 400);
    }

    const db = c.env.DB;
    if (!db) return c.json({ error: 'データベース接続が利用できません' }, 500);

    const result = await db.prepare(`
      SELECT * FROM schedule_plans
      WHERE child_id = ? AND year = ? AND month = ?
      ORDER BY day ASC
    `).bind(childId, year, month).all();

    return c.json({
      plans: result.results,
      child_id: childId,
      year,
      month,
    });
  } catch (e: any) {
    console.error('Schedules child list error:', e);
    return c.json({ error: e.message || 'スケジュール取得エラー' }, 500);
  }
});

// ── Upsert schedule plans (bulk) ──
// Body: { child_id, year, month, days: [{ day, planned_start, planned_end, lunch_flag, am_snack_flag, pm_snack_flag, dinner_flag }] }
scheduleRoutes.post('/', async (c) => {
  try {
    let body: {
      child_id: string;
      year: number;
      month: number;
      days: Array<{
        day: number;
        planned_start?: string | null;
        planned_end?: string | null;
        lunch_flag?: number;
        am_snack_flag?: number;
        pm_snack_flag?: number;
        dinner_flag?: number;
      }>;
    };

    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'リクエストのJSONが不正です' }, 400);
    }

    if (!body.child_id || !body.year || !body.month || !Array.isArray(body.days)) {
      return c.json({ error: 'child_id, year, month, days[] が必要です' }, 400);
    }

    const db = c.env.DB;
    if (!db) return c.json({ error: 'データベース接続が利用できません' }, 500);

    // Verify child exists
    const child = await db.prepare('SELECT id FROM children WHERE id = ?').bind(body.child_id).first();
    if (!child) {
      return c.json({ error: '園児が見つかりません' }, 404);
    }

    let upserted = 0;
    let deleted = 0;

    for (const dayData of body.days) {
      const { day, planned_start, planned_end, lunch_flag, am_snack_flag, pm_snack_flag, dinner_flag } = dayData;
      
      if (!day || day < 1 || day > 31) continue;

      // If no start/end time, delete this plan entry (child is not coming this day)
      if (!planned_start && !planned_end) {
        await db.prepare(`
          DELETE FROM schedule_plans 
          WHERE child_id = ? AND year = ? AND month = ? AND day = ?
        `).bind(body.child_id, body.year, body.month, day).run();
        deleted++;
        continue;
      }

      const planId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);

      await db.prepare(`
        INSERT INTO schedule_plans (id, child_id, year, month, day, planned_start, planned_end, lunch_flag, am_snack_flag, pm_snack_flag, dinner_flag, source_file)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'UI入力')
        ON CONFLICT(child_id, year, month, day) DO UPDATE SET
          planned_start = excluded.planned_start,
          planned_end = excluded.planned_end,
          lunch_flag = excluded.lunch_flag,
          am_snack_flag = excluded.am_snack_flag,
          pm_snack_flag = excluded.pm_snack_flag,
          dinner_flag = excluded.dinner_flag,
          source_file = 'UI入力'
      `).bind(
        planId, body.child_id, body.year, body.month, day,
        planned_start || null, planned_end || null,
        lunch_flag ?? 0, am_snack_flag ?? 0, pm_snack_flag ?? 0, dinner_flag ?? 0
      ).run();
      upserted++;
    }

    return c.json({ message: '予定を保存しました', upserted, deleted });
  } catch (e: any) {
    console.error('Schedules upsert error:', e);
    return c.json({ error: e.message || '予定保存エラー' }, 500);
  }
});

// ── Delete all schedule plans for a child/month ──
scheduleRoutes.delete('/:childId', async (c) => {
  try {
    const childId = c.req.param('childId');
    const year = parseInt(c.req.query('year') || '0', 10);
    const month = parseInt(c.req.query('month') || '0', 10);

    if (isNaN(year) || year < 2000 || year > 2100) {
      return c.json({ error: 'year を正しく指定してください (2000-2100)' }, 400);
    }
    if (isNaN(month) || month < 1 || month > 12) {
      return c.json({ error: 'month を正しく指定してください (1-12)' }, 400);
    }

    const db = c.env.DB;
    if (!db) return c.json({ error: 'データベース接続が利用できません' }, 500);

    await db.prepare(`
      DELETE FROM schedule_plans
      WHERE child_id = ? AND year = ? AND month = ?
    `).bind(childId, year, month).run();

    return c.json({ message: '予定を削除しました', child_id: childId, year, month });
  } catch (e: any) {
    console.error('Schedules delete error:', e);
    return c.json({ error: e.message || '予定削除エラー' }, 500);
  }
});

// ── Dashboard from DB schedule data ──
// Returns structured data for dashboard display (日別登園人数・食数 etc.)
scheduleRoutes.post('/dashboard', async (c) => {
  let body: { year: number; month: number };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'リクエストのJSONが不正です' }, 400);
  }

  const { year, month } = body;
  if (!year || !month) {
    return c.json({ error: 'year と month を指定してください' }, 400);
  }

  try {
  const db = c.env.DB;
  if (!db) {
    return c.json({ error: 'データベース接続が利用できません。D1バインディングを確認してください。' }, 500);
  }
  const fiscalYear = getFiscalYear(year, month);

  // Get all children
  const childrenResult = await db.prepare(`
    SELECT * FROM children WHERE nursery_id = ?
    ORDER BY 
      CASE enrollment_type WHEN '月極' THEN 0 ELSE 1 END,
      age_class ASC, birth_date ASC, name ASC
  `).bind(DEFAULT_NURSERY_ID).all();
  const children = childrenResult.results as Record<string, unknown>[];

  // Get all schedules for this month
  const schedulesResult = await db.prepare(`
    SELECT sp.*, c.name, c.birth_date, c.age_class, c.enrollment_type, c.lukumi_id
    FROM schedule_plans sp
    JOIN children c ON sp.child_id = c.id
    WHERE sp.year = ? AND sp.month = ?
    ORDER BY sp.day ASC
  `).bind(year, month).all();
  const schedules = schedulesResult.results as Record<string, unknown>[];

  // Build day → children map
  const daysInMonth = new Date(year, month, 0).getDate();
  const weekdayNames = ['日', '月', '火', '水', '木', '金', '土'];
  
  const dailySummary: Record<string, unknown>[] = [];

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month - 1, day);
    const dow = date.getDay();
    const weekday = weekdayNames[dow];
    const isWeekend = dow === 0 || dow === 6;

    const daySchedules = schedules.filter((s) => s.day === day);

    let totalChildren = 0;
    let lunchCount = 0;
    let amSnackCount = 0;
    let pmSnackCount = 0;
    let dinnerCount = 0;
    let earlyMorningCount = 0;
    let extensionCount = 0;
    let nightCount = 0;
    let sickCount = 0;
    let age0 = 0, age1 = 0, age2 = 0, age3 = 0, age4 = 0, age5 = 0, tempCount = 0;

    const dayChildren: Record<string, unknown>[] = [];

    for (const s of daySchedules) {
      if (!s.planned_start && !s.planned_end) continue;

      totalChildren++;

      const ageClass = s.age_class as number | null;
      const enrollType = s.enrollment_type as string;

      if (enrollType === '一時') { tempCount++; }
      else if (ageClass === 0) age0++;
      else if (ageClass === 1) age1++;
      else if (ageClass === 2) age2++;
      else if (ageClass === 3) age3++;
      else if (ageClass === 4) age4++;
      else if (ageClass === 5) age5++;

      if (s.lunch_flag) lunchCount++;
      if (s.am_snack_flag) amSnackCount++;
      if (s.pm_snack_flag) pmSnackCount++;
      if (s.dinner_flag) dinnerCount++;

      // Check time zones — TIME_BOUNDARIES 定数を使用（全モジュール統一）
      const startMin = safeToMinutes(s.planned_start as string);
      const endMin = safeToMinutes(s.planned_end as string);
      if (startMin !== null && startMin < TIME_BOUNDARIES.early_end) earlyMorningCount++;
      if (endMin !== null && endMin > TIME_BOUNDARIES.extension_start) extensionCount++;
      if (endMin !== null && endMin > TIME_BOUNDARIES.night_start) nightCount++;

      const className = enrollType === '一時' ? '一時' : (ageClass !== null ? `${ageClass}歳児` : '');

      dayChildren.push({
        child_id: s.child_id,
        name: s.name,
        birth_date: s.birth_date,
        age_class: ageClass,
        enrollment_type: enrollType,
        class_name: className,
        planned_start: s.planned_start,
        planned_end: s.planned_end,
        actual_checkin: null,
        actual_checkout: null,
        billing_start: s.planned_start,
        billing_end: s.planned_end,
        has_lunch: s.lunch_flag ? 1 : 0,
        has_am_snack: s.am_snack_flag ? 1 : 0,
        has_pm_snack: s.pm_snack_flag ? 1 : 0,
        has_dinner: s.dinner_flag ? 1 : 0,
        is_early_morning: startMin !== null && startMin < TIME_BOUNDARIES.early_end ? 1 : 0,
        is_extension: endMin !== null && endMin > TIME_BOUNDARIES.extension_start ? 1 : 0,
        is_night: endMin !== null && endMin > TIME_BOUNDARIES.night_start ? 1 : 0,
        is_sick: 0,
        status: 'planned',
      });
    }

    dailySummary.push({
      day,
      weekday,
      is_weekend: isWeekend,
      total_children: totalChildren,
      lunch_count: lunchCount,
      am_snack_count: amSnackCount,
      pm_snack_count: pmSnackCount,
      dinner_count: dinnerCount,
      early_morning_count: earlyMorningCount,
      extension_count: extensionCount,
      night_count: nightCount,
      sick_count: sickCount,
      age_0_count: age0,
      age_1_count: age1,
      age_2_count: age2,
      age_3_count: age3,
      age_4_count: age4,
      age_5_count: age5,
      temp_count: tempCount,
      planned_absent: 0,
      children: dayChildren,
    });
  }

  // Build submission overview: which children have submitted and which have not
  const childrenWithSchedules = new Set(schedules.map(s => s.child_id as string));
  const submittedChildren: { id: string; name: string; enrollment_type: string; days: number }[] = [];
  const notSubmittedChildren: { id: string; name: string; enrollment_type: string }[] = [];

  for (const child of children) {
    const cid = child.id as string;
    if (childrenWithSchedules.has(cid)) {
      const dayCount = schedules.filter(s => s.child_id === cid).length;
      submittedChildren.push({
        id: cid,
        name: child.name as string,
        enrollment_type: child.enrollment_type as string,
        days: dayCount,
      });
    } else {
      notSubmittedChildren.push({
        id: cid,
        name: child.name as string,
        enrollment_type: child.enrollment_type as string,
      });
    }
  }

  return c.json({
    year,
    month,
    days_in_month: daysInMonth,
    total_children: children.length,
    is_schedule_only: true,
    daily_summary: dailySummary,
    submission_overview: {
      total: children.length,
      submitted_count: submittedChildren.length,
      not_submitted_count: notSubmittedChildren.length,
      submitted: submittedChildren,
      not_submitted: notSubmittedChildren,
    },
    submission_report: null,
    source: 'database',
  });
  } catch (e: any) {
    console.error('Schedules dashboard error:', e);
    return c.json({ 
      error: e.message || 'スケジュールダッシュボード生成エラー',
      detail: String(e),
    }, 500);
  }
});

// ── Public view: calendar data for a specific child/month ──
// GET /api/schedules/view/:token/:year/:month
// token は view_token (32文字hex) または childId (16文字hex、後方互換)
// view_token を優先検索し、見つからなければ childId にフォールバック
scheduleRoutes.get('/view/:token/:year/:month', async (c) => {
  try {
    const token = c.req.param('token');
    const year = parseInt(c.req.param('year') || '0', 10);
    const month = parseInt(c.req.param('month') || '0', 10);

    // トークンバリデーション: 英数字・ハイフン・アンダースコアのみ
    if (!/^[a-zA-Z0-9_-]+$/.test(token)) {
      return c.json({ error: '無効なトークンです' }, 400);
    }

    if (isNaN(year) || year < 2000 || year > 2100 || isNaN(month) || month < 1 || month > 12) {
      return c.json({ error: '無効な年月です' }, 400);
    }

    const db = c.env.DB;
    if (!db) return c.json({ error: 'データベース接続が利用できません' }, 500);

  // view_token で検索（推奨）→ childId にフォールバック（後方互換）
  let child = await db.prepare(
    'SELECT id, name, enrollment_type, birth_date, age_class FROM children WHERE view_token = ?'
  ).bind(token).first<{ id: string; name: string; enrollment_type: string; birth_date: string | null; age_class: number | null }>();

  if (!child) {
    // 後方互換: childId として検索
    child = await db.prepare(
      'SELECT id, name, enrollment_type, birth_date, age_class FROM children WHERE id = ?'
    ).bind(token).first<{ id: string; name: string; enrollment_type: string; birth_date: string | null; age_class: number | null }>();
  }

  if (!child) {
    return c.json({ error: '園児が見つかりません' }, 404);
  }

  // Get schedule plans
  const result = await db.prepare(`
    SELECT day, planned_start, planned_end, lunch_flag, am_snack_flag, pm_snack_flag, dinner_flag, source_file
    FROM schedule_plans
    WHERE child_id = ? AND year = ? AND month = ?
    ORDER BY day ASC
  `).bind(child.id, year, month).all();

  const daysInMonth = new Date(year, month, 0).getDate();
  const weekdayNames = ['日', '月', '火', '水', '木', '金', '土'];

  // Build full month array (including days with no schedule)
  const days: Record<string, unknown>[] = [];
  const planMap = new Map<number, Record<string, unknown>>();
  for (const r of result.results as Record<string, unknown>[]) {
    planMap.set(r.day as number, r);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month - 1, day);
    const dow = date.getDay();
    const plan = planMap.get(day);
    days.push({
      day,
      weekday: weekdayNames[dow],
      is_weekend: dow === 0 || dow === 6,
      planned_start: plan?.planned_start ?? null,
      planned_end: plan?.planned_end ?? null,
      lunch_flag: plan?.lunch_flag ?? 0,
      am_snack_flag: plan?.am_snack_flag ?? 0,
      pm_snack_flag: plan?.pm_snack_flag ?? 0,
      dinner_flag: plan?.dinner_flag ?? 0,
      has_plan: !!plan,
      source: plan?.source_file ?? null,
    });
  }

  return c.json({
    child: {
      id: child.id,
      name: child.name,
      enrollment_type: child.enrollment_type,
      age_class: child.age_class,
    },
    year,
    month,
    days_in_month: daysInMonth,
    total_planned_days: result.results.length,
    days,
  });
  } catch (e: any) {
    console.error('Schedules view error:', e);
    return c.json({ error: e.message || 'スケジュール表示エラー' }, 500);
  }
});

// safeToMinutes は types/index.ts から import 済み

export default scheduleRoutes;

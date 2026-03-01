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
import type { HonoEnv } from '../types/index';
import { getAgeClassFromBirthDate, getFiscalYear, ageClassToLabel } from '../lib/age-class';

const scheduleRoutes = new Hono<HonoEnv>();

// ── List all schedule plans for a month ──
scheduleRoutes.get('/', async (c) => {
  const year = parseInt(c.req.query('year') || '0');
  const month = parseInt(c.req.query('month') || '0');

  if (!year || !month) {
    return c.json({ error: 'year と month を指定してください' }, 400);
  }

  const db = c.env.DB;

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
});

// ── List plans for a single child in a month ──
scheduleRoutes.get('/:childId', async (c) => {
  const childId = c.req.param('childId');
  const year = parseInt(c.req.query('year') || '0');
  const month = parseInt(c.req.query('month') || '0');

  if (!year || !month) {
    return c.json({ error: 'year と month を指定してください' }, 400);
  }

  const db = c.env.DB;

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
});

// ── Upsert schedule plans (bulk) ──
// Body: { child_id, year, month, days: [{ day, planned_start, planned_end, lunch_flag, am_snack_flag, pm_snack_flag, dinner_flag }] }
scheduleRoutes.post('/', async (c) => {
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
});

// ── Delete all schedule plans for a child/month ──
scheduleRoutes.delete('/:childId', async (c) => {
  const childId = c.req.param('childId');
  const year = parseInt(c.req.query('year') || '0');
  const month = parseInt(c.req.query('month') || '0');

  if (!year || !month) {
    return c.json({ error: 'year と month を指定してください' }, 400);
  }

  const db = c.env.DB;

  await db.prepare(`
    DELETE FROM schedule_plans
    WHERE child_id = ? AND year = ? AND month = ?
  `).bind(childId, year, month).run();

  return c.json({ message: '予定を削除しました', child_id: childId, year, month });
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

  const db = c.env.DB;
  const fiscalYear = getFiscalYear(year, month);

  // Get all children
  const childrenResult = await db.prepare(`
    SELECT * FROM children WHERE nursery_id = 'ayukko_001'
    ORDER BY 
      CASE enrollment_type WHEN '月極' THEN 0 ELSE 1 END,
      age_class ASC, birth_date ASC, name ASC
  `).all();
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

      // Check time zones
      const startMin = timeToMinutes(s.planned_start as string);
      const endMin = timeToMinutes(s.planned_end as string);
      if (startMin !== null && startMin < 450) earlyMorningCount++; // before 7:30
      if (endMin !== null && endMin > 1200) extensionCount++; // after 20:00
      if (endMin !== null && endMin > 1260) nightCount++; // after 21:00

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
        is_early_morning: startMin !== null && startMin < 450 ? 1 : 0,
        is_extension: endMin !== null && endMin > 1200 ? 1 : 0,
        is_night: endMin !== null && endMin > 1260 ? 1 : 0,
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

  return c.json({
    year,
    month,
    days_in_month: daysInMonth,
    total_children: children.length,
    is_schedule_only: true,
    daily_summary: dailySummary,
    submission_report: null,
    source: 'database',
  });
});

function timeToMinutes(timeStr: string | null): number | null {
  if (!timeStr) return null;
  const parts = timeStr.split(':');
  if (parts.length < 2) return null;
  const h = parseInt(parts[0]);
  const m = parseInt(parts[1]);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}

export default scheduleRoutes;

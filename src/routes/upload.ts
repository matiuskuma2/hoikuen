/**
 * アップロード→ダッシュボード API ルート
 * Python Generator の /dashboard エンドポイントを TypeScript で完全置換
 * SheetJS でExcelを解析し、ダッシュボードJSONを返却
 */
import { Hono } from 'hono';
import type { HonoEnv } from '../types/index';
import {
  parseLukumi, parseSchedule, matchChildren, computeUsageFacts,
  normalizeName, type MatchedChild, type ParseWarning, type SchedulePlan,
} from '../lib/excel-parser';

const uploadRoutes = new Hono<HonoEnv>();

// ── POST /api/upload/dashboard ──
// multipart/form-data: year, month, lukumi_file?, schedule_files[]
uploadRoutes.post('/dashboard', async (c) => {
  try {
    const formData = await c.req.formData();
    const year = parseInt(formData.get('year') as string);
    const month = parseInt(formData.get('month') as string);

    if (isNaN(year) || year < 2000 || year > 2100) {
      return c.json({ error: `年が範囲外です: ${year}` }, 400);
    }
    if (isNaN(month) || month < 1 || month > 12) {
      return c.json({ error: `月が範囲外です: ${month}` }, 400);
    }

    const warnings: ParseWarning[] = [];

    // ── Parse Lukumi file (optional) ──
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

    // ── Parse schedule files ──
    const allPlans = new Map<string, Record<number, SchedulePlan>>();
    const scheduleChildNames: string[] = [];

    // Get all schedule files from formData
    const scheduleFiles = formData.getAll('schedule_files') as File[];
    for (const sf of scheduleFiles) {
      if (!sf || sf.size === 0) continue;
      const buf = await sf.arrayBuffer();
      const result = parseSchedule(buf, sf.name, year, month);
      warnings.push(...result.warnings);
      for (const { plans, childName } of result.results) {
        if (childName) {
          scheduleChildNames.push(childName);
          if (allPlans.has(childName)) {
            warnings.push({
              level: 'warn', child_name: childName,
              message: `園児「${childName}」の予定表が複数アップロードされています。後のデータで上書きします`,
              suggestion: null, file: sf.name,
            });
          }
          allPlans.set(childName, plans);
        }
      }
    }

    // ── Match children ──
    let { children, warnings: matchWarnings, unmatched } = matchChildren(lukumiChildren, scheduleChildNames);
    warnings.push(...matchWarnings);

    // ── Schedule-only mode (no lukumi) ──
    const isScheduleOnly = lukumiChildren.length === 0;
    if (isScheduleOnly && scheduleChildNames.length > 0) {
      const schedChildren: MatchedChild[] = scheduleChildNames.map(sname => {
        const normName = normalizeName(sname);
        return {
          id: `sched_${normName.replace(/ /g, '_')}`,
          lukumi_id: `sched_${normName.replace(/ /g, '_')}`,
          name: normName,
          name_norm: normName,
          name_kana: null,
          age_class: null,
          enrollment_type: '月極',
          birth_date: null,
          class_name: '',
          has_schedule: true,
          schedule_file: sname,
          is_allergy: 0,
          child_order: 1,
        };
      });
      children = schedChildren;
      warnings.push({
        level: 'info', child_name: null,
        message: `ルクミーデータなし — 予定表から${children.length}名の園児を検出しました（予定プレビューモード）`,
        suggestion: '実績データを表示するにはルクミー登降園データもアップロードしてください',
      });
    }

    // ── Compute usage facts ──
    const usageFacts = computeUsageFacts(children, allPlans, attendance, year, month);

    // ── Build dashboard data ──
    const daysInMonth = new Date(year, month, 0).getDate();
    const weekdaysJp = ['日', '月', '火', '水', '木', '金', '土'];

    const dailySummary = [];
    for (let day = 1; day <= daysInMonth; day++) {
      const dayFacts = usageFacts.filter(f => f.day === day && ['present', 'late_arrive', 'early_leave'].includes(f.attendance_status));
      const planOnly = usageFacts.filter(f => f.day === day && f.attendance_status === 'absent' && f.planned_start);
      const allDayFacts = [...dayFacts, ...planOnly];

      const childrenDetail = allDayFacts.map(f => {
        const childInfo = children.find(c => c.lukumi_id === f.child_id) || {} as any;
        let status = f.attendance_status;
        if (isScheduleOnly && status === 'absent') status = 'planned';

        return {
          name: f.child_name,
          child_id: f.child_id,
          class_name: childInfo.class_name || '',
          age_class: childInfo.age_class ?? null,
          birth_date: childInfo.birth_date || null,
          planned_start: f.planned_start,
          planned_end: f.planned_end,
          actual_checkin: f.actual_checkin,
          actual_checkout: f.actual_checkout,
          billing_start: f.billing_start,
          billing_end: f.billing_end,
          billing_minutes: f.billing_minutes,
          status,
          enrollment_type: childInfo.enrollment_type || '月極',
          has_breakfast: f.has_breakfast,
          has_lunch: f.has_lunch,
          has_am_snack: f.has_am_snack,
          has_pm_snack: f.has_pm_snack,
          has_dinner: f.has_dinner,
          is_early_morning: f.is_early_morning,
          is_extension: f.is_extension,
          is_night: f.is_night,
          is_sick: f.is_sick,
          exception_notes: f.exception_notes,
        };
      });

      const d = new Date(year, month - 1, day);
      const weekday = weekdaysJp[d.getDay()];
      const isWeekend = d.getDay() === 0 || d.getDay() === 6;

      const countBase = isScheduleOnly ? allDayFacts : dayFacts;
      const ageCounts: Record<number, number> = {};
      let tempCount = 0;
      for (const cd of childrenDetail) {
        if (cd.enrollment_type === '一時') { tempCount++; }
        else if (cd.age_class != null) { ageCounts[cd.age_class] = (ageCounts[cd.age_class] || 0) + 1; }
      }

      dailySummary.push({
        day, weekday, is_weekend: isWeekend,
        total_children: countBase.length,
        planned_absent: isScheduleOnly ? 0 : planOnly.length,
        total_with_plans: allDayFacts.length,
        is_schedule_only: isScheduleOnly,
        age_0_count: ageCounts[0] || 0,
        age_1_count: ageCounts[1] || 0,
        age_2_count: ageCounts[2] || 0,
        age_3_count: ageCounts[3] || 0,
        age_4_count: ageCounts[4] || 0,
        age_5_count: ageCounts[5] || 0,
        temp_count: tempCount,
        breakfast_count: countBase.filter(f => f.has_breakfast).length,
        lunch_count: countBase.filter(f => f.has_lunch).length,
        am_snack_count: countBase.filter(f => f.has_am_snack).length,
        pm_snack_count: countBase.filter(f => f.has_pm_snack).length,
        dinner_count: countBase.filter(f => f.has_dinner).length,
        early_morning_count: countBase.filter(f => f.is_early_morning).length,
        extension_count: countBase.filter(f => f.is_extension).length,
        night_count: countBase.filter(f => f.is_night).length,
        sick_count: countBase.filter(f => f.is_sick).length,
        children: childrenDetail,
      });
    }

    // Children summary
    const childrenSummary = children.map(c => {
      const cFacts = usageFacts.filter(f => f.child_id === c.lukumi_id && ['present', 'late_arrive', 'early_leave'].includes(f.attendance_status));
      const cPlanDays = usageFacts.filter(f => f.child_id === c.lukumi_id && f.planned_start);
      return {
        name: c.name,
        child_id: c.lukumi_id,
        class_name: c.class_name || '',
        age_class: c.age_class,
        birth_date: c.birth_date,
        enrollment_type: c.enrollment_type,
        has_schedule: c.has_schedule,
        attendance_days: cFacts.length,
        planned_days: cPlanDays.length,
      };
    });

    return c.json({
      year, month, days_in_month: daysInMonth,
      total_children: children.length,
      is_schedule_only: isScheduleOnly,
      daily_summary: dailySummary,
      children_summary: childrenSummary,
      submission_report: {
        submitted: children.filter(c => c.has_schedule).map(c => ({ name: c.name, lukumi_id: c.lukumi_id })),
        not_submitted: children.filter(c => !c.has_schedule).map(c => ({ name: c.name, lukumi_id: c.lukumi_id, reason: '利用予定表が未提出です' })),
        unmatched_schedules: unmatched.map(s => ({ schedule_name: s, reason: 'ルクミー登降園データに該当する園児なし' })),
        summary: {
          total_children: children.length,
          submitted: children.filter(c => c.has_schedule).length,
          not_submitted: children.filter(c => !c.has_schedule).length,
          unmatched: unmatched.length,
        },
      },
      warnings,
    });
  } catch (e: any) {
    console.error('Dashboard error:', e);
    return c.json({ error: e.message || 'ダッシュボード生成エラー', warnings: [] }, 500);
  }
});

export default uploadRoutes;

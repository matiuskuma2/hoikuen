/**
 * Daily Report Excel Generator (日報 Excel)
 * 
 * Phase A-2: SheetJS でスクラッチから日報Excelを生成
 * DB テーブル (children, schedule_plans, attendance_records, usage_facts) から取得。
 * 
 * シート構成:
 *   1. 月間カレンダー: 日別の在園児数・食事数・時間外保育数
 *   2. 園児別出席一覧: 園児ごとの出欠マーク
 *   3. 食事集計: 日別の食事種類別カウント
 *   4. 時間外保育: 早朝・延長・夜間の日別詳細
 * 
 * Created: 2026-03-17
 */

import * as XLSX from 'xlsx';
import {
  type Child,
  type UsageFact,
  type SchedulePlan,
  type AttendanceRecord,
} from '../types/index';
import { ageClassToLabel } from './age-class';

/** 日報生成用の入力データ */
export interface DailyReportInput {
  children: Child[];
  usageFacts: UsageFact[];
  schedulePlans: SchedulePlan[];
  attendanceRecords: AttendanceRecord[];
  year: number;
  month: number;
}

const WEEKDAYS_JP = ['日', '月', '火', '水', '木', '金', '土'];

/** HH:MM:SS or HH:MM → short H:MM */
function shortTime(t: string): string {
  if (!t) return '';
  const m = t.match(/^0?(\d{1,2}):(\d{2})/);
  return m ? `${parseInt(m[1])}:${m[2]}` : t;
}

/**
 * 日報Excelを生成
 */
export function generateDailyReportExcel(input: DailyReportInput): ArrayBuffer {
  const { children, usageFacts, schedulePlans, attendanceRecords, year, month } = input;
  const wb = XLSX.utils.book_new();
  const daysInMonth = new Date(year, month, 0).getDate();

  // Sorted children: 月極 first → age_class asc → name
  const sortedChildren = [...children].sort((a, b) => {
    if (a.enrollment_type !== b.enrollment_type) {
      return a.enrollment_type === '月極' ? -1 : 1;
    }
    const ageA = a.age_class ?? 99;
    const ageB = b.age_class ?? 99;
    if (ageA !== ageB) return ageA - ageB;
    return a.name.localeCompare(b.name, 'ja');
  });

  // Helper: get weekday for a day
  function getWeekday(day: number): string {
    const d = new Date(year, month - 1, day);
    return WEEKDAYS_JP[d.getDay()];
  }
  function isWeekend(day: number): boolean {
    const d = new Date(year, month - 1, day);
    return d.getDay() === 0 || d.getDay() === 6;
  }

  // ═══════════════════════════════════
  // Sheet 1: 月間サマリー（日別集計）
  // ═══════════════════════════════════
  {
    const data: (string | number | null)[][] = [];
    data.push([`${year}年${month}月 日報サマリー`]);
    data.push([]);
    data.push([
      '日', '曜日', '在園児数', '欠席', '0歳', '1歳', '2歳', '3歳', '4歳', '5歳', '一時',
      '朝食', '昼食', 'AM間食', 'PM間食', '夕食',
      '早朝', '延長', '夜間', '病児',
    ]);

    const totals = new Array(17).fill(0); // columns 2..18

    for (let day = 1; day <= daysInMonth; day++) {
      const dayFacts = usageFacts.filter(f =>
        f.day === day && ['present', 'late_arrive', 'early_leave'].includes(f.attendance_status)
      );
      const absentFacts = usageFacts.filter(f =>
        f.day === day && f.attendance_status === 'absent'
      );

      // Age counts
      const ageCounts = [0, 0, 0, 0, 0, 0]; // 0-5
      let tempCount = 0;
      for (const fact of dayFacts) {
        const child = children.find(c => c.id === fact.child_id);
        if (child?.enrollment_type === '一時') {
          tempCount++;
        } else if (child?.age_class != null && child.age_class >= 0 && child.age_class <= 5) {
          ageCounts[child.age_class]++;
        }
      }

      // Meal counts
      const breakfastCount = dayFacts.filter(f => f.has_breakfast === 1).length;
      const lunchCount = dayFacts.filter(f => f.has_lunch === 1).length;
      const amSnackCount = dayFacts.filter(f => f.has_am_snack === 1).length;
      const pmSnackCount = dayFacts.filter(f => f.has_pm_snack === 1).length;
      const dinnerCount = dayFacts.filter(f => f.has_dinner === 1).length;

      // Time-zone counts
      const earlyCount = dayFacts.filter(f => f.is_early_morning === 1).length;
      const extCount = dayFacts.filter(f => f.is_extension === 1).length;
      const nightCount = dayFacts.filter(f => f.is_night === 1).length;
      const sickCount = dayFacts.filter(f => f.is_sick === 1).length;

      const row = [
        day, getWeekday(day),
        dayFacts.length, absentFacts.length,
        ...ageCounts,
        tempCount,
        breakfastCount, lunchCount, amSnackCount, pmSnackCount, dinnerCount,
        earlyCount, extCount, nightCount, sickCount,
      ];

      // Accumulate totals (skip day, weekday columns)
      for (let i = 2; i < row.length; i++) {
        totals[i - 2] += (row[i] as number) || 0;
      }

      data.push(row);
    }

    // Total row
    data.push([]);
    data.push(['合計', null, ...totals]);

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [
      { wch: 4 }, { wch: 4 }, { wch: 8 }, { wch: 6 },
      { wch: 5 }, { wch: 5 }, { wch: 5 }, { wch: 5 }, { wch: 5 }, { wch: 5 }, { wch: 5 },
      { wch: 6 }, { wch: 6 }, { wch: 7 }, { wch: 7 }, { wch: 6 },
      { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 },
    ];
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 19 } }];

    XLSX.utils.book_append_sheet(wb, ws, '月間サマリー');
  }

  // ═══════════════════════════════════
  // Sheet 2: 園児別出席一覧
  // ═══════════════════════════════════
  {
    const data: (string | number | null)[][] = [];
    data.push([`${year}年${month}月 出席一覧`]);
    data.push([]);

    // Header: No, クラス, 氏名, 区分, [1日...31日], 出席日数, 欠席日数
    const headerRow: (string | number | null)[] = ['No', 'クラス', '氏名', '区分'];
    for (let d = 1; d <= daysInMonth; d++) {
      headerRow.push(`${d}\n${getWeekday(d)}`);
    }
    headerRow.push('出席', '欠席', '予定');
    data.push(headerRow);

    sortedChildren.forEach((child, idx) => {
      const cls = ageClassToLabel(child.age_class, child.enrollment_type);
      const row: (string | number | null)[] = [idx + 1, cls, child.name, child.enrollment_type];

      let presentDays = 0;
      let absentDays = 0;
      let plannedDays = 0;

      for (let d = 1; d <= daysInMonth; d++) {
        const fact = usageFacts.find(f => f.child_id === child.id && f.day === d);
        const plan = schedulePlans.find(p => p.child_id === child.id && p.day === d && p.planned_start);

        if (plan) plannedDays++;

        if (!fact || fact.attendance_status === 'absent_no_plan') {
          row.push(null);  // no mark
        } else if (fact.attendance_status === 'absent') {
          row.push('欠');
          absentDays++;
        } else if (fact.attendance_status === 'early_leave') {
          row.push('早退');
          presentDays++;
        } else if (fact.attendance_status === 'late_arrive') {
          row.push('遅刻');
          presentDays++;
        } else {
          // present
          row.push('○');
          presentDays++;
        }
      }

      row.push(presentDays, absentDays, plannedDays);
      data.push(row);
    });

    // Bottom totals
    data.push([]);
    const totalRow: (string | number | null)[] = [null, null, '合計', null];
    for (let d = 1; d <= daysInMonth; d++) {
      const dayFacts = usageFacts.filter(f =>
        f.day === d && ['present', 'late_arrive', 'early_leave'].includes(f.attendance_status)
      );
      totalRow.push(dayFacts.length);
    }
    totalRow.push(null, null, null);
    data.push(totalRow);

    const ws = XLSX.utils.aoa_to_sheet(data);
    const cols = [
      { wch: 4 }, { wch: 7 }, { wch: 14 }, { wch: 5 },
      ...Array.from({ length: daysInMonth }, () => ({ wch: 4 })),
      { wch: 5 }, { wch: 5 }, { wch: 5 },
    ];
    ws['!cols'] = cols;
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: Math.min(daysInMonth + 6, 36) } }];

    XLSX.utils.book_append_sheet(wb, ws, '出席一覧');
  }

  // ═══════════════════════════════════
  // Sheet 3: 食事集計
  // ═══════════════════════════════════
  {
    const data: (string | number | null)[][] = [];
    data.push([`${year}年${month}月 食事集計`]);
    data.push([]);

    // Header: No, クラス, 氏名, [日ごとの食事マーク...], 朝食計, 昼食計, AM計, PM計, 夕食計
    const hdr: (string | number | null)[] = ['No', 'クラス', '氏名'];
    for (let d = 1; d <= daysInMonth; d++) {
      hdr.push(`${d}(${getWeekday(d)})`);
    }
    hdr.push('朝食計', '昼食計', 'AM計', 'PM計', '夕食計');
    data.push(hdr);

    sortedChildren.forEach((child, idx) => {
      const cls = ageClassToLabel(child.age_class, child.enrollment_type);
      const row: (string | number | null)[] = [idx + 1, cls, child.name];

      let bfTotal = 0, lTotal = 0, amTotal = 0, pmTotal = 0, dTotal = 0;

      for (let d = 1; d <= daysInMonth; d++) {
        const fact = usageFacts.find(f => f.child_id === child.id && f.day === d);
        if (!fact || fact.attendance_status === 'absent' || fact.attendance_status === 'absent_no_plan') {
          row.push(null);
          continue;
        }
        // Compact meal notation
        const parts: string[] = [];
        if (fact.has_breakfast) { parts.push('朝'); bfTotal++; }
        if (fact.has_am_snack) { parts.push('A'); amTotal++; }
        if (fact.has_lunch) { parts.push('昼'); lTotal++; }
        if (fact.has_pm_snack) { parts.push('P'); pmTotal++; }
        if (fact.has_dinner) { parts.push('夕'); dTotal++; }
        row.push(parts.join(',') || null);
      }

      row.push(bfTotal, lTotal, amTotal, pmTotal, dTotal);
      data.push(row);
    });

    // Day totals
    data.push([]);
    const totalRow: (string | number | null)[] = [null, null, '合計'];
    for (let d = 1; d <= daysInMonth; d++) {
      const dayFacts = usageFacts.filter(f =>
        f.day === d && ['present', 'late_arrive', 'early_leave'].includes(f.attendance_status)
      );
      const mealCount = dayFacts.filter(f =>
        f.has_breakfast || f.has_lunch || f.has_am_snack || f.has_pm_snack || f.has_dinner
      ).length;
      totalRow.push(mealCount);
    }
    totalRow.push(null, null, null, null, null);
    data.push(totalRow);

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [
      { wch: 4 }, { wch: 7 }, { wch: 14 },
      ...Array.from({ length: daysInMonth }, () => ({ wch: 8 })),
      { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 }, { wch: 6 },
    ];
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: Math.min(daysInMonth + 7, 37) } }];

    XLSX.utils.book_append_sheet(wb, ws, '食事集計');
  }

  // ═══════════════════════════════════
  // Sheet 4: 時間外保育詳細
  // ═══════════════════════════════════
  {
    const data: (string | number | null)[][] = [];
    data.push([`${year}年${month}月 時間外保育詳細`]);
    data.push([]);
    data.push([
      '日', '曜日', '氏名', 'クラス', '区分',
      '予定開始', '予定終了', '実績開始', '実績終了',
      '請求開始', '請求終了', '請求分数',
      '早朝', '延長', '夜間', '病児', '備考',
    ]);

    for (let day = 1; day <= daysInMonth; day++) {
      const dayFacts = usageFacts.filter(f =>
        f.day === day &&
        (f.is_early_morning === 1 || f.is_extension === 1 || f.is_night === 1 || f.is_sick === 1)
      );

      for (const fact of dayFacts) {
        const child = children.find(c => c.id === fact.child_id);
        const plan = schedulePlans.find(p => p.child_id === fact.child_id && p.day === day);
        const attend = attendanceRecords.find(a => a.child_id === fact.child_id && a.day === day);
        const cls = child ? ageClassToLabel(child.age_class, child.enrollment_type) : '';

        data.push([
          day, getWeekday(day),
          child?.name || fact.child_id,
          cls,
          child?.enrollment_type || '',
          plan?.planned_start || null,
          plan?.planned_end || null,
          attend?.actual_checkin || null,
          attend?.actual_checkout || null,
          fact.billing_start,
          fact.billing_end,
          fact.billing_minutes != null ? fact.billing_minutes : null,
          fact.is_early_morning ? '○' : null,
          fact.is_extension ? '○' : null,
          fact.is_night ? '○' : null,
          fact.is_sick ? '○' : null,
          fact.exception_notes || null,
        ]);
      }
    }

    // Summary
    data.push([]);
    data.push(['【集計】']);
    data.push(['種別', '延べ回数', '延べ人数']);
    const earlyTotal = usageFacts.filter(f => f.is_early_morning === 1).length;
    const extTotal = usageFacts.filter(f => f.is_extension === 1 && f.is_night === 0).length;
    const nightTotal = usageFacts.filter(f => f.is_night === 1).length;
    const sickTotal = usageFacts.filter(f => f.is_sick === 1).length;
    const earlyChildren = new Set(usageFacts.filter(f => f.is_early_morning === 1).map(f => f.child_id)).size;
    const extChildren = new Set(usageFacts.filter(f => f.is_extension === 1 && f.is_night === 0).map(f => f.child_id)).size;
    const nightChildren = new Set(usageFacts.filter(f => f.is_night === 1).map(f => f.child_id)).size;
    const sickChildren = new Set(usageFacts.filter(f => f.is_sick === 1).map(f => f.child_id)).size;

    data.push(['早朝保育', earlyTotal, earlyChildren]);
    data.push(['延長保育', extTotal, extChildren]);
    data.push(['夜間保育', nightTotal, nightChildren]);
    data.push(['病児保育', sickTotal, sickChildren]);

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [
      { wch: 4 }, { wch: 4 }, { wch: 14 }, { wch: 7 }, { wch: 5 },
      { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 },
      { wch: 8 }, { wch: 8 }, { wch: 8 },
      { wch: 5 }, { wch: 5 }, { wch: 5 }, { wch: 5 },
      { wch: 20 },
    ];
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 16 } }];

    XLSX.utils.book_append_sheet(wb, ws, '時間外保育');
  }

  // ═══════════════════════════════════
  // Sheet 5: 児童実績表申請（大学提出用）
  // 園児ごとの日別：登園時間/降園時間/一時利用フラグ/早朝/延長/夜間/病児
  // ═══════════════════════════════════
  {
    const data: (string | number | null)[][] = [];
    data.push([`${year}年${month}月 児童実績表申請`]);
    data.push([]);

    // Header row 1: column labels
    const hdr1: (string | number | null)[] = ['No', 'クラス', '氏名', '区分'];
    for (let d = 1; d <= daysInMonth; d++) {
      hdr1.push(`${d}日(${getWeekday(d)})`);
    }
    hdr1.push('出席日数', '一時利用日数', '早朝回数', '延長回数', '夜間回数', '病児回数');
    data.push(hdr1);

    // Subheader row: explain what each day cell contains
    const hdr2: (string | number | null)[] = [null, null, null, null];
    for (let d = 1; d <= daysInMonth; d++) {
      hdr2.push('登園-降園');
    }
    hdr2.push(null, null, null, null, null, null);
    data.push(hdr2);

    sortedChildren.forEach((child, idx) => {
      const cls = ageClassToLabel(child.age_class, child.enrollment_type);
      const row: (string | number | null)[] = [idx + 1, cls, child.name, child.enrollment_type];

      let presentDays = 0;
      let spotDays = 0;
      let earlyCount = 0;
      let extCount = 0;
      let nightCount = 0;
      let sickCount = 0;

      for (let d = 1; d <= daysInMonth; d++) {
        const fact = usageFacts.find(f => f.child_id === child.id && f.day === d);
        const plan = schedulePlans.find(p => p.child_id === child.id && p.day === d);
        const attend = attendanceRecords.find(a => a.child_id === child.id && a.day === d);

        if (!fact || fact.attendance_status === 'absent_no_plan') {
          row.push(null);
        } else if (fact.attendance_status === 'absent') {
          row.push('欠席');
        } else {
          // Show actual check-in/out or planned times
          const checkin = attend?.actual_checkin || plan?.planned_start || '';
          const checkout = attend?.actual_checkout || plan?.planned_end || '';
          const timeStr = checkin && checkout ? `${shortTime(checkin)}-${shortTime(checkout)}` : (checkin || checkout || '○');

          // Annotate with flags
          const flags: string[] = [];
          if (child.enrollment_type === '一時') { flags.push('一時'); spotDays++; }
          if (fact.is_early_morning) { flags.push('早'); earlyCount++; }
          if (fact.is_extension) { flags.push('延'); extCount++; }
          if (fact.is_night) { flags.push('夜'); nightCount++; }
          if (fact.is_sick) { flags.push('病'); sickCount++; }

          const flagStr = flags.length > 0 ? ` [${flags.join(',')}]` : '';
          row.push(timeStr + flagStr);
          presentDays++;
        }
      }

      row.push(presentDays, spotDays, earlyCount, extCount, nightCount, sickCount);
      data.push(row);
    });

    // Totals row
    data.push([]);
    const totalRow: (string | number | null)[] = [null, null, '合計', null];
    for (let d = 1; d <= daysInMonth; d++) {
      const dayFacts = usageFacts.filter(f =>
        f.day === d && ['present', 'late_arrive', 'early_leave'].includes(f.attendance_status)
      );
      totalRow.push(dayFacts.length > 0 ? dayFacts.length : null);
    }
    // sum columns
    const allPresent = usageFacts.filter(f => ['present', 'late_arrive', 'early_leave'].includes(f.attendance_status));
    totalRow.push(
      allPresent.length,
      allPresent.filter(f => {
        const child = children.find(c => c.id === f.child_id);
        return child?.enrollment_type === '一時';
      }).length,
      allPresent.filter(f => f.is_early_morning === 1).length,
      allPresent.filter(f => f.is_extension === 1).length,
      allPresent.filter(f => f.is_night === 1).length,
      allPresent.filter(f => f.is_sick === 1).length,
    );
    data.push(totalRow);

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [
      { wch: 4 }, { wch: 7 }, { wch: 14 }, { wch: 5 },
      ...Array.from({ length: daysInMonth }, () => ({ wch: 14 })),
      { wch: 7 }, { wch: 7 }, { wch: 7 }, { wch: 7 }, { wch: 7 }, { wch: 7 },
    ];
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: Math.min(daysInMonth + 9, 40) } }];

    XLSX.utils.book_append_sheet(wb, ws, '児童実績表申請');
  }

  // ═══════════════════════════════════
  // Sheet 6: 給食実数表（個人）
  // 園児ごとの月間食事回数一覧（朝食/昼食/AM間食/PM間食/夕食）
  // ═══════════════════════════════════
  {
    const data: (string | number | null)[][] = [];
    data.push([`${year}年${month}月 給食実数表（個人）`]);
    data.push([]);

    // Header
    data.push([
      'No', 'クラス', '氏名', '区分', 'アレルギー',
      '朝食回数', '昼食回数', 'AM間食回数', 'PM間食回数', '夕食回数', '食事合計',
      '出席日数', '朝食率%', '昼食率%',
    ]);

    let grandBreakfast = 0, grandLunch = 0, grandAm = 0, grandPm = 0, grandDinner = 0;

    sortedChildren.forEach((child, idx) => {
      const cls = ageClassToLabel(child.age_class, child.enrollment_type);
      const childFacts = usageFacts.filter(f =>
        f.child_id === child.id &&
        ['present', 'late_arrive', 'early_leave'].includes(f.attendance_status)
      );

      const bf = childFacts.filter(f => f.has_breakfast === 1).length;
      const lu = childFacts.filter(f => f.has_lunch === 1).length;
      const am = childFacts.filter(f => f.has_am_snack === 1).length;
      const pm = childFacts.filter(f => f.has_pm_snack === 1).length;
      const dn = childFacts.filter(f => f.has_dinner === 1).length;
      const total = bf + lu + am + pm + dn;
      const present = childFacts.length;

      grandBreakfast += bf;
      grandLunch += lu;
      grandAm += am;
      grandPm += pm;
      grandDinner += dn;

      data.push([
        idx + 1,
        cls,
        child.name,
        child.enrollment_type,
        child.is_allergy ? 'あり' : '',
        bf || null,
        lu || null,
        am || null,
        pm || null,
        dn || null,
        total || null,
        present || null,
        present > 0 ? Math.round((bf / present) * 100) : null,
        present > 0 ? Math.round((lu / present) * 100) : null,
      ]);
    });

    // Totals
    data.push([]);
    data.push([
      null, null, '合計', null, null,
      grandBreakfast, grandLunch, grandAm, grandPm, grandDinner,
      grandBreakfast + grandLunch + grandAm + grandPm + grandDinner,
      null, null, null,
    ]);

    // Per-day meal totals breakdown
    data.push([]);
    data.push(['【日別食事提供数】']);
    data.push(['日', '曜日', '出席', '朝食', '昼食', 'AM間食', 'PM間食', '夕食']);

    for (let d = 1; d <= daysInMonth; d++) {
      const dayFacts = usageFacts.filter(f =>
        f.day === d && ['present', 'late_arrive', 'early_leave'].includes(f.attendance_status)
      );
      if (dayFacts.length === 0) continue;

      data.push([
        d,
        getWeekday(d),
        dayFacts.length,
        dayFacts.filter(f => f.has_breakfast === 1).length || null,
        dayFacts.filter(f => f.has_lunch === 1).length || null,
        dayFacts.filter(f => f.has_am_snack === 1).length || null,
        dayFacts.filter(f => f.has_pm_snack === 1).length || null,
        dayFacts.filter(f => f.has_dinner === 1).length || null,
      ]);
    }

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [
      { wch: 4 }, { wch: 7 }, { wch: 14 }, { wch: 5 }, { wch: 9 },
      { wch: 8 }, { wch: 8 }, { wch: 9 }, { wch: 9 }, { wch: 8 },
      { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 },
    ];
    ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 13 } }];

    XLSX.utils.book_append_sheet(wb, ws, '給食実数表（個人）');
  }

  // Write to buffer
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

/**
 * DB から日報データを一括取得するヘルパー
 */
export async function fetchDailyReportData(
  db: D1Database,
  nurseryId: string,
  year: number,
  month: number,
): Promise<{ input: DailyReportInput; warnings: string[] }> {
  const warnings: string[] = [];

  // Children
  const childrenResult = await db.prepare(
    `SELECT * FROM children WHERE nursery_id = ? ORDER BY
      CASE enrollment_type WHEN '月極' THEN 0 ELSE 1 END,
      age_class ASC, name ASC`
  ).bind(nurseryId).all();
  const children = childrenResult.results as unknown as Child[];

  if (children.length === 0) {
    warnings.push('園児マスタにデータがありません');
  }

  // Schedule plans
  const plansResult = await db.prepare(
    `SELECT * FROM schedule_plans WHERE year = ? AND month = ?`
  ).bind(year, month).all();
  const schedulePlans = plansResult.results as unknown as SchedulePlan[];

  // Attendance records
  const attendResult = await db.prepare(
    `SELECT * FROM attendance_records WHERE year = ? AND month = ?`
  ).bind(year, month).all();
  const attendanceRecords = attendResult.results as unknown as AttendanceRecord[];

  // Usage facts
  const factsResult = await db.prepare(
    `SELECT * FROM usage_facts WHERE year = ? AND month = ?`
  ).bind(year, month).all();
  const usageFacts = factsResult.results as unknown as UsageFact[];

  if (usageFacts.length === 0) {
    warnings.push(`${year}年${month}月のusage_factsがありません。先にジョブを実行してください。`);
  }

  return {
    input: { children, usageFacts, schedulePlans, attendanceRecords, year, month },
    warnings,
  };
}

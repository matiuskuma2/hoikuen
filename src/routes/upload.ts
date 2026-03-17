/**
 * アップロード→DB保存 & ダッシュボード API ルート — v3.0
 * 
 * Phase B: ファイルアップロード → DB保存 → ダッシュボードSSOT化
 * 
 * POST /api/upload/dashboard  — 従来互換（ファイルからダッシュボード生成）
 * POST /api/upload/import     — ルクミー＋予定表をパースしてDBに保存
 * 
 * v3.0: import エンドポイント追加、DBに attendance_records, schedule_plans, children を保存
 */
import { Hono } from 'hono';
import { DEFAULT_NURSERY_ID, type HonoEnv, type ParseWarning, type ParsedAttendanceRecord, type ParsedChildInfo, type ParsedSchedulePlan } from '../types/index';
import { buildDashboardFromFormData } from '../lib/dashboard-builder';
import { parseLukumi, parseSchedule, normalizeName } from '../lib/excel-parser';
import { getAgeClassFromBirthDate, getFiscalYear } from '../lib/age-class';

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;

const uploadRoutes = new Hono<HonoEnv>();

// ── POST /api/upload/dashboard ── (従来互換)
uploadRoutes.post('/dashboard', async (c) => {
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
    console.error('Dashboard error:', message);
    return c.json({ error: message || 'ダッシュボード生成エラー', warnings: [] }, 500);
  }
});

// ═══════════════════════════════════
// POST /api/upload/import — ファイルパース → DB保存
// ═══════════════════════════════════
uploadRoutes.post('/import', async (c) => {
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

    const db = c.env.DB;
    const nurseryId = DEFAULT_NURSERY_ID;
    const warnings: ParseWarning[] = [];
    const stats = {
      children_upserted: 0,
      attendance_upserted: 0,
      schedule_upserted: 0,
    };
    const fiscalYear = getFiscalYear(year, month);

    // ── 1. Parse Lukumi file → children + attendance_records ──
    const lukumiFile = formData.get('lukumi_file') as File | null;
    if (lukumiFile && lukumiFile.size > 0) {
      if (lukumiFile.size > MAX_FILE_SIZE_BYTES) {
        warnings.push({
          level: 'error', child_name: null,
          message: `ルクミーファイルが大きすぎます (${(lukumiFile.size / 1024 / 1024).toFixed(1)}MB)`,
          suggestion: '50MB以下のファイルをアップロードしてください',
        });
      } else {
        const buf = await lukumiFile.arrayBuffer();
        const result = parseLukumi(buf, lukumiFile.name, year, month);
        warnings.push(...result.warnings);

        // UPSERT children from Lukumi
        for (const child of result.children) {
          const childId = `lk_${child.lukumi_id}`;
          const ageClass = child.birth_date
            ? getAgeClassFromBirthDate(child.birth_date, fiscalYear)
            : child.age_class;

          // Determine enrollment_type from class_name
          let enrollmentType = '月極';
          if (child.class_name && (child.class_name.includes('一時') || child.class_name.includes('いちじ'))) {
            enrollmentType = '一時';
          }

          // Generate view_token for new children
          const viewToken = Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map(b => b.toString(16).padStart(2, '0')).join('');

          await db.prepare(`
            INSERT INTO children (id, nursery_id, lukumi_id, name, name_kana, birth_date, age_class, enrollment_type, view_token, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              name_kana = COALESCE(excluded.name_kana, children.name_kana),
              birth_date = COALESCE(excluded.birth_date, children.birth_date),
              age_class = COALESCE(excluded.age_class, children.age_class),
              enrollment_type = excluded.enrollment_type,
              lukumi_id = COALESCE(excluded.lukumi_id, children.lukumi_id),
              updated_at = datetime('now')
          `).bind(
            childId, nurseryId, child.lukumi_id, child.name, child.name_kana,
            child.birth_date, ageClass, enrollmentType, viewToken,
          ).run();
          stats.children_upserted++;
        }

        // UPSERT attendance_records
        for (const rec of result.attendance) {
          // Find child_id from lukumi_id
          const childRow = await db.prepare(
            `SELECT id FROM children WHERE nursery_id = ? AND lukumi_id = ?`
          ).bind(nurseryId, rec.lukumi_id).first();

          const childId = childRow?.id as string || `lk_${rec.lukumi_id}`;

          await db.prepare(`
            INSERT INTO attendance_records (id, child_id, year, month, day, actual_checkin, actual_checkout, memo, raw_class, source_file)
            VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(child_id, year, month, day) DO UPDATE SET
              actual_checkin = excluded.actual_checkin,
              actual_checkout = excluded.actual_checkout,
              memo = excluded.memo,
              raw_class = excluded.raw_class,
              source_file = excluded.source_file
          `).bind(
            childId, year, month, rec.day,
            rec.actual_checkin, rec.actual_checkout,
            rec.memo, rec.class_name, lukumiFile.name,
          ).run();
          stats.attendance_upserted++;
        }
      }
    }

    // ── 2. Parse Schedule files → schedule_plans ──
    const scheduleFiles = formData.getAll('schedule_files') as File[];
    for (const sf of scheduleFiles) {
      if (!sf || sf.size === 0) continue;
      if (sf.size > MAX_FILE_SIZE_BYTES) {
        warnings.push({
          level: 'error', child_name: null,
          message: `予定表「${sf.name}」が大きすぎます (${(sf.size / 1024 / 1024).toFixed(1)}MB)`,
          suggestion: null, file: sf.name,
        });
        continue;
      }

      const buf = await sf.arrayBuffer();
      const result = parseSchedule(buf, sf.name, year, month);
      warnings.push(...result.warnings);

      for (const { plans, childName } of result.results) {
        if (!childName) continue;

        // Find child_id by name matching
        const normName = normalizeName(childName);
        const childRow = await db.prepare(
          `SELECT id FROM children WHERE nursery_id = ? AND (name = ? OR name = ?)`
        ).bind(nurseryId, childName, normName).first();

        let childId: string;
        if (childRow?.id) {
          childId = childRow.id as string;
        } else {
          // Child not found — create stub
          childId = `sched_${normName.replace(/\s+/g, '_')}`;
          const viewToken = Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map(b => b.toString(16).padStart(2, '0')).join('');

          await db.prepare(`
            INSERT OR IGNORE INTO children (id, nursery_id, name, enrollment_type, view_token, updated_at)
            VALUES (?, ?, ?, '月極', ?, datetime('now'))
          `).bind(childId, nurseryId, childName, viewToken).run();

          warnings.push({
            level: 'info', child_name: childName,
            message: `園児「${childName}」がマスタに未登録のため仮登録しました`,
            suggestion: 'ルクミーデータをアップロードすると詳細情報が更新されます',
          });
        }

        // UPSERT schedule_plans for each day
        for (const [dayStr, plan] of Object.entries(plans)) {
          const day = parseInt(dayStr, 10);
          if (isNaN(day)) continue;

          const p = plan as ParsedSchedulePlan;
          await db.prepare(`
            INSERT INTO schedule_plans (id, child_id, year, month, day, planned_start, planned_end, lunch_flag, am_snack_flag, pm_snack_flag, dinner_flag, breakfast_flag, source_file)
            VALUES (lower(hex(randomblob(8))), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(child_id, year, month, day) DO UPDATE SET
              planned_start = excluded.planned_start,
              planned_end = excluded.planned_end,
              lunch_flag = excluded.lunch_flag,
              am_snack_flag = excluded.am_snack_flag,
              pm_snack_flag = excluded.pm_snack_flag,
              dinner_flag = excluded.dinner_flag,
              breakfast_flag = excluded.breakfast_flag,
              source_file = excluded.source_file
          `).bind(
            childId, year, month, day,
            p.planned_start, p.planned_end,
            p.lunch_flag, p.am_snack_flag, p.pm_snack_flag, p.dinner_flag,
            p.breakfast_flag ?? 0, sf.name,
          ).run();
          stats.schedule_upserted++;
        }
      }
    }

    return c.json({
      success: true,
      year,
      month,
      stats,
      warnings,
      message: `インポート完了: 園児${stats.children_upserted}件, 出席${stats.attendance_upserted}件, 予定${stats.schedule_upserted}件`,
    });

  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('Import error:', message);
    return c.json({ error: `インポートエラー: ${message}`, warnings: [] }, 500);
  }
});

export default uploadRoutes;

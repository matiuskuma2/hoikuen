/**
 * Generate API Routes — v1.0
 * 
 * Phase A-3: Excel帳票生成エンドポイント
 * 
 * POST /api/generate/billing   — 請求明細Excel生成
 * POST /api/generate/daily     — 日報Excel生成
 * POST /api/generate/all       — 全帳票一括生成 → R2保存 → output_files記録
 * GET  /api/generate/download/:key — R2 からファイルダウンロード
 * 
 * Created: 2026-03-17
 */

import { Hono } from 'hono';
import { DEFAULT_NURSERY_ID, type HonoEnv, type Child, type UsageFact, type ChargeLine, type PricingRules, type SchedulePlan, type AttendanceRecord } from '../types/index';
import { generateBillingExcel, fetchBillingData } from '../lib/billing-generator';
import { generateDailyReportExcel, fetchDailyReportData } from '../lib/daily-report-generator';
import { generateChargeLines } from '../lib/charge-calculator';
import { computeUsageFact } from '../lib/usage-calculator';
import { getFiscalYear } from '../lib/age-class';

const generateRoutes = new Hono<HonoEnv>();

/** 年月バリデーション */
function validateYearMonth(year: unknown, month: unknown): { year: number; month: number } | string {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isInteger(y) || y < 2000 || y > 2100) return '年を正しく指定してください (2000-2100)';
  if (!Number.isInteger(m) || m < 1 || m > 12) return '月を正しく指定してください (1-12)';
  return { year: y, month: m };
}

// ═══════════════════════════════════
// POST /api/generate/compute — usage_facts & charge_lines を計算してDBに保存
// ═══════════════════════════════════
generateRoutes.post('/compute', async (c) => {
  try {
    const body = await c.req.json<{ year: number; month: number }>();
    const result = validateYearMonth(body.year, body.month);
    if (typeof result === 'string') return c.json({ error: result }, 400);
    const { year, month } = result;

    const db = c.env.DB;
    const nurseryId = DEFAULT_NURSERY_ID;

    // 1. Get all children
    const childrenResult = await db.prepare(
      `SELECT * FROM children WHERE nursery_id = ?`
    ).bind(nurseryId).all();
    const children = childrenResult.results as unknown as Child[];

    if (children.length === 0) {
      return c.json({ error: '園児マスタにデータがありません' }, 400);
    }

    // 2. Get pricing rules
    const fiscalYear = getFiscalYear(year, month);
    const rulesResult = await db.prepare(
      `SELECT rules_json FROM pricing_rules WHERE nursery_id = ? AND fiscal_year = ?`
    ).bind(nurseryId, fiscalYear).first();

    if (!rulesResult?.rules_json) {
      return c.json({ error: `${fiscalYear}年度の料金ルールが未設定です` }, 400);
    }

    const rules = JSON.parse(rulesResult.rules_json as string) as PricingRules;

    // 3. Get schedule_plans and attendance_records for this month
    const plansResult = await db.prepare(
      `SELECT * FROM schedule_plans WHERE year = ? AND month = ?`
    ).bind(year, month).all();
    const allPlans = plansResult.results as unknown as SchedulePlan[];

    const attendResult = await db.prepare(
      `SELECT * FROM attendance_records WHERE year = ? AND month = ?`
    ).bind(year, month).all();
    const allAttendance = attendResult.results as unknown as AttendanceRecord[];

    const daysInMonth = new Date(year, month, 0).getDate();
    const warnings: string[] = [];
    let totalFactsCreated = 0;
    let totalChargesCreated = 0;

    // 4. For each child, compute usage_facts
    for (const child of children) {
      const childPlans = allPlans.filter(p => p.child_id === child.id);
      const childAttend = allAttendance.filter(a => a.child_id === child.id);

      const facts: UsageFact[] = [];

      for (let day = 1; day <= daysInMonth; day++) {
        const plan = childPlans.find(p => p.day === day) || null;
        const actual = childAttend.find(a => a.day === day) || null;

        // Skip days with no data at all
        if (!plan && !actual) continue;

        const fact = computeUsageFact(child, plan, actual, rules, year, month, day);
        facts.push(fact);

        // UPSERT usage_fact
        await db.prepare(`
          INSERT INTO usage_facts (
            id, child_id, year, month, day,
            billing_start, billing_end, billing_minutes,
            is_early_morning, is_extension, is_night, is_sick,
            spot_30min_blocks,
            has_breakfast, has_lunch, has_am_snack, has_pm_snack, has_dinner,
            meal_allergy, attendance_status, exception_notes
          ) VALUES (
            lower(hex(randomblob(8))), ?, ?, ?, ?,
            ?, ?, ?,
            ?, ?, ?, ?,
            ?,
            ?, ?, ?, ?, ?,
            ?, ?, ?
          )
          ON CONFLICT(child_id, year, month, day) DO UPDATE SET
            billing_start = excluded.billing_start,
            billing_end = excluded.billing_end,
            billing_minutes = excluded.billing_minutes,
            is_early_morning = excluded.is_early_morning,
            is_extension = excluded.is_extension,
            is_night = excluded.is_night,
            is_sick = excluded.is_sick,
            spot_30min_blocks = excluded.spot_30min_blocks,
            has_breakfast = excluded.has_breakfast,
            has_lunch = excluded.has_lunch,
            has_am_snack = excluded.has_am_snack,
            has_pm_snack = excluded.has_pm_snack,
            has_dinner = excluded.has_dinner,
            meal_allergy = excluded.meal_allergy,
            attendance_status = excluded.attendance_status,
            exception_notes = excluded.exception_notes
        `).bind(
          child.id, year, month, day,
          fact.billing_start, fact.billing_end, fact.billing_minutes,
          fact.is_early_morning, fact.is_extension, fact.is_night, fact.is_sick,
          fact.spot_30min_blocks,
          fact.has_breakfast, fact.has_lunch, fact.has_am_snack, fact.has_pm_snack, fact.has_dinner,
          fact.meal_allergy, fact.attendance_status, fact.exception_notes,
        ).run();
        totalFactsCreated++;
      }

      // 5. Generate charge_lines for this child
      const chargeLines = generateChargeLines(child, facts, rules, year, month);

      // Delete existing charge_lines for this child/month, then insert
      await db.prepare(
        `DELETE FROM charge_lines WHERE child_id = ? AND year = ? AND month = ?`
      ).bind(child.id, year, month).run();

      for (const cl of chargeLines) {
        if (cl.subtotal === 0 && cl.quantity === 0) continue; // Skip zero charges
        await db.prepare(`
          INSERT INTO charge_lines (
            id, child_id, year, month, charge_type,
            quantity, unit_price, subtotal, notes
          ) VALUES (
            lower(hex(randomblob(8))), ?, ?, ?, ?,
            ?, ?, ?, ?
          )
        `).bind(
          child.id, year, month, cl.charge_type,
          cl.quantity, cl.unit_price, cl.subtotal, cl.notes,
        ).run();
        totalChargesCreated++;
      }
    }

    return c.json({
      success: true,
      year,
      month,
      children_processed: children.length,
      usage_facts_created: totalFactsCreated,
      charge_lines_created: totalChargesCreated,
      warnings,
    });

  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('Compute error:', message);
    return c.json({ error: `計算エラー: ${message}` }, 500);
  }
});

// ═══════════════════════════════════
// POST /api/generate/billing — 請求明細Excel生成
// ═══════════════════════════════════
generateRoutes.post('/billing', async (c) => {
  try {
    const body = await c.req.json<{ year: number; month: number }>();
    const result = validateYearMonth(body.year, body.month);
    if (typeof result === 'string') return c.json({ error: result }, 400);
    const { year, month } = result;

    const { rows, rules, warnings } = await fetchBillingData(c.env.DB, DEFAULT_NURSERY_ID, year, month);

    const buf = generateBillingExcel(rows, year, month, rules);
    const fileName = `請求明細_${year}年${month}月.xlsx`;

    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'X-Warnings': JSON.stringify(warnings),
      },
    });

  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('Billing generate error:', message);
    return c.json({ error: `請求明細生成エラー: ${message}` }, 500);
  }
});

// ═══════════════════════════════════
// POST /api/generate/daily — 日報Excel生成
// ═══════════════════════════════════
generateRoutes.post('/daily', async (c) => {
  try {
    const body = await c.req.json<{ year: number; month: number }>();
    const result = validateYearMonth(body.year, body.month);
    if (typeof result === 'string') return c.json({ error: result }, 400);
    const { year, month } = result;

    const { input, warnings } = await fetchDailyReportData(c.env.DB, DEFAULT_NURSERY_ID, year, month);

    const buf = generateDailyReportExcel(input);
    const fileName = `日報_${year}年${month}月.xlsx`;

    return new Response(buf, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'X-Warnings': JSON.stringify(warnings),
      },
    });

  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('Daily report generate error:', message);
    return c.json({ error: `日報生成エラー: ${message}` }, 500);
  }
});

// ═══════════════════════════════════
// POST /api/generate/all — 全帳票一括生成（計算→Excel→R2→output_files）
// ═══════════════════════════════════
generateRoutes.post('/all', async (c) => {
  try {
    const body = await c.req.json<{ year: number; month: number }>();
    const result = validateYearMonth(body.year, body.month);
    if (typeof result === 'string') return c.json({ error: result }, 400);
    const { year, month } = result;

    const db = c.env.DB;
    const r2 = c.env.R2;
    const nurseryId = DEFAULT_NURSERY_ID;
    const allWarnings: string[] = [];

    // Step 1: Create job record
    const jobId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    await db.prepare(`
      INSERT INTO jobs (id, nursery_id, year, month, status, started_at)
      VALUES (?, ?, ?, ?, 'generating', datetime('now'))
    `).bind(jobId, nurseryId, year, month).run();

    try {
      // Step 2: Compute usage_facts and charge_lines
      // (reuse compute logic inline)
      const childrenResult = await db.prepare(
        `SELECT * FROM children WHERE nursery_id = ?`
      ).bind(nurseryId).all();
      const children = childrenResult.results as unknown as Child[];

      if (children.length === 0) {
        throw new Error('園児マスタにデータがありません');
      }

      const fiscalYear = getFiscalYear(year, month);
      const rulesResult = await db.prepare(
        `SELECT rules_json FROM pricing_rules WHERE nursery_id = ? AND fiscal_year = ?`
      ).bind(nurseryId, fiscalYear).first();

      if (!rulesResult?.rules_json) {
        throw new Error(`${fiscalYear}年度の料金ルールが未設定です`);
      }

      const rules = JSON.parse(rulesResult.rules_json as string) as PricingRules;

      const plansResult = await db.prepare(
        `SELECT * FROM schedule_plans WHERE year = ? AND month = ?`
      ).bind(year, month).all();
      const allPlans = plansResult.results as unknown as SchedulePlan[];

      const attendResult = await db.prepare(
        `SELECT * FROM attendance_records WHERE year = ? AND month = ?`
      ).bind(year, month).all();
      const allAttendance = attendResult.results as unknown as AttendanceRecord[];

      const daysInMonth = new Date(year, month, 0).getDate();

      // Compute for each child
      for (const child of children) {
        const childPlans = allPlans.filter(p => p.child_id === child.id);
        const childAttend = allAttendance.filter(a => a.child_id === child.id);
        const facts: UsageFact[] = [];

        for (let day = 1; day <= daysInMonth; day++) {
          const plan = childPlans.find(p => p.day === day) || null;
          const actual = childAttend.find(a => a.day === day) || null;
          if (!plan && !actual) continue;

          const fact = computeUsageFact(child, plan, actual, rules, year, month, day);
          facts.push(fact);

          await db.prepare(`
            INSERT INTO usage_facts (
              id, child_id, year, month, day,
              billing_start, billing_end, billing_minutes,
              is_early_morning, is_extension, is_night, is_sick,
              spot_30min_blocks,
              has_breakfast, has_lunch, has_am_snack, has_pm_snack, has_dinner,
              meal_allergy, attendance_status, exception_notes
            ) VALUES (
              lower(hex(randomblob(8))), ?, ?, ?, ?,
              ?, ?, ?,
              ?, ?, ?, ?,
              ?,
              ?, ?, ?, ?, ?,
              ?, ?, ?
            )
            ON CONFLICT(child_id, year, month, day) DO UPDATE SET
              billing_start = excluded.billing_start,
              billing_end = excluded.billing_end,
              billing_minutes = excluded.billing_minutes,
              is_early_morning = excluded.is_early_morning,
              is_extension = excluded.is_extension,
              is_night = excluded.is_night,
              is_sick = excluded.is_sick,
              spot_30min_blocks = excluded.spot_30min_blocks,
              has_breakfast = excluded.has_breakfast,
              has_lunch = excluded.has_lunch,
              has_am_snack = excluded.has_am_snack,
              has_pm_snack = excluded.has_pm_snack,
              has_dinner = excluded.has_dinner,
              meal_allergy = excluded.meal_allergy,
              attendance_status = excluded.attendance_status,
              exception_notes = excluded.exception_notes
          `).bind(
            child.id, year, month, day,
            fact.billing_start, fact.billing_end, fact.billing_minutes,
            fact.is_early_morning, fact.is_extension, fact.is_night, fact.is_sick,
            fact.spot_30min_blocks,
            fact.has_breakfast, fact.has_lunch, fact.has_am_snack, fact.has_pm_snack, fact.has_dinner,
            fact.meal_allergy, fact.attendance_status, fact.exception_notes,
          ).run();
        }

        // Generate charge_lines
        const chargeLines = generateChargeLines(child, facts, rules, year, month);
        await db.prepare(
          `DELETE FROM charge_lines WHERE child_id = ? AND year = ? AND month = ?`
        ).bind(child.id, year, month).run();

        for (const cl of chargeLines) {
          if (cl.subtotal === 0 && cl.quantity === 0) continue;
          await db.prepare(`
            INSERT INTO charge_lines (
              id, child_id, year, month, charge_type,
              quantity, unit_price, subtotal, notes
            ) VALUES (
              lower(hex(randomblob(8))), ?, ?, ?, ?,
              ?, ?, ?, ?
            )
          `).bind(
            child.id, year, month, cl.charge_type,
            cl.quantity, cl.unit_price, cl.subtotal, cl.notes,
          ).run();
        }
      }

      // Step 3: Generate Billing Excel
      const { rows: billingRows, rules: billingRules, warnings: billingWarnings } =
        await fetchBillingData(db, nurseryId, year, month);
      allWarnings.push(...billingWarnings);

      const billingBuf = generateBillingExcel(billingRows, year, month, billingRules);
      const billingFileName = `請求明細_${year}年${month}月.xlsx`;
      const billingR2Key = `output/${jobId}/${billingFileName}`;

      await r2.put(billingR2Key, billingBuf, {
        httpMetadata: {
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      });

      await db.prepare(`
        INSERT INTO output_files (id, job_id, file_type, file_name, r2_key, file_size, content_type)
        VALUES (lower(hex(randomblob(8))), ?, 'billing_excel', ?, ?, ?, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      `).bind(jobId, billingFileName, billingR2Key, billingBuf.byteLength).run();

      // Step 4: Generate Daily Report Excel
      const { input: dailyInput, warnings: dailyWarnings } =
        await fetchDailyReportData(db, nurseryId, year, month);
      allWarnings.push(...dailyWarnings);

      const dailyBuf = generateDailyReportExcel(dailyInput);
      const dailyFileName = `日報_${year}年${month}月.xlsx`;
      const dailyR2Key = `output/${jobId}/${dailyFileName}`;

      await r2.put(dailyR2Key, dailyBuf, {
        httpMetadata: {
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
      });

      await db.prepare(`
        INSERT INTO output_files (id, job_id, file_type, file_name, r2_key, file_size, content_type)
        VALUES (lower(hex(randomblob(8))), ?, 'daily_report_excel', ?, ?, ?, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      `).bind(jobId, dailyFileName, dailyR2Key, dailyBuf.byteLength).run();

      // Step 5: Generate meta.json summary
      const meta = {
        job_id: jobId,
        year,
        month,
        generated_at: new Date().toISOString(),
        children_count: children.length,
        files: [
          { type: 'billing_excel', name: billingFileName, r2_key: billingR2Key },
          { type: 'daily_report_excel', name: dailyFileName, r2_key: dailyR2Key },
        ],
        warnings: allWarnings,
      };

      const metaR2Key = `output/${jobId}/meta.json`;
      await r2.put(metaR2Key, JSON.stringify(meta, null, 2), {
        httpMetadata: { contentType: 'application/json' },
      });

      // Step 6: Update job status
      await db.prepare(`
        UPDATE jobs SET
          status = 'completed',
          progress_pct = 100,
          warnings_json = ?,
          completed_at = datetime('now')
        WHERE id = ?
      `).bind(JSON.stringify(allWarnings), jobId).run();

      return c.json({
        success: true,
        job_id: jobId,
        year,
        month,
        files: [
          {
            type: 'billing_excel',
            name: billingFileName,
            download_url: `/api/generate/download/${encodeURIComponent(billingR2Key)}`,
          },
          {
            type: 'daily_report_excel',
            name: dailyFileName,
            download_url: `/api/generate/download/${encodeURIComponent(dailyR2Key)}`,
          },
        ],
        warnings: allWarnings,
        children_processed: children.length,
      });

    } catch (innerErr) {
      // Update job as failed
      const innerMessage = innerErr instanceof Error ? innerErr.message : String(innerErr);
      await db.prepare(`
        UPDATE jobs SET
          status = 'failed',
          error_json = ?,
          completed_at = datetime('now')
        WHERE id = ?
      `).bind(JSON.stringify({ error: innerMessage }), jobId).run();
      throw innerErr;
    }

  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('Generate all error:', message);
    return c.json({ error: `一括生成エラー: ${message}` }, 500);
  }
});

// ═══════════════════════════════════
// GET /api/generate/download/:key — R2 からファイルダウンロード
// ═══════════════════════════════════
generateRoutes.get('/download/*', async (c) => {
  try {
    const r2Key = c.req.path.replace('/api/generate/download/', '');
    const decodedKey = decodeURIComponent(r2Key);

    const r2 = c.env.R2;
    const object = await r2.get(decodedKey);

    if (!object) {
      return c.json({ error: 'ファイルが見つかりません' }, 404);
    }

    const fileName = decodedKey.split('/').pop() || 'download';

    return new Response(object.body, {
      status: 200,
      headers: {
        'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      },
    });

  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('Download error:', message);
    return c.json({ error: `ダウンロードエラー: ${message}` }, 500);
  }
});

export default generateRoutes;

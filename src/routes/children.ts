/**
 * Children API Routes — v2.0
 * 
 * GET    /api/children           - List all children
 * POST   /api/children           - Create a new child
 * PUT    /api/children/:id       - Update a child
 * DELETE /api/children/:id       - Delete a child
 *
 * Birth date → age_class auto-calculation on create/update
 */

import { Hono } from 'hono';
import type { HonoEnv } from '../types/index';
import { getAgeClassFromBirthDate, getFiscalYear, ageClassToLabel } from '../lib/age-class';

const childRoutes = new Hono<HonoEnv>();

const NURSERY_ID = 'ayukko_001';

// ── List all children ──
childRoutes.get('/', async (c) => {
  const db = c.env.DB;

  const result = await db.prepare(`
    SELECT * FROM children 
    WHERE nursery_id = ? 
    ORDER BY 
      CASE enrollment_type WHEN '月極' THEN 0 ELSE 1 END,
      age_class ASC, 
      birth_date ASC,
      name ASC
  `).bind(NURSERY_ID).all();

  return c.json({
    children: result.results,
    total: result.results.length,
  });
});

// ── Create a new child ──
childRoutes.post('/', async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'リクエストのJSONが不正です' }, 400);
  }

  const name = String(body.name || '').trim();
  if (!name) {
    return c.json({ error: '名前は必須です' }, 400);
  }

  const enrollmentType = String(body.enrollment_type || '月極');
  if (!['月極', '一時'].includes(enrollmentType)) {
    return c.json({ error: '利用区分は「月極」または「一時」です' }, 400);
  }

  const birthDate = body.birth_date ? String(body.birth_date) : null;
  const nameKana = body.name_kana ? String(body.name_kana) : null;
  const lukumiId = body.lukumi_id ? String(body.lukumi_id) : null;
  const childOrder = body.child_order ? Number(body.child_order) : 1;
  const isAllergy = body.is_allergy ? 1 : 0;

  // Auto-calculate age_class from birth_date
  let ageClass: number | null = null;
  if (birthDate && enrollmentType === '月極') {
    const now = new Date();
    const fy = getFiscalYear(now.getFullYear(), now.getMonth() + 1);
    ageClass = getAgeClassFromBirthDate(birthDate, fy);
  }
  // If enrollment is 一時, age_class can still be calculated but class_name will show 一時
  if (birthDate && enrollmentType === '一時') {
    const now = new Date();
    const fy = getFiscalYear(now.getFullYear(), now.getMonth() + 1);
    ageClass = getAgeClassFromBirthDate(birthDate, fy);
  }

  const db = c.env.DB;
  const childId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);

  await db.prepare(`
    INSERT INTO children (id, nursery_id, lukumi_id, name, name_kana, birth_date, age_class, enrollment_type, child_order, is_allergy)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(childId, NURSERY_ID, lukumiId, name, nameKana, birthDate, ageClass, enrollmentType, childOrder, isAllergy).run();

  const created = await db.prepare('SELECT * FROM children WHERE id = ?').bind(childId).first();
  return c.json(created, 201);
});

// ── Update a child ──
childRoutes.put('/:id', async (c) => {
  const childId = c.req.param('id');
  const db = c.env.DB;

  const child = await db.prepare('SELECT * FROM children WHERE id = ?').bind(childId).first();
  if (!child) {
    return c.json({ error: '園児が見つかりません' }, 404);
  }

  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'リクエストのJSONが不正です' }, 400);
  }

  const updates: string[] = [];
  const values: unknown[] = [];

  const allowedFields = ['name', 'name_kana', 'lukumi_id', 'enrollment_type', 'child_order', 'birth_date', 'is_allergy'];
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(body[field]);
    }
  }

  // Auto-recalculate age_class when birth_date or enrollment_type changes
  const newBirthDate = body.birth_date !== undefined ? String(body.birth_date) : (child.birth_date as string);
  const newEnrollType = body.enrollment_type !== undefined ? String(body.enrollment_type) : (child.enrollment_type as string);

  if (newBirthDate) {
    const now = new Date();
    const fy = getFiscalYear(now.getFullYear(), now.getMonth() + 1);
    const newAgeClass = getAgeClassFromBirthDate(newBirthDate, fy);
    updates.push('age_class = ?');
    values.push(newAgeClass);
  }

  if (updates.length === 0) {
    return c.json({ error: '更新するフィールドがありません' }, 400);
  }

  updates.push("updated_at = datetime('now')");
  values.push(childId);

  await db.prepare(`
    UPDATE children SET ${updates.join(', ')} WHERE id = ?
  `).bind(...values).run();

  const updated = await db.prepare('SELECT * FROM children WHERE id = ?').bind(childId).first();
  return c.json(updated);
});

// ── Delete a child ──
childRoutes.delete('/:id', async (c) => {
  const childId = c.req.param('id');
  const db = c.env.DB;

  const child = await db.prepare('SELECT * FROM children WHERE id = ?').bind(childId).first();
  if (!child) {
    return c.json({ error: '園児が見つかりません' }, 404);
  }

  // Delete related records first
  await db.prepare('DELETE FROM schedule_plans WHERE child_id = ?').bind(childId).run();
  await db.prepare('DELETE FROM attendance_records WHERE child_id = ?').bind(childId).run();
  await db.prepare('DELETE FROM usage_facts WHERE child_id = ?').bind(childId).run();
  await db.prepare('DELETE FROM charge_lines WHERE child_id = ?').bind(childId).run();
  await db.prepare('DELETE FROM children WHERE id = ?').bind(childId).run();

  return c.json({ message: '園児を削除しました', id: childId });
});

export default childRoutes;

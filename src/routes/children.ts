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
import { DEFAULT_NURSERY_ID, type HonoEnv } from '../types/index';
import { getAgeClassFromBirthDate, getFiscalYear, ageClassToLabel } from '../lib/age-class';

const childRoutes = new Hono<HonoEnv>();

const NURSERY_ID = DEFAULT_NURSERY_ID;

// ── List all children ──
childRoutes.get('/', async (c) => {
  try {
    const db = c.env.DB;
    if (!db) return c.json({ error: 'データベース接続が利用できません' }, 500);

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
  } catch (e: any) {
    console.error('Children list error:', e);
    return c.json({ error: e.message || '園児一覧取得エラー' }, 500);
  }
});

// ── Create a new child ──
childRoutes.post('/', async (c) => {
  try {
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
    if (birthDate) {
      const now = new Date();
      const fy = getFiscalYear(now.getFullYear(), now.getMonth() + 1);
      ageClass = getAgeClassFromBirthDate(birthDate, fy);
    }

    const db = c.env.DB;
    if (!db) return c.json({ error: 'データベース接続が利用できません' }, 500);
    const childId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    // view_token: 保護者カレンダーURL用のランダムトークン (32文字hex)
    const viewToken = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');

    await db.prepare(`
      INSERT INTO children (id, nursery_id, lukumi_id, name, name_kana, birth_date, age_class, enrollment_type, child_order, is_allergy, view_token)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(childId, NURSERY_ID, lukumiId, name, nameKana, birthDate, ageClass, enrollmentType, childOrder, isAllergy, viewToken).run();

    const created = await db.prepare('SELECT * FROM children WHERE id = ?').bind(childId).first();
    return c.json(created, 201);
  } catch (e: any) {
    console.error('Children create error:', e);
    return c.json({ error: e.message || '園児登録エラー' }, 500);
  }
});

// ── Update a child ──
childRoutes.put('/:id', async (c) => {
  try {
    const childId = c.req.param('id');
    const db = c.env.DB;
    if (!db) return c.json({ error: 'データベース接続が利用できません' }, 500);

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
  } catch (e: any) {
    console.error('Children update error:', e);
    return c.json({ error: e.message || '園児更新エラー' }, 500);
  }
});

// ── Delete a child ──
childRoutes.delete('/:id', async (c) => {
  try {
    const childId = c.req.param('id');
    const db = c.env.DB;
    if (!db) return c.json({ error: 'データベース接続が利用できません' }, 500);

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
  } catch (e: any) {
    console.error('Children delete error:', e);
    return c.json({ error: e.message || '園児削除エラー' }, 500);
  }
});

export default childRoutes;

// ── view_token 再発行エンドポイント ──
// POST /api/children/:id/regenerate-token
childRoutes.post('/:id/regenerate-token', async (c) => {
  try {
    const childId = c.req.param('id');
    const db = c.env.DB;
    if (!db) return c.json({ error: 'データベース接続が利用できません' }, 500);

    const child = await db.prepare('SELECT id FROM children WHERE id = ?').bind(childId).first();
    if (!child) return c.json({ error: '園児が見つかりません' }, 404);

    const newToken = Array.from(crypto.getRandomValues(new Uint8Array(16))).map(b => b.toString(16).padStart(2, '0')).join('');
    await db.prepare("UPDATE children SET view_token = ?, updated_at = datetime('now') WHERE id = ?").bind(newToken, childId).run();

    return c.json({ id: childId, view_token: newToken, message: 'トークンを再発行しました' });
  } catch (e: any) {
    console.error('Token regenerate error:', e);
    return c.json({ error: e.message || 'トークン再発行エラー' }, 500);
  }
});

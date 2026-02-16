/**
 * Children API Routes
 * GET  /api/children      - List all children
 * PUT  /api/children/:id  - Update child info
 */

import { Hono } from 'hono';
import type { HonoEnv } from '../types/index';

const childRoutes = new Hono<HonoEnv>();

// List all children
childRoutes.get('/', async (c) => {
  const db = c.env.DB;
  const nurseryId = 'ayukko_001';

  const result = await db.prepare(`
    SELECT * FROM children 
    WHERE nursery_id = ? 
    ORDER BY age_class ASC, name ASC
  `).bind(nurseryId).all();

  return c.json({
    children: result.results,
    total: result.results.length,
  });
});

// Update child info
childRoutes.put('/:id', async (c) => {
  const childId = c.req.param('id');
  const body = await c.req.json();
  const db = c.env.DB;

  const child = await db.prepare('SELECT * FROM children WHERE id = ?').bind(childId).first();
  if (!child) {
    return c.json({ error: '園児が見つかりません' }, 404);
  }

  const updates: string[] = [];
  const values: unknown[] = [];

  const allowedFields = ['name', 'name_kana', 'lukumi_id', 'age_class', 'enrollment_type', 'child_order'];
  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(body[field]);
    }
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

export default childRoutes;

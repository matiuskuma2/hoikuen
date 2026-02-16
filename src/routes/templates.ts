/**
 * Template & Pricing API Routes
 */

import { Hono } from 'hono';
import type { HonoEnv } from '../types/index';

const templateRoutes = new Hono<HonoEnv>();

// List templates
templateRoutes.get('/', async (c) => {
  const db = c.env.DB;
  const nurseryId = 'ayukko_001';

  const result = await db.prepare(`
    SELECT id, template_type, file_name, uploaded_at 
    FROM templates WHERE nursery_id = ?
  `).bind(nurseryId).all();

  return c.json({ templates: result.results });
});

// Upload template
templateRoutes.post('/upload', async (c) => {
  const db = c.env.DB;
  const r2 = c.env.R2;
  const nurseryId = 'ayukko_001';

  const formData = await c.req.formData();
  const file = formData.get('file') as File | null;
  const templateType = formData.get('template_type') as string | null;

  if (!file || !templateType) {
    return c.json({ error: 'ファイルとテンプレートタイプが必要です' }, 400);
  }

  const validTypes = ['daily_report', 'billing_detail', 'parent_statement'];
  if (!validTypes.includes(templateType)) {
    return c.json({ error: `テンプレートタイプは ${validTypes.join(', ')} のいずれかです` }, 400);
  }

  const r2Key = `templates/${nurseryId}/${templateType}/${file.name}`;
  const arrayBuffer = await file.arrayBuffer();
  await r2.put(r2Key, arrayBuffer);

  // Upsert template record
  const templateId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  await db.prepare(`
    INSERT INTO templates (id, nursery_id, template_type, file_name, r2_key, mapping_json)
    VALUES (?, ?, ?, ?, ?, '{}')
    ON CONFLICT(nursery_id, template_type) DO UPDATE SET
      file_name = excluded.file_name,
      r2_key = excluded.r2_key,
      uploaded_at = datetime('now')
  `).bind(templateId, nurseryId, templateType, file.name, r2Key).run();

  return c.json({
    message: 'テンプレートをアップロードしました',
    template_type: templateType,
    file_name: file.name,
  });
});

// Get pricing rules
templateRoutes.get('/pricing', async (c) => {
  const db = c.env.DB;
  const nurseryId = 'ayukko_001';

  const result = await db.prepare(`
    SELECT * FROM pricing_rules WHERE nursery_id = ? ORDER BY fiscal_year DESC LIMIT 1
  `).bind(nurseryId).first();

  if (!result) {
    return c.json({ error: '料金ルールが設定されていません', default_available: true }, 404);
  }

  return c.json({
    ...result,
    rules: JSON.parse(result.rules_json as string),
  });
});

// Set pricing rules
templateRoutes.post('/pricing', async (c) => {
  const db = c.env.DB;
  const nurseryId = 'ayukko_001';
  const body = await c.req.json();

  const { fiscal_year, rules } = body;
  if (!fiscal_year || !rules) {
    return c.json({ error: '年度と料金ルールが必要です' }, 400);
  }

  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  await db.prepare(`
    INSERT INTO pricing_rules (id, nursery_id, fiscal_year, rules_json)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(nursery_id, fiscal_year) DO UPDATE SET
      rules_json = excluded.rules_json,
      extracted_at = datetime('now')
  `).bind(id, nurseryId, fiscal_year, JSON.stringify(rules)).run();

  return c.json({ message: '料金ルールを保存しました', fiscal_year });
});

export default templateRoutes;

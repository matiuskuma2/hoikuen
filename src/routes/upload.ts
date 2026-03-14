/**
 * アップロード→ダッシュボード API ルート — v2.0
 * Python Generator の /dashboard エンドポイントを TypeScript で完全置換
 * dashboard-builder.ts の共通関数を使用
 *
 * v2.0: dashboard-builder.ts に統合、重複コード解消
 */
import { Hono } from 'hono';
import type { HonoEnv } from '../types/index';
import { buildDashboardFromFormData } from '../lib/dashboard-builder';

const uploadRoutes = new Hono<HonoEnv>();

// ── POST /api/upload/dashboard ──
// multipart/form-data: year, month, lukumi_file?, schedule_files[]
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

export default uploadRoutes;

/**
 * LIFF (LINE Front-end Framework) API Routes
 * 
 * GET  /api/liff/me       — LINE userId から連携状態・紐付き園児・view_token を返す
 * POST /api/liff/link     — Web経由でLINE連携（userId + 連携コード → 園児紐付け）
 * 
 * これらは LIFF起動ページ (/line/entry) のフロントエンドから呼ばれる。
 * LINE Webhook経由の連携とは別経路。
 */

import { Hono } from 'hono';
import { DEFAULT_NURSERY_ID, type HonoEnv } from '../types/index';
import {
  findLineAccount,
  getLinkedChildren,
  verifyAndLinkCode,
} from '../lib/conversation';

const liffRoutes = new Hono<HonoEnv>();

// ============================================================
// GET /me — 連携状態確認
// ============================================================
liffRoutes.get('/me', async (c) => {
  try {
    const lineUserId = c.req.query('line_user_id');
    if (!lineUserId || !/^U[0-9a-f]{32}$/i.test(lineUserId)) {
      return c.json({ error: 'line_user_id は必須です（U + 32文字hex）' }, 400);
    }

    const db = c.env.DB;
    if (!db) return c.json({ error: 'データベース接続が利用できません' }, 500);

    // LINE アカウント検索
    const account = await findLineAccount(db, lineUserId);

    if (!account) {
      return c.json({
        linked: false,
        line_user_id: lineUserId,
      });
    }

    // 紐付き園児取得（view_token 含む）
    const children = await getLinkedChildren(db, lineUserId);

    return c.json({
      linked: true,
      line_user_id: lineUserId,
      display_name: account.display_name,
      children: children.map((ch) => ({
        child_id: ch.id,
        name: ch.name,
        enrollment_type: ch.enrollment_type,
        view_token: ch.view_token,
      })),
    });
  } catch (e: any) {
    console.error('[LIFF] /me error:', e);
    return c.json({ error: e.message || '連携状態取得エラー' }, 500);
  }
});

// ============================================================
// POST /link — Web経由連携
// ============================================================
liffRoutes.post('/link', async (c) => {
  try {
    let body: {
      line_user_id: string;
      code: string;
      display_name?: string;
    };

    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'リクエストのJSONが不正です' }, 400);
    }

    const { line_user_id, code, display_name } = body;

    // バリデーション
    if (!line_user_id || !/^U[0-9a-f]{32}$/i.test(line_user_id)) {
      return c.json({ error: 'line_user_id は必須です（U + 32文字hex）' }, 400);
    }
    if (!code || !/^AYK-\d{4}$/i.test(code)) {
      return c.json({ error: '連携コードの形式が不正です（AYK-XXXX）' }, 400);
    }

    const db = c.env.DB;
    if (!db) return c.json({ error: 'データベース接続が利用できません' }, 500);

    // 既に連携済みかチェック
    const existingAccount = await findLineAccount(db, line_user_id);
    if (existingAccount) {
      const existingChildren = await getLinkedChildren(db, line_user_id);
      if (existingChildren.length > 0) {
        // 追加連携：新しいコードで追加の園児を紐付ける
        // （兄弟のコードを後から入力するケース）
        const result = await verifyAndLinkCode(db, line_user_id, code, display_name ?? null);
        if (!result) {
          return c.json({
            error: '連携コードが無効です。コードをもう一度ご確認ください。',
            hint: '既に使用済みのコード、有効期限切れ、または対象園児が未設定の可能性があります。',
          }, 400);
        }

        // 追加分を含めた全園児を返す
        const allChildren = await getLinkedChildren(db, line_user_id);
        return c.json({
          success: true,
          message: '追加の園児を連携しました',
          children: allChildren.map((ch) => ({
            child_id: ch.id,
            name: ch.name,
            enrollment_type: ch.enrollment_type,
            view_token: ch.view_token,
          })),
        });
      }
    }

    // 新規連携
    const result = await verifyAndLinkCode(db, line_user_id, code, display_name ?? null);
    if (!result) {
      return c.json({
        error: '連携コードが無効です。コードをもう一度ご確認ください。',
        hint: '既に使用済みのコード、有効期限切れ、または対象園児が未設定の可能性があります。',
      }, 400);
    }

    // 連携成功 → 紐付いた園児のview_tokenを返す
    const linkedChildren = await getLinkedChildren(db, line_user_id);
    return c.json({
      success: true,
      message: '連携が完了しました',
      children: linkedChildren.map((ch) => ({
        child_id: ch.id,
        name: ch.name,
        enrollment_type: ch.enrollment_type,
        view_token: ch.view_token,
      })),
    });
  } catch (e: any) {
    console.error('[LIFF] /link error:', e);
    return c.json({ error: e.message || '連携エラー' }, 500);
  }
});

export default liffRoutes;

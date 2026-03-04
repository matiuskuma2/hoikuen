/**
 * LINE Webhook & Management Routes
 * 
 * POST /api/line/webhook  — LINE Platform からの webhook 受信
 * GET  /api/line/health    — LINE 連携ステータス確認
 * 
 * 設計方針:
 *  - 署名検証を必ず行う (HMAC-SHA256)
 *  - 200 OK を迅速に返す (LINE Platform の 1 秒タイムアウト対策)
 *  - イベント処理は waitUntil で非同期実行
 *  - 食事推定はしない: 不足情報は保護者に質問で確認
 */

import { Hono } from 'hono';
import type { HonoEnv } from '../types/index';
import {
  verifySignature,
  replyMessage,
  type LineEvent,
  type LineWebhookBody,
} from '../lib/line-client';

// Bindings に LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN を追加
type LineBindings = {
  DB: D1Database;
  R2: R2Bucket;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
};

type LineEnv = { Bindings: LineBindings };

const lineRoutes = new Hono<LineEnv>();

// ============================================================
// POST /webhook — LINE Platform が呼び出す
// ============================================================
lineRoutes.post('/webhook', async (c) => {
  const secret = c.env.LINE_CHANNEL_SECRET;

  // 1. Channel Secret が設定されていなければ 500
  if (!secret) {
    console.error('[LINE] LINE_CHANNEL_SECRET is not configured');
    return c.json({ error: 'LINE not configured' }, 500);
  }

  // 2. 署名検証
  const signature = c.req.header('x-line-signature') ?? '';
  const rawBody = await c.req.text();

  const valid = await verifySignature(rawBody, signature, secret);
  if (!valid) {
    console.warn('[LINE] Invalid signature — rejected');
    return c.json({ error: 'Invalid signature' }, 403);
  }

  // 3. 即座に 200 OK を返す (LINE は 1 秒以内の応答を要求)
  //    イベント処理は waitUntil で非同期実行
  const body: LineWebhookBody = JSON.parse(rawBody);

  // Cloudflare Workers の executionCtx.waitUntil を取得
  const ctx = c.executionCtx;
  if (ctx && 'waitUntil' in ctx) {
    ctx.waitUntil(handleEvents(body.events, c.env));
  } else {
    // フォールバック: 同期処理 (ローカル開発時)
    await handleEvents(body.events, c.env);
  }

  return c.json({ status: 'ok' });
});

// ============================================================
// GET /health — LINE 連携の稼働確認
// ============================================================
lineRoutes.get('/health', async (c) => {
  const hasSecret = !!c.env.LINE_CHANNEL_SECRET;
  const hasToken = !!c.env.LINE_CHANNEL_ACCESS_TOKEN;

  return c.json({
    line_integration: 'active',
    channel_secret_configured: hasSecret,
    channel_access_token_configured: hasToken,
    webhook_path: '/api/line/webhook',
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// イベントハンドラー
// ============================================================

async function handleEvents(events: LineEvent[], env: LineBindings): Promise<void> {
  for (const event of events) {
    try {
      await handleSingleEvent(event, env);
    } catch (err) {
      console.error(`[LINE] Error handling event ${event.type}:`, err);
    }
  }
}

async function handleSingleEvent(event: LineEvent, env: LineBindings): Promise<void> {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return;

  switch (event.type) {
    // --- 友だち追加 ---
    case 'follow': {
      if (event.replyToken) {
        await replyMessage(
          event.replyToken,
          [
            {
              type: 'text',
              text: 'あゆっこ保育所です🌟\n友だち追加ありがとうございます！\n\nこちらから毎月の利用予定を提出できるようになります。\n\n連携コードをお持ちの方は、コードを入力してください。\n（例: AYK-1234）',
            },
          ],
          token,
        );
      }
      console.log(`[LINE] follow: userId=${event.source.userId}`);
      break;
    }

    // --- ブロック ---
    case 'unfollow': {
      console.log(`[LINE] unfollow: userId=${event.source.userId}`);
      break;
    }

    // --- テキストメッセージ ---
    case 'message': {
      if (event.message?.type === 'text' && event.replyToken) {
        const text = event.message.text ?? '';
        await handleTextMessage(text, event.replyToken, event.source.userId ?? '', token, env);
      }
      break;
    }

    // --- Postback ---
    case 'postback': {
      console.log(`[LINE] postback: data=${event.postback?.data}, userId=${event.source.userId}`);
      break;
    }

    default:
      console.log(`[LINE] Unhandled event type: ${event.type}`);
  }
}

// ============================================================
// テキストメッセージ処理 (初期実装: エコー + 連携コード認識)
// ============================================================

async function handleTextMessage(
  text: string,
  replyToken: string,
  _userId: string,
  channelAccessToken: string,
  _env: LineBindings,
): Promise<void> {
  // 連携コードパターン: AYK-XXXX
  const linkCodePattern = /^AYK-\d{4}$/i;

  if (linkCodePattern.test(text.trim())) {
    // 連携コードを受信 — 将来的に link_codes テーブルで検証
    await replyMessage(
      replyToken,
      [
        {
          type: 'text',
          text: `連携コード「${text.trim().toUpperCase()}」を受け付けました。\n\n現在、アカウント連携機能を準備中です。\nもう少々お待ちください🙇`,
        },
      ],
      channelAccessToken,
    );
    return;
  }

  // デフォルト応答
  await replyMessage(
    replyToken,
    [
      {
        type: 'text',
        text: 'メッセージを受信しました。\n\n利用予定の提出機能は現在準備中です。\n連携コードをお持ちの方は「AYK-XXXX」の形式で入力してください。',
      },
    ],
    channelAccessToken,
  );
}

export default lineRoutes;

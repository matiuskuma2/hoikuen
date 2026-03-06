/**
 * LINE Webhook & 会話フロー Routes
 * 
 * POST /api/line/webhook  — LINE Platform からの webhook 受信
 * GET  /api/line/health    — LINE 連携ステータス確認
 * 
 * Phase 1 MVP:
 *  - 状態機械で会話管理（LLM不使用）
 *  - 固定フォーマット入力のみ
 *  - 1LINEユーザー → 複数児童対応（Phase 1では最初の1人自動選択）
 *  - 入力: 日付・登園時間・降園時間のみ（食事は園側管理）
 */

import { Hono } from 'hono';
import type { HonoEnv } from '../types/index';
import {
  verifySignature,
  replyMessage,
  getProfile,
  type LineEvent,
  type LineWebhookBody,
} from '../lib/line-client';
import {
  getOrCreateConversation,
  updateConversation,
  findLineAccount,
  verifyAndLinkCode,
  getLinkedChildren,
  parseScheduleInput,
  saveScheduleEntries,
  logConversation,
  getDraftEntries,
  mergeDraftEntries,
  formatDraftForConfirmation,
  type ConversationState,
  type DraftEntry,
} from '../lib/conversation';

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

  if (!secret) {
    console.error('[LINE] LINE_CHANNEL_SECRET is not configured');
    return c.json({ error: 'LINE not configured' }, 500);
  }

  const signature = c.req.header('x-line-signature') ?? '';
  const rawBody = await c.req.text();

  const valid = await verifySignature(rawBody, signature, secret);
  if (!valid) {
    console.warn('[LINE] Invalid signature — rejected');
    return c.json({ error: 'Invalid signature' }, 403);
  }

  const body: LineWebhookBody = JSON.parse(rawBody);

  // Cloudflare Workers の executionCtx.waitUntil を取得
  const ctx = c.executionCtx;
  if (ctx && 'waitUntil' in ctx) {
    ctx.waitUntil(handleEvents(body.events, c.env));
  } else {
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
    phase: 'Phase 1 MVP (state-machine, fixed-format)',
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
  const db = env.DB;
  if (!token || !db) return;

  const userId = event.source.userId ?? '';
  if (!userId) return;

  switch (event.type) {
    case 'follow': {
      await handleFollow(userId, event.replyToken, token, db);
      break;
    }
    case 'unfollow': {
      console.log(`[LINE] unfollow: userId=${userId}`);
      break;
    }
    case 'message': {
      if (event.message?.type === 'text' && event.replyToken) {
        const text = event.message.text ?? '';
        await handleTextMessage(text, userId, event.replyToken, token, db);
      }
      break;
    }
    default:
      console.log(`[LINE] Unhandled event type: ${event.type}`);
  }
}

// ============================================================
// Follow イベント処理
// ============================================================

async function handleFollow(
  userId: string,
  replyToken: string | undefined,
  token: string,
  db: D1Database,
): Promise<void> {
  // 会話状態を初期化
  const conv = await getOrCreateConversation(db, userId);

  // 既にアカウント連携済みかチェック
  const account = await findLineAccount(db, userId);

  if (account) {
    // 再フォロー（既に連携済み）
    await updateConversation(db, userId, { state: 'LINKED' });
    if (replyToken) {
      await replyMessage(
        replyToken,
        [{
          type: 'text',
          text: 'おかえりなさい🌟\nアカウントは連携済みです。\n\n「予定入力」と送ると利用予定を入力できます。',
        }],
        token,
      );
    }
  } else {
    // 新規フォロー → IDLE → LINKING
    await updateConversation(db, userId, { state: 'IDLE' });
    if (replyToken) {
      await replyMessage(
        replyToken,
        [{
          type: 'text',
          text: 'あゆっこ保育所です🌟\n友だち追加ありがとうございます！\n\nこちらから毎月の利用予定を提出できるようになります。\n\n連携コードをお持ちの方は、コードを入力してください。\n（例: AYK-1234）',
        }],
        token,
      );
    }
  }

  await logConversation(db, userId, 'incoming', 'follow', null, conv.state, account ? 'LINKED' : 'IDLE');
  console.log(`[LINE] follow: userId=${userId}, linked=${!!account}`);
}

// ============================================================
// テキストメッセージ処理（状態機械）
// ============================================================

async function handleTextMessage(
  text: string,
  userId: string,
  replyToken: string,
  token: string,
  db: D1Database,
): Promise<void> {
  const conv = await getOrCreateConversation(db, userId);
  const stateBefore = conv.state;
  const trimmed = text.trim();

  await logConversation(db, userId, 'incoming', 'text', trimmed, stateBefore, null);

  // グローバルコマンド（どの状態からでも受付）
  if (/^(リセット|reset|キャンセル)$/i.test(trimmed)) {
    await handleReset(userId, replyToken, token, db, conv);
    return;
  }

  if (/^(ヘルプ|help|使い方)$/i.test(trimmed)) {
    await handleHelp(userId, replyToken, token, db, conv);
    return;
  }

  if (/^(状態|ステータス|status)$/i.test(trimmed)) {
    await handleStatus(userId, replyToken, token, db, conv);
    return;
  }

  // 状態に応じた処理
  switch (conv.state) {
    case 'IDLE':
    case 'LINKING':
      await stateIdleOrLinking(trimmed, userId, replyToken, token, db, conv);
      break;

    case 'LINKED':
    case 'SAVED':
      await stateLinked(trimmed, userId, replyToken, token, db, conv);
      break;

    case 'SELECT_MONTH':
      await stateSelectMonth(trimmed, userId, replyToken, token, db, conv);
      break;

    case 'COLLECTING':
      await stateCollecting(trimmed, userId, replyToken, token, db, conv);
      break;

    case 'CONFIRM':
      await stateConfirm(trimmed, userId, replyToken, token, db, conv);
      break;

    default:
      await replyMessage(replyToken, [{
        type: 'text',
        text: '予期しない状態です。「リセット」と送信してやり直してください。',
      }], token);
  }
}

// ============================================================
// 各状態のハンドラー
// ============================================================

/**
 * IDLE / LINKING: 連携コード入力待ち
 */
async function stateIdleOrLinking(
  text: string,
  userId: string,
  replyToken: string,
  token: string,
  db: D1Database,
  conv: ReturnType<typeof Object>,
): Promise<void> {
  const linkCodePattern = /^AYK-\d{4}$/i;

  if (linkCodePattern.test(text)) {
    // 連携コード検証
    const profile = await getProfile(userId, token);
    const result = await verifyAndLinkCode(db, userId, text, profile?.displayName ?? null);

    if (result) {
      await updateConversation(db, userId, { state: 'LINKED' });
      const childList = result.childNames.map((n) => `  ・${n}`).join('\n');
      await replyMessage(
        replyToken,
        [{
          type: 'text',
          text: `連携が完了しました！✨\n\nお子様の情報:\n${childList}\n\n「予定入力」と送ると、利用予定を入力できます。`,
        }],
        token,
      );
      await logConversation(db, userId, 'outgoing', 'link_success', null, 'LINKING', 'LINKED');
    } else {
      await updateConversation(db, userId, { state: 'IDLE' });
      await replyMessage(
        replyToken,
        [{
          type: 'text',
          text: '連携コードが見つかりません。\nコードをもう一度ご確認ください。\n（例: AYK-1234）',
        }],
        token,
      );
    }
    return;
  }

  // 連携コード以外のメッセージ
  // まずアカウント連携済みかチェック（以前のセッションで連携済みの場合）
  const account = await findLineAccount(db, userId);
  if (account) {
    await updateConversation(db, userId, { state: 'LINKED' });
    await replyMessage(
      replyToken,
      [{
        type: 'text',
        text: 'アカウントは連携済みです✨\n\n「予定入力」と送ると利用予定を入力できます。',
      }],
      token,
    );
    return;
  }

  await replyMessage(
    replyToken,
    [{
      type: 'text',
      text: '連携コードを入力してください。\n（例: AYK-1234）\n\n連携コードは園からお渡ししています。',
    }],
    token,
  );
}

/**
 * LINKED / SAVED: メニュー待ち → 月選択へ
 */
async function stateLinked(
  text: string,
  userId: string,
  replyToken: string,
  token: string,
  db: D1Database,
  conv: ReturnType<typeof Object>,
): Promise<void> {
  if (/^(予定入力|予定|入力|スケジュール)/.test(text)) {
    // 児童が1人のみの場合は自動選択
    const children = await getLinkedChildren(db, userId);
    if (children.length === 0) {
      await replyMessage(replyToken, [{
        type: 'text',
        text: '紐づけされた園児がいません。\n園にお問い合わせください。',
      }], token);
      return;
    }

    // Phase 1 MVP: 最初の児童を自動選択
    const child = children[0];

    // 来月をデフォルト提案
    const now = new Date();
    const nextMonth = now.getMonth() + 2; // getMonth() is 0-based
    const nextYear = nextMonth > 12 ? now.getFullYear() + 1 : now.getFullYear();
    const nextM = nextMonth > 12 ? 1 : nextMonth;

    await updateConversation(db, userId, {
      state: 'SELECT_MONTH',
      current_child_id: child.id,
      draft_entries: '[]',
    });

    let childInfo = `👶 ${child.name}さん`;
    if (children.length > 1) {
      childInfo += `\n（※お子様が${children.length}人登録されています。現在は${child.name}さんの予定を入力します）`;
    }

    await replyMessage(replyToken, [{
      type: 'text',
      text: `${childInfo}\n\n📅 何月の予定を入力しますか？\n\n「${nextM}月」または「${nextYear}/${nextM}」のように送ってください。\n\n（例: 4月、2026/4）`,
    }], token);
    return;
  }

  // その他のメッセージ
  await replyMessage(replyToken, [{
    type: 'text',
    text: '📋 メニュー:\n\n・「予定入力」→ 利用予定を入力\n・「ヘルプ」→ 使い方\n・「状態」→ 現在の状態確認',
  }], token);
}

/**
 * SELECT_MONTH: 月を選択
 */
async function stateSelectMonth(
  text: string,
  userId: string,
  replyToken: string,
  token: string,
  db: D1Database,
  conv: ReturnType<typeof Object>,
): Promise<void> {
  const convData = await getOrCreateConversation(db, userId);

  // "4月" or "2026/4" or "4"
  const monthMatch = text.match(/^(?:(\d{4})\s*[\/年]\s*)?(\d{1,2})\s*月?$/);
  if (!monthMatch) {
    await replyMessage(replyToken, [{
      type: 'text',
      text: '月を入力してください。\n\n（例: 4月、2026/4、4）',
    }], token);
    return;
  }

  const now = new Date();
  const year = monthMatch[1] ? parseInt(monthMatch[1]) : now.getFullYear();
  const month = parseInt(monthMatch[2]);

  if (month < 1 || month > 12) {
    await replyMessage(replyToken, [{
      type: 'text',
      text: '1〜12の月を入力してください。',
    }], token);
    return;
  }

  await updateConversation(db, userId, {
    state: 'COLLECTING',
    current_year: year,
    current_month: month,
    draft_entries: '[]',
  });

  const daysInMonth = new Date(year, month, 0).getDate();

  await replyMessage(replyToken, [{
    type: 'text',
    text: `📅 ${year}年${month}月（${daysInMonth}日まで）の予定を入力してください。\n\n【入力形式】\n  日付 登園-降園\n\n【例】\n  1日 8:30-17:30\n  4/2 9:00-18:00\n  5日-10日 8:30-17:30\n\n複数行まとめて入力OK！\n入力が終わったら「確認」と送ってください。`,
  }], token);
}

/**
 * COLLECTING: 予定入力中
 */
async function stateCollecting(
  text: string,
  userId: string,
  replyToken: string,
  token: string,
  db: D1Database,
  conv: ReturnType<typeof Object>,
): Promise<void> {
  const convData = await getOrCreateConversation(db, userId);
  const year = convData.current_year!;
  const month = convData.current_month!;

  // 「確認」→ CONFIRM へ遷移
  if (/^(確認|確定|完了|done|ok)$/i.test(text)) {
    const drafts = getDraftEntries(convData);
    if (drafts.length === 0) {
      await replyMessage(replyToken, [{
        type: 'text',
        text: 'まだ予定が入力されていません。\n\n日付と時間を入力してください。\n（例: 1日 8:30-17:30）',
      }], token);
      return;
    }

    await updateConversation(db, userId, { state: 'CONFIRM' });

    const summary = formatDraftForConfirmation(drafts, year, month);
    await replyMessage(replyToken, [{
      type: 'text',
      text: `${summary}\n\nこの内容で確定しますか？\n・「確定」→ 保存します\n・「修正」→ 入力に戻ります\n・「クリア」→ 全件削除して入力し直し`,
    }], token);
    return;
  }

  // 「一覧」→ 現在のドラフト表示
  if (/^(一覧|リスト|list|確認中)$/i.test(text)) {
    const drafts = getDraftEntries(convData);
    if (drafts.length === 0) {
      await replyMessage(replyToken, [{
        type: 'text',
        text: 'まだ予定が入力されていません。\n\n日付と時間を入力してください。\n（例: 1日 8:30-17:30）',
      }], token);
    } else {
      const summary = formatDraftForConfirmation(drafts, year, month);
      await replyMessage(replyToken, [{
        type: 'text',
        text: `現在の入力内容:\n\n${summary}\n\n追加入力するか、「確認」で確定へ進みます。`,
      }], token);
    }
    return;
  }

  // 「クリア」→ ドラフト全消去
  if (/^(クリア|clear|全消去)$/i.test(text)) {
    await updateConversation(db, userId, { draft_entries: '[]' });
    await replyMessage(replyToken, [{
      type: 'text',
      text: '入力内容をクリアしました。\n\n日付と時間を入力してください。\n（例: 1日 8:30-17:30）',
    }], token);
    return;
  }

  // 予定入力をパース
  const { entries, errors } = parseScheduleInput(text, year, month);

  if (entries.length === 0 && errors.length > 0) {
    await replyMessage(replyToken, [{
      type: 'text',
      text: `⚠️ 入力エラー:\n${errors.join('\n')}\n\n【正しい形式】\n  1日 8:30-17:30\n  4/1-4/5 8:30-17:30`,
    }], token);
    return;
  }

  if (entries.length === 0) {
    await replyMessage(replyToken, [{
      type: 'text',
      text: '入力形式を認識できませんでした。\n\n【例】\n  1日 8:30-17:30\n  4/1 9:00-18:00\n  5日-10日 8:30-17:30\n\n入力が終わったら「確認」と送ってください。',
    }], token);
    return;
  }

  // ドラフトにマージ
  const existingDrafts = getDraftEntries(convData);
  const merged = mergeDraftEntries(existingDrafts, entries);
  await updateConversation(db, userId, {
    draft_entries: JSON.stringify(merged),
  });

  let reply = `✅ ${entries.length}日分を追加しました。`;
  if (errors.length > 0) {
    reply += `\n\n⚠️ 一部エラー:\n${errors.join('\n')}`;
  }
  reply += `\n\n現在 ${merged.length}日分入力済み。\n続けて入力するか、「確認」で確定へ進みます。`;

  await replyMessage(replyToken, [{ type: 'text', text: reply }], token);
}

/**
 * CONFIRM: 確認 → 保存 or 修正
 */
async function stateConfirm(
  text: string,
  userId: string,
  replyToken: string,
  token: string,
  db: D1Database,
  conv: ReturnType<typeof Object>,
): Promise<void> {
  const convData = await getOrCreateConversation(db, userId);
  const year = convData.current_year!;
  const month = convData.current_month!;
  const childId = convData.current_child_id!;
  const drafts = getDraftEntries(convData);

  if (/^(確定|保存|save|yes|はい)$/i.test(text)) {
    // schedule_plans に UPSERT
    const count = await saveScheduleEntries(db, childId, year, month, drafts);

    await updateConversation(db, userId, {
      state: 'SAVED',
      draft_entries: '[]',
    });

    await logConversation(db, userId, 'outgoing', 'schedule_saved', `${count} entries`, 'CONFIRM', 'SAVED');

    await replyMessage(replyToken, [{
      type: 'text',
      text: `✅ ${year}年${month}月の予定（${count}日分）を保存しました！\n\n・「予定入力」→ 追加の予定を入力\n・「ヘルプ」→ 使い方`,
    }], token);
    return;
  }

  if (/^(修正|戻る|back|no|いいえ)$/i.test(text)) {
    await updateConversation(db, userId, { state: 'COLLECTING' });
    await replyMessage(replyToken, [{
      type: 'text',
      text: '入力に戻ります。\n\n追加入力するか、特定の日を上書きしてください。\n（例: 3日 9:00-16:00）\n\n「確認」で再度確定画面に進みます。',
    }], token);
    return;
  }

  if (/^(クリア|clear|全消去)$/i.test(text)) {
    await updateConversation(db, userId, {
      state: 'COLLECTING',
      draft_entries: '[]',
    });
    await replyMessage(replyToken, [{
      type: 'text',
      text: '入力内容をクリアしました。\n\n日付と時間を入力してください。\n（例: 1日 8:30-17:30）',
    }], token);
    return;
  }

  // その他
  const summary = formatDraftForConfirmation(drafts, year, month);
  await replyMessage(replyToken, [{
    type: 'text',
    text: `${summary}\n\n「確定」→ 保存\n「修正」→ 入力に戻る\n「クリア」→ 全件削除`,
  }], token);
}

// ============================================================
// グローバルコマンド
// ============================================================

async function handleReset(
  userId: string,
  replyToken: string,
  token: string,
  db: D1Database,
  conv: ReturnType<typeof Object>,
): Promise<void> {
  const account = await findLineAccount(db, userId);
  const newState: ConversationState = account ? 'LINKED' : 'IDLE';

  await updateConversation(db, userId, {
    state: newState,
    current_child_id: null,
    current_year: null,
    current_month: null,
    draft_entries: '[]',
  });

  if (account) {
    await replyMessage(replyToken, [{
      type: 'text',
      text: 'リセットしました。\n\n「予定入力」→ 利用予定を入力\n「ヘルプ」→ 使い方',
    }], token);
  } else {
    await replyMessage(replyToken, [{
      type: 'text',
      text: 'リセットしました。\n\n連携コードを入力してください。\n（例: AYK-1234）',
    }], token);
  }
}

async function handleHelp(
  userId: string,
  replyToken: string,
  token: string,
  db: D1Database,
  conv: ReturnType<typeof Object>,
): Promise<void> {
  await replyMessage(replyToken, [{
    type: 'text',
    text: `📖 あゆっこ利用予定システム\n\n【基本の流れ】\n1️⃣ 連携コード入力（初回のみ）\n2️⃣ 「予定入力」と送る\n3️⃣ 月を選ぶ（例: 4月）\n4️⃣ 予定を入力\n   例: 1日 8:30-17:30\n5️⃣ 「確認」→「確定」で保存\n\n【入力形式】\n・1日 8:30-17:30\n・4/1 9:00-18:00\n・5日-10日 8:30-17:30（範囲）\n・複数行まとめてOK\n\n【コマンド】\n・確認 → 入力内容を確認\n・確定 → 予定を保存\n・一覧 → 現在の入力内容\n・クリア → 入力をやり直し\n・リセット → 最初に戻る`,
  }], token);
}

async function handleStatus(
  userId: string,
  replyToken: string,
  token: string,
  db: D1Database,
  conv: ReturnType<typeof Object>,
): Promise<void> {
  const convData = await getOrCreateConversation(db, userId);
  const account = await findLineAccount(db, userId);
  const children = account ? await getLinkedChildren(db, userId) : [];

  let status = `📊 現在の状態: ${convData.state}`;
  status += `\n👤 アカウント連携: ${account ? '済' : '未'}`;

  if (children.length > 0) {
    status += `\n👶 園児: ${children.map((c) => c.name).join('、')}`;
  }

  if (convData.current_year && convData.current_month) {
    status += `\n📅 対象月: ${convData.current_year}年${convData.current_month}月`;
  }

  const drafts = getDraftEntries(convData);
  if (drafts.length > 0) {
    status += `\n📝 入力中: ${drafts.length}日分`;
  }

  await replyMessage(replyToken, [{ type: 'text', text: status }], token);
}

export default lineRoutes;

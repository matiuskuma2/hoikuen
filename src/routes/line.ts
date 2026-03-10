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
    text: `📅 ${year}年${month}月（${daysInMonth}日まで）の予定を入力してください。\n\n【一括入力（おすすめ）】\n  平日 8:30-17:30\n  → 月〜金に一括で入力されます\n\n【個別入力】\n  4/1 8:30-17:30\n  4/1-4/5 8:30-17:30\n\n【休みの日】\n  3日 休み\n\n【便利機能】\n  前月コピー → 先月の予定をコピー\n\n※食事は時間から自動判定します\n\n入力が終わったら「確認」と送ってください。`,
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
        text: 'まだ予定が入力されていません。\n\n日付と時間を入力してください。\n（例: 平日 8:30-17:30）',
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
        text: 'まだ予定が入力されていません。\n\n日付と時間を入力してください。\n（例: 平日 8:30-17:30）',
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
      text: '入力内容をクリアしました。\n\n日付と時間を入力してください。\n（例: 平日 8:30-17:30）',
    }], token);
    return;
  }

  // 「前月コピー」→ 前月の予定をコピー
  if (/^(前月コピー|前月|コピー|先月コピー)$/i.test(text)) {
    const childId = convData.current_child_id!;
    const prevMonth = month === 1 ? 12 : month - 1;
    const prevYear = month === 1 ? year - 1 : year;

    const prevSchedules = await db
      .prepare(
        `SELECT day, planned_start, planned_end FROM schedule_plans
         WHERE child_id = ? AND year = ? AND month = ?
         ORDER BY day`,
      )
      .bind(childId, prevYear, prevMonth)
      .all<{ day: number; planned_start: string; planned_end: string }>();

    if (prevSchedules.results.length === 0) {
      await replyMessage(replyToken, [{
        type: 'text',
        text: `${prevYear}年${prevMonth}月の予定が見つかりませんでした。\n\n手動で入力してください。\n（例: 平日 8:30-17:30）`,
      }], token);
      return;
    }

    // 前月の予定を今月にコピー（日は同じ番号で、月の最終日を超えない）
    const daysInMonth = new Date(year, month, 0).getDate();
    const newEntries: DraftEntry[] = [];
    for (const s of prevSchedules.results) {
      if (s.day <= daysInMonth && s.planned_start && s.planned_end) {
        newEntries.push({ day: s.day, start: s.planned_start, end: s.planned_end });
      }
    }

    if (newEntries.length === 0) {
      await replyMessage(replyToken, [{
        type: 'text',
        text: `${prevYear}年${prevMonth}月の予定をコピーできませんでした。`,
      }], token);
      return;
    }

    const existingDrafts = getDraftEntries(convData);
    const merged = mergeDraftEntries(existingDrafts, newEntries);
    await updateConversation(db, userId, {
      draft_entries: JSON.stringify(merged),
    });

    await replyMessage(replyToken, [{
      type: 'text',
      text: `📋 ${prevYear}年${prevMonth}月の予定（${newEntries.length}日分）をコピーしました。\n\n現在 ${merged.length}日分入力済み。\n\n変更がある日は上書き入力してください。\n（例: 3日 休み / 15日 9:00-16:00）\n\n入力が終わったら「確認」と送ってください。`,
    }], token);
    return;
  }

  // 予定入力をパース
  const { entries, removeDays, errors } = parseScheduleInput(text, year, month);

  // 休み指定（removeDays）の処理
  if (removeDays.length > 0) {
    const existingDrafts = getDraftEntries(convData);
    const filtered = existingDrafts.filter(e => !removeDays.includes(e.day));
    const removedCount = existingDrafts.length - filtered.length;

    // 新しいエントリもマージ
    const merged = entries.length > 0 ? mergeDraftEntries(filtered, entries) : filtered;
    await updateConversation(db, userId, {
      draft_entries: JSON.stringify(merged),
    });

    let reply = '';
    if (removedCount > 0) {
      reply += `🗑️ ${removeDays.map(d => `${d}日`).join('・')}を休みにしました。`;
    }
    if (entries.length > 0) {
      reply += `\n✅ ${entries.length}日分を追加しました。`;
    }
    if (errors.length > 0) {
      reply += `\n\n⚠️ 一部エラー:\n${errors.join('\n')}`;
    }
    reply += `\n\n現在 ${merged.length}日分入力済み。\n続けて入力するか、「確認」で確定へ進みます。`;

    await replyMessage(replyToken, [{ type: 'text', text: reply }], token);
    return;
  }

  if (entries.length === 0 && errors.length > 0) {
    await replyMessage(replyToken, [{
      type: 'text',
      text: `⚠️ 入力エラー:\n${errors.join('\n')}\n\n【正しい形式】\n  平日 8:30-17:30\n  4/1-4/5 8:30-17:30\n  3日 休み`,
    }], token);
    return;
  }

  if (entries.length === 0) {
    await replyMessage(replyToken, [{
      type: 'text',
      text: '入力形式を認識できませんでした。\n\n【例】\n  平日 8:30-17:30（一括入力）\n  4/1 9:00-18:00\n  4/1-4/5 8:30-17:30\n  3日 休み\n\n入力が終わったら「確認」と送ってください。',
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
    text: `📖 あゆっこ利用予定システム\n\n【基本の流れ】\n1️⃣ 連携コード入力（初回のみ）\n2️⃣ 「予定入力」と送る\n3️⃣ 月を選ぶ（例: 4月）\n4️⃣ 予定を入力\n5️⃣ 「確認」→「確定」で保存\n\n【一括入力】\n・平日 8:30-17:30（月〜金一括）\n・月水金 9:00-17:00（曜日指定）\n・前月コピー（先月の予定をコピー）\n\n【個別入力】\n・4/1 8:30-17:30\n・4/1-4/5 8:30-17:30（範囲）\n\n【休み】\n・3日 休み\n\n※食事は時間から自動判定\n\n【コマンド】\n・確認/確定/一覧/クリア/リセット`,
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

// ============================================================
// 管理画面用 API
// ============================================================

/**
 * GET /link-codes — 連携コード一覧（園児紐付け情報付き）
 */
lineRoutes.get('/link-codes', async (c) => {
  const db = c.env.DB;
  const results = await db
    .prepare(
      `SELECT lc.id, lc.code, lc.nursery_id, lc.expires_at, lc.used_by_line_account_id, lc.used_at,
              la.line_user_id, la.display_name
       FROM link_codes lc
       LEFT JOIN line_accounts la ON la.id = lc.used_by_line_account_id
       ORDER BY lc.created_at DESC`,
    )
    .all();
  return c.json({ codes: results.results });
});

/**
 * POST /link-codes — 連携コード新規発行
 * Body: { child_ids?: string[] }  (将来的に特定園児に紐づけ)
 */
lineRoutes.post('/link-codes', async (c) => {
  const db = c.env.DB;
  // ランダム4桁コード生成
  const num = Math.floor(1000 + Math.random() * 9000);
  const code = `AYK-${num}`;
  const id = `lc_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  // 有効期限: 90日
  const expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

  await db
    .prepare(
      `INSERT INTO link_codes (id, code, nursery_id, expires_at, created_at)
       VALUES (?, ?, 'ayukko_001', ?, datetime('now'))`,
    )
    .bind(id, code, expiresAt)
    .run();

  return c.json({ id, code, expires_at: expiresAt });
});

/**
 * GET /submission-status?year=YYYY&month=MM — 月次提出状況一覧
 * 園児ごとに LINE連携済み / 予定提出済み / 提出日数 を返す
 */
lineRoutes.get('/submission-status', async (c) => {
  const db = c.env.DB;
  const year = parseInt(c.req.query('year') ?? String(new Date().getFullYear()));
  const month = parseInt(c.req.query('month') ?? String(new Date().getMonth() + 2));

  // 全園児を取得
  const children = await db
    .prepare('SELECT id, name, enrollment_type FROM children WHERE withdrawn_at IS NULL ORDER BY name')
    .all<{ id: string; name: string; enrollment_type: string }>();

  // LINE連携状況（line_account_children 経由）
  const lineLinks = await db
    .prepare(
      `SELECT c.id as child_id, la.line_user_id, la.display_name, conv.state as conv_state
       FROM children c
       LEFT JOIN line_account_children lac ON lac.child_id = c.id
       LEFT JOIN line_accounts la ON la.id = lac.line_account_id AND la.unlinked_at IS NULL
       LEFT JOIN conversations conv ON conv.line_user_id = la.line_user_id
       WHERE c.withdrawn_at IS NULL`,
    )
    .all<{ child_id: string; line_user_id: string | null; display_name: string | null; conv_state: string | null }>();

  // 予定提出状況（schedule_plans でLINEソース）
  const schedules = await db
    .prepare(
      `SELECT child_id, COUNT(*) as day_count, source_file
       FROM schedule_plans
       WHERE year = ? AND month = ?
       GROUP BY child_id, source_file`,
    )
    .bind(year, month)
    .all<{ child_id: string; day_count: number; source_file: string }>();

  // 全予定（ソース不問）
  const allSchedules = await db
    .prepare(
      `SELECT child_id, COUNT(*) as day_count
       FROM schedule_plans
       WHERE year = ? AND month = ?
       GROUP BY child_id`,
    )
    .bind(year, month)
    .all<{ child_id: string; day_count: number }>();

  // 組み立て
  const linkMap = new Map<string, { line_user_id: string | null; display_name: string | null; conv_state: string | null }>();
  for (const r of lineLinks.results) {
    linkMap.set(r.child_id, r);
  }
  const schedMap = new Map<string, { line_days: number; other_days: number }>();
  for (const r of schedules.results) {
    const existing = schedMap.get(r.child_id) ?? { line_days: 0, other_days: 0 };
    if (r.source_file === 'LINE') {
      existing.line_days = r.day_count;
    } else {
      existing.other_days += r.day_count;
    }
    schedMap.set(r.child_id, existing);
  }
  const allSchedMap = new Map<string, number>();
  for (const r of allSchedules.results) {
    allSchedMap.set(r.child_id, r.day_count);
  }

  const status = children.results.map((child) => {
    const link = linkMap.get(child.id);
    const sched = schedMap.get(child.id);
    const totalDays = allSchedMap.get(child.id) ?? 0;
    return {
      child_id: child.id,
      child_name: child.name,
      enrollment_type: child.enrollment_type,
      line_linked: !!link?.line_user_id,
      line_display_name: link?.display_name ?? null,
      conv_state: link?.conv_state ?? null,
      line_submitted_days: sched?.line_days ?? 0,
      other_submitted_days: sched?.other_days ?? 0,
      total_submitted_days: totalDays,
      has_submission: totalDays > 0,
    };
  });

  const totalChildren = status.length;
  const linkedCount = status.filter((s) => s.line_linked).length;
  const submittedCount = status.filter((s) => s.has_submission).length;

  return c.json({
    year,
    month,
    total_children: totalChildren,
    line_linked_count: linkedCount,
    submitted_count: submittedCount,
    not_submitted_count: totalChildren - submittedCount,
    children: status,
  });
});

export default lineRoutes;

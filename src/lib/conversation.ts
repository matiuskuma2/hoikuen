/**
 * LINE 会話状態管理（State Machine）
 * 
 * 状態遷移:
 *   IDLE → LINKING → LINKED → SELECT_MONTH → COLLECTING → CONFIRM → SAVED
 * 
 * 設計原則:
 *   - 推定禁止: 食事は聞かない（園側管理）。入力は日付・登園・降園の3項目のみ
 *   - LLM不使用 (Phase 1 MVP): 固定フォーマット入力のみ対応
 *   - 部分確定可: 入力分だけ確定→追加入力ができる
 */

// ============================================================
// 型定義
// ============================================================

export type ConversationState =
  | 'IDLE'
  | 'LINKING'
  | 'LINKED'
  | 'SELECT_MONTH'
  | 'COLLECTING'
  | 'CONFIRM'
  | 'SAVED';

export interface DraftEntry {
  day: number;
  start: string;   // HH:MM
  end: string;      // HH:MM
}

export interface ConversationRow {
  id: string;
  line_user_id: string;
  state: ConversationState;
  current_child_id: string | null;
  current_year: number | null;
  current_month: number | null;
  draft_entries: string;  // JSON string of DraftEntry[]
  last_message_at: string | null;
}

export interface LineAccountRow {
  id: string;
  line_user_id: string;
  display_name: string | null;
  nursery_id: string;
  linked_at: string;
}

export interface LinkCodeRow {
  id: string;
  code: string;
  nursery_id: string;
  used_by_line_account_id: string | null;
  used_at: string | null;
  expires_at: string | null;
}

// ============================================================
// 状態管理: 会話取得・更新
// ============================================================

/**
 * LINE userId から会話状態を取得（無ければ IDLE で作成）
 */
export async function getOrCreateConversation(
  db: D1Database,
  lineUserId: string,
): Promise<ConversationRow> {
  const existing = await db
    .prepare('SELECT * FROM conversations WHERE line_user_id = ?')
    .bind(lineUserId)
    .first<ConversationRow>();

  if (existing) return existing;

  // 新規作成
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  await db
    .prepare(
      `INSERT INTO conversations (id, line_user_id, state, draft_entries, created_at, updated_at)
       VALUES (?, ?, 'IDLE', '[]', datetime('now'), datetime('now'))`,
    )
    .bind(id, lineUserId)
    .run();

  return {
    id,
    line_user_id: lineUserId,
    state: 'IDLE',
    current_child_id: null,
    current_year: null,
    current_month: null,
    draft_entries: '[]',
    last_message_at: null,
  };
}

/**
 * 会話状態を更新
 */
export async function updateConversation(
  db: D1Database,
  lineUserId: string,
  updates: Partial<Pick<ConversationRow, 'state' | 'current_child_id' | 'current_year' | 'current_month' | 'draft_entries'>>,
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (updates.state !== undefined) {
    sets.push('state = ?');
    values.push(updates.state);
  }
  if (updates.current_child_id !== undefined) {
    sets.push('current_child_id = ?');
    values.push(updates.current_child_id);
  }
  if (updates.current_year !== undefined) {
    sets.push('current_year = ?');
    values.push(updates.current_year);
  }
  if (updates.current_month !== undefined) {
    sets.push('current_month = ?');
    values.push(updates.current_month);
  }
  if (updates.draft_entries !== undefined) {
    sets.push('draft_entries = ?');
    values.push(updates.draft_entries);
  }

  sets.push("updated_at = datetime('now')");
  sets.push("last_message_at = datetime('now')");
  values.push(lineUserId);

  await db
    .prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE line_user_id = ?`)
    .bind(...values)
    .run();
}

// ============================================================
// アカウント連携
// ============================================================

/**
 * LINE userId でアカウントを検索
 */
export async function findLineAccount(
  db: D1Database,
  lineUserId: string,
): Promise<LineAccountRow | null> {
  return db
    .prepare('SELECT * FROM line_accounts WHERE line_user_id = ? AND unlinked_at IS NULL')
    .bind(lineUserId)
    .first<LineAccountRow>();
}

/**
 * 連携コード検証 & アカウント作成
 * @returns 紐づいた児童名の配列（成功時）、null（コード無効）
 */
export async function verifyAndLinkCode(
  db: D1Database,
  lineUserId: string,
  code: string,
  displayName: string | null,
): Promise<{ childNames: string[] } | null> {
  // 1. コード検索
  const linkCode = await db
    .prepare(
      `SELECT * FROM link_codes
       WHERE code = ? AND used_by_line_account_id IS NULL
       AND (expires_at IS NULL OR expires_at > datetime('now'))`,
    )
    .bind(code.toUpperCase())
    .first<LinkCodeRow>();

  if (!linkCode) return null;

  // 2. line_accounts に登録（既存の場合は再利用）
  let account = await findLineAccount(db, lineUserId);
  if (!account) {
    const accountId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    await db
      .prepare(
        `INSERT INTO line_accounts (id, line_user_id, display_name, nursery_id, linked_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`,
      )
      .bind(accountId, lineUserId, displayName, linkCode.nursery_id)
      .run();
    account = {
      id: accountId,
      line_user_id: lineUserId,
      display_name: displayName,
      nursery_id: linkCode.nursery_id,
      linked_at: new Date().toISOString(),
    };
  }

  // 3. link_codes を使用済みに更新
  await db
    .prepare(
      `UPDATE link_codes SET used_by_line_account_id = ?, used_at = datetime('now') WHERE id = ?`,
    )
    .bind(account.id, linkCode.id)
    .run();

  // 4. line_account_children に紐づけ
  //    link_codes テーブルに child_id は入れていないので、
  //    nursery_id 全児童を紐づける（テスト用。本番は園が個別指定）
  //    → ここでは link_code にどの child を紐づけるか seed で設定済みと想定
  //    MVP では link_code 1つ = 全園児にアクセス可能（テスト簡略化のため）
  const children = await db
    .prepare('SELECT id, name FROM children WHERE nursery_id = ?')
    .bind(linkCode.nursery_id)
    .all<{ id: string; name: string }>();

  const childNames: string[] = [];
  for (const child of children.results) {
    await db
      .prepare(
        `INSERT OR IGNORE INTO line_account_children (id, line_account_id, child_id, created_at)
         VALUES (?, ?, ?, datetime('now'))`,
      )
      .bind(
        crypto.randomUUID().replace(/-/g, '').slice(0, 16),
        account.id,
        child.id,
      )
      .run();
    childNames.push(child.name);
  }

  return { childNames };
}

/**
 * LINE アカウントに紐づく児童一覧を取得
 */
export async function getLinkedChildren(
  db: D1Database,
  lineUserId: string,
): Promise<{ id: string; name: string; enrollment_type: string }[]> {
  const results = await db
    .prepare(
      `SELECT c.id, c.name, c.enrollment_type
       FROM children c
       JOIN line_account_children lac ON lac.child_id = c.id
       JOIN line_accounts la ON la.id = lac.line_account_id
       WHERE la.line_user_id = ? AND la.unlinked_at IS NULL
       ORDER BY c.name`,
    )
    .bind(lineUserId)
    .all<{ id: string; name: string; enrollment_type: string }>();

  return results.results;
}

// ============================================================
// 予定入力パーサー（固定フォーマット / Phase 1 MVP）
// ============================================================

/**
 * 固定フォーマットの予定入力をパースする
 * 
 * 対応フォーマット:
 *   - "4/1 8:30-17:30"
 *   - "4/1 8:30 17:30"
 *   - "4/1-4/5 8:30-17:30"  (範囲指定)
 *   - "1日 8:30-17:30"
 *   - 複数行対応
 * 
 * @returns パースされたエントリ配列 + エラーメッセージ
 */
export function parseScheduleInput(
  text: string,
  year: number,
  month: number,
): { entries: DraftEntry[]; errors: string[] } {
  const entries: DraftEntry[] = [];
  const errors: string[] = [];
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    const parsed = parseSingleLine(line, year, month);
    if (parsed.entries.length > 0) {
      entries.push(...parsed.entries);
    }
    if (parsed.error) {
      errors.push(parsed.error);
    }
  }

  return { entries, errors };
}

function parseSingleLine(
  line: string,
  year: number,
  month: number,
): { entries: DraftEntry[]; error: string | null } {
  // 全角→半角変換
  const normalized = line
    .replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0))
    .replace(/：/g, ':')
    .replace(/ー/g, '-')
    .replace(/〜/g, '-')
    .replace(/～/g, '-')
    .replace(/　/g, ' ');

  // パターン1: "4/1 8:30-17:30" or "4/1 8:30 17:30"
  const singleDayMatch = normalized.match(
    /^(\d{1,2})[\/日]\s*(\d{1,2}:\d{2})\s*[-\s]\s*(\d{1,2}:\d{2})/,
  );
  if (singleDayMatch) {
    const day = parseInt(singleDayMatch[1]);
    const start = normalizeTime(singleDayMatch[2]);
    const end = normalizeTime(singleDayMatch[3]);
    const validation = validateEntry(day, start, end, year, month);
    if (validation) return { entries: [], error: `${line}: ${validation}` };
    return { entries: [{ day, start, end }], error: null };
  }

  // パターン2: "4/1-4/5 8:30-17:30" (日付範囲)
  const rangeMatch = normalized.match(
    /^(\d{1,2})[\/日]\s*-\s*(\d{1,2})[\/日]?\s+(\d{1,2}:\d{2})\s*[-\s]\s*(\d{1,2}:\d{2})/,
  );
  if (rangeMatch) {
    const dayStart = parseInt(rangeMatch[1]);
    const dayEnd = parseInt(rangeMatch[2]);
    const start = normalizeTime(rangeMatch[3]);
    const end = normalizeTime(rangeMatch[4]);

    if (dayStart > dayEnd) {
      return { entries: [], error: `${line}: 開始日が終了日より後です` };
    }

    const entries: DraftEntry[] = [];
    for (let d = dayStart; d <= dayEnd; d++) {
      const validation = validateEntry(d, start, end, year, month);
      if (validation) {
        return { entries: [], error: `${line}: ${d}日 - ${validation}` };
      }
      entries.push({ day: d, start, end });
    }
    return { entries, error: null };
  }

  // パターン3: "1日 8:30-17:30"  
  const dayOnlyMatch = normalized.match(
    /^(\d{1,2})日?\s+(\d{1,2}:\d{2})\s*[-\s]\s*(\d{1,2}:\d{2})/,
  );
  if (dayOnlyMatch) {
    const day = parseInt(dayOnlyMatch[1]);
    const start = normalizeTime(dayOnlyMatch[2]);
    const end = normalizeTime(dayOnlyMatch[3]);
    const validation = validateEntry(day, start, end, year, month);
    if (validation) return { entries: [], error: `${line}: ${validation}` };
    return { entries: [{ day, start, end }], error: null };
  }

  return { entries: [], error: `「${line}」の形式を認識できませんでした。\n例: 4/1 8:30-17:30` };
}

function normalizeTime(time: string): string {
  const [h, m] = time.split(':');
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
}

function validateEntry(
  day: number,
  start: string,
  end: string,
  year: number,
  month: number,
): string | null {
  const daysInMonth = new Date(year, month, 0).getDate();
  if (day < 1 || day > daysInMonth) {
    return `${day}日は${month}月にありません（${daysInMonth}日まで）`;
  }
  if (start >= end) {
    return `登園時間(${start})が降園時間(${end})以降です`;
  }
  // 営業時間チェック (7:00-21:00)
  if (start < '07:00') {
    return `登園時間(${start})が早すぎます（7:00以降）`;
  }
  if (end > '21:00') {
    return `降園時間(${end})が遅すぎます（21:00まで）`;
  }
  return null;
}

// ============================================================
// schedule_plans UPSERT
// ============================================================

/**
 * 確定された予定を schedule_plans に UPSERT
 */
export async function saveScheduleEntries(
  db: D1Database,
  childId: string,
  year: number,
  month: number,
  entries: DraftEntry[],
): Promise<number> {
  let savedCount = 0;

  for (const entry of entries) {
    await db
      .prepare(
        `INSERT INTO schedule_plans (id, child_id, year, month, day, planned_start, planned_end, lunch_flag, am_snack_flag, pm_snack_flag, dinner_flag, source_file)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'LINE')
         ON CONFLICT (child_id, year, month, day) DO UPDATE SET
           planned_start = excluded.planned_start,
           planned_end = excluded.planned_end,
           source_file = 'LINE'`,
      )
      .bind(
        crypto.randomUUID().replace(/-/g, '').slice(0, 16),
        childId,
        year,
        month,
        entry.day,
        entry.start,
        entry.end,
      )
      .run();
    savedCount++;
  }

  return savedCount;
}

// ============================================================
// 会話ログ記録
// ============================================================

export async function logConversation(
  db: D1Database,
  lineUserId: string,
  direction: 'incoming' | 'outgoing',
  messageType: string,
  messageText: string | null,
  stateBefore: string | null,
  stateAfter: string | null,
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO conversation_logs (id, line_user_id, direction, message_type, message_text, state_before, state_after, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .bind(
        crypto.randomUUID().replace(/-/g, '').slice(0, 16),
        lineUserId,
        direction,
        messageType,
        messageText,
        stateBefore,
        stateAfter,
      )
      .run();
  } catch (err) {
    console.error('[CONV_LOG] Failed to log:', err);
  }
}

// ============================================================
// ドラフト操作ヘルパー
// ============================================================

export function getDraftEntries(conv: ConversationRow): DraftEntry[] {
  try {
    return JSON.parse(conv.draft_entries || '[]');
  } catch {
    return [];
  }
}

export function mergeDraftEntries(
  existing: DraftEntry[],
  newEntries: DraftEntry[],
): DraftEntry[] {
  const map = new Map<number, DraftEntry>();
  for (const e of existing) {
    map.set(e.day, e);
  }
  for (const e of newEntries) {
    map.set(e.day, e); // 同じ日は上書き
  }
  return Array.from(map.values()).sort((a, b) => a.day - b.day);
}

/**
 * ドラフトを確認メッセージに整形
 */
export function formatDraftForConfirmation(
  entries: DraftEntry[],
  year: number,
  month: number,
): string {
  if (entries.length === 0) return '入力された予定はありません。';

  const lines = entries.map((e) => {
    const dow = getDayOfWeek(year, month, e.day);
    return `  ${month}/${e.day}(${dow}) ${e.start}〜${e.end}`;
  });

  return `📅 ${year}年${month}月の利用予定:\n\n${lines.join('\n')}\n\n合計: ${entries.length}日`;
}

function getDayOfWeek(year: number, month: number, day: number): string {
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  return days[new Date(year, month - 1, day).getDay()];
}

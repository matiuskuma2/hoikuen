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
 * 
 * セキュリティ修正 (2026-03-21):
 *   旧: コード1つで nursery 全園児に紐づけ（テスト簡略化のMVP実装 → 本番NG）
 *   新: link_code_children テーブルで指定された園児のみ紐付け
 *   フォールバック: link_code_children が空の場合は link_codes に紐づく子なし → エラー
 * 
 * @returns 紐づいた児童名の配列（成功時）、null（コード無効）
 */
export async function verifyAndLinkCode(
  db: D1Database,
  lineUserId: string,
  code: string,
  displayName: string | null,
): Promise<{ childNames: string[]; childIds: string[] } | null> {
  // 1. コード検索（未使用 & 有効期限内）
  const linkCode = await db
    .prepare(
      `SELECT * FROM link_codes
       WHERE code = ? AND used_by_line_account_id IS NULL
       AND (expires_at IS NULL OR expires_at > datetime('now'))`,
    )
    .bind(code.toUpperCase())
    .first<LinkCodeRow>();

  if (!linkCode) return null;

  // 2. link_code_children から対象園児を取得（セキュリティ修正）
  const targetChildren = await db
    .prepare(
      `SELECT c.id, c.name FROM link_code_children lcc
       JOIN children c ON c.id = lcc.child_id
       WHERE lcc.link_code_id = ?
       ORDER BY c.name`,
    )
    .bind(linkCode.id)
    .all<{ id: string; name: string }>();

  // 対象園児が未設定の場合はコード無効とする（全園児紐付け防止）
  if (!targetChildren.results || targetChildren.results.length === 0) {
    console.warn(`[LINE] link_code ${code} has no target children in link_code_children table`);
    return null;
  }

  // 3. line_accounts に登録（既存の場合は再利用）
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

  // 4. link_codes を使用済みに更新
  await db
    .prepare(
      `UPDATE link_codes SET used_by_line_account_id = ?, used_at = datetime('now') WHERE id = ?`,
    )
    .bind(account.id, linkCode.id)
    .run();

  // 5. line_account_children に対象園児のみ紐づけ
  const childNames: string[] = [];
  const childIds: string[] = [];
  for (const child of targetChildren.results) {
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
    childIds.push(child.id);
  }

  return { childNames, childIds };
}

/**
 * LINE アカウントに紐づく児童一覧を取得（view_token 含む）
 */
export async function getLinkedChildren(
  db: D1Database,
  lineUserId: string,
): Promise<{ id: string; name: string; enrollment_type: string; view_token: string | null }[]> {
  const results = await db
    .prepare(
      `SELECT c.id, c.name, c.enrollment_type, c.view_token
       FROM children c
       JOIN line_account_children lac ON lac.child_id = c.id
       JOIN line_accounts la ON la.id = lac.line_account_id
       WHERE la.line_user_id = ? AND la.unlinked_at IS NULL
       ORDER BY c.name`,
    )
    .bind(lineUserId)
    .all<{ id: string; name: string; enrollment_type: string; view_token: string | null }>();

  return results.results;
}

// ============================================================
// 予定入力パーサー（固定フォーマット / Phase 1 MVP）
// ============================================================

/**
 * 固定フォーマットの予定入力をパースする
 * 
 * 対応フォーマット:
 *   - "4/1 8:30-17:30"           (月/日 開始-終了)
 *   - "4/1 8:30 17:30"           (月/日 開始 終了)
 *   - "4/1-4/5 8:30-17:30"      (月/日-月/日 範囲指定)
 *   - "4/1-4/5 8:00-18:00"      (月/日-月/日 範囲指定、丸時間)
 *   - "1日 8:30-17:30"           (日のみ)
 *   - "1日-5日 8:30-17:30"      (日のみ範囲指定)
 *   - "1日7時30分から17時"       (自然言語風)
 *   - "1日 8時-17時"             (時のみ、分省略)
 *   - "1日 8時30分-17時30分"     (時分表記)
 *   - "平日 8:30-17:30"          (月〜金一括)
 *   - "月-金 8:30-17:30"         (曜日範囲一括)
 *   - "3日 休み"                  (特定日の休み = ドラフトから削除)
 *   - 複数行対応
 * 
 * @returns パースされたエントリ配列 + エラーメッセージ
 */
export function parseScheduleInput(
  text: string,
  year: number,
  month: number,
): { entries: DraftEntry[]; removeDays: number[]; errors: string[] } {
  const entries: DraftEntry[] = [];
  const removeDays: number[] = [];
  const errors: string[] = [];
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    const parsed = parseSingleLine(line, year, month);
    if (parsed.entries.length > 0) {
      entries.push(...parsed.entries);
    }
    if (parsed.removeDays && parsed.removeDays.length > 0) {
      removeDays.push(...parsed.removeDays);
    }
    if (parsed.error) {
      errors.push(parsed.error);
    }
  }

  return { entries, removeDays, errors };
}

/**
 * 時間表記を正規化してHH:MM形式に変換
 * "8:30" → "08:30"
 * "8時30分" → "08:30"
 * "8時" → "08:00"
 * "17:30" → "17:30"
 */
function parseTimeExpression(expr: string): string | null {
  expr = expr.trim();
  
  // "8:30" or "08:30" 形式
  const colonMatch = expr.match(/^(\d{1,2}):(\d{2})$/);
  if (colonMatch) {
    return normalizeTime(`${colonMatch[1]}:${colonMatch[2]}`);
  }
  
  // "8時30分" or "8時" 形式
  const jpTimeMatch = expr.match(/^(\d{1,2})時(?:(\d{1,2})分?)?$/);
  if (jpTimeMatch) {
    const h = jpTimeMatch[1];
    const m = jpTimeMatch[2] ?? '00';
    return normalizeTime(`${h}:${m.padStart(2, '0')}`);
  }
  
  return null;
}

/**
 * テキストから時間範囲（開始-終了）を抽出
 * "8:30-17:30" → ["08:30", "17:30"]
 * "8:30 17:30" → ["08:30", "17:30"]
 * "8時30分から17時" → ["08:30", "17:00"]
 * "8時-17時30分" → ["08:00", "17:30"]
 */
function parseTimeRange(text: string): { start: string; end: string } | null {
  text = text.trim();
  
  // Pattern A: "HH:MM-HH:MM" or "HH:MM HH:MM" (standard colon format)
  const colonPairMatch = text.match(/^(\d{1,2}:\d{2})\s*[-\s]\s*(\d{1,2}:\d{2})$/);
  if (colonPairMatch) {
    const start = parseTimeExpression(colonPairMatch[1]);
    const end = parseTimeExpression(colonPairMatch[2]);
    if (start && end) return { start, end };
  }
  
  // Pattern B: Japanese time expressions "8時30分から17時" or "8時-17時30分"
  // Match: <time_expr> <separator> <time_expr>
  const jpRangeMatch = text.match(/^(\d{1,2}時(?:\d{1,2}分?)?)\s*(?:から|~|-|ー|〜|～)\s*(\d{1,2}時(?:\d{1,2}分?)?)$/);
  if (jpRangeMatch) {
    const start = parseTimeExpression(jpRangeMatch[1]);
    const end = parseTimeExpression(jpRangeMatch[2]);
    if (start && end) return { start, end };
  }
  
  // Pattern C: Mixed "8:30-17時" or "8時-17:30"
  const mixedMatch = text.match(/^(\d{1,2}(?::\d{2}|時(?:\d{1,2}分?)?))\s*(?:から|~|-|ー|〜|～)\s*(\d{1,2}(?::\d{2}|時(?:\d{1,2}分?)?))$/);
  if (mixedMatch) {
    const start = parseTimeExpression(mixedMatch[1]);
    const end = parseTimeExpression(mixedMatch[2]);
    if (start && end) return { start, end };
  }
  
  return null;
}

/**
 * 日付部分をパースして日番号を返す
 * "4/1" → 1 (月/日 → 日のみ返す。月は検証用)
 * "1日" → 1
 * "1" → 1
 */
function parseDayExpression(expr: string, expectedMonth: number): number | null {
  expr = expr.trim();
  
  // "4/1" → month=4, day=1
  const slashMatch = expr.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (slashMatch) {
    const m = parseInt(slashMatch[1]);
    const d = parseInt(slashMatch[2]);
    // 月が一致するか緩くチェック（一致しなくても日だけ使う）
    if (m !== expectedMonth) {
      // 月が違う場合でも、日だけ返す（ユーザーが4月入力中に4/1と打つのは普通）
    }
    return d;
  }
  
  // "1日" → 1
  const dayMatch = expr.match(/^(\d{1,2})日$/);
  if (dayMatch) return parseInt(dayMatch[1]);
  
  // "1" → 1 (bare number)
  const numMatch = expr.match(/^(\d{1,2})$/);
  if (numMatch) return parseInt(numMatch[1]);
  
  return null;
}

function parseSingleLine(
  line: string,
  year: number,
  month: number,
): { entries: DraftEntry[]; removeDays?: number[]; error: string | null } {
  // 全角→半角変換
  const normalized = line
    .replace(/[０-９]/g, (s) => String.fromCharCode(s.charCodeAt(0) - 0xfee0))
    .replace(/：/g, ':')
    .replace(/ー/g, '-')
    .replace(/〜/g, '-')
    .replace(/～/g, '-')
    .replace(/　/g, ' ')
    .trim();

  // ============================================================
  // 特殊パターン0: 「休み」関連
  // "3日 休み", "4/3 休み", "3 休み"
  // ============================================================
  const restMatch = normalized.match(/^(\d{1,2})(?:\/(\d{1,2}))?日?\s*(?:休み|休日|おやすみ|欠席|お休み)$/);
  if (restMatch) {
    const day = restMatch[2] ? parseInt(restMatch[2]) : parseInt(restMatch[1]);
    const daysInMonth = new Date(year, month, 0).getDate();
    if (day < 1 || day > daysInMonth) {
      return { entries: [], error: `${line}: ${day}日は${month}月にありません` };
    }
    return { entries: [], removeDays: [day], error: null };
  }

  // ============================================================
  // 特殊パターン1: 「平日 8:30-17:30」— 月〜金一括入力
  // ============================================================
  const weekdayBulkMatch = normalized.match(/^(?:平日|へいじつ)\s+(.+)$/);
  if (weekdayBulkMatch) {
    const timeRange = parseTimeRange(weekdayBulkMatch[1]);
    if (timeRange) {
      return buildWeekdayEntries([1, 2, 3, 4, 5], timeRange.start, timeRange.end, year, month, line);
    }
  }

  // ============================================================
  // 特殊パターン2: 「月-金 8:30-17:30」— 曜日範囲指定
  // "月火水木金 8:30-17:30", "月-金 8:30-17:30", "月水金 8:30-17:30"
  // ============================================================
  const DOW_MAP: Record<string, number> = { '日': 0, '月': 1, '火': 2, '水': 3, '木': 4, '金': 5, '土': 6 };
  
  const dowRangeMatch = normalized.match(/^([日月火水木金土])\s*-\s*([日月火水木金土])\s+(.+)$/);
  if (dowRangeMatch) {
    const fromDow = DOW_MAP[dowRangeMatch[1]];
    const toDow = DOW_MAP[dowRangeMatch[2]];
    const timeRange = parseTimeRange(dowRangeMatch[3]);
    if (fromDow !== undefined && toDow !== undefined && timeRange) {
      const dows: number[] = [];
      for (let d = fromDow; d <= toDow; d++) dows.push(d);
      return buildWeekdayEntries(dows, timeRange.start, timeRange.end, year, month, line);
    }
  }
  
  const dowListMatch = normalized.match(/^([日月火水木金土]{2,7})\s+(.+)$/);
  if (dowListMatch) {
    const dows = [...dowListMatch[1]].map(c => DOW_MAP[c]).filter(d => d !== undefined);
    const timeRange = parseTimeRange(dowListMatch[2]);
    if (dows.length > 0 && timeRange) {
      return buildWeekdayEntries(dows, timeRange.start, timeRange.end, year, month, line);
    }
  }

  // ============================================================
  // パターン1: 日付範囲 + 時間範囲
  // "4/1-4/5 8:30-17:30", "1日-5日 8:30-17:30", "1-5 8:30-17:30"
  // ============================================================
  
  // Match: <day_expr>-<day_expr> <time_range>
  // Key insight: 時間範囲は最後の "数字:数字" ペアで始まる
  const rangeWithSlashMatch = normalized.match(
    /^(\d{1,2}\/\d{1,2})\s*-\s*(\d{1,2}\/\d{1,2})\s+(.+)$/,
  );
  if (rangeWithSlashMatch) {
    const dayStart = parseDayExpression(rangeWithSlashMatch[1], month);
    const dayEnd = parseDayExpression(rangeWithSlashMatch[2], month);
    const timeRange = parseTimeRange(rangeWithSlashMatch[3]);
    
    if (dayStart !== null && dayEnd !== null && timeRange) {
      return buildRangeEntries(dayStart, dayEnd, timeRange.start, timeRange.end, year, month, line);
    }
  }
  
  // "1日-5日 8:30-17:30" or "1-5日 8:30-17:30"
  const rangeDayMatch = normalized.match(
    /^(\d{1,2})日?\s*-\s*(\d{1,2})日?\s+(.+)$/,
  );
  if (rangeDayMatch) {
    const dayStart = parseInt(rangeDayMatch[1]);
    const dayEnd = parseInt(rangeDayMatch[2]);
    const timeRange = parseTimeRange(rangeDayMatch[3]);
    
    if (timeRange) {
      return buildRangeEntries(dayStart, dayEnd, timeRange.start, timeRange.end, year, month, line);
    }
  }

  // ============================================================
  // パターン2: 単日 + 時間範囲
  // "4/1 8:30-17:30", "1日 8:30-17:30", "1 8:30-17:30"
  // ============================================================
  
  // "4/1 8:30-17:30"
  const singleSlashMatch = normalized.match(
    /^(\d{1,2}\/\d{1,2})\s+(.+)$/,
  );
  if (singleSlashMatch) {
    const day = parseDayExpression(singleSlashMatch[1], month);
    const timeRange = parseTimeRange(singleSlashMatch[2]);
    
    if (day !== null && timeRange) {
      const validation = validateEntry(day, timeRange.start, timeRange.end, year, month);
      if (validation) return { entries: [], error: `${line}: ${validation}` };
      return { entries: [{ day, start: timeRange.start, end: timeRange.end }], error: null };
    }
  }
  
  // "1日 8:30-17:30" or "1日8時30分から17時"
  const singleDayMatch = normalized.match(
    /^(\d{1,2})日?\s*(.+)$/,
  );
  if (singleDayMatch) {
    const day = parseInt(singleDayMatch[1]);
    const timeRange = parseTimeRange(singleDayMatch[2]);
    
    if (timeRange) {
      const validation = validateEntry(day, timeRange.start, timeRange.end, year, month);
      if (validation) return { entries: [], error: `${line}: ${validation}` };
      return { entries: [{ day, start: timeRange.start, end: timeRange.end }], error: null };
    }
  }

  // ============================================================
  // パターン3: 自然言語風（"1日7時30分から17時2日から10日8時から18時" のような連続入力）
  // → これは1行に複数の予定が入っているケース
  // ============================================================
  const naturalEntries = parseNaturalLanguage(normalized, year, month);
  if (naturalEntries.length > 0) {
    return { entries: naturalEntries, error: null };
  }

  return { entries: [], error: `「${line}」の形式を認識できませんでした。\n例: 4/1 8:30-17:30` };
}

/**
 * 自然言語風の入力をパース
 * "1日7時30分から17時2日から10日8時から18時" → 複数エントリ
 */
function parseNaturalLanguage(
  text: string,
  year: number,
  month: number,
): DraftEntry[] {
  const entries: DraftEntry[] = [];
  
  // "N日M時N分からM時N分" のパターンを繰り返し検索
  const pattern = /(\d{1,2})日\s*(\d{1,2})時(\d{1,2})?分?\s*(?:から|~|-)\s*(\d{1,2})時(\d{1,2})?分?/g;
  let match;
  
  while ((match = pattern.exec(text)) !== null) {
    const day = parseInt(match[1]);
    const startH = match[2].padStart(2, '0');
    const startM = (match[3] ?? '0').padStart(2, '0');
    const endH = match[4].padStart(2, '0');
    const endM = (match[5] ?? '0').padStart(2, '0');
    
    const start = `${startH}:${startM}`;
    const end = `${endH}:${endM}`;
    
    const validation = validateEntry(day, start, end, year, month);
    if (!validation) {
      entries.push({ day, start, end });
    }
  }
  
  return entries;
}

/**
 * 日付範囲からエントリを生成
 */
function buildRangeEntries(
  dayStart: number,
  dayEnd: number,
  start: string,
  end: string,
  year: number,
  month: number,
  originalLine: string,
): { entries: DraftEntry[]; error: string | null } {
  if (dayStart > dayEnd) {
    return { entries: [], error: `${originalLine}: 開始日が終了日より後です` };
  }

  const entries: DraftEntry[] = [];
  for (let d = dayStart; d <= dayEnd; d++) {
    const validation = validateEntry(d, start, end, year, month);
    if (validation) {
      return { entries: [], error: `${originalLine}: ${d}日 - ${validation}` };
    }
    entries.push({ day: d, start, end });
  }
  return { entries, error: null };
}

/**
 * 指定曜日の全日にエントリを生成
 * @param dows - 曜日番号の配列 (0=日, 1=月, ..., 6=土)
 */
function buildWeekdayEntries(
  dows: number[],
  start: string,
  end: string,
  year: number,
  month: number,
  originalLine: string,
): { entries: DraftEntry[]; error: string | null } {
  const daysInMonth = new Date(year, month, 0).getDate();
  const dowSet = new Set(dows);
  const entries: DraftEntry[] = [];

  for (let d = 1; d <= daysInMonth; d++) {
    const dayOfWeek = new Date(year, month - 1, d).getDay();
    if (dowSet.has(dayOfWeek)) {
      const validation = validateEntry(d, start, end, year, month);
      if (validation) {
        return { entries: [], error: `${originalLine}: ${d}日 - ${validation}` };
      }
      entries.push({ day: d, start, end });
    }
  }
  return { entries, error: null };
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
 * 登降園時間から食事フラグを自動判定
 * 
 * 木村さん確定ルール (2026-03-10):
 * - 12時までに登園 → 朝食あり + 昼食あり
 * - 15時以降に降園 → 午後おやつあり
 * - 19時以降に登園（夜間保育） → 朝食あり
 * 
 * 未確定（木村さんに確認中。現在は0固定）:
 * - 午前おやつ (am_snack_flag)
 * - 夕食 (dinner_flag)
 */
export function calculateMealFlags(start: string, end: string): {
  breakfast_flag: number;
  lunch_flag: number;
  am_snack_flag: number;
  pm_snack_flag: number;
  dinner_flag: number;
} {
  const startMinutes = timeToMinutes(start);
  const endMinutes = timeToMinutes(end);
  
  // 夜間保育: 19時以降に登園
  const isNightCare = startMinutes >= timeToMinutes('19:00');
  
  return {
    // 12時前に登園 → 朝食あり、または夜間保育 → 朝食あり
    breakfast_flag: (startMinutes < timeToMinutes('12:00') || isNightCare) ? 1 : 0,
    // 12時前に登園 → 昼食あり
    lunch_flag: startMinutes < timeToMinutes('12:00') ? 1 : 0,
    // 午前おやつ: 未確定（木村さん確認待ち）→ 0固定
    am_snack_flag: 0,
    // 15時以降に降園 → 午後おやつあり
    pm_snack_flag: endMinutes >= timeToMinutes('15:00') ? 1 : 0,
    // 夕食: 未確定（木村さん確認待ち）→ 0固定
    dinner_flag: 0,
  };
}

function timeToMinutes(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/**
 * 確定された予定を schedule_plans に UPSERT
 * 食事フラグは登降園時間から自動判定
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
    const meals = calculateMealFlags(entry.start, entry.end);
    
    await db
      .prepare(
        `INSERT INTO schedule_plans (id, child_id, year, month, day, planned_start, planned_end, breakfast_flag, lunch_flag, am_snack_flag, pm_snack_flag, dinner_flag, source_file)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LINE')
         ON CONFLICT (child_id, year, month, day) DO UPDATE SET
           planned_start = excluded.planned_start,
           planned_end = excluded.planned_end,
           breakfast_flag = excluded.breakfast_flag,
           lunch_flag = excluded.lunch_flag,
           am_snack_flag = excluded.am_snack_flag,
           pm_snack_flag = excluded.pm_snack_flag,
           dinner_flag = excluded.dinner_flag,
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
        meals.breakfast_flag,
        meals.lunch_flag,
        meals.am_snack_flag,
        meals.pm_snack_flag,
        meals.dinner_flag,
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
 * ドラフトを確認メッセージに整形（食事フラグ付き）
 */
export function formatDraftForConfirmation(
  entries: DraftEntry[],
  year: number,
  month: number,
): string {
  if (entries.length === 0) return '入力された予定はありません。';

  const lines = entries.map((e) => {
    const dow = getDayOfWeek(year, month, e.day);
    const meals = calculateMealFlags(e.start, e.end);
    const mealIcons: string[] = [];
    if (meals.breakfast_flag) mealIcons.push('朝食');
    if (meals.lunch_flag) mealIcons.push('昼食');
    if (meals.am_snack_flag) mealIcons.push('午前おやつ');
    if (meals.pm_snack_flag) mealIcons.push('午後おやつ');
    if (meals.dinner_flag) mealIcons.push('夕食');
    const mealStr = mealIcons.length > 0 ? ` [${mealIcons.join('・')}]` : '';
    return `  ${month}/${e.day}(${dow}) ${e.start}〜${e.end}${mealStr}`;
  });

  return `📅 ${year}年${month}月の利用予定:\n\n${lines.join('\n')}\n\n合計: ${entries.length}日`;
}

function getDayOfWeek(year: number, month: number, day: number): string {
  const days = ['日', '月', '火', '水', '木', '金', '土'];
  return days[new Date(year, month - 1, day).getDay()];
}

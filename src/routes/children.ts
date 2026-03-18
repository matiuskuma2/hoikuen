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

// ═══════════════════════════════════
// POST /api/children/import — 園児CSVインポート（クラス判定付き）
// ═══════════════════════════════════
// CSV列: クラス名, 氏名(姓), 氏名(名), 生年月日, ルクミーID, ...
// クラス名が「一時預かり」「一時」→ enrollment_type = '一時'
// それ以外 → enrollment_type = '月極'、birth_date → age_class 自動計算
childRoutes.post('/import', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;

    if (!file || file.size === 0) {
      return c.json({ error: 'CSVファイルを指定してください' }, 400);
    }

    const text = await file.text();
    const lines = text.split(/\r?\n/).filter(l => l.trim());

    if (lines.length < 2) {
      return c.json({ error: 'CSVにデータ行がありません' }, 400);
    }

    const db = c.env.DB;
    if (!db) return c.json({ error: 'データベース接続が利用できません' }, 500);

    const now = new Date();
    const fiscalYear = getFiscalYear(now.getFullYear(), now.getMonth() + 1);

    // Parse header
    const header = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const colIdx: Record<string, number> = {};

    // Auto-detect columns
    const colPatterns: Record<string, string[]> = {
      class_name: ['クラス名', 'クラス', 'class', '組'],
      fullname: ['園児氏名', '氏名', 'name', 'フルネーム'],
      surname: ['園児姓', '姓', '苗字', '名前(姓)'],
      firstname: ['園児名前', '名前(名)'],
      birth_date: ['園児生年月日', '生年月日', '誕生日', 'birthday', '生月日'],
      lukumi_id: ['園児ID', 'ルクミーID', 'ID', '児童ID'],
      kana_fullname: ['園児ふりがな', 'ふりがな', 'よみがな', 'フリガナ'],
      kana_sei: ['姓よみ', 'セイ', '姓読み'],
      kana_mei: ['名よみ', 'メイ', '名読み'],
      enrollment_type: ['利用区分', '区分', '在籍区分', 'enrollment'],
    };

    // Pass 1: exact match only
    for (let i = 0; i < header.length; i++) {
      const h = header[i];
      for (const [field, patterns] of Object.entries(colPatterns)) {
        if (field in colIdx) continue;
        for (const p of patterns) {
          if (h === p) {
            colIdx[field] = i;
            break;
          }
        }
      }
    }
    // Pass 2: includes match (only for patterns of length >= 2, skip already matched)
    for (let i = 0; i < header.length; i++) {
      const h = header[i];
      // Skip columns already assigned
      if (Object.values(colIdx).includes(i)) continue;
      for (const [field, patterns] of Object.entries(colPatterns)) {
        if (field in colIdx) continue;
        for (const p of patterns) {
          if (p.length >= 2 && h.includes(p)) {
            colIdx[field] = i;
            break;
          }
        }
      }
    }

    const warnings: string[] = [];
    const results: { name: string; age_class: number | null; enrollment_type: string; action: string }[] = [];
    let created = 0;
    let updated = 0;
    let skippedDupRows = 0;

    // ── 重複行検出: ルクミーCSV は「姓 名」行と「姓名 フリガナ」行が交互に来る場合がある
    // 同一園児が2行になるのを防ぐため、名前のセットで重複を検出する
    const seenNames = new Set<string>();

    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
      if (cols.length < 2) continue;

      // Name
      let name: string;
      if ('fullname' in colIdx) {
        name = cols[colIdx.fullname] || '';
      } else if ('surname' in colIdx) {
        const sur = cols[colIdx.surname] || '';
        const first = 'firstname' in colIdx ? (cols[colIdx.firstname] || '') : '';
        name = `${sur} ${first}`.trim();
      } else {
        // Fallback: assume col 1 is surname, col 2 is firstname
        name = `${cols[1] || ''} ${cols[2] || ''}`.trim();
      }

      if (!name) {
        warnings.push(`行${i + 1}: 名前が空のためスキップ`);
        continue;
      }

      // ── ルクミーCSV重複行スキップ ──
      // ルクミーCSVは「姓 名」行に続いて「姓名 フリガナ」行がある場合がある
      // 例: 行1「吉田, 希子, ...」→ 行2「吉田 希子, よしだ きこ, ...」
      // 後者はフリガナ行なので、前の園児のサブデータとしてスキップする
      const nameNormForDedup = name.replace(/\s+/g, '');

      // フリガナ行の判定: 名前がひらがな/カタカナを含み、かつ既に漢字名で登録済みの園児のフリガナっぽい場合
      // 具体的には: 「漢字姓名 ふりがな」形式（スペース区切りで4語以上）を検出
      const nameParts = name.split(/\s+/);
      if (nameParts.length >= 4) {
        // 例: "吉田 希子 よしだ きこ" → 姓名+フリガナ形式
        const kanjiName = `${nameParts[0]} ${nameParts[1]}`;
        const kanjiNameNoSpace = `${nameParts[0]}${nameParts[1]}`;
        if (seenNames.has(kanjiNameNoSpace)) {
          // この行はフリガナ行 → スキップしてフリガナ情報を前の園児に付与
          skippedDupRows++;
          const kanaStr = nameParts.slice(2).join(' ');
          // フリガナは次のUPSERTで反映するため、nameを漢字名に変換
          name = kanjiName;
          // seenNames は更新不要（既に存在する）
        }
      }
      // 名前にルクミーIDがなく、かつ前行と同じ漢字名なら重複行
      if (seenNames.has(nameNormForDedup)) {
        // 同一名前の2回目 → フリガナや追加情報の行かもしれないが、重複登録を防ぐ
        // lukumiIdがあればUPDATE、なければスキップ
        const lukumiIdCheck = 'lukumi_id' in colIdx ? (cols[colIdx.lukumi_id] || null) : null;
        if (!lukumiIdCheck) {
          skippedDupRows++;
          continue;
        }
      }
      seenNames.add(nameNormForDedup);

      // Class name → enrollment_type determination
      const className = 'class_name' in colIdx ? (cols[colIdx.class_name] || '') : '';
      const rawEnrollmentType = 'enrollment_type' in colIdx ? (cols[colIdx.enrollment_type] || '') : '';

      let enrollmentType = '月極';
      if (
        className.includes('一時') || className.includes('いちじ') || className.includes('一時預かり') ||
        rawEnrollmentType.includes('一時')
      ) {
        enrollmentType = '一時';
      }

      // Birth date
      let birthDate: string | null = null;
      if ('birth_date' in colIdx) {
        const raw = cols[colIdx.birth_date] || '';
        // Parse various date formats
        const match = raw.match(/(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
        if (match) {
          birthDate = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
        }
      }

      // Age class determination
      let ageClass: number | null = null;
      if (enrollmentType === '月極' && birthDate) {
        ageClass = getAgeClassFromBirthDate(birthDate, fiscalYear);
      }
      // Fallback: parse from class_name (e.g. "0歳児", "1歳児")
      if (ageClass === null && enrollmentType === '月極') {
        const ageMatch = className.match(/(\d)歳/);
        if (ageMatch) ageClass = parseInt(ageMatch[1]);
      }

      // Lukumi ID
      const lukumiId = 'lukumi_id' in colIdx ? (cols[colIdx.lukumi_id] || null) : null;

      // Kana — prefer kana_fullname (園児ふりがな), fallback to sei+mei
      let nameKana: string | null = null;
      if ('kana_fullname' in colIdx) {
        nameKana = cols[colIdx.kana_fullname]?.trim() || null;
      } else {
        const kanaSei = 'kana_sei' in colIdx ? (cols[colIdx.kana_sei] || '') : '';
        const kanaMei = 'kana_mei' in colIdx ? (cols[colIdx.kana_mei] || '') : '';
        nameKana = `${kanaSei} ${kanaMei}`.trim() || null;
      }

      // Check if child already exists (by name or lukumi_id)
      // Normalize name for comparison: remove extra whitespace
      const nameNorm = name.replace(/\s+/g, ' ').trim();
      let existing: Record<string, unknown> | null = null;
      if (lukumiId) {
        existing = await db.prepare(
          `SELECT * FROM children WHERE nursery_id = ? AND lukumi_id = ?`
        ).bind(NURSERY_ID, lukumiId).first() as Record<string, unknown> | null;
      }
      if (!existing) {
        existing = await db.prepare(
          `SELECT * FROM children WHERE nursery_id = ? AND name = ?`
        ).bind(NURSERY_ID, nameNorm).first() as Record<string, unknown> | null;
      }
      if (!existing) {
        // Fallback: try matching without spaces
        const nameNoSpace = nameNorm.replace(/ /g, '');
        const allChildren = await db.prepare(
          `SELECT * FROM children WHERE nursery_id = ?`
        ).bind(NURSERY_ID).all();
        for (const ch of allChildren.results) {
          const chName = String((ch as Record<string, unknown>).name || '').replace(/\s+/g, '');
          if (chName === nameNoSpace) {
            existing = ch as Record<string, unknown>;
            break;
          }
        }
      }

      if (existing) {
        // Update existing
        await db.prepare(`
          UPDATE children SET
            name_kana = COALESCE(?, name_kana),
            birth_date = COALESCE(?, birth_date),
            age_class = COALESCE(?, age_class),
            enrollment_type = ?,
            lukumi_id = COALESCE(?, lukumi_id),
            updated_at = datetime('now')
          WHERE id = ?
        `).bind(
          nameKana, birthDate, ageClass, enrollmentType, lukumiId,
          existing.id as string,
        ).run();
        updated++;
        results.push({ name, age_class: ageClass, enrollment_type: enrollmentType, action: 'updated' });
      } else {
        // Create new
        const childId = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        const viewToken = Array.from(crypto.getRandomValues(new Uint8Array(16)))
          .map(b => b.toString(16).padStart(2, '0')).join('');

        await db.prepare(`
          INSERT INTO children (id, nursery_id, lukumi_id, name, name_kana, birth_date, age_class, enrollment_type, view_token)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          childId, NURSERY_ID, lukumiId, name, nameKana, birthDate, ageClass, enrollmentType, viewToken,
        ).run();
        created++;
        results.push({ name, age_class: ageClass, enrollment_type: enrollmentType, action: 'created' });
      }
    }

    return c.json({
      success: true,
      created,
      updated,
      skipped_duplicates: skippedDupRows,
      total: created + updated,
      results,
      warnings,
      message: `CSVインポート完了: 新規${created}件, 更新${updated}件` + (skippedDupRows > 0 ? `, 重複スキップ${skippedDupRows}件` : ''),
    });

  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('Children import error:', message);
    return c.json({ error: `CSVインポートエラー: ${message}` }, 500);
  }
});

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

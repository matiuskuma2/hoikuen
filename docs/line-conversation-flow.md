# LINE会話フロー 状態機械設計書

> **Version**: 1.0 (2026-03-06)
> **Status**: 設計（実装前）
> **依存**: `docs/line-decisions.md` の全6決定事項に基づく
> **Scope**: あゆっこ保育所（単園）

---

## 1. 設計原則

1. **状態機械で会話を管理** — LLMに会話制御を丸投げしない
2. **推定禁止** — 食事は聞かない（園側管理）。入力は日付・登園・降園の3項目のみ
3. **LLMの役割は限定** — 自由文→構造化変換＋不足質問生成のみ
4. **部分確定可** — 入力分だけ確定→追加入力・追加確定ができる
5. **即座に200 OK** — LINE Platformの1秒タイムアウト対策。処理はwaitUntilで非同期

---

## 2. 状態一覧

```
IDLE → LINKING → LINKED → SELECT_CHILD → SELECT_MONTH
  → COLLECTING → CONFIRM → SAVED
                              ↓
                          (追加入力) → COLLECTING → CONFIRM → SAVED
```

| 状態 | 説明 | 次の遷移 |
|------|------|----------|
| `IDLE` | 初期状態。友だち追加直後 or 連携未完了 | → `LINKING` |
| `LINKING` | 連携コード入力待ち | → `LINKED`（成功） / `IDLE`（失敗） |
| `LINKED` | アカウント連携済み。メニュー待ち | → `SELECT_CHILD` / `CHANGE_REQUEST` |
| `SELECT_CHILD` | 児童選択（複数児童の場合） | → `SELECT_MONTH` |
| `SELECT_MONTH` | 対象月選択 | → `COLLECTING` |
| `COLLECTING` | 予定入力中（日付・登園・降園を収集） | → `CONFIRM`（入力完了） / `COLLECTING`（追加入力） |
| `CONFIRM` | 入力内容の確認待ち | → `SAVED`（確定） / `COLLECTING`（修正） |
| `SAVED` | 保存完了 | → `LINKED`（終了） / `COLLECTING`（追加入力） |
| `CHANGE_REQUEST` | 当月変更リクエスト | → `LINKED` |

---

## 3. 状態遷移の詳細

### 3.1 IDLE → LINKING（友だち追加〜連携コード入力）

**トリガー**: `follow` イベント

**システム応答**:
```
あゆっこ保育所です🌟
友だち追加ありがとうございます！

こちらから毎月の利用予定を提出できるようになります。

連携コードをお持ちの方は、コードを入力してください。
（例: AYK-1234）
```

**連携コードの仕組み**:
- 園側管理画面で保護者ごとに発行（`AYK-XXXX` 形式）
- 1コードで複数児童（兄弟）に紐づけ可能
- `link_codes` テーブルで管理

---

### 3.2 LINKING → LINKED（連携コード検証）

**トリガー**: `AYK-XXXX` パターンのテキスト受信

**処理**:
1. `link_codes` テーブルで検証
2. 有効 → `line_accounts` テーブルに LINE userId と保護者を紐づけ
3. 紐づく児童一覧を取得

**成功応答**:
```
連携が完了しました！

お子様の情報:
・山田 太郎くん（0歳クラス）
・山田 花子ちゃん（3歳クラス）

「予定入力」と送ると、来月の利用予定を入力できます。
```

**失敗応答**:
```
連携コードが見つかりません。
コードをもう一度ご確認ください。
（例: AYK-1234）
```

---

### 3.3 LINKED → SELECT_CHILD（メニュー → 児童選択）

**トリガー**: 「予定入力」「予定」「入力」などのキーワード

**児童が1人の場合**: SELECT_CHILD をスキップ → SELECT_MONTH へ

**児童が複数の場合**:
```
どのお子様の予定を入力しますか？

1. 山田 太郎くん（0歳クラス）
2. 山田 花子ちゃん（3歳クラス）

番号で選んでください。
```

---

### 3.4 SELECT_CHILD → SELECT_MONTH（対象月選択）

**トリガー**: 児童選択完了

**応答**（来月が自動推定される場合）:
```
山田 太郎くんの予定ですね。

2026年4月の利用予定を入力しますか？
（「はい」または別の月を入力してください）
```

**ルール**:
- デフォルトは「来月」を提示
- 25日以前 → 来月分の新規入力
- 25日以降 → 来月分の追加/修正（既に入力済みがあればその旨表示）
- 既存データがあれば「○日分が登録済みです」と表示

---

### 3.5 SELECT_MONTH → COLLECTING（予定入力）

**トリガー**: 対象月確定

**初回ガイダンス**:
```
2026年4月の利用予定を入力します。

利用する日と時間を教えてください。
（食事の入力は不要です。園で管理します。）

【入力例】
・4/1 8:30-17:30
・4/2〜4/5 9:00-18:00
・4/7, 4/8 8:00-17:00

まとめて入力しても、1日ずつでもOKです。
入力が終わったら「確定」と送ってください。
```

**LLMの役割（ここだけ）**:
- 自由文テキストを構造化データに変換
- 不足項目を特定して質問を生成
- 推定は一切しない

**LLMへの入力**:
```json
{
  "user_message": "4/1から4/5は8:30から17:30でお願いします",
  "child_name": "山田 太郎",
  "target_month": "2026-04",
  "already_registered": [3, 7, 8]
}
```

**LLMからの出力（構造化）**:
```json
{
  "parsed_entries": [
    { "day": 1, "start": "8:30", "end": "17:30" },
    { "day": 2, "start": "8:30", "end": "17:30" },
    { "day": 3, "start": "8:30", "end": "17:30" },
    { "day": 4, "start": "8:30", "end": "17:30" },
    { "day": 5, "start": "8:30", "end": "17:30" }
  ],
  "missing_info": [],
  "confirmation_text": "4/1〜4/5 を 8:30-17:30 で登録します。"
}
```

**不足がある場合のLLM出力**:
```json
{
  "parsed_entries": [
    { "day": 1, "start": "8:30", "end": null }
  ],
  "missing_info": ["4/1の降園時間が不明です。何時ですか？"],
  "confirmation_text": null
}
```

**入力パターン対応**:
| パターン | 例 | 処理 |
|---------|-----|------|
| 単日 | `4/1 8:30-17:30` | 1エントリ生成 |
| 範囲 | `4/1〜4/5 9:00-18:00` | 土日を除外して複数エントリ |
| 列挙 | `4/1, 4/3, 4/5 8:30-17:00` | 列挙日のエントリ |
| 休みを指定 | `4/1〜4/30で土日と4/15は休み` | 除外日を除いてエントリ |
| 時間不足 | `4/1から行きます` | 不足質問: 登園・降園時間を聞く |
| あいまい | `いつもと同じで` | 不足質問: 具体的な日付・時間を聞く |

---

### 3.6 COLLECTING → CONFIRM（入力内容確認）

**トリガー**: 「確定」「OK」「これで」などのキーワード

**応答**:
```
以下の内容で登録します。よろしいですか？

📅 2026年4月 山田 太郎くん

4/1（火）8:30 - 17:30
4/2（水）8:30 - 17:30
4/3（木）8:30 - 17:30
4/4（金）8:30 - 17:30
4/5（土）8:30 - 17:30

合計: 5日間

※食事は園で管理します（入力不要）

「はい」で確定、「修正」で入力し直し
```

---

### 3.7 CONFIRM → SAVED（保存実行）

**トリガー**: 「はい」「確定」「OK」

**処理**:
1. `schedule_plans` テーブルに UPSERT（`source_file = 'LINE'`）
2. 既存データがあれば上書き（UPSERTなので安全）

**応答**:
```
登録が完了しました！ ✅

📅 2026年4月: 5日分を登録しました。

追加で入力したい日があれば、続けて入力できます。
別のお子様の入力は「予定入力」と送ってください。
```

---

### 3.8 SAVED → COLLECTING（追加入力）

**トリガー**: 確定後に追加の日付・時間を送信

**応答**: 3.5 と同じフローで追加分を収集 → CONFIRM → SAVED

**ポイント**:
- 既に登録済みの日は「○日は登録済み（8:30-17:30）。上書きしますか？」と確認
- 追加分だけ新たにUPSERT

---

### 3.9 CHANGE_REQUEST（当月変更）

**トリガー**: 連携済みユーザーが当月の変更を申請

**判定ロジック（ルール側、LLMではない）**:

```
現在日時と変更対象日から判定:

1. 対象日 - 現在 ≥ 1日 かつ 現在時刻 < 17:00
   → 予定反映OK (schedule_plans を更新)

2. 対象日 - 現在 ≥ 1日 かつ 現在時刻 ≥ 17:00
   → 変更リクエストとして記録（予定反映はしない）
   → 園に通知

3. 対象日 = 当日
   → 月極: 欠席のみ受付（記録＋通知）
   → 一時: 受付不可
```

**食事キャンセル判定**:
```
対象日 - 現在 ≥ 4日 → キャンセル可
対象日 - 現在 < 4日 → 食事代徴収（記録のみ）
```

**応答（反映OK）**:
```
4/10の予定を変更しました。
変更前: 8:30 - 17:30
変更後: 8:30 - 19:00
```

**応答（記録のみ）**:
```
4/10の変更リクエストを受け付けました。
（前日17時を過ぎているため、園に確認します。）
園からの回答をお待ちください。
```

---

## 4. 会話状態テーブル設計

```sql
-- 会話状態（メモリ代わり。1ユーザー1行）
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  line_user_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'IDLE',
  -- 現在の操作コンテキスト
  current_child_id TEXT,
  current_year INTEGER,
  current_month INTEGER,
  -- 入力中の下書きデータ（JSON）
  draft_entries TEXT DEFAULT '[]',
  -- メタデータ
  last_message_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 会話ログ（監査用・デバッグ用）
CREATE TABLE IF NOT EXISTS conversation_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  line_user_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('incoming', 'outgoing')),
  message_type TEXT NOT NULL,
  message_text TEXT,
  state_before TEXT,
  state_after TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 変更リクエスト（前日17時以降の変更記録）
CREATE TABLE IF NOT EXISTS schedule_change_requests (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  child_id TEXT NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  change_type TEXT NOT NULL CHECK(change_type IN ('absence', 'time_change', 'meal_cancel', 'add_day')),
  original_start TEXT,
  original_end TEXT,
  requested_start TEXT,
  requested_end TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
  requested_by TEXT NOT NULL,
  requested_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by TEXT,
  notes TEXT,
  FOREIGN KEY (child_id) REFERENCES children(id)
);
CREATE INDEX IF NOT EXISTS idx_change_requests_child_date
  ON schedule_change_requests(child_id, year, month, day);
```

---

## 5. 状態遷移図（テキスト版）

```
                    +----------+
        follow      |          |
   ─────────────────>   IDLE   |
                    |          |
                    +----+-----+
                         |
                    AYK-XXXX入力
                         |
                    +----v-----+
                    |          |  コード無効
                    | LINKING  +──────────> IDLE
                    |          |
                    +----+-----+
                         |
                    コード有効
                         |
                    +----v-----+
              +────>|          |<─────────────────+
              |     | LINKED   |                  |
              |     |          |                  |
              |     +----+-----+                  |
              |          |                        |
              |     「予定入力」            「変更」  |
              |          |                   |    |
              |     +----v---------+    +----v--+ |
              |     |              |    | CHANGE | |
              |     | SELECT_CHILD |    | REQUEST+-+
              |     |              |    +--------+
              |     +----+---------+
              |          |
              |     児童選択
              |          |
              |     +----v---------+
              |     |              |
              |     | SELECT_MONTH |
              |     |              |
              |     +----+---------+
              |          |
              |     月選択
              |          |
              |     +----v---------+
              |     |              |<──── 修正
              |     | COLLECTING   |
              |     |              +──+
              |     +----+---------+  |
              |          |            | 追加入力
              |     「確定」          |
              |          |            |
              |     +----v-----+     |
              |     |          |     |
              |     | CONFIRM  |     |
              |     |          |     |
              |     +----+-----+     |
              |          |           |
              |     「はい」         |
              |          |           |
              |     +----v-----+     |
              |     |          +─────+
              +─────+  SAVED   |
               終了  |          |
                    +----------+
```

---

## 6. LLMプロンプト設計

### 6.1 システムプロンプト（テキスト→構造化変換用）

```
あなたは保育所の利用予定を構造化するアシスタントです。

【ルール】
1. 保護者のメッセージから「利用日」「登園時間」「降園時間」を抽出してください。
2. 食事（朝食・昼食・おやつ・夕食）は一切聞かないでください。園側で管理します。
3. 情報が不足している場合は、不足項目を質問してください。
4. 推定や補完は禁止です。明示されていない情報はnullにしてください。
5. 土日も利用の可能性があります。除外しないでください（保護者が明示的に除外した場合のみ）。

【出力形式】
JSON形式で以下を返してください:
{
  "parsed_entries": [
    { "day": 数値, "start": "HH:MM" or null, "end": "HH:MM" or null }
  ],
  "missing_info": ["不足している情報の質問文"],
  "confirmation_text": "確認テキスト（不足がある場合はnull）"
}
```

### 6.2 LLMを使わないケース

以下はルールベースで処理（LLM不要）:
- 連携コード判定（正規表現: `/^AYK-\d{4}$/`）
- 状態遷移（キーワードマッチ: 「予定入力」「確定」「はい」「修正」「変更」）
- 締切判定（日付計算）
- 変更リクエストの反映可否（前日17時ルール）

---

## 7. エラーハンドリング

| 状況 | 応答 |
|------|------|
| 未連携で予定入力しようとした | 「連携コードを入力してください（例: AYK-1234）」 |
| 連携コードが無効 | 「コードが見つかりません。もう一度ご確認ください。」 |
| 対象月が過去 | 「過去の月は変更できません。」 |
| 25日を過ぎた後の来月入力 | 締切後である旨を通知。追加/修正は可能（部分確定の原則） |
| LLM解析に失敗 | 「入力内容を理解できませんでした。以下の形式で入力してください: 4/1 8:30-17:30」 |
| DB保存エラー | 「保存に失敗しました。もう一度お試しください。解決しない場合は園にご連絡ください。」 |
| 前日17時以降の変更 | 変更リクエストとして記録し、園に通知する旨を案内 |

---

## 8. 実装優先度（フェーズ分け）

### Phase 1（MVP）: 予定入力の基本フロー
- IDLE → LINKING → LINKED → SELECT_MONTH → COLLECTING → CONFIRM → SAVED
- 児童1人のみ対応
- LLMなし（固定フォーマット入力のみ）
- 部分確定対応

### Phase 2: 自然言語入力 + 複数児童
- LLMによるテキスト→構造化変換
- SELECT_CHILD 状態の追加
- 追加入力フロー

### Phase 3: 当月変更 + 通知
- CHANGE_REQUEST 状態
- 前日17時ルールの自動判定
- 園スタッフへの通知

---

## 変更履歴

| 日付 | 内容 |
|------|------|
| 2026-03-06 | 初版作成。line-decisions.md の全6決定事項に基づき状態機械を設計 |

# あゆっこ保育園 業務自動化システム — 完全要件定義書

> **Version**: 3.1 (2026-02-16)
> **Status**: MVP事故防止版（課金ルール最終修正済み）
> **Author**: GenSpark AI Developer
> **Reviewed by**: モギモギ（関屋紘之）

---

## 1. システム概要

### 1.1 目的
滋賀医科大学学内保育所「あゆっこ」の月次帳票作成業務を自動化する。
**コア体験**: 「アップロード → ワンクリック生成 → 全成果物ZIP」

### 1.2 技術スタック
| レイヤー | 技術 |
|---------|------|
| Frontend | HTML + TailwindCSS + Vanilla JS |
| Backend | Hono (Cloudflare Workers) |
| Database | Cloudflare D1 (SQLite) |
| Storage | Cloudflare R2 |
| Excel処理 | ExcelJS (Worker内) |
| PDF生成 | jsPDF / pdf-lib |

### 1.3 MVPスコープ
**IN**: 月次帳票自動生成（日報3シート、大学提出用、経理用保育料明細、保護者向け利用明細書）
**OUT**: LINE連携、リアルタイム通知、職員シフト管理（将来拡張）

### 1.4 MVP設計原則（v3.0 追加）

```
■ 原則1: 「書き込みセル最小化」
  → テンプレの数式・書式・条件付き書式を壊さない
  → 数式で自動計算されるシートには直接書かない
  → 入力元（◆保育時間等）にだけ書き、下流は数式に任せる

■ 原則2: 「壊れたら返さない」
  → 書き込み後に #REF!/#VALUE! が増えたらジョブ失敗
  → 数式列の数式が消えたらジョブ失敗
  → 成果物を返さず、原因ログを返す

■ 原則3: 「1画面完結」
  → MVP入力は1画面: 対象月 + ルクミー + 予定表 → 生成ボタン
  → テンプレ・料金ルールは初回設定画面で別管理

■ 原則4: 「止めない」
  → 1園児のエラーは他園児に波及させない
  → 例外は警告として蓄積し、対処提案付きで表示
```

---

## 2. インプット仕様

### 2.1 毎月アップロード（必須）

#### A. 児童利用予定表 (Excel) — 1園児1ファイル
```
ファイル形式: .xlsx
シート名: "原本"
構造:
  B6  = 園児氏名
  J1  = 年（数値）
  M1  = 月（数値）
  
  左半分（日1-15）:
    B12:B26 = 日付（1-15 or Excel日付）
    D列     = 登所時間 (HH:MM)
    G列     = 降所時間 (HH:MM)
    J列     = 昼食フラグ (〇)
    K列     = おやつフラグ (〇)
    L列     = 夕食フラグ (〇)
  
  右半分（日16-31）:
    M12:M27 = 日付
    O列     = 登所時間
    R列     = 降所時間
    U列     = 昼食フラグ
    V列     = おやつフラグ
    W列     = 夕食フラグ

ビジネスルール:
  月極利用 = 15分単位
  一時利用 = 30分単位
```

#### B. ルクミー登降園データ (CSV/Excel)
```
ファイル形式: .xlsx (CSV変換可)
シート名: "シート１"
ヘッダ行: 1
列構造:
  A = クラス名
  B = 園児 姓
  C = 園児 名
  D = 日付 (YYYY/MM/DD)
  E = 登園日時 (YYYY/MM/DD HH:MM:SS or HH:MM)
  F = 降園日時 (YYYY/MM/DD HH:MM:SS or HH:MM)
  G = メモ
  H = 園児ID (安定突合キー ★)
  I = 園児 姓（よみがな）
  J = 園児 名（よみがな）
  K = 園児 生年月日
  L = クラス年齢

特記:
  - 園児IDがシステム間の一意キー
  - 全日NULL行あり（登園なし日も行が存在）
  - 約2000行/月（66名 × 31日）
```

### 2.2 初回のみアップロード

#### C. 保育料案内 PDF（料金マスタ）
```
抽出対象（AI解析で自動抽出）:

■ 月極保育料（月額）
  0~2歳: 第1子 45,000 / 第2子 50,000 / 第3子 54,000
  3歳:   第1子 36,000 / 第2子 41,000 / 第3子 45,000
  4~5歳: 第1子 35,000 / 第2子 39,000 / 第3子 42,000

■ 一時保育料（30分単位）
  0~2歳: 200円/30分
  3歳:   200円/30分
  4~5歳: 150円/30分

■ 追加料金
  早朝保育 (7:00-7:30): 300円/回
  延長保育 (18:00-20:00): 300円/回
  夜間保育 (20:00以降): 0~2歳 3,000円 / 3歳 2,500円 / 4~5歳 2,500円
  病児保育: 2,500円/回

■ 給食料
  昼食:     300円/食
  朝おやつ:  50円/食 (AM)
  午後おやつ: 100円/食 (PM) ★ 50円ではなく100円
  夕食:     300円/食

■ 開園時間
  通常: 7:30 - 20:00
  早朝: 7:00 - 7:30
  夜間: 20:00 -
  年間開所日数: 最大356日（年末年始除く）
```

#### D. テンプレートファイル（日報Excel）
```
ファイル: 日報YYYYMM.xlsx
22シート構成（主要シートのみ記載）:
  ◆園情報        — 園名、年月、開園日等の定数
  ◆園児名簿      — B列No, C列クラス, D列氏名, G列生年月日, H列歳児
  園児登園確認表□  — 出力シート①
  児童実績表申請□  — 出力シート②
  給食実数表（個人）□ — 出力シート③
  ◆保育時間      — 出力シート④
  保育時間 (提出用) — 出力シート⑤（大学提出用）
  ◆日次情報□     — 出力シート⑥
  ルクミー        — ルクミーデータ貼り付け先
```

### 2.3 初回のみアップロード

#### E. 保育料明細テンプレート (Excel)
```
ファイル: あゆっこ_保育料明細.xlsx
月別シート構成（4月〜提出）

月シート列構造:
  K列 = 園児名
  L列 = 生年月日
  M列 = 年齢
  N列 = 区分（月極/一時）
  O列 = 入園日
  Q列 = 徴収方法
  R列 = 請求金額 ★ 数式（触らない）
  S列 = 保育料月額 ★ 触らない
  
  ▼ 書き込み対象列（数量のみ）
  T列 = 一時保育料・回数 (30分×○回)
  U列 = 一時保育料・単価（読取用）
  V列 = 一時保育料・合計 ★ 数式
  W列 = 早朝保育料・回数
  X列 = 早朝保育料・単価（読取用）
  Y列 = 早朝保育料・合計 ★ 数式
  Z列 = 延長保育料・回数
  AA列 = 延長保育料・単価（読取用）
  AB列 = 延長保育料・合計 ★ 数式
  AC列 = 夜間保育料・回数
  AD列 = 夜間保育料・単価（読取用）
  AE列 = 夜間保育料・合計 ★ 数式
  AF列 = 病児保育料・回数
  AG列 = 病児保育料・単価（読取用）
  AH列 = 病児保育料・合計 ★ 数式
  AI列 = 昼食代・食数
  AJ列 = 昼食代・単価（読取用）
  AK列 = 昼食代・合計 ★ 数式
  AL列 = 朝おやつ代・食数
  AM列 = 朝おやつ代・単価（読取用）
  AN列 = 朝おやつ代・合計 ★ 数式
  AO列 = 午後おやつ代・食数
  AP列 = 午後おやつ代・単価（読取用）
  AQ列 = 午後おやつ代・合計 ★ 数式
  AR列 = 夕食代・食数
  AS列 = 夕食代・単価（読取用）
  AT列 = 夕食代・合計 ★ 数式

書き込みルール:
  ✅ 書く: T, W, Z, AC, AF, AI, AL, AO, AR（数量列のみ）
  ❌ 触らない: R, S, V, Y, AB, AE, AH, AK, AN, AQ, AT（数式列）
  ❌ 触らない: U, X, AA, AD, AG, AJ, AM, AP, AS（単価列=テンプレ固定値）
```

---

## 3. アウトプット仕様

### 3.1 出力一覧

| # | 成果物 | 形式 | 用途 | 説明 |
|---|--------|------|------|------|
| ① | 園児登園確認表 | Excel (日報内) | 園内管理 | 日次の出欠確認 |
| ② | 児童実績表申請 | Excel (日報内) | 行政提出 | 登降園時刻・利用時間 |
| ③ | 給食実数表（個人） | Excel (日報内) | 園内管理 | 食事提供実績（★MVP: ◆保育時間から数式自動反映。直接書き込みしない） |
| ④ | ◆保育時間 | Excel (日報内) | 園内管理 | 予定vs実績の全時間管理 |
| ⑤ | 保育時間 (提出用) | Excel (日報内) | 大学提出 | ④の提出フォーマット版 |
| ⑥ | ◆日次情報 | Excel (日報内) | 園内管理 | 日別のサマリ（数式駆動） |
| ⑦ | 保育料明細 | Excel (別ファイル) | 経理用 | 月次請求金額 |
| ⑧ | 利用明細書 | PDF | 保護者配布 | 月次利用・請求の通知 |

### 3.2 園児登園確認表□ — 書き込み仕様（MVP確定）

```
シート名: "園児登園確認表□"
ヘッダ:
  Row 4: B=№, C=クラス, D=名前, E=学齢, F-AJ=日付(2026-01-01〜01-31)
  Row 5: F-AJ=Excel serial numbers (曜日判定用)

データ領域:
  Row 6〜: 1行/園児（stride=1）
  B列 = No (1〜)
  C列 = クラス（月極/一時）
  D列 = 名前
  E列 = 学齢 (0〜5)
  F〜AJ列 = 日付セル

★ MVP書き込みフォーマット（確定）:
  1セルに文字列 "HH:MM-HH:MM" を書き込む
  例: "8:12-17:34"
  
  - 登園あり・降園あり → "8:12-17:34"
  - 登園あり・降園なし → "8:12-" (途中、又は園でまだ在園)
  - 登園なし          → セル空白
  - 休園日            → セル空白（テンプレの背景色で判別）

  時刻フォーマット: H:MM（0埋めなし時間:0埋め分）
    08:12 → "8:12"  ※ 先頭0なし
    17:05 → "17:05"

列オフセット計算（★ v3.0: 固定オフセット方式に確定）:
  col_index = 6 + (day_of_month - 1)
  day 1 → col F (index 6)
  day 31 → col AJ (index 36)
  
  ★ ヘッダ行のDATE値は読み取りに使わない
  （Row4の日付はDATE値ではなく数式で生成されている可能性があり、
   data_only=true で読むと値に見えるが、数式編集すると壊れるリスクがある。
   固定オフセットが最も壊れにくい。）
```

### 3.3 児童実績表申請□ — 書き込み仕様

```
シート名: "児童実績表申請□"
ヘッダ:
  Row 1-6: 固定ヘッダ（園名、開園日等）
  Row 4 (or 6): 日付ヘッダ G-X列 = 日付
  
データ領域:
  Row 7〜: 4行/園児ブロック (stride=4)
  
  行1 (offset+0): 登園時刻
    A列 = 園児No
    B列 = 園児No (日報内連番)
    D列 = (空 or 園児名)
    G〜X列 = 登園時刻 (HH:MM or Excelシリアル時刻)
    
  行2 (offset+1): 降園時刻
    G〜X列 = 降園時刻
    
  行3 (offset+2): 利用時間
    D列 = 職員名
    G〜X列 = 利用時間 (H:MM形式)
    
  行4 (offset+3): 一時利用数
    G〜X列 = 一時利用30分ブロック数

園児n のブロック開始行: 7 + (n-1) * 4

★ 書き込み値:
  登園: Excel時刻シリアル値 (例: 8:30 → 0.354166...)
  降園: Excel時刻シリアル値
  利用時間: Excel時刻シリアル値 (降園-登園)
  一時利用数: 整数（一時園児のみ、30分単位の利用ブロック数）
```

### 3.4 給食実数表（個人）□ — MVP方針（v3.0 変更）

```
★★★ MVP決定: このシートには直接書き込まない ★★★

理由:
  1. このシートは◆保育時間シートのOFFSET参照で駆動している
  2. ◆保育時間の給食列（昼食/朝おやつ/午後おやつ/夕食）に〇を書けば
     給食実数表は数式で自動計算される
  3. 直接書き込むとテンプレの計算構造を壊すリスクが高い
     （データ検証・条件付き書式がExcelJS保存時に落ちる危険）
  4. 「書き込みセル最小化」原則に従い、入力元のみに書く

MVP動作:
  → ◆保育時間シートに予定/実績/給食マークを正しく書く
  → 給食実数表（個人）□はテンプレの数式が自動反映
  → システムは一切触らない（読み取り専用シート扱い）

Post-MVP:
  → 数式で自動反映されない項目があれば、その時点で書き込み対象に昇格
  → ただし書き込む場合も「値のみ＋検証」の2段階方式を必ず適用

参考: 構造分析結果（読み取り専用として保持）
  シート名: "給食実数表（個人）□"
  Row 1-5: 単価定義 (C2:D5 = 昼食300, 朝おやつ50, 午後おやつ50, 夕食300)
  Row 10〜: 8行/園児ブロック (stride=8)
    前半4行 = 個人日次、後半4行 = 月極集計
    AK=計, AL=単価, AM=小計, AN=合計, AO-AR=食種別合計
```

### 3.5 ◆保育時間 — 書き込み仕様

```
シート名: "◆保育時間"
構造: 園児を横に展開（8列/園児ブロック）

ヘッダ:
  Row 1: 年齢起算日
  Row 2: 園児番号 (H2=1, P2=2, X2=3, ...)
  Row 3: 年月、歳児クラス
  Row 4: 園児名 (H4, P4, X4, ...)
  Row 5: 列ヘッダ

園児nの列ブロック開始: col_start = 8 + (n-1) * 8
  col+0 (H) = 利用時間開始（予定登園）
  col+1 (I) = 利用時間終了（予定降園）
  col+2 (J) = 通園時間開始（実績登園）
  col+3 (K) = 通園時間終了（実績降園）
  col+4 (L) = 昼食 (〇)
  col+5 (M) = 朝おやつ (〇)
  col+6 (N) = 午後おやつ (〇)
  col+7 (O) = 夕食 (〇)

行: Row 6 = 1月1日, Row 7 = 1月2日, ... Row 36 = 1月31日

★ 書き込み値:
  予定登園/降園: Excel時刻シリアル値
  実績登園/降園: Excel時刻シリアル値
  給食: "〇" or 空白
```

### 3.6 保育時間 (提出用) — 書き込み仕様

```
シート名: "保育時間 (提出用)"
構造: ◆保育時間と同様だが列配置が異なる

ヘッダ:
  Row 4-5: 年月、歳児
  Row 6: 園児名 (I6, Q6, Y6, ...)
  Row 7: 列ヘッダ

園児nの列ブロック開始: col_start = 9 + (n-1) * 8
  col+0 (I) = 利用時間開始
  col+1 (J) = 利用時間終了
  col+2 (K) = 通園時間開始
  col+3 (L) = 通園時間終了
  col+4 (M) = 朝食 (〇)
  col+5 (N) = 昼食 (〇)
  col+6 (O) = おやつ (〇)
  col+7 (P) = 夕食 (〇)

行: Row 8 = 1月1日, Row 9 = 1月2日, ...

★ 注: ◆保育時間と同じデータを別レイアウトで書く（参照式の可能性あり → 要確認）
```

### 3.7 保育料明細 — 書き込み仕様

```
ファイル: あゆっこ_保育料明細.xlsx
対象シート: 月名シート (例: "1月")

書き込み対象（数量列のみ）:
  T列  = 一時保育料・30分×回数
  W列  = 早朝保育料・回数
  Z列  = 延長保育料・回数
  AC列 = 夜間保育料・回数
  AF列 = 病児保育料・回数
  AI列 = 昼食代・食数
  AL列 = 朝おやつ代・食数
  AO列 = 午後おやつ代・食数
  AR列 = 夕食代・食数

読み取り専用（突合用）:
  K列 = 園児名
  N列 = 区分（月極/一時）
  
★ 絶対に触らない:
  R列（請求金額=数式）, S列（月額保育料）
  V,Y,AB,AE,AH,AK,AN,AQ,AT列（合計=数式）
  U,X,AA,AD,AG,AJ,AM,AP,AS列（単価=固定値）
```

### 3.8 利用明細書 PDF — 生成仕様

```
レイアウト: A4縦
フォント: IPAex Gothic (or NotoSansCJK)

構成:
  y=55pt:  タイトル "利用明細書"
  y=73pt:  年月 "2026年1月"
  y=92pt:  園児名 "Mondal Aum 様"
  
  y=118pt〜: 日次テーブル（31行、行高13.45pt）
    列: 日, 曜日, 予定登園, 予定降園, 実績登園, 実績降園, 利用時間, 出欠マーク
  
  y=569pt〜: 請求テーブル
    保育料（月額）, 一時保育料, 早朝保育料, 延長保育料, 夜間保育料,
    病児保育料, 昼食代, 朝おやつ代, 午後おやつ代, 夕食代, 調整費
    各項目: 回数/食数, 単価, 小計
  
  y=731pt:  合計金額
```

---

## 4. データモデル (D1 Schema)

### 4.1 ERD概要

```
nurseries ──< children
nurseries ──< jobs
nurseries ──< pricing_rules
nurseries ──< templates
children  ──< schedule_plans
children  ──< attendance_records
children  ──< usage_facts
children  ──< charge_lines
jobs      ──< job_logs
jobs      ──< output_files
```

### 4.2 テーブル定義

```sql
-- 0001_initial_schema.sql

-- 園情報
CREATE TABLE IF NOT EXISTS nurseries (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  name TEXT NOT NULL DEFAULT 'あゆっこ',
  settings_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- 園児マスタ
CREATE TABLE IF NOT EXISTS children (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  nursery_id TEXT NOT NULL REFERENCES nurseries(id),
  lukumi_id TEXT,                    -- ルクミー園児ID (安定キー)
  name TEXT NOT NULL,                -- 氏名（全角スペース正規化済み）
  name_kana TEXT,                    -- フリガナ
  birth_date TEXT,                   -- 生年月日 (YYYY-MM-DD)
  age_class INTEGER,                 -- 歳児クラス (0-5)
  enrollment_type TEXT NOT NULL CHECK(enrollment_type IN ('月極','一時')),
  child_order INTEGER DEFAULT 1,     -- 第○子
  enrolled_at TEXT,                  -- 入園日
  withdrawn_at TEXT,                 -- 退園日
  collection_method TEXT DEFAULT '口座振替', -- 徴収方法
  bank_info_json TEXT,               -- 銀行口座情報(JSON)
  is_allergy INTEGER DEFAULT 0,      -- アレルギー食フラグ
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_children_lukumi ON children(lukumi_id);
CREATE INDEX idx_children_nursery ON children(nursery_id);
CREATE INDEX idx_children_name ON children(name);

-- 利用予定（月次）
CREATE TABLE IF NOT EXISTS schedule_plans (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  child_id TEXT NOT NULL REFERENCES children(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  planned_start TEXT,                -- 予定登園 (HH:MM)
  planned_end TEXT,                  -- 予定降園 (HH:MM)
  lunch_flag INTEGER DEFAULT 0,      -- 昼食予定
  am_snack_flag INTEGER DEFAULT 0,   -- 朝おやつ予定
  pm_snack_flag INTEGER DEFAULT 0,   -- 午後おやつ予定
  dinner_flag INTEGER DEFAULT 0,     -- 夕食予定
  source_file TEXT,                  -- 元ファイル名
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(child_id, year, month, day)
);

-- 登降園実績（ルクミー）
CREATE TABLE IF NOT EXISTS attendance_records (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  child_id TEXT NOT NULL REFERENCES children(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  actual_checkin TEXT,               -- 実績登園 (HH:MM:SS)
  actual_checkout TEXT,              -- 実績降園 (HH:MM:SS)
  memo TEXT,
  raw_class TEXT,                    -- 元クラス名
  source_file TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(child_id, year, month, day)
);

-- 利用実績（計算結果）
CREATE TABLE IF NOT EXISTS usage_facts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  child_id TEXT NOT NULL REFERENCES children(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  
  -- 課金用の開始・終了
  billing_start TEXT,                -- 課金開始 (HH:MM) = planned_start (あれば) else actual_checkin
  billing_end TEXT,                  -- 課金終了 (HH:MM) = max(planned_end, actual_checkout)
  billing_minutes INTEGER,           -- 課金対象分数
  
  -- 時間区分フラグ
  is_early_morning INTEGER DEFAULT 0,  -- 早朝 (7:00-7:30)
  is_extension INTEGER DEFAULT 0,      -- 延長 (18:00-20:00)
  is_night INTEGER DEFAULT 0,          -- 夜間 (20:00-)
  is_sick INTEGER DEFAULT 0,           -- 病児
  
  -- 一時利用
  spot_30min_blocks INTEGER DEFAULT 0, -- 30分ブロック数
  
  -- 給食
  has_lunch INTEGER DEFAULT 0,
  has_am_snack INTEGER DEFAULT 0,
  has_pm_snack INTEGER DEFAULT 0,
  has_dinner INTEGER DEFAULT 0,
  meal_allergy INTEGER DEFAULT 0,      -- △表示
  
  -- 出欠
  attendance_status TEXT DEFAULT 'present' 
    CHECK(attendance_status IN ('present','absent','early_leave','late_arrive','absent_no_plan')),
  
  exception_notes TEXT,               -- 異常メモ（AI生成）
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(child_id, year, month, day)
);

-- 請求明細行
CREATE TABLE IF NOT EXISTS charge_lines (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  child_id TEXT NOT NULL REFERENCES children(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  charge_type TEXT NOT NULL CHECK(charge_type IN (
    'monthly_fee','spot_care','early_morning','extension',
    'night','sick','lunch','am_snack','pm_snack','dinner'
  )),
  quantity INTEGER NOT NULL DEFAULT 0,    -- 回数/食数/30分ブロック数
  unit_price INTEGER NOT NULL DEFAULT 0,  -- 単価（円）
  subtotal INTEGER NOT NULL DEFAULT 0,    -- 小計
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(child_id, year, month, charge_type)
);

-- 料金ルール
CREATE TABLE IF NOT EXISTS pricing_rules (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  nursery_id TEXT NOT NULL REFERENCES nurseries(id),
  fiscal_year INTEGER NOT NULL,
  rules_json TEXT NOT NULL,           -- 全料金ルール（JSON）
  source_file TEXT,
  extracted_at TEXT DEFAULT (datetime('now')),
  UNIQUE(nursery_id, fiscal_year)
);

-- ジョブ管理
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  nursery_id TEXT NOT NULL REFERENCES nurseries(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','parsing','calculating','generating','completed','failed')),
  input_files_json TEXT,              -- アップロードファイル一覧
  progress_pct INTEGER DEFAULT 0,
  error_json TEXT,                    -- エラー詳細
  warnings_json TEXT,                 -- 警告一覧（止めない）
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX idx_jobs_nursery ON jobs(nursery_id, year, month);

-- ジョブログ
CREATE TABLE IF NOT EXISTS job_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  level TEXT NOT NULL CHECK(level IN ('info','warn','error')),
  phase TEXT NOT NULL,                -- parsing, calculating, generating
  message TEXT NOT NULL,
  detail_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- 生成ファイル
CREATE TABLE IF NOT EXISTS output_files (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  file_type TEXT NOT NULL,            -- daily_report, billing_detail, parent_statement, zip
  file_name TEXT NOT NULL,
  r2_key TEXT NOT NULL,               -- R2保存キー
  file_size INTEGER,
  content_type TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- テンプレート管理
CREATE TABLE IF NOT EXISTS templates (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  nursery_id TEXT NOT NULL REFERENCES nurseries(id),
  template_type TEXT NOT NULL CHECK(template_type IN (
    'daily_report','billing_detail','parent_statement'
  )),
  file_name TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  mapping_json TEXT NOT NULL,          -- テンプレートマッピング定義
  uploaded_at TEXT DEFAULT (datetime('now')),
  UNIQUE(nursery_id, template_type)
);

-- 名前突合テーブル（名前正規化マッピング）
CREATE TABLE IF NOT EXISTS name_mappings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  nursery_id TEXT NOT NULL REFERENCES nurseries(id),
  source_system TEXT NOT NULL,         -- lukumi, plan, roster, billing
  original_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  child_id TEXT REFERENCES children(id),
  confidence REAL DEFAULT 1.0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(nursery_id, source_system, original_name)
);
```

---

## 5. template_mappings.mapping_json 完全定義

### 5.1 園児登園確認表

```json
{
  "template_kind": "daily_report_xlsx",
  "sheet_name": "園児登園確認表□",
  "version": "2.0",
  
  "header": {
    "note": "v3.0: 日付列はヘッダ読み取りではなく固定オフセットで決定（数式破損リスク回避）",
    "date_row": 4,
    "date_cols": { "start": "F", "end": "AJ" },
    "date_format": "fixed_offset",
    "date_col_formula": "col_F_index(6) + (day_of_month - 1)",
    "serial_row": 5
  },
  
  "child_list": {
    "start_row": 6,
    "stride": 1,
    "cols": {
      "no": "B",
      "class": "C",
      "name": "D",
      "age_class": "E"
    }
  },
  
  "data_write": {
    "mode": "string_in_cell",
    "format": "H:MM-H:MM",
    "col_offset_formula": "col_F + (day - 1)",
    "values": {
      "present": "{checkin_H}:{checkin_MM}-{checkout_H}:{checkout_MM}",
      "checkin_only": "{checkin_H}:{checkin_MM}-",
      "absent": null
    },
    "time_format": {
      "hour": "no_leading_zero",
      "minute": "zero_padded"
    }
  },
  
  "post_write_checks": [
    { "check": "no_ref_error", "scope": "data_area" },
    { "check": "no_value_error", "scope": "data_area" }
  ]
}
```

### 5.2 児童実績表申請

```json
{
  "template_kind": "daily_report_xlsx",
  "sheet_name": "児童実績表申請□",
  "version": "2.0",
  
  "header": {
    "date_row": 6,
    "date_cols": { "start": "G", "end": "X" },
    "note": "日付列はG-X（18列で足りない場合はheader readで動的判定）"
  },
  
  "child_list": {
    "start_row": 7,
    "stride": 4,
    "rows_per_child": [
      { "offset": 0, "label": "登園", "data_type": "excel_time_serial" },
      { "offset": 1, "label": "降園", "data_type": "excel_time_serial" },
      { "offset": 2, "label": "利用時間", "data_type": "excel_time_serial" },
      { "offset": 3, "label": "一時利用数", "data_type": "integer" }
    ],
    "cols": {
      "child_no_a": "A",
      "child_no_b": "B",
      "staff_name": "D"
    }
  },
  
  "data_write": {
    "mode": "multi_row_block",
    "time_format": "excel_serial",
    "col_offset_formula": "col_G + (day - 1)",
    "rows": {
      "登園": { "value": "actual_checkin_serial" },
      "降園": { "value": "actual_checkout_serial" },
      "利用時間": { "value": "usage_duration_serial" },
      "一時利用数": { 
        "value": "spot_30min_blocks",
        "condition": "enrollment_type == '一時'"
      }
    }
  },
  
  "post_write_checks": [
    { "check": "no_ref_error", "scope": "data_area" },
    { "check": "row_stride_intact", "expected_stride": 4 }
  ]
}
```

### 5.3 給食実数表（個人）— MVP: 書き込まない（v3.0 変更）

```json
{
  "template_kind": "daily_report_xlsx",
  "sheet_name": "給食実数表（個人）□",
  "version": "3.0",
  
  "mvp_policy": "DO_NOT_WRITE",
  "reason": "◆保育時間シートのOFFSET参照で駆動。入力元(◆保育時間)にだけ書き、このシートは数式に任せる。",
  
  "data_write": {
    "mode": "none",
    "note": "MVPでは一切書き込まない。◆保育時間の給食列が正しければ自動反映される。"
  },
  
  "post_write_checks": [
    { "check": "no_ref_error", "scope": "data_area", "note": "他シート書き込み後に連鎖破損がないか確認" },
    { "check": "summary_not_empty", "cols": ["AK", "AN"], "note": "数式の自動計算結果が入っているか" }
  ],
  
  "structure_reference": {
    "note": "Post-MVP用の構造情報（参考保持）",
    "start_row": 10,
    "stride": 8,
    "unit_prices": { "C2": "昼食=300", "C3": "朝おやつ=50", "C4": "午後おやつ=50", "C5": "夕食=300" }
  }
}
```

### 5.4 ◆保育時間

```json
{
  "template_kind": "daily_report_xlsx",
  "sheet_name": "◆保育時間",
  "version": "2.0",
  
  "header": {
    "child_number_row": 2,
    "child_name_row": 4,
    "column_header_row": 5,
    "date_start_row": 6
  },
  
  "child_list": {
    "layout": "horizontal",
    "first_child_col": "H",
    "stride_cols": 8,
    "cols_per_child": [
      { "offset": 0, "label": "利用時間開始", "data": "planned_start" },
      { "offset": 1, "label": "利用時間終了", "data": "planned_end" },
      { "offset": 2, "label": "通園時間開始", "data": "actual_checkin" },
      { "offset": 3, "label": "通園時間終了", "data": "actual_checkout" },
      { "offset": 4, "label": "昼食", "data": "lunch_mark" },
      { "offset": 5, "label": "朝おやつ", "data": "am_snack_mark" },
      { "offset": 6, "label": "午後おやつ", "data": "pm_snack_mark" },
      { "offset": 7, "label": "夕食", "data": "dinner_mark" }
    ]
  },
  
  "data_write": {
    "mode": "time_serial_and_marks",
    "row_offset_formula": "row_6 + (day - 1)",
    "time_cols": {
      "format": "excel_time_serial",
      "fields": ["planned_start", "planned_end", "actual_checkin", "actual_checkout"]
    },
    "meal_cols": {
      "format": "string",
      "values": { "yes": "〇", "allergy": "△", "no": null }
    }
  }
}
```

### 5.5 保育料明細

```json
{
  "template_kind": "billing_detail_xlsx",
  "sheet_name_pattern": "{month}月",
  "version": "2.0",
  
  "header": {
    "column_def_rows": [5, 6, 7],
    "data_start_row": 8
  },
  
  "child_list": {
    "layout": "vertical",
    "stride": 1,
    "match_col": "K",
    "match_field": "name"
  },
  
  "data_write": {
    "mode": "quantity_only",
    "columns": {
      "spot_care_count":    { "col": "T", "type": "integer", "label": "一時保育30分×回数" },
      "early_morning_count":{ "col": "W", "type": "integer", "label": "早朝保育回数" },
      "extension_count":    { "col": "Z", "type": "integer", "label": "延長保育回数" },
      "night_count":        { "col": "AC", "type": "integer", "label": "夜間保育回数" },
      "sick_count":         { "col": "AF", "type": "integer", "label": "病児保育回数" },
      "lunch_count":        { "col": "AI", "type": "integer", "label": "昼食食数" },
      "am_snack_count":     { "col": "AL", "type": "integer", "label": "朝おやつ食数" },
      "pm_snack_count":     { "col": "AO", "type": "integer", "label": "午後おやつ食数" },
      "dinner_count":       { "col": "AR", "type": "integer", "label": "夕食食数" }
    },
    "protected_columns": [
      "R", "S", "V", "Y", "AB", "AE", "AH", "AK", "AN", "AQ", "AT",
      "U", "X", "AA", "AD", "AG", "AJ", "AM", "AP", "AS"
    ]
  },
  
  "post_write_checks": [
    { "check": "no_ref_error", "scope": "R:AT" },
    { "check": "formula_intact", "cols": ["R", "V", "Y", "AB", "AE", "AH", "AK", "AN", "AQ", "AT"] },
    { "check": "sum_positive_or_zero", "col": "R" }
  ]
}
```

---

## 6. usage_facts 計算アルゴリズム

### 6.1 Zodスキーマ

```typescript
import { z } from 'zod';

// === Input Schemas ===

const TimeStr = z.string().regex(/^\d{1,2}:\d{2}(:\d{2})?$/);
const DayInt = z.number().int().min(1).max(31);

const SchedulePlanInput = z.object({
  child_id: z.string(),
  day: DayInt,
  planned_start: TimeStr.nullable(),  // HH:MM
  planned_end: TimeStr.nullable(),
  lunch_flag: z.boolean(),
  am_snack_flag: z.boolean(),
  pm_snack_flag: z.boolean(),
  dinner_flag: z.boolean(),
});

const AttendanceInput = z.object({
  child_id: z.string(),
  day: DayInt,
  actual_checkin: TimeStr.nullable(),   // HH:MM:SS
  actual_checkout: TimeStr.nullable(),
  memo: z.string().nullable(),
});

const ChildMaster = z.object({
  id: z.string(),
  name: z.string(),
  age_class: z.number().int().min(0).max(5),
  enrollment_type: z.enum(['月極', '一時']),
  is_allergy: z.boolean(),
});

const PricingRules = z.object({
  monthly_fees: z.record(z.string(), z.record(z.string(), z.number())),
  spot_rates: z.record(z.string(), z.number()),     // age_group → yen/30min
  early_morning_fee: z.number(),                     // 300
  extension_fee: z.number(),                         // 300
  night_fees: z.record(z.string(), z.number()),      // age_group → yen
  sick_fee: z.number(),                              // 2500
  meal_prices: z.object({
    lunch: z.number(),         // 300
    am_snack: z.number(),      // 50
    pm_snack: z.number(),      // 100
    dinner: z.number(),        // 300
  }),
  time_boundaries: z.object({
    open: z.string(),           // "07:30"
    early_start: z.string(),    // "07:00"
    early_end: z.string(),      // "07:30"
    extension_start: z.string(),// "18:00"
    night_start: z.string(),    // "20:00"
    close: z.string(),          // "20:00" (通常)
  }),
});

// === Output Schemas ===

const UsageFact = z.object({
  child_id: z.string(),
  year: z.number(),
  month: z.number(),
  day: DayInt,
  
  billing_start: TimeStr.nullable(),
  billing_end: TimeStr.nullable(),
  billing_minutes: z.number().int().nullable(),
  
  is_early_morning: z.boolean(),
  is_extension: z.boolean(),
  is_night: z.boolean(),
  is_sick: z.boolean(),
  
  spot_30min_blocks: z.number().int(),
  
  has_lunch: z.boolean(),
  has_am_snack: z.boolean(),
  has_pm_snack: z.boolean(),
  has_dinner: z.boolean(),
  meal_allergy: z.boolean(),
  
  attendance_status: z.enum([
    'present',        // 通常出席
    'absent',         // 予定あり欠席
    'early_leave',    // 早退
    'late_arrive',    // 遅刻
    'absent_no_plan', // 予定なし（無視）
  ]),
  
  exception_notes: z.string().nullable(),
});

const ChargeLine = z.object({
  child_id: z.string(),
  year: z.number(),
  month: z.number(),
  charge_type: z.enum([
    'monthly_fee', 'spot_care', 'early_morning', 'extension',
    'night', 'sick', 'lunch', 'am_snack', 'pm_snack', 'dinner',
  ]),
  quantity: z.number().int(),
  unit_price: z.number().int(),
  subtotal: z.number().int(),
  notes: z.string().nullable(),
});
```

### 6.2 usage_facts 計算アルゴリズム（疑似コード）

```
FUNCTION compute_usage_fact(
  child: ChildMaster,
  plan: SchedulePlanInput | null,
  actual: AttendanceInput | null,
  rules: PricingRules,
  year: int, month: int
) → UsageFact:

  fact = new UsageFact(child_id=child.id, year, month, day)

  // ─── Step 1: 出欠判定 ───
  has_plan = plan != null AND plan.planned_start != null
  has_checkin = actual != null AND actual.actual_checkin != null
  has_checkout = actual != null AND actual.actual_checkout != null

  IF NOT has_plan AND NOT has_checkin:
    fact.attendance_status = 'absent_no_plan'
    RETURN fact  // 何も書かない

  IF has_plan AND NOT has_checkin:
    fact.attendance_status = 'absent'
    fact.exception_notes = "予定あり・実績なし（欠席）"
    // 給食フラグはクリア（食べていない）
    RETURN fact

  // ─── Step 2: 課金時間の決定 ───
  // ★★★ 核心ルール (v3.1 最終確定) ★★★
  //   start = planned_start（予定があれば常に予定を優先）
  //           予定がなければ actual_checkin を使用
  //   end   = max(planned_end, actual_checkout) ← 遅い方を採用
  //   どちらか欠けている場合はある方を使用
  //
  // 設計意図: 予定時刻から課金する（遅刻しても予定開始で課金）
  //   ただし予定表未提出の飛び込み利用は実績を使う
  //
  // 例: 予定 9:00-15:00 / 実績 9:15-15:15 → 課金 9:00-15:15 (予定開始優先)
  // 例: 予定 9:00-15:00 / 実績 8:45-14:30 → 課金 9:00-15:00 (予定開始優先)
  // 例: 予定なし / 実績 10:00-16:00 → 課金 10:00-16:00 (実績のみ)
  
  IF has_plan AND has_checkin:
    // 開始: 予定を常に優先（遅刻しても予定開始時刻で課金）
    billing_start = plan.planned_start
    
    // 終了: 予定と実績の遅い方（どちらか欠けたらある方）
    IF has_checkout AND plan.planned_end != null:
      plan_end_min = toMinutes(plan.planned_end)
      actual_end_min = toMinutes(actual.actual_checkout)
      billing_end = (actual_end_min > plan_end_min)
        ? actual.actual_checkout
        : plan.planned_end
    ELSE IF has_checkout:
      billing_end = actual.actual_checkout
    ELSE IF plan.planned_end != null:
      billing_end = plan.planned_end
    ELSE:
      billing_end = null
    
    fact.attendance_status = 'present'
    
    // 早退判定: 実績降園が予定降園より30分以上前
    IF has_checkout AND plan.planned_end != null AND
       toMinutes(plan.planned_end) - toMinutes(actual.actual_checkout) > 30:
      fact.attendance_status = 'early_leave'
    
    // 遅刻判定: 実績登園が予定登園より15分以上後
    IF toMinutes(actual.actual_checkin) - toMinutes(plan.planned_start) > 15:
      fact.attendance_status = 'late_arrive'

  ELSE IF NOT has_plan AND has_checkin:
    // 予定なし・実績あり（飛び込み利用）
    billing_start = actual.actual_checkin
    billing_end = actual.actual_checkout
    fact.exception_notes = "予定表未提出・実績のみ"
    fact.attendance_status = 'present'

  // 降園未記録（予定終了もない場合）
  IF billing_end == null:
    fact.exception_notes += " / 降園未記録・予定終了もなし"

  fact.billing_start = formatTime(billing_start)
  fact.billing_end = formatTime(billing_end)

  // ─── Step 3: 分数計算 ───
  IF billing_start != null AND billing_end != null:
    fact.billing_minutes = toMinutes(billing_end) - toMinutes(billing_start)
    IF fact.billing_minutes < 0:
      fact.billing_minutes = 0
      fact.exception_notes += " / 負の利用時間（エラー）"

  // ─── Step 4: 時間区分フラグ ───
  start_min = toMinutes(billing_start)
  end_min = toMinutes(billing_end)
  
  // 早朝: 7:00-7:30 に在園
  early_start = toMinutes(rules.time_boundaries.early_start)   // 420
  early_end   = toMinutes(rules.time_boundaries.early_end)     // 450
  fact.is_early_morning = start_min < early_end AND start_min >= early_start

  // 延長: 18:00 以降
  ext_start = toMinutes(rules.time_boundaries.extension_start)  // 1080
  fact.is_extension = end_min != null AND end_min > ext_start

  // 夜間: 20:00 以降
  night_start = toMinutes(rules.time_boundaries.night_start)    // 1200
  fact.is_night = end_min != null AND end_min > night_start

  // ─── Step 5: 一時利用ブロック数 ───
  IF child.enrollment_type == '一時' AND fact.billing_minutes != null:
    // 30分単位で切り上げ
    fact.spot_30min_blocks = CEIL(fact.billing_minutes / 30)

  // ─── Step 6: 給食フラグ ───
  // 実際に登園した日のみ給食をカウント
  IF fact.attendance_status IN ('present', 'late_arrive'):
    // 予定表の給食フラグを基本に、実績の在園時間で補正
    IF has_plan:
      fact.has_lunch    = plan.lunch_flag
      fact.has_am_snack = plan.am_snack_flag
      fact.has_pm_snack = plan.pm_snack_flag
      fact.has_dinner   = plan.dinner_flag
    ELSE:
      // 予定なしの場合、在園時間から推定
      fact.has_lunch    = (start_min <= 720 AND end_min >= 720)  // 12:00在園
      fact.has_am_snack = (start_min <= 600)                      // 10:00前登園
      fact.has_pm_snack = (end_min >= 900)                        // 15:00以降在園
      fact.has_dinner   = (end_min >= 1080)                       // 18:00以降在園
    
    // 早退の場合、実際の降園時間で食事フラグを修正
    IF fact.attendance_status == 'early_leave' AND end_min != null:
      IF end_min < 720: fact.has_lunch = false
      IF end_min < 900: fact.has_pm_snack = false
      IF end_min < 1080: fact.has_dinner = false
  
  fact.meal_allergy = child.is_allergy

  RETURN fact
```

### 6.3 charge_lines 生成アルゴリズム（疑似コード）

```
FUNCTION generate_charge_lines(
  child: ChildMaster,
  facts: UsageFact[],         // 当月全日分
  rules: PricingRules,
  year: int, month: int
) → ChargeLine[]:

  lines = []
  age_group = get_age_group(child.age_class)  // "0~2歳" | "3歳" | "4~5歳"

  // ─── 1. 月額保育料（月極のみ） ───
  IF child.enrollment_type == '月極':
    monthly = rules.monthly_fees[age_group][String(child.child_order)]
    lines.push({
      charge_type: 'monthly_fee',
      quantity: 1,
      unit_price: monthly,
      subtotal: monthly,
      notes: f"{age_group} 第{child.child_order}子"
    })

  // ─── 2. 一時保育料（一時のみ） ───
  IF child.enrollment_type == '一時':
    total_blocks = SUM(f.spot_30min_blocks for f in facts)
    unit = rules.spot_rates[age_group]   // 150 or 200
    lines.push({
      charge_type: 'spot_care',
      quantity: total_blocks,
      unit_price: unit,
      subtotal: total_blocks * unit,
      notes: f"30分×{total_blocks}回"
    })

  // ─── 3. 早朝保育料 ───
  early_count = COUNT(f for f in facts WHERE f.is_early_morning)
  IF early_count > 0:
    lines.push({
      charge_type: 'early_morning',
      quantity: early_count,
      unit_price: rules.early_morning_fee,    // 300
      subtotal: early_count * rules.early_morning_fee
    })

  // ─── 4. 延長保育料 ───
  ext_count = COUNT(f for f in facts WHERE f.is_extension AND NOT f.is_night)
  IF ext_count > 0:
    lines.push({
      charge_type: 'extension',
      quantity: ext_count,
      unit_price: rules.extension_fee,         // 300
      subtotal: ext_count * rules.extension_fee
    })

  // ─── 5. 夜間保育料 ───
  night_count = COUNT(f for f in facts WHERE f.is_night)
  IF night_count > 0:
    night_unit = rules.night_fees[age_group]
    lines.push({
      charge_type: 'night',
      quantity: night_count,
      unit_price: night_unit,
      subtotal: night_count * night_unit
    })

  // ─── 6. 病児保育料 ───
  sick_count = COUNT(f for f in facts WHERE f.is_sick)
  IF sick_count > 0:
    lines.push({
      charge_type: 'sick',
      quantity: sick_count,
      unit_price: rules.sick_fee,              // 2500
      subtotal: sick_count * rules.sick_fee
    })

  // ─── 7. 給食料 ───
  FOR meal_type IN ['lunch', 'am_snack', 'pm_snack', 'dinner']:
    flag_name = f"has_{meal_type}"
    count = COUNT(f for f in facts WHERE f[flag_name] == true)
    IF count > 0:
      unit = rules.meal_prices[meal_type]
      lines.push({
        charge_type: meal_type,
        quantity: count,
        unit_price: unit,
        subtotal: count * unit
      })

  RETURN lines


// ─── ヘルパー関数 ───

FUNCTION get_age_group(age_class: int) → string:
  IF age_class <= 2: RETURN "0~2歳"
  IF age_class == 3: RETURN "3歳"
  RETURN "4~5歳"

FUNCTION toMinutes(time_str: string) → int:
  // "HH:MM" or "HH:MM:SS" → 分数
  parts = time_str.split(":")
  RETURN int(parts[0]) * 60 + int(parts[1])

FUNCTION formatTime(time_str: string | null) → string | null:
  IF time_str == null: RETURN null
  parts = time_str.split(":")
  RETURN f"{int(parts[0])}:{parts[1].padStart(2,'0')}"
```

---

## 7. テンプレート保全・検査要件

### 7.1 Excel書き込み方針

```
■ 2段階書き込み方式:
  Phase 1: ExcelJSで値のみ書き込み
    - セルに直接値をセット
    - 数式セルには絶対に触らない
    - スタイル・書式は変更しない
    - 条件付き書式・データ検証には触れない
  
  Phase 2: 検証（★ v3.0: NGなら成果物を返さない）
    - #REF! エラーチェック（書き込み前後で増えていないか）
    - #VALUE! エラーチェック（同上）
    - 数式列の数式が残っているか確認
    - 集計列が空でないか確認
    - 合計値が0以上か確認
    → いずれかNGの場合: ジョブをfailedにし、成果物を返さない
    → 原因ログ + テンプレバックアップを返却

■ ExcelJSの制約対策:
  - マクロ付きファイル(.xlsm)は非対応 → .xlsxで保存
  - 条件付き書式は読み込み時に消える可能性 → 上書き回避
  - ピボットテーブル非対応 → 該当シートは触らない
  - ★ v3.0: 給食実数表（個人）はOFFSET参照が多いため直接書き込まない
  
■ テンプレートバックアップ:
  - 書き込み前にR2にバックアップを保存
  - 破損検知時は元ファイル（バックアップ）を返却
  - バックアップキー: templates/{nursery_id}/{template_type}/{timestamp}_backup.xlsx

■ ★ v3.0追加: 書き込み前後の差分検査
  - 書き込み前に「エラーセル数」をスナップショット
  - 書き込み後に「エラーセル数」を再カウント
  - 増えていたら → ジョブfailed（書き込みが原因で壊れた）
  - 減ったor同じ → OK
```

### 7.2 検証チェックリスト

```typescript
interface PostWriteCheck {
  // ★ v3.0: 必須チェック（NGなら成果物を返さない=FATAL）
  no_new_ref_error: boolean;     // #REF! が書き込み前より増えていない
  no_new_value_error: boolean;   // #VALUE! が書き込み前より増えていない
  formula_intact: boolean;       // 数式列の数式が残っている
  summary_not_empty: boolean;    // 集計列が空でない（数式の自動計算結果）
  
  // 警告チェック（止めない=WARN）
  total_positive: boolean;       // 合計値が0以上
  row_count_match: boolean;      // 書き込み行数 == 園児数
  date_range_match: boolean;     // 日付列が対象月と一致
  meal_sheet_auto_filled: boolean; // 給食実数表が◆保育時間から自動反映されているか
}
```

### 7.3 名前突合ロジック

```
FUNCTION normalize_name(name: string) → string:
  // 1. 全角スペース → 半角スペース
  name = name.replace(/\u3000/g, ' ')
  // 2. 連続スペース → 単一スペース  
  name = name.replace(/\s+/g, ' ')
  // 3. 前後空白除去
  name = name.trim()
  RETURN name

FUNCTION match_child(
  target_name: string,
  children: ChildMaster[],
  source: string
) → { child: ChildMaster | null, confidence: number }:

  normalized = normalize_name(target_name)
  
  // 完全一致
  exact = children.find(c => normalize_name(c.name) == normalized)
  IF exact: RETURN { child: exact, confidence: 1.0 }
  
  // 姓のみ一致（候補が1名の場合）
  surname = normalized.split(' ')[0]
  candidates = children.filter(c => normalize_name(c.name).startsWith(surname))
  IF candidates.length == 1: RETURN { child: candidates[0], confidence: 0.8 }
  
  // ルクミーID突合（最優先）
  IF source == 'lukumi' AND target has lukumi_id:
    by_id = children.find(c => c.lukumi_id == target.lukumi_id)
    IF by_id: RETURN { child: by_id, confidence: 1.0 }
  
  // 不一致 → 手動確認キューに入れる
  RETURN { child: null, confidence: 0 }
```

---

## 8. 処理パイプライン

### 8.1 フェーズ一覧

```
Phase 1: PARSING (ファイル解析)
  1-A: ルクミーExcel → attendance_records テーブル
  1-B: 利用予定表Excel(複数) → schedule_plans テーブル
  1-C: 園児名簿(日報テンプレ内) → children テーブル更新
  1-D: 保育料案内PDF → pricing_rules テーブル (初回のみ)

Phase 2: MATCHING (突合)
  2-A: 名前正規化 → name_mappings
  2-B: ルクミーID ↔ children 突合
  2-C: 予定表園児 ↔ children 突合
  2-D: 未突合リスト → warnings (例外として止めない)

Phase 3: CALCULATING (計算)
  3-A: 各園児×各日 → usage_facts 生成
  3-B: 各園児×月 → charge_lines 生成
  3-C: 検算（charge_lines合計 vs 保育料明細テンプレの合計数式）

Phase 4: GENERATING (成果物生成)
  4-A: 日報Excelテンプレートを読み込み
  4-B: 園児登園確認表□ 書き込み
  4-C: 児童実績表申請□ 書き込み
  4-D: ◆保育時間 書き込み ★ 給食列はここで書く（給食実数表の入力元）
  4-E: 保育時間(提出用) 書き込み（or 数式による自動反映確認）
  4-F: 給食実数表（個人）□ → 書き込まない（数式の自動反映を検証のみ）
  4-G: 保育料明細Excel 書き込み
  4-H: 利用明細書PDF 生成（園児ごと）
  4-I: テンプレート検証（#REF!, #VALUE!, 数式残存チェック）

Phase 5: PACKAGING (パッケージング)
  5-A: 全ファイルをR2に保存
  5-B: ZIP生成
  5-C: ダウンロードURL発行
```

### 8.2 例外ハンドリング方針

```
■ 原則: 「止めない」
  → 1園児のエラーが他園児の処理を妨げない
  → エラーは warnings_json に蓄積し、最終結果に添付

■ 例外レベル:
  WARN: 処理は続行、結果に注記
    - 予定表未提出の園児（→ 実績のみで計算）
    - 降園未記録（→ 時間欄空欄、給食は登園分のみ）
    - 名前不一致（→ 手動確認リストに追加）
    - 利用時間が負（→ 0に補正、注記）
  
  ERROR: 該当園児をスキップ、他は続行
    - ルクミーIDが複数の園児に紐づく（データ整合性エラー）
    - テンプレートのシート名が見つからない
  
  FATAL: ジョブ全体を停止
    - テンプレートファイルが読み込めない
    - D1接続エラー
    - R2書き込みエラー

■ 人間向けメッセージ:
  WARN → "⚠ 田中太郎: 1月15日の降園が未記録です → 時間欄は空欄で出力しました"
  ERROR → "❌ 山田花子: ルクミーIDが重複しています → この園児はスキップしました"
```

---

## 9. API設計

### 9.1 エンドポイント一覧

```
POST   /api/jobs                  ジョブ作成（月指定）
GET    /api/jobs/:id              ジョブ状態取得
POST   /api/jobs/:id/upload       ファイルアップロード
POST   /api/jobs/:id/run          処理実行
GET    /api/jobs/:id/result       結果取得（ファイル一覧 + 警告）
GET    /api/jobs/:id/download     ZIP一括ダウンロード
GET    /api/jobs/:id/download/:fileId  個別ファイルダウンロード

GET    /api/templates             テンプレート一覧
POST   /api/templates/upload      テンプレートアップロード
DELETE /api/templates/:id         テンプレート削除

GET    /api/pricing               料金ルール取得
POST   /api/pricing/upload        料金PDF解析＋保存
PUT    /api/pricing/:id           料金ルール手動修正

GET    /api/children              園児一覧
PUT    /api/children/:id          園児情報更新
GET    /api/children/:id/facts    園児の月次利用実績

GET    /api/health                ヘルスチェック
```

### 9.2 主要リクエスト/レスポンス

```typescript
// POST /api/jobs
Request:
{
  year: number;
  month: number;
}
Response:
{
  id: string;
  status: "pending";
  upload_urls: {
    lukumi: string;          // R2 presigned URL
    schedule_plans: string;  // R2 presigned URL (複数ファイル受付)
  }
}

// POST /api/jobs/:id/run
Response:
{
  id: string;
  status: "parsing";
  estimated_time_sec: number;
}

// GET /api/jobs/:id/result
Response:
{
  id: string;
  status: "completed";
  outputs: [
    {
      file_type: "daily_report";
      file_name: "日報202601.xlsx";
      download_url: string;
      purpose: "園内管理：園児登園確認表・児童実績表申請・給食実数表";
    },
    {
      file_type: "billing_detail";
      file_name: "保育料明細_202601.xlsx";
      download_url: string;
      purpose: "経理用：月次請求金額計算";
    },
    {
      file_type: "parent_statement";
      file_name: "利用明細書_Mondal_Aum_202601.pdf";
      download_url: string;
      purpose: "保護者配布：月次利用・請求通知";
    }
    // ... 園児数分のPDF
  ],
  zip_url: string;
  warnings: [
    {
      level: "warn";
      child_name: "田中太郎";
      message: "1月15日の降園が未記録です";
      suggestion: "ルクミーで降園打刻を確認してください";
    }
  ],
  stats: {
    children_processed: 66;
    children_skipped: 0;
    days_processed: 31;
    total_warnings: 3;
    total_errors: 0;
  }
}
```

---

## 10. UI画面設計

### 10.1 画面一覧

```
Screen 1: ダッシュボード (/)
  - 月選択
  - 過去ジョブ一覧
  - 「新規作成」ボタン

Screen 2: ジョブ実行 (/jobs/:id)
  - Step 1: ファイルアップロード
    ├ ルクミーデータ (.xlsx/.csv) [ドラッグ&ドロップ]
    ├ 利用予定表 (.xlsx × N名分) [ドラッグ&ドロップ]
    └ ファイル一覧表示 + 検証ステータス
  - Step 2: 確認 & 実行
    ├ アップロード済みファイルサマリ
    ├ 園児突合結果プレビュー
    ├ 未提出予定表の園児リスト
    └ 「生成実行」ボタン
  - Step 3: 進捗表示
    ├ プログレスバー (parsing → calculating → generating)
    └ リアルタイムログ
  - Step 4: 結果
    ├ 成果物リスト（種類・用途説明付き）
    ├ 警告・エラー一覧（自然言語 + 対処提案）
    ├ 個別ダウンロード
    └ ZIP一括ダウンロード

Screen 3: テンプレート管理 (/templates)
  - 日報テンプレート
  - 保育料明細テンプレート
  - 料金ルール（PDF解析結果の確認・編集）

Screen 4: 園児管理 (/children)  ※ MVP後
  - 園児一覧
  - 名前突合の手動修正
```

### 10.2 ワイヤーフレーム

```
┌─────────────────────────────────────────────────┐
│  🏫 あゆっこ業務自動化          [テンプレート] [設定] │
├─────────────────────────────────────────────────┤
│                                                   │
│  📅 対象月: [2026年] [1月 ▼]    [新規作成]         │
│                                                   │
│  ┌────────────────────────────────────────────┐ │
│  │ Step 1: ファイルアップロード                    │ │
│  │                                              │ │
│  │ ┌──────────────────┐ ┌──────────────────┐ │ │
│  │ │ 📁 ルクミーデータ   │ │ 📁 利用予定表     │ │ │
│  │ │ ドラッグ&ドロップ    │ │ (複数ファイル可)   │ │ │
│  │ │ .xlsx / .csv      │ │ .xlsx × N名分    │ │ │
│  │ └──────────────────┘ └──────────────────┘ │ │
│  │                                              │ │
│  │ アップロード済み:                               │ │
│  │ ✅ 登降園_2026年01月全クラス.xlsx  (66名検出)   │ │
│  │ ✅ 児童利用予定表_沖優司.xlsx                   │ │
│  │ ✅ 児童利用予定表_Mondal_Aum.xlsx              │ │
│  │ ⚠ 未提出: 田中太郎、山田花子 (他3名)           │ │
│  │                                              │ │
│  │              [次へ: 確認 →]                    │ │
│  └────────────────────────────────────────────┘ │
│                                                   │
│  過去の実行:                                       │
│  ┌──────┬────────┬───────┬──────────┐          │
│  │ 月    │ 状態    │ 園児数 │ 実行日     │          │
│  ├──────┼────────┼───────┼──────────┤          │
│  │ 12月  │ ✅完了  │ 64名  │ 2026-01-05│          │
│  │ 11月  │ ✅完了  │ 62名  │ 2025-12-03│          │
│  └──────┴────────┴───────┴──────────┘          │
│                                                   │
└─────────────────────────────────────────────────┘
```

```
┌─────────────────────────────────────────────────┐
│  結果画面                                         │
├─────────────────────────────────────────────────┤
│                                                   │
│  ✅ 生成完了  2026年1月  (66名処理、0エラー)        │
│                                                   │
│  📦 成果物                    [ZIP一括ダウンロード]  │
│  ┌──────────────────────────────────────────┐  │
│  │ 📊 園内管理用                               │  │
│  │   └ 日報202601.xlsx                        │  │
│  │     園児登園確認表・児童実績表・給食実数表        │  │
│  │                                [ダウンロード] │  │
│  ├──────────────────────────────────────────┤  │
│  │ 🏛 大学提出用                               │  │
│  │   └ 日報202601.xlsx (保育時間 提出用シート)    │  │
│  │                                [ダウンロード] │  │
│  ├──────────────────────────────────────────┤  │
│  │ 💰 経理用                                   │  │
│  │   └ 保育料明細_202601.xlsx                   │  │
│  │     月次請求金額（数量列のみ更新）              │  │
│  │                                [ダウンロード] │  │
│  ├──────────────────────────────────────────┤  │
│  │ 👨‍👩‍👧 保護者配布用 (66件)                       │  │
│  │   └ 利用明細書_*.pdf                         │  │
│  │     Mondal Aum / 沖 優司 / 垣内 風花 ...     │  │
│  │                          [全PDF ダウンロード] │  │
│  └──────────────────────────────────────────┘  │
│                                                   │
│  ⚠ 警告 (3件)                                    │
│  ┌──────────────────────────────────────────┐  │
│  │ ⚠ 田中太郎: 1/15の降園未記録                  │  │
│  │   → ルクミーで降園打刻を確認してください         │  │
│  │ ⚠ 山田花子: 利用予定表が未提出                  │  │
│  │   → 実績データのみで計算しました                 │  │
│  │ ⚠ 森灯里: 1/22の利用時間が12時間超             │  │
│  │   → 登降園時刻を確認してください                 │  │
│  └──────────────────────────────────────────┘  │
│                                                   │
└─────────────────────────────────────────────────┘
```

---

## 11. 実装優先順位

### Phase A: 基盤 (Week 1)
- [ ] プロジェクト初期化（Hono + D1 + R2）
- [ ] DBマイグレーション実行
- [ ] 基本APIスケルトン

### Phase B: パーサー (Week 2)
- [ ] B-1: ルクミーExcelパーサー
- [ ] B-2: 利用予定表パーサー（1ファイル/園児）
- [ ] B-3: 園児名簿パーサー（日報テンプレ内）
- [ ] B-4: 名前正規化 + 突合エンジン

### Phase C: 計算エンジン (Week 2-3)
- [ ] C-1: usage_facts計算
- [ ] C-2: charge_lines生成
- [ ] C-3: 検算ロジック

### Phase D: テンプレート書き込み (Week 3-4)
- [ ] D-1: 園児登園確認表□（1行/園児、HH:MM-HH:MM文字列）
- [ ] D-2: 児童実績表申請□（4行/園児ブロック）
- [ ] D-3: ◆保育時間（横展開）★ 給食列もここで書く
- [ ] D-4: 給食実数表 → MVPでは書き込まない（◆保育時間からの自動反映を検証）
- [ ] D-5: 保育料明細（数量列のみ）
- [ ] D-6: テンプレート検証（#REF! / #VALUE!チェック）

### Phase E: PDF生成 (Week 4)
- [ ] E-1: 利用明細書PDFレイアウト
- [ ] E-2: 園児ごとPDF一括生成

### Phase F: UI (Week 4-5)
- [ ] F-1: ダッシュボード画面
- [ ] F-2: アップロード + 実行画面
- [ ] F-3: 結果画面（警告表示付き）
- [ ] F-4: テンプレート管理画面

### Phase G: パッケージング (Week 5)
- [ ] G-1: ZIP生成
- [ ] G-2: R2保存 + ダウンロードURL
- [ ] G-3: ジョブ冪等性（同月再実行 → 上書き確認）

### Phase H: 品質保証 (Week 5-6)
- [ ] H-1: サンプルデータでE2Eテスト
- [ ] H-2: 生成Excel vs 手作業Excelの差分比較
- [ ] H-3: 料金計算の検算

---

## 12. 将来拡張（MVP外）

- LINE連携（保護者への明細通知）
- 職員シフト管理
- リアルタイムルクミー連携（API）
- 複数園対応
- 年次集計レポート
- 保護者ポータル（Web閲覧）

---

## 13. 補足: 入力バリデーション仕様

### 13.1 アップロード時チェック

```
■ ルクミーファイル:
  - ファイル形式: .xlsx or .csv
  - 必須列: クラス名, 園児姓, 園児名, 日付, 園児ID
  - 月チェック: ジョブの対象月と一致する日付が含まれる
  - 重複チェック: 同一園児ID × 同一日付が複数ある場合は警告

■ 利用予定表:
  - ファイル形式: .xlsx
  - 園児名が抽出可能（B6セル）
  - 月チェック: J1(年) × M1(月) がジョブ対象月と一致
  - 時刻妥当性: 登所 < 降所

■ テンプレート:
  - 日報: 必須シート名の存在チェック
  - 保育料明細: 月シート名の存在チェック
  - 料金PDF: テキスト抽出可能性チェック
```

### 13.2 冪等性

```
同一ジョブ（nursery_id + year + month）の再実行時:
  1. 既存のusage_facts, charge_linesをDELETE
  2. 新規にINSERT
  3. 成果物ファイルはR2で上書き
  4. 旧ZIPは削除
  
→ 何度実行しても同じ結果になることを保証
```

---

## 付録A: 料金ルール pricing_rules.rules_json サンプル

```json
{
  "fiscal_year": 2025,
  "monthly_fees": {
    "0~2歳": { "1": 45000, "2": 50000, "3": 54000 },
    "3歳":   { "1": 36000, "2": 41000, "3": 45000 },
    "4~5歳": { "1": 35000, "2": 39000, "3": 42000 }
  },
  "spot_rates": {
    "0~2歳": 200,
    "3歳":   200,
    "4~5歳": 150
  },
  "early_morning_fee": 300,
  "extension_fee": 300,
  "night_fees": {
    "0~2歳": 3000,
    "3歳":   2500,
    "4~5歳": 2500
  },
  "sick_fee": 2500,
  "meal_prices": {
    "lunch": 300,
    "am_snack": 50,
    "pm_snack": 100,
    "dinner": 300
  },
  "time_boundaries": {
    "open": "07:30",
    "early_start": "07:00",
    "early_end": "07:30",
    "extension_start": "18:00",
    "night_start": "20:00",
    "close": "20:00"
  },
  "rounding": {
    "monthly": "15min",
    "spot": "30min"
  }
}
```

---

## 付録B: 園児突合キーの優先順位

```
1. ルクミー園児ID (attendance_records.H列) ← 最優先（数値キー）
2. 名前正規化一致（全角スペース → 半角、trim）
3. 姓のみ一致（候補1名の場合のみ）
4. name_mappings テーブル（過去の手動紐付け結果）
5. 未解決 → 警告リストに追加、ユーザーに手動確認を依頼

突合元ごとの名前:
  ルクミー:     B列(姓) + C列(名)  → "長谷 律希"
  園児名簿:     D列                → "長谷　律希" (全角スペース)
  予定表:       B6                 → "長谷律希" (スペースなしの場合あり)
  保育料明細:   K列                → "長谷　律希" (全角スペース)
```

---

## 付録C: v3.1 変更履歴（v2.0からの差分）

```
■ 課金時間ルール【重大修正 → v3.1で再修正】
  v2.0: start = planned_start, end = actual_checkout
  v3.0: start = min(planned_start, actual_checkin) ← 誤り
  v3.1: start = planned_start（あれば）else actual_checkin ← 最終確定
        end   = max(planned_end, actual_checkout)
  理由: 予定時刻から課金する（遅刻しても予定開始で課金）。
        予定9:00-15:00, 実績9:15-15:15 → 課金9:00-15:15
        予定9:00-15:00, 実績8:45-14:30 → 課金9:00-15:00
        min()ではなく予定優先が正しいビジネスルール。

■ 給食実数表（個人）□【方針変更】
  旧: MVPで8行/園児ブロックに〇を書き込む
  新: MVPでは書き込まない。◆保育時間の給食列に〇を書けば数式で自動反映。
  理由: OFFSET参照が多く、ExcelJS保存で壊れるリスク大。
        「書き込みセル最小化」原則に従う。

■ 日付列の決定方法【安全性向上】
  旧: ヘッダRow4の日付値を読み取って列を決定
  新: 固定オフセット col = F + (day - 1) で列を決定
  理由: Row4の日付はDATE値ではなく数式で生成されている可能性。
        固定オフセットが最も壊れにくい。

■ テンプレート破損ガード【強化】
  旧: 検証はWARNレベル（止めない）
  新: 必須チェック4項目がNGなら成果物を返さない（FATAL）
      書き込み前後のエラーセル数を差分比較
  理由: 壊れたExcelを返すと運用事故になる。
        「壊れたら返さない」がMVPの安全弁。

■ 設計原則の明文化【追加】
  原則1: 書き込みセル最小化
  原則2: 壊れたら返さない
  原則3: 1画面完結
  原則4: 止めない（1園児のエラーは他に波及させない）
```

---

*End of Requirements Document*

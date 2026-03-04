# 木村さん要件 vs 現状実装 チェック結果

> **Version**: 1.1 (2026-03-04)
> **対象システム**: あゆっこ業務自動化システム v6.1
> **最終確認コミット**: c07e7f2 (v6.0 + v6.1 ダッシュボードDB直結)
> **目的**: 木村さん側の全要望を要件として洗い出し、現在のコードが満たしているかを判定する
> **関連設計書**: MULTI_FACILITY_DESIGN.md (v2.0), LINE_SCHEDULE_COLLECTION_PLAN.md (v4.0)
>
> **v1.1 変更点**: 要件①の保護者入力チャネルを **Web/PWA ポータル (Primary)** に更新。
> LINE は Phase 2 Optional の補助チャネルとして位置付け変更。

---

## 凡例

| 記号 | 意味 |
|------|------|
| ✅ 反映済 | コードで確認済み。要望を満たしている |
| ⚠️ 一部反映 | 方向性は合っているが、仕様のズレ or 不完全な箇所がある |
| ❌ 未反映 | 要望に対応する実装が見当たらない / 明確にズレている |
| 🔍 確認不能 | Python Generator を実行しないと判断できない |

---

## 1. 保護者の利用予定申請 (A)

### 要望
> 紙の利用予定表を廃止し、UI上で保護者が入力できるようにしたい

### チェック結果

| # | 受入条件 | 判定 | 根拠 (コード箇所) |
|---|---------|------|-------------------|
| A-1 | 園児を選び、月カレンダー上で「利用予定（開始/終了）」を登録できる | ✅ 反映済 | `src/index.tsx` L510-623: 予定入力タブにカレンダーUI。`src/routes/schedules.ts` L73-147: POST /api/schedules でUPSERT |
| A-2 | 食事（昼食/朝おやつ/午後おやつ/夕食）が予定として登録できる | ✅ 反映済 | 予定入力UIに4種チェックボックス (L579-589)。schedule_plans テーブルに lunch_flag, am_snack_flag, pm_snack_flag, dinner_flag |
| A-3 | 月末に次月予定を確定できる運用に対応 | ⚠️ 一部反映 | UIで入力→保存は可能。ただし **「確定」ステータスや月末締切ロック** の概念がまだ無い。園側が「この月は確定」とマークする機能が無い |
| A-4 | 園側が予定だけ見て人員配置・給食発注ができる画面がある | ✅ 反映済 | `loadDashboardFromDB()` (app.js L869-938) が `/api/schedules/dashboard` を叩いてDBからカレンダー表示。日別の人数・食数集計あり |
| A-5 | 保護者自身がUIで入力する導線 | ⚠️ 一部反映 | 現在のUIは **園側スタッフが入力する前提**。保護者向け認証・自分の子だけ編集できるポータルは未実装。**LINE連携計画書 (別ドキュメント) で設計済み** |

### 補足: 「保護者が入力する」について
木村さんの最終要望は「保護者からの紙提出を廃止」。保護者入力の手段は：
1. **Web/PWA ポータル (Primary)** (設計済み、未実装) → MULTI_FACILITY_DESIGN.md v2.0 セクション6 参照
   - ★★★ これだけで要件①は100%充足される
2. **LINE AI ヒアリング (Phase 2 Optional)** (設計済み、未実装) → LINE_SCHEDULE_COLLECTION_PLAN.md v4.0 参照
   - Web入力が難しい保護者向けの補助チャネル。希望施設のみ有効化。
3. **園スタッフが代行入力** (現在の実装) → これは過渡期の運用として有効

---

## 2. 園内共有 — ダッシュボード (B)

### 要望
> 日ごとの登園予定人数・食数を確認して、保育士配置・給食発注に使いたい

### チェック結果

| # | 受入条件 | 判定 | 根拠 |
|---|---------|------|------|
| B-1 | 月間ダッシュボードに「予定」が表示される | ✅ 反映済 | v6.1で「予定を表示」ボタン → DBから即カレンダー表示 (loadDashboardFromDB)。ファイルアップロード不要 |
| B-2 | 日別に人数と食数の集計が出る（予定ベース） | ✅ 反映済 | `/api/schedules/dashboard` が daily_summary を返し、各日の total_children, lunch_count, am_snack_count, pm_snack_count, dinner_count を集計 (schedules.ts L210-320) |
| B-3 | クラス別人数（0/1/2/一時）が詳細に出る | ✅ 反映済 | schedules.ts L229-247: age_0_count ～ age_5_count, temp_count。app.js v5.1コメントに「年齢別人数バッジ表示」 |
| B-4 | 並び順: 0歳→1歳→2歳→一時、生年月日順 | ✅ 反映済 | children.ts L24-32: ORDER BY enrollment_type(月極→一時), age_class ASC, birth_date ASC, name ASC |
| B-5 | 今日/明日/今週/月間 の表示切替 | ✅ 反映済 | app.js L184-199: switchDashView() で4つのサブタブ |

---

## 3. ルクミー登降園データ — 実績取り込み (C)

### 要望
> ルクミー打刻データを取り込み、予定と突合して実績にしたい。病児保育は打刻なしで手入力したい。

### チェック結果

| # | 受入条件 | 判定 | 根拠 |
|---|---------|------|------|
| C-1 | ルクミーCSVの取り込みが安定（園児紐付け・月次反映） | ✅ 反映済 | `generator/parsers/lukumi_parser.py` でCSV/Excel解析。`generator/engine/name_matcher.py` + `src/lib/name-matcher.ts` で園児名突合。ルクミーID、完全名一致、姓のみ一致の3段階マッチング |
| C-2 | 病児保育を「打刻なし」で実績追加できる | ⚠️ 一部反映 | **ダッシュボード上での手動トグル**: app.js L480-494 に `toggleSick()` 関数があり、ダッシュボード表示上で病児フラグをクリック切替できる。ただし **メモリ内保持 (manualEdits) のみで、DBに永続化されない**。ページリロードで消える。帳票生成時にこのオーバーレイが反映されるかは Python Generator の実行依存 |
| C-3 | 病児保育の実績を恒久的にDB登録する機能 | ❌ 未反映 | 病児の打刻なし実績を `attendance_records` や `usage_facts` テーブルに直接登録するUIやAPIが存在しない。manualEditsはフロント側メモリのみ |

---

## 4. 一時利用の請求・報告ロジック (D)

### 要望
> 予定9:00-15:00、打刻9:15-15:15 → 報告/請求は9:00-15:15（予定start + max(予定end, 実績end)）

### チェック結果

| # | 受入条件 | 判定 | 根拠 |
|---|---------|------|------|
| D-1 | billing_start = planned_start（予定あれば）, billing_end = max(planned_end, actual_checkout) | ✅ 反映済 | **TypeScript版**: usage-calculator.ts L70-91 で明確に実装。コメントにも「★★★ Core rule v3.1 ★★★」。**Python版**: generator/engine/usage_calculator.py L168-187 で同一ロジック。「★ min(planned_start, actual_checkin) は絶対に使わない」とコメントあり |
| D-2 | 一時利用は30分単位のspot_30min_blocks で課金 | ✅ 反映済 | usage-calculator.ts L159-161: `Math.ceil(billing_minutes / 30)` |
| D-3 | 月極は月額保育料が基本、一時保育料はかからない | ✅ 反映済 | charge-calculator.ts L27-41: 月極→monthly_fee, L44-58: 一時→spot_care。月極にspot_careは発生しない |

---

## 5. 提出物（帳票）生成 (E)

### 要望
> 大学提出(児童実績表・給食実数表)、経理(保育料明細)、保護者(利用明細書)を生成。PDFにデータが入らない問題あり。

### チェック結果

| # | 受入条件 | 判定 | 根拠 |
|---|---------|------|------|
| E-1 | 指定フォーマットで帳票が生成される | 🔍 確認不能 | Python Generator (port 8787) 経由で生成。`generator/writers/` に daily_report_writer.py, billing_writer.py, pdf_writer.py が存在。コードは存在するが、**現在Generatorが起動していないため実際の出力は確認不能** |
| E-2 | PDFが空欄にならない | ⚠️ 要注意 | pdf_writer.py v5.0: フォント問題修正済み（WQY Micro Hei使用）。ただし木村さんが2/28に「PDFにデータが入らない」と報告しており、**修正後の実動確認が必要** |
| E-3 | 保護者利用明細書で「■」文字化けがない | ⚠️ 要注意 | フォント修正 (v5.0) で対応済みの可能性が高いが、**実際のPDF出力で確認必要** |
| E-4 | 「予定のみモード」でも園内運用に必要な情報が見える | ✅ 反映済 | ダッシュボード (loadDashboardFromDB) で予定ベースの人数・食数がファイル不要で表示される。帳票は予定+実績が揃ってから生成する運用フロー |

---

## 6. クラス判定・優先順位 (F)

### 要望
> クラスは予定側（UI入力の月極/一時 + 生年月日）が正。ルクミーは上書きしない。
> 0歳: 2024/4/2～, 1歳: 2023/4/2～2024/4/1, 2歳: 2022/4/2～2023/4/1

### チェック結果

| # | 受入条件 | 判定 | 根拠 |
|---|---------|------|------|
| F-1 | クラスは園児マスタの生年月日 + enrollment_type から自動算出 | ✅ 反映済 | `src/lib/age-class.ts` L31-68: `getAgeClassFromBirthDate()` が fiscal_year と birth_date からage_classを計算。children.ts L66-77: POST時に自動計算 |
| F-2 | 年度境界（4/1, 4/2）が正しい | ✅ 反映済 | age-class.ts L46-51: `rangeStart = new Date(startYear, 3, 2)` (4/2), `rangeEnd = new Date(endYear, 3, 1)` (4/1) |
| F-3 | ルクミーCSVのクラス名はマスタを上書きしない | ⚠️ 要確認 | TypeScript側 (children.ts) はマスタの birth_date から算出するのでOK。ただし **Python Generator 側** の `generator/engine/usage_calculator.py` は `child.get("lukumi_id")` で突合しており、ルクミーCSVのA列クラス名を帳票に使う可能性がある。帳票出力時のクラス名ソースを要確認 |
| F-4 | ダッシュボード/一覧のクラス名がマスタ基準 | ✅ 反映済 | schedules.ts ダッシュボードは children テーブルの age_class を使用 (L198-199) |

---

## 7. 料金計算 (G)

### 要望
> 延長料金: 7:00-7:30 (早朝) と 20:00-21:00 (延長)。保育料案内準拠。

### チェック結果

| # | 受入条件 | 判定 | 根拠 |
|---|---------|------|------|
| G-1 | 早朝: 7:00-7:30 のみ課金 | ✅ 反映済 | **Python**: `early_start: "07:00"`, `early_end: "07:30"` (usage_calculator.py L32-33)。**TypeScript**: seed.sql L40-41 で同値 |
| G-2 | 延長: 20:00-21:00 のみ課金 | ⚠️ **不整合あり** | **Python (正)**: `extension_start: "20:00"` (usage_calculator.py L34)。★修正コメントあり「18:00→20:00（保育料案内準拠）」。**TypeScript (誤)**: seed.sql L43 `extension_start: "18:00"` のまま。**→ seed.sql の pricing_rules が古い値 (18:00) のまま** |
| G-3 | 夜間: 21:00以降 | ⚠️ **不整合あり** | **Python (正)**: `night_start: "21:00"` (usage_calculator.py L35)。**TypeScript (誤)**: seed.sql L44 `night_start: "20:00"` のまま。**→ seed.sql が古い値** |
| G-4 | ダッシュボード (schedules.ts) の延長/夜間判定 | ✅ 反映済 | schedules.ts L258: `endMin > 1200` (20:00=1200分)、L259: `endMin > 1260` (21:00=1260分)。**こちらは保育料案内に準拠** |
| G-5 | TypeScript usage-calculator.ts の延長/夜間判定 | ❌ **不整合** | usage-calculator.ts L146: `extStart = toMinutes(rules.time_boundaries.extension_start)` → seed.sqlから"18:00"を取得 = **18:00以降を延長と判定してしまう**。Python版は自前定数で"20:00"に修正済みだが、TypeScript版はDBの値を使うため古いseedデータの影響を受ける |
| G-6 | 早朝/延長の単価: 各300円 | ✅ 反映済 | seed.sql L25-26: `early_morning_fee: 300`, `extension_fee: 300` |
| G-7 | 一時保育料: 30分あたり200円 | ✅ 反映済 | seed.sql L22-24: `spot_rates: {"0~2歳": 200, "3歳": 200, "4~5歳": 150}` |
| G-8 | 病児保育料: 1回2,500円 | ✅ 反映済 | seed.sql L32: `sick_fee: 2500` |
| G-9 | 夜間保育料: 月極2,500円, それ以外3,000円 | ⚠️ 一部反映 | seed.sql L28-30: `night_fees: {"0~2歳": 3000, "3歳": 2500, "4~5歳": 2500}`。**年齢区分別であり、月極/一時の区別ではない**。保育料案内では「月極利用者は2,500円、それ以外は3,000円」なので、ロジックが異なる可能性あり |
| G-10 | 食事単価が正しい | ⚠️ **朝食が未整合** | seed.sql L33-38: lunch 300, am_snack 50, pm_snack 100, dinner 300。**保育料案内記載: 朝食150円** → しかしTypeScript側の `schedule_plans` テーブルには **breakfast_flag が存在しない**。Python側 (usage_calculator.py L133) には `has_breakfast` があるが、予定入力UIにもDBスキーマにも朝食の列がない |
| G-11 | 月極の月額保育料テーブル | ✅ 反映済 | seed.sql L16-20: 年齢区分×きょうだい順の料金表 |

---

## 8. UI/UX 詳細要望

| # | 受入条件 | 判定 | 根拠 |
|---|---------|------|------|
| U-1 | 5タブ構成（ダッシュボード/園児管理/予定入力/ファイル入力/提出物生成） | ✅ 反映済 | app.js L57-63: TABS定数。index.tsx L146-161: タブボタン |
| U-2 | 園児追加モーダル（名前/フリガナ/生年月日/区分/きょうだい順/ルクミーID/アレルギー） | ✅ 反映済 | index.tsx L452-507 |
| U-3 | デフォルト時間一括入力 | ✅ 反映済 | index.tsx L567-591: デフォルト登園/降園 + 食事チェック + 一括入力ボタン |
| U-4 | ダッシュボード上で食事・病児をクリックで編集 | ⚠️ 一部反映 | app.js L464-494: toggleMeal/toggleSickでUI上のトグル可。**ただしmanualEditsはメモリのみ（非永続）** |
| U-5 | 予定保存後に「ダッシュボードで確認」ボタン | ✅ 反映済 | v6.1で追加 (会話履歴に記載) |

---

## 要件充足サマリー

### 全体統計

| 判定 | 件数 | 割合 |
|------|------|------|
| ✅ 反映済 | 23 | 62% |
| ⚠️ 一部反映/要確認 | 11 | 30% |
| ❌ 未反映 | 2 | 5% |
| 🔍 確認不能 | 1 | 3% |

---

## 🔴 最優先修正項目 (このままだと要望未反映判定)

### 1. 延長/夜間の時間帯不整合 (G-2, G-3, G-5)

**問題**: Python Generator は `extension_start: 20:00`, `night_start: 21:00` に修正済みだが、TypeScript側 (seed.sql の pricing_rules) は `extension_start: 18:00`, `night_start: 20:00` のまま。

**影響箇所**:
- `src/lib/usage-calculator.ts` が seed.sql の pricing_rules を読んで計算するため、**18:00以降を延長と判定してしまう**
- ダッシュボードの `schedules.ts` はハードコードで `1200 (20:00)`, `1260 (21:00)` を使っているので**こちらは正しい**
- 結果: **ダッシュボードの表示と、帳票生成時の計算結果が一致しない可能性**

**必要な修正**:
```
seed.sql の pricing_rules:
  extension_start: "18:00" → "20:00"
  night_start: "20:00" → "21:00"
  close: "20:00" → "21:00"
```

### 2. 病児保育の実績永続化 (C-3)

**問題**: ダッシュボードで病児フラグをクリック切替できるが、`manualEdits` はフロント側メモリ保持のみ。ページリロードで消失。DB書き込みAPIも未実装。

**影響**: 病児保育は電話受付で打刻がないため、帳票に反映するにはDB永続化が必須。

**必要な修正**:
- manualEditsをDBに保存するAPIエンドポイント
- attendance_records or usage_facts への手動実績登録UI

### 3. 朝食 (breakfast) の欠落 (G-10)

**問題**: 保育料案内に「朝食150円」が記載されているが:
- `schedule_plans` テーブルに `breakfast_flag` カラムが無い
- 予定入力UIに朝食チェックボックスが無い
- TypeScript の charge-calculator.ts の meal_prices に breakfast が無い
- **Python Generator のみ** `has_breakfast` を持っている (usage_calculator.py L133, pdf_writer.py L241)

**影響**: 朝食を希望する園児の料金が計算できない。

**必要な修正**:
- schedule_plans テーブルに `breakfast_flag` カラム追加
- 予定入力UIに朝食チェックボックス追加
- seed.sql の meal_prices に `breakfast: 150` 追加
- TypeScript の SchedulePlan 型に追加

---

## 🟠 重要修正項目 (運用で毎月問題になる)

### 4. 夜間保育料の月極/一時区分 (G-9)

**問題**: 保育料案内では「月極利用者は2,500円、一時利用者は3,000円」だが、seed.sql の night_fees は年齢区分別 (`0~2歳: 3000, 3歳: 2500, 4~5歳: 2500`)。

**影響**: 0~2歳の月極児に夜間保育料3,000円が課金される可能性（正しくは2,500円）。

**必要な修正**: night_fees のルックアップキーを enrollment_type ベースに変更、または charge-calculator.ts で enrollment_type を考慮するロジック追加。

### 5. 帳票のクラス名ソース (F-3)

**問題**: Python Generator がルクミーCSVのA列クラス名を帳票に使っている可能性。園児マスタのage_classが正であるべき。

**確認方法**: `generator/writers/daily_report_writer.py`, `generator/writers/billing_writer.py` でクラス名をどこから取得しているか確認。

### 6. 提出物PDFの空欄問題 (E-2)

**問題**: 木村さんが2/28に「PDFにデータが入らない」と報告。v5.0でフォント修正は行われたが、実動確認が必要。

**確認方法**: テストデータでPython Generatorを実行し、出力PDFを目視確認。

### 7. 予定確定/ロック機能 (A-3)

**問題**: 現在は予定入力→保存のみで、「確定」ステータスがない。月末以降の変更を制限するロック機構もない。

**影響**: スタッフが意図せず過去月の予定を変更してしまうリスク。

---

## 🟡 改善推奨項目 (品質向上)

### 8. manualEdits の永続化 (U-4)

食事のトグル変更もメモリのみ。保存ボタンでDBに反映する機能が望ましい。

### 9. 保護者入力導線 (A-5)

**設計済み**: Web/PWA ポータル (Primary, MULTI_FACILITY_DESIGN.md v2.0 セクション6) および LINE AI ヒアリング (Phase 2 Optional, LINE_SCHEDULE_COLLECTION_PLAN.md v4.0) の実装。過渡期は園スタッフ代行入力で運用可能。

### 10. schedule_plans の source_file 値統一

現在 `'UI入力'` のみ。LINE連携実装時に `'LINE'`, `'LINE_修正'` の追加予定 (LINE計画書参照)。

---

## 修正優先度マトリックス

```
影響度 ＼ 緊急度   高（今月の運用に直結）   中（帳票品質）   低（将来運用）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
高（課金に影響）    #1 延長/夜間の時間帯     #4 夜間料金     
                    #3 朝食の欠落             区分
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
中（運用に影響）    #2 病児保育永続化         #6 PDF空欄       #7 確定/ロック
                                             #5 クラス名       #9 保護者入力
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
低（UX改善）                                 #8 manualEdits    #10 source統一
                                             永続化
```

---

## Python vs TypeScript 不整合の詳細

以下は **同じロジックの2つの実装間の差異** で、特に注意が必要。

### 時間帯境界値

| パラメータ | Python Generator (修正済み) | TypeScript (seed.sql) | schedules.ts ダッシュボード | 正しい値 |
|-----------|---------------------------|----------------------|--------------------------|---------|
| early_start | 07:00 | 07:00 | 450分未満 (=7:30) | 07:00 |
| early_end | 07:30 | 07:30 | 450分 (=7:30) | 07:30 |
| extension_start | **20:00** ✅ | **18:00** ❌ | **1200分 (=20:00)** ✅ | **20:00** |
| night_start | **21:00** ✅ | **20:00** ❌ | **1260分 (=21:00)** ✅ | **21:00** |
| close | - | 20:00 | - | 21:00 |

### 食事区分

| 区分 | Python Generator | TypeScript (DB/UI) | 保育料案内 | 単価 |
|------|-----------------|-------------------|-----------|------|
| 朝食 (breakfast) | ✅ has_breakfast | ❌ **カラム・UIなし** | ✅ 記載あり | ¥150 |
| 昼食 (lunch) | ✅ has_lunch | ✅ lunch_flag | ✅ | ¥300 |
| 朝おやつ (am_snack) | ✅ has_am_snack | ✅ am_snack_flag | ✅ | ¥50 |
| 午後おやつ (pm_snack) | ✅ has_pm_snack | ✅ pm_snack_flag | ✅ | ¥100 |
| 夕食 (dinner) | ✅ has_dinner | ✅ dinner_flag | ✅ | ¥300 |

---

## 変更履歴

| バージョン | 日付 | 内容 |
|-----------|------|------|
| 1.0 | 2026-03-04 | 初版作成。全要件の確認結果と不整合の詳細を記載 |
| 1.1 | 2026-03-04 | 要件①の保護者入力チャネルを Web/PWA Primary + LINE Optional に更新。関連設計書参照を MULTI_FACILITY_DESIGN.md v2.0 および LINE_SCHEDULE_COLLECTION_PLAN.md v4.0 に更新 |

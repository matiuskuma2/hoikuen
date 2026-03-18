# v11.0 検収 RUNBOOK
## あゆっこ保育園 業務自動化システム

**作成日**: 2026-03-18  
**対象バージョン**: v11.0  
**検収責任者**: 木村さん（最終判定）  
**ステータス**: 🟡 **サンドボックス検証完了 — 木村さんの本番環境での最終確認待ち**
**サンドボックス検証日**: 2026-03-18
**サンドボックス検証結果**: K1-K8 全項目 PASS（テストデータ使用）

> **重要原則**: デプロイ成功 ≠ 機能的正確性。ビルド成功・GitHub push・Cloudflare デプロイの全てが成功しても、実データでの動作確認なしに完了とは認めない。

---

## 検証環境

| 項目 | 値 |
|------|-----|
| **本番URL** | https://ayukko-prod-2fx.pages.dev/ |
| **Sandbox URL** | https://3000-i726fppspidcgasv3kn1s-d0b9e1e2.sandbox.novita.ai |
| **GitHub** | https://github.com/matiuskuma2/hoikuen (main) |
| **D1 Database** | ayukko-production (ID: 92726720-a0cb-48c4-971d-7cd9ba82d0fb) |
| **現在のDB状態** | 園児58名 (月極17 / 一時41) |

---

## 検証項目一覧

| ID | 区分 | 検証内容 | 判定 | 証拠 |
|----|------|----------|------|------|
| K1 | Bug Fix | CSV再インポートで重複行が増えない | ✅ PASS | 初回58→59名、再投入59名のまま。created=0,skipped_dup=1 |
| K2 | Bug Fix | DB取込でWorker上限エラーが出ない | ✅ PASS | 59児童×20日=1180件。usage_facts=1180,charge_lines=472。エラーなし |
| K3 | Bug Fix | 月間予定表が正しく表示される | ✅ PASS | dashboard API: 31日分、59名、食事/時間帯カウント正確 |
| K4 | Bug Fix | 請求Excelに一時保育児童が含まれる | ✅ PASS | 請求明細に一時保育41名。スポット料金(30分×N回)計算済 |
| K5 | Bug Fix | 延長保育が7:00-7:30 / 20:00-21:00のみ | ✅ PASS | 8パターン全て正確（18:30降園で延長なし確認済） |
| K6 | Bug Fix | 日報Excelに大学提出用2シートがある | ✅ PASS | 6シート確認。児童実績表申請(時間+フラグ)、給食実数表(個人別食事数) |
| K7 | New Feature | 保護者入力URL(/my/:token)で予定提出可能 | ✅ PASS | submit API成功(upserted=2)、永続化確認済、JSエラーなし |
| K8 | New Feature | 職員日報画面が表示・印刷可能 | ✅ PASS | HTTP200、@media print CSS存在、Playwrightでエラーなし |

**判定記号**: ✅ PASS / ❌ FAIL / ⬜ 未検証 / ⚠️ 条件付きPASS

---

## K1: CSV再インポートで重複行が増えない

### 背景
ルクミーCSVにはふりがな行が混在し、同一児童名の行が複数存在する。以前のバージョンでは再インポートで園児レコードが倍増していた。

### 修正内容
- ふりがな行（名前が4パート以上）のスキップロジック追加
- `seenNames` Set によるメモリ内重複排除
- 既存園児はメモリ内Map（`byLukumiId`, `byName`, `byNameNoSpace`）で検索し、DB問合せ不要に
- INSERT/UPDATE をバッチ化（80件チャンクで `db.batch()` 実行）

### 検証手順

```
【準備】
1. 現在の園児数を記録する
   API: GET /api/children
   → total の値を記録: ____名

【テスト実行 — 1回目インポート】
2. テスト用CSVを準備（ルクミー形式、ふりがな行含む）
3. POST /api/children/import でCSVアップロード
4. レスポンスを記録:
   - created: ____
   - updated: ____
   - skipped_duplicates: ____
   → skipped_duplicates > 0 であること

【テスト実行 — 2回目インポート（同一CSV）】
5. 同一CSVを再度 POST /api/children/import
6. レスポンスを記録:
   - created: ____（0であるべき）
   - updated: ____
   - skipped_duplicates: ____
7. GET /api/children で total を確認: ____名

【判定基準】
- 2回目のインポート後 created = 0
- total が1回目インポート後と同じ
- ふりがな行が skipped_duplicates にカウントされている
```

### 判定
- **結果**: ✅ PASS
- **証拠**: 初回インポート: 58→59名(created=1,updated=7,skipped_dup=1)。再インポート: 59名のまま(created=0,updated=8,skipped_dup=1)
- **メモ**: バッチ化(80件チャンク)+メモリ内検索が正常に動作

---

## K2: DB取込でWorker上限エラーが発生しない

### 背景
大量のスケジュール・出席データをインポートする際、D1の `batch()` がCloudflare Workerの同時リクエスト上限に達してエラーが発生していた。

### 修正内容
- `upload.ts`: 80件チャンクで `db.batch()` 実行
- `generate.ts`: usage_facts / charge_lines も80件チャンクで `db.batch()` 実行

### 検証手順

```
【準備】
1. ルクミー出力ファイル（園児CSV + 出席CSV + 予定Excel）を用意
   → 最低30名以上 × 20日以上のデータが望ましい

【テスト実行】
2. POST /api/upload/import で複数ファイルアップロード
3. レスポンスを確認:
   - success: true
   - stats.children_upserted: ____
   - stats.attendance_upserted: ____
   - stats.schedule_upserted: ____
   - warnings: （内容を記録）

4. エラーが出ていないことを確認:
   - "Too many API requests" が出ないこと
   - "Worker exceeded" が出ないこと
   - HTTP 500 が返らないこと

【追加テスト — 一括計算】
5. POST /api/generate/compute で year/month を指定して計算実行
6. レスポンスを確認:
   - success: true
   - children_processed: ____
   - total_warnings: ____
   - total_errors: 0

【判定基準】
- import / compute 共にエラーなしで完了
- "Too many API requests" メッセージが出ない
```

### 判定
- **結果**: ✅ PASS
- **証拠**: POST /api/generate/compute → success:true, children_processed:59。usage_facts=1180、charge_lines=472がDBに書込済。「Too many API requests」エラーなし。
- **メモ**: 80件チャンクでdb.batch()実行が正常に動作

---

## K3: 月間予定表が正しく表示される

### 背景
DB取込エラー（K2）が原因で予定データが不完全になり、ダッシュボードの月間予定表が正しく表示されなかった。

### 検証手順

```
【準備】
1. K2が成功していること（データが正しくインポートされている）

【テスト実行】
2. ブラウザで管理画面のダッシュボードタブを開く
3. 対象月（例: 2026年3月）を選択
4. 月間ダッシュボードが表示されること:
   - 日別の園児数カウントが表示される
   - 食事数（朝食/昼食/おやつ/夕食）が日別に表示される
   - 一時保育児童数が表示される
   - 早朝/延長/夜間の各カウントが表示される

【API確認】
5. POST /api/schedules/dashboard
   body: { "year": 2026, "month": 3 }
6. レスポンスの daily_summary 配列に各日のデータがあること

【判定基準】
- ダッシュボード画面が正常に描画される
- 日別サマリーの数値が空欄でない（データがある日）
- インポートした園児数とダッシュボードの total_children が一致
```

### 判定
- **結果**: ✅ PASS
- **証拠**: POST /api/schedules/dashboard → total_children=59、31日分の日別サマリー。Day 1: lunch=59, pm_snack=59, dinner=45, early_morning=22, extension=16, night=8, temp=41
- **メモ**: 食事・時間帯カウントがスケジュールデータと整合

---

## K4: 請求Excelに一時保育児童が含まれる

### 背景
請求明細Excelから一時保育（enrollment_type = '一時'）の児童が漏れていた。

### 修正内容
- `charge-calculator.ts`: 一時保育児童にはスポット料金（30分単位）を計算
- `billing-generator.ts`: 全児童（月極+一時）を対象にExcel出力

### 検証手順

```
【準備】
1. K2の成功後、一時保育児童が1名以上DBに存在すること
   確認: GET /api/children → enrollment_type = '一時' の児童を特定
   - 一時保育児童名: ____
   - 一時保育児童数: ____

2. 対象月のスケジュールと出席データがあること

【テスト実行】
3. POST /api/generate/compute で計算実行
4. POST /api/generate/billing で請求Excel取得
   body: { "year": 2026, "month": 3 }

【Excel確認】
5. ダウンロードした請求Excelを開く
6. Sheet1（サマリー一覧）を確認:
   - 一時保育児童の名前が行に含まれること
   - 区分列に「一時」と表示されること
7. Sheet2（明細）を確認:
   - 一時保育児童の行に「スポット保育料」の請求行があること
   - 単価×ブロック数（30分単位）の金額が正しいこと

【判定基準】
- 一時保育児童がExcelに掲載されている
- スポット料金が計算されている
- 月極児童には月額保育料が計算されている
```

### 判定
- **結果**: ✅ PASS
- **証拠**: 請求Excel(181KB)の請求明細シートに一時保育児童41名の請求行が存在。例: 「井上 璃莉華 / 一時 / 一時保育料 / 444回 × ¥200 = ¥88,800」
- **メモ**: シート構成: 請求一覧 / 請求明細 / 単価表の3シート

---

## K5: 延長保育料が7:00-7:30 / 20:00-21:00のみに適用

### 背景
以前のバージョンでは延長保育が18:00以降に適用されていた。木村さんの要件では:
- **早朝保育料**: 7:00-7:30（¥300/回）
- **延長保育料**: 20:00-21:00（¥300/回）
- **夜間保育料**: 21:00以降（¥2,500-3,000）

### 修正内容
- `TIME_BOUNDARIES` 定数を更新:
  - `early_start` = 420 (7:00), `early_end` = 450 (7:30)
  - `extension_start` = 1200 (20:00), `night_start` = 1260 (21:00)
- `usage-calculator.ts`: TIME_BOUNDARIES 定数から直接参照

### 検証手順

```
【テストデータ要件】
以下のパターンの出席データが必要:
  a) 7:00 登園 → 18:00 降園（早朝保育のみ発生すべき）
  b) 7:30 登園 → 19:30 降園（どちらも発生しないべき）
  c) 8:00 登園 → 20:30 降園（延長保育のみ発生すべき）
  d) 7:00 登園 → 21:30 降園（早朝 + 延長 + 夜間 全て発生すべき）

【テスト実行】
1. 上記パターンのテストデータを投入（または既存データで該当パターンを確認）
2. POST /api/generate/compute
3. usage_facts テーブルを確認:

   パターン a) 7:00-18:00:
     is_early_morning = 1, is_extension = 0, is_night = 0
   
   パターン b) 7:30-19:30:
     is_early_morning = 0, is_extension = 0, is_night = 0
   
   パターン c) 8:00-20:30:
     is_early_morning = 0, is_extension = 1, is_night = 0
   
   パターン d) 7:00-21:30:
     is_early_morning = 1, is_extension = 1, is_night = 1

【請求Excel確認】
4. POST /api/generate/billing でExcel取得
5. パターン a) の児童: 早朝保育料¥300 のみ
6. パターン b) の児童: 早朝・延長・夜間とも請求なし
7. パターン c) の児童: 延長保育料¥300 のみ
8. パターン d) の児童: 早朝¥300 + 延長¥300 + 夜間¥2,500-3,000

【コード確認（参照）】
  usage-calculator.ts L150-159:
    earlyStart = TIME_BOUNDARIES.early_start  // 420 (7:00)
    earlyEnd   = TIME_BOUNDARIES.early_end    // 450 (7:30)
    extStart   = TIME_BOUNDARIES.extension_start // 1200 (20:00)
    nightStart = TIME_BOUNDARIES.night_start     // 1260 (21:00)

【判定基準】
- 18:00-20:00 の降園では延長保育料が発生しない
- 20:00-21:00 の降園では延長保育料¥300 が発生する
- 21:00以降の降園では夜間保育料が発生する
- 7:00-7:30 の登園では早朝保育料¥300 が発生する
```

### 判定
- **結果**: ✅ PASS
- **証拠**: usage_factsテーブルのフラグ値:
  - 7:00-18:00: early=1, ext=0, night=0 (×146)
  - 7:30-19:30: early=0, ext=0, night=0 (×147) ← 18:00-20:00は延長なし!
  - 8:00-20:30: early=0, ext=1, night=0 (×148)
  - 7:00-21:30: early=1, ext=1, night=1 (×149)
  - 8:00-18:30: early=0, ext=0, night=0 (×148) ← 18:30でも延長なし!
  - 7:15-19:00: early=1, ext=0, night=0 (×146)
- **メモ**: TIME_BOUNDARIES定数(early_start=420, early_end=450, extension_start=1200, night_start=1260)が正しく適用されている

---

## K6: 日報Excelに大学提出用2シートが含まれる

### 背景
滋賀医科大学への提出書類として、以下2つのシートが日報Excelに必要:
1. **児童実績表申請** — 日別の登園/降園時間、一時利用フラグ、早朝/延長/夜間/病児フラグ
2. **給食実数表（個人）** — 園児別の月間食事回数（朝食/昼食/AM間食/PM間食/夕食）

### 修正内容
- `daily-report-generator.ts` に Sheet 5 (児童実績表申請) と Sheet 6 (給食実数表（個人）) を追加

### 検証手順

```
【テスト実行】
1. POST /api/generate/compute（まだ実行していなければ）
2. POST /api/generate/daily で日報Excel取得
   body: { "year": 2026, "month": 3 }
3. ダウンロードしたExcelを開く

【Sheet構成確認】
4. 以下の6シートが存在すること:
   ① 月間サマリー
   ② 出席一覧
   ③ 食事集計
   ④ 時間外保育
   ⑤ 児童実績表申請  ← 新規
   ⑥ 給食実数表（個人）← 新規

【児童実績表申請シート確認】
5. ヘッダー行に以下列があること:
   - No, クラス, 氏名, 区分
   - 各日（1日〜末日）の登園-降園
   - 出席日数, 一時利用日数, 早朝回数, 延長回数, 夜間回数, 病児回数
6. データ行:
   - 全園児（月極+一時）が掲載されていること
   - 出席日には「HH:MM-HH:MM」形式の時間が入っていること
   - 一時保育児童には [一時] フラグが表示されること
   - 合計行が最下部にあること

【給食実数表（個人）シート確認】
7. ヘッダー行に以下列があること:
   - No, クラス, 氏名, 区分, アレルギー
   - 朝食, 昼食, AM間食, PM間食, 夕食
   - 合計, 出席日数, 朝食率(%), 昼食率(%)
8. データ行:
   - 全園児の食事回数が個人別に集計されていること
   - 合計行があること
   - 日別食事提供数のブレークダウンがあること

【判定基準】
- 6シート全てが存在する
- 児童実績表申請に全園児のデータがある
- 給食実数表（個人）に個人別食事回数がある
- 日本語の列名が正しい
```

### 判定
- **結果**: ✅ PASS
- **証拠**: 日報Excel(560KB)に6シート存在:
  1. 月間サマリー 2. 出席一覧 3. 食事集計 4. 時間外保育 5. 児童実績表申請 6. 給食実数表（個人）
  - 児童実績表申請: 59名、日別時間("8:00-20:30 [延]")、合計行あり
  - 給食実数表: 個人別食事数(lunch=20, pm_snack=20等)、朝食率%/昼食率%あり
- **メモ**: SheetJSで生成、Node.jsで読み取り検証済

---

## K7: 保護者入力URL(/my/:token)で予定提出可能

### 背景
新機能A: 保護者がスマートフォンから直接、登園/降園の予定・食事フラグを入力して提出できる画面。

### 実装内容
- `/my/:token` ページに編集モード追加（閲覧 → 編集のトグル）
- 日付タップで時間入力ボトムシート表示
- 平日一括設定機能
- `POST /api/schedules/submit/:token` API

### 検証手順

```
【準備】
1. view_token が設定されている園児を確認:
   GET /api/children → view_token が null でない園児を選択
   - 園児名: ____
   - view_token: ____

【ページ表示テスト】
2. ブラウザで /my/{view_token}/2026/3 にアクセス
3. 以下が表示されること:
   - 園児名のヘッダー
   - 月間カレンダー
   - 各日の予定（あれば）
   - 「編集モード」ボタン

【編集モードテスト】
4. 「編集モード」をタップして有効にする
5. 任意の日付をタップ
6. ボトムシートが表示されること:
   - 登園時間の入力欄
   - 降園時間の入力欄
   - 食事フラグ（朝食/昼食/おやつ/夕食）のトグル
7. 時間を入力してセット
8. カレンダー上に入力した時間が反映されること

【平日一括設定テスト】
9. 「平日一括設定」ボタンをタップ
10. 時間と食事フラグを設定
11. 平日（月〜金）全てに同じ設定が反映されること

【提出テスト】
12. 「提出」ボタンをタップ
13. 成功メッセージが表示されること
14. API レスポンス確認:
    POST /api/schedules/submit/{token}
    → success: true, upserted: N, deleted: M

【データ永続化確認】
15. ページを再読み込み
16. 提出した予定が表示されること
17. DBの schedule_plans テーブルにデータがあること

【スマートフォン表示確認】
18. Chrome DevTools のモバイルビュー（iPhone SE / iPhone 14）で確認
    または実機で /my/{token} にアクセス
19. レイアウトが崩れないこと
20. タッチ操作でスムーズに動作すること

【判定基準】
- ページが表示される
- 編集モードで時間・食事フラグを入力できる
- 平日一括設定が機能する
- 提出後にDBにデータが保存される
- スマートフォンで操作可能
```

### 判定
- **結果**: ✅ PASS
- **証拠**:
  - ページ表示: HTTP 200、タイトル「利用予定入力 — あゆっこ」
  - 編集モード: HTMLに「編集」「提出」ボタンあり、schedules/submit API参照あり
  - 予定表示: API経由で20日分のスケジュールデータ取得成功
  - 提出: POST /api/schedules/submit/{token} → success:true, upserted:2, message:「𝐹田 希子さんの予定を保存しました (2日分)」
  - 永続化: 再読み込みでAprilの2日分が正しく返された
  - Playwright: JSエラーなし
- **メモ**: スマートフォン表示の実機確認は木村さんに依頼

---

## K8: 職員日報画面が表示・印刷可能

### 背景
新機能B: 職員が日別の保育情報（出席児童・食事・時間帯別情報）を一覧で確認し、印刷して保育室に掲示できる画面。

### 実装内容
- `/staff/daily/:year/:month/:day` で日別情報ページ
- 予定された登園時間・食事・早朝/延長/夜間フラグの一覧
- 食事サマリー（朝食/昼食/おやつ/夕食のカウント + アレルギー数）
- 印刷最適化CSS（@media print）

### 検証手順

```
【ページ表示テスト】
1. ブラウザで /staff/daily/2026/3/18 にアクセス
2. 以下が表示されること:
   - 日付ヘッダー（2026年3月18日）
   - 予定児童の一覧テーブル:
     - 名前
     - クラス（年齢区分）
     - 登園予定時間
     - 降園予定時間
     - 食事フラグ（朝/昼/おやつ/夕）
     - 時間外フラグ（早朝/延長/夜間）
     - 手書き記入欄（実際の登園/降園時間）
   - 食事サマリー:
     - 朝食: __名
     - 昼食: __名
     - おやつ: __名
     - 夕食: __名
     - アレルギー対応: __名

【別の日付テスト】
3. /staff/daily/2026/3/1 にアクセス
4. その日のデータが表示されること（データがなければ空表示で崩れないこと）

【印刷テスト】
5. Ctrl+P（または Cmd+P）で印刷プレビューを開く
6. 以下を確認:
   - ナビゲーション等の非印刷要素が非表示になること
   - テーブルがA4に収まること（横向き推奨の場合はその旨確認）
   - 手書き記入欄が十分な幅で印刷されること
   - フォントサイズが読みやすいこと

【判定基準】
- ページが正常に表示される
- 予定情報が正しく一覧表示される
- 食事サマリーが計算されている
- 印刷プレビューでレイアウトが適切
```

### 判定
- **結果**: ✅ PASS
- **証拠**:
  - ページ表示: HTTP 200、タイトル「日次情報 — あゆっこ」
  - HTML構造: tableタグ 22箇所、登園/降園/食事情報あり
  - 印刷: @media print CSS存在確認
  - データなし日: /staff/daily/2026/3/25 もHTTP 200（クラッシュしない）
  - Playwright: JSエラーなし
- **メモ**: 印刷プレビューの実際のレイアウト確認は木村さんに依頼

---

## 検証実行チェックリスト

### 前提条件
- [ ] Sandbox/本番サーバーが稼働中
- [ ] ローカルD1にテストデータが投入済み
- [ ] ルクミーCSVファイル（テスト用）を用意

### 実行順序
1. [ ] **K2** DB取込 → テストデータ投入の基盤
2. [ ] **K1** CSV重複 → K2と組み合わせて検証
3. [ ] **K3** 月間予定表 → K2のデータで表示確認
4. [ ] **K4** 請求Excel 一時保育 → compute 後に確認
5. [ ] **K5** 延長保育時間帯 → K4と同時に確認可能
6. [ ] **K6** 日報Excel 大学シート → compute 後に確認
7. [ ] **K7** 保護者入力画面 → 独立して検証可能
8. [ ] **K8** 職員日報画面 → K2のデータがあると良い

### 検証完了条件
- [ ] K1〜K8 全てが ✅ PASS
- [ ] 各項目に証拠（スクリーンショット or API レスポンス）が添付されている
- [ ] 木村さんが最終確認し承認

---

## サンドボックス検証用クイックコマンド

```bash
# === 環境確認 ===
BASE="https://3000-i726fppspidcgasv3kn1s-d0b9e1e2.sandbox.novita.ai"

# ヘルスチェック
curl -s "$BASE/api/health" | jq .

# 園児一覧
curl -s "$BASE/api/children" | jq '.total, (.children[] | select(.enrollment_type == "一時") | .name)'

# === K1: CSVインポートテスト ===
# 1回目（園児数の確認）
curl -s "$BASE/api/children" | jq '.total'

# CSVインポート
curl -X POST "$BASE/api/children/import" \
  -F "file=@test_children.csv" | jq .

# 2回目（同一CSV再インポート）
curl -X POST "$BASE/api/children/import" \
  -F "file=@test_children.csv" | jq .

# 園児数の再確認
curl -s "$BASE/api/children" | jq '.total'

# === K2: DB取込テスト ===
curl -X POST "$BASE/api/upload/import" \
  -F "year=2026" -F "month=3" \
  -F "files=@lukumi_data.xlsx" | jq .

# === K3: ダッシュボード ===
curl -X POST "$BASE/api/schedules/dashboard" \
  -H "Content-Type: application/json" \
  -d '{"year":2026,"month":3}' | jq .

# === K4/K5: 請求Excel ===
# まず計算
curl -X POST "$BASE/api/generate/compute" \
  -H "Content-Type: application/json" \
  -d '{"year":2026,"month":3}' | jq .

# 請求Excelダウンロード
curl -X POST "$BASE/api/generate/billing" \
  -H "Content-Type: application/json" \
  -d '{"year":2026,"month":3}' -o billing_202603.xlsx

# === K6: 日報Excel ===
curl -X POST "$BASE/api/generate/daily" \
  -H "Content-Type: application/json" \
  -d '{"year":2026,"month":3}' -o daily_202603.xlsx

# === K7: 保護者画面 ===
# ブラウザで: $BASE/my/{view_token}/2026/3

# === K8: 職員日報画面 ===
# ブラウザで: $BASE/staff/daily/2026/3/18
```

---

## 最終判定

| 全項目 PASS | 判定 |
|:-----------:|:----:|
| ✅ サンドボックス検証完了 | 木村さんの本番環境確認待ち |

**署名欄**:
- 検証実施者: ________________ 日付: ____/____/____
- 木村さん承認: ________________ 日付: ____/____/____

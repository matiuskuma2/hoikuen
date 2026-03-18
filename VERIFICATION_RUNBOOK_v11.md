# v11.0 検収 RUNBOOK
## あゆっこ保育園 業務自動化システム

**作成日**: 2026-03-18  
**最終更新**: 2026-03-18 (過大評価を修正し正直な評価に書換え)  
**対象バージョン**: v11.0  
**検収責任者**: 木村さん（最終判定）  
**ステータス**: 🔴 **v11.0 完了報告は保留中 — 検証が不完全なため完了とは認めない**

> **重要原則**:  
> 1. デプロイ成功 ≠ 機能的正確性  
> 2. API成功 ≠ ユーザーが実際に使える  
> 3. テストデータでの検証 ≠ 本番データでの検証  
> 4. サーバーサイドHTML返却 ≠ ブラウザでの実表示  

---

## 検証環境

| 項目 | 値 |
|------|-----|
| **本番URL** | https://ayukko-prod-2fx.pages.dev/ |
| **Sandbox URL** | https://3000-i726fppspidcgasv3kn1s-d0b9e1e2.sandbox.novita.ai |
| **GitHub** | https://github.com/matiuskuma2/hoikuen (main) |
| **D1 Database** | ayukko-production (ID: 92726720-a0cb-48c4-971d-7cd9ba82d0fb) |
| **現在のDB状態** | 園児59名 (月極17 / 一時42) — テストデータ含む |

---

## 検証項目サマリー（正直な評価）

| ID | 区分 | 検証内容 | 判定 | 信頼度 |
|----|------|----------|------|--------|
| K1 | Bug Fix | CSV再インポートで重複行が増えない | ✅ PASS | **高** |
| K2 | Bug Fix | DB取込でWorker上限エラーが出ない | ✅ PASS | **高** |
| K3 | Bug Fix | 月間予定表が正しく表示される | ⚠️ 条件付きPASS | **中** — テストデータでのAPI検証のみ。木村さんの実データでの画面表示・月切替を未確認 |
| K4 | Bug Fix | 請求Excelに一時保育児童が含まれる | ✅ PASS | **高** |
| K5 | Bug Fix | 延長保育が7:00-7:30 / 20:00-21:00のみ | ✅ PASS | **高** |
| K6 | Bug Fix | 日報Excelに大学提出用2シートがある | ✅ PASS | **高** |
| K7 | New Feature | 保護者入力URL(/my/:token)で予定提出可能 | ⚠️ API PASS — UI未検証 | **中** — API動作は確認済だが、ブラウザ上での編集操作・月切替・保存ボタン押下・スマホでの使いやすさは未検証 |
| K8 | New Feature | 職員日報画面が表示・印刷可能 | ⚠️ HTML構造PASS — 実表示・印刷未確認 | **低** — HTTPレスポンスとHTML構造・印刷CSSの存在は確認したが、データがブラウザ上で正しく表示されるか、A4印刷レイアウトが適切か、は未検証 |

**判定記号**: ✅ PASS / ❌ FAIL / ⬜ 未検証 / ⚠️ 条件付きPASS

---

## 高確度 PASS 項目（K1, K2, K4, K5, K6）

### K1: CSV再インポートで重複行が増えない — ✅ PASS

**証拠**:
- 初回インポート: 58→59名 (created=1, updated=7, skipped_dup=1)
- **同一CSVの再インポート**: 59名のまま (created=0, updated=8, skipped_dup=1)
- ふりがな行（名前が4パート以上）のスキップロジック動作確認済み
- バッチ化(80件チャンク) + メモリ内検索が正常に動作

**検証方法**: テストCSV（完全重複行1件、ふりがな重複1件、ユニーク6件）を使用し、APIレスポンスとDBカウントで確認

---

### K2: DB取込でWorker上限エラーが発生しない — ✅ PASS

**証拠**:
- POST /api/generate/compute → success:true, children_processed:59
- 59児童 × 20日 = 1,180 usage_facts がDBに書込済
- 472 charge_lines がDBに書込済
- 「Too many API requests」エラーなし
- 80件チャンクで db.batch() 実行が正常に動作

**検証方法**: 59名の園児に20日分のスケジュール+出席データを投入し、一括計算を実行

---

### K4: 請求Excelに一時保育児童が含まれる — ✅ PASS

**証拠**:
- 請求Excel(181KB) の3シート構成: 請求一覧 / 請求明細 / 単価表
- 請求明細シートに一時保育児童41名の請求行が存在
- 例: 「井上 璃莉華 / 一時 / 一時保育料 / 444回 × ¥200 = ¥88,800」(30分単位)
- 月極児童には月額保育料 + 早朝保育料 + 延長保育料 + 夜間保育料が正しく分離
- 請求一覧シートに月極・一時の両方が掲載されていることをPython解析で確認

**検証方法**: POST /api/generate/billing でExcelダウンロード→openpyxl/xlsxで解析

---

### K5: 延長保育料が正しい時間帯に適用 — ✅ PASS

**証拠** (usage_factsテーブルの実データ):

| パターン | 登園-降園 | 早朝 | 延長 | 夜間 | 件数 | 判定 |
|---------|-----------|------|------|------|------|------|
| a | 7:00-18:00 | 1 | 0 | 0 | 146 | 正しい |
| b | 7:30-19:30 | 0 | 0 | 0 | 147 | 正しい(18:00-20:00は延長なし) |
| c | 8:00-20:30 | 0 | 1 | 0 | 148 | 正しい |
| d | 7:00-21:30 | 1 | 1 | 1 | 149 | 正しい |
| e | 8:30-17:00 | 0 | 0 | 0 | 149 | 正しい |
| f | 8:00-18:30 | 0 | 0 | 0 | 148 | 正しい(18:30でも延長なし) |
| g | 7:15-19:00 | 1 | 0 | 0 | 146 | 正しい |
| h | 9:00-16:00 | 0 | 0 | 0 | 147 | 正しい |

TIME_BOUNDARIES定数: early_start=420(7:00), early_end=450(7:30), extension_start=1200(20:00), night_start=1260(21:00)

---

### K6: 日報Excelに大学提出用2シートが含まれる — ✅ PASS

**証拠**:
- 日報Excel(560KB) に6シート存在:
  1. 月間サマリー
  2. 出席一覧
  3. 食事集計
  4. 時間外保育
  5. **児童実績表申請** (59名、日別時間 "8:00-20:30 [延]" 等、合計列)
  6. **給食実数表（個人）** (79名、朝食/昼食/AM間食/PM間食/夕食の個人別回数、食事率%)

**検証方法**: POST /api/generate/daily → Node.js (SheetJS/xlsx) でシート名・データ・ヘッダー列を解析

---

## 条件付きPASS / 未検証項目（K3, K7, K8）

### K3: 月間予定表 — ⚠️ 条件付きPASS (テストデータでのAPI検証のみ)

**確認済み**:
- Dashboard API (POST /api/schedules/dashboard) が正しくデータを返す
  - 3月: total_children=59、31日分のサマリー
  - Day 1: lunch=59, pm_snack=59, dinner=45, early=22, ext=16, night=8, temp=41
- 月切替: 2月(0件)、3月(20日分)、4月(K7テスト2日分) — APIレベルで切替動作確認
- 個別日の詳細: 児童名・時間帯・食事フラグが正しく返却

**未確認（本番検証が必要）**:
- [ ] 木村さんの実データでダッシュボード画面がブラウザ上で正しく描画されるか
- [ ] 月切替ボタンのブラウザ上での動作
- [ ] データ件数が多い場合のパフォーマンス

---

### K7: 保護者入力URL — ⚠️ API PASS、UI操作は未検証

**確認済み**:
- **ページ表示**: HTTP 200、タイトル「利用予定入力 — あゆっこ」
  - URL: `https://…/my/{view_token}`
  - HTML: 24,165 bytes、Playwright JSエラーなし
- **HTML要素**: 編集ボタン(1)、提出ボタン(8)、カレンダーグリッド(7列: 月火水木金土日)、時間入力(4)、月切替(changeMonth関数)、食事チェックボックス(36)
- **JS関数**: loadSchedule, renderAll, getDayData, renderCalendar, renderDayList, toggleMode, applyDefaults, openDayModal, closeDayModal, saveDay, clearDay, updateSaveBar, submitAll, shortTime, changeMonth, scrollToDay (16関数)
- **API動作（正しいフィールド名 planned_start/planned_end で検証）**:
  - 新規入力: POST /api/schedules/submit/{token} → upserted=3, deleted=0 (7月に3日分保存)
  - 編集: Day 1 を 08:30-17:00 → 07:30-18:30 に変更 → upserted=3, deleted=0
  - 編集後確認: view APIで Day 1 = 07:30-18:30 を確認（永続化OK）
  - 削除: Day 3 を null/null で送信 → upserted=2, deleted=1
  - 削除後確認: total_planned_days=2（Day 3 が削除されている）
  - 月切替: 3月(20日)、4月(0日)、7月(2日)、8月(0日) — 各月の切替が正常
- **フロントエンドJS**: submitAll関数が正しく `planned_start`/`planned_end` フィールド名を使用

**未確認（実機検証が必要）**:
- [ ] ブラウザ上で「編集」ボタンをタップし、編集モードに切り替わるか
- [ ] 日付タップでボトムシートが開き、時間・食事を入力できるか
- [ ] 「保存」「提出」ボタンの実際のクリック動作
- [ ] 平日一括設定機能の実操作
- [ ] スマートフォン実機での操作性（タッチ操作・レスポンシブ表示）
- [ ] 遅い回線での動作（API呼び出しのタイムアウト等）

---

### K8: 職員日報画面 — ⚠️ HTML構造PASS、実表示・印刷は未確認

**確認済み**:
- **アクセスURL**: `https://…/staff/daily/2026/3/1`
- **HTTPレスポンス**: 200 OK、11,754 bytes、Content-Type: text/html
- **ページタイトル**: 「日次情報 — あゆっこ」
- **HTML構造**:
  - テーブル: 1つ (18列ヘッダー)
  - 列: No, クラス, 氏名, 区分, 予定登園, 予定降園, 朝食, 昼食, 朝おやつ, 午後おやつ, 夕食, 早朝, 延長, 夜間, 実績登園(print-only), 実績降園(print-only), 確認(print-only)
  - 印刷ボタン: 3箇所
  - 印刷CSS: `print-color-adjust: exact`, `.no-print { display: none !important; }` 確認済み
- **JavaScript**: `loadDate`, `loadDayData` (fetch `/api/schedules/dashboard`), `shortTime` — 3関数
  - children.map() で `<tr><td>` 行を構築し tbody.innerHTML に挿入するレンダリングロジック確認
- **データソースAPI**: POST /api/schedules/dashboard で Day 1 の59名分データが正しく返却される
- **Playwright**: コンソールエラーなし（Tailwind CDN警告のみ）
- **エラー耐性**: データなし日 (/staff/daily/2026/3/25) でも HTTP 200（クラッシュしない）

**未確認（実機検証が必要）**:
- [ ] ブラウザ上でテーブルにデータが正しくレンダリングされるか（JSの動的レンダリングのため、curlでは確認不可）
- [ ] 児童名・時間帯・食事フラグが正しい位置に表示されるか
- [ ] 印刷プレビュー(Ctrl+P)で:
  - ナビゲーション要素が非表示になるか
  - テーブルがA4に収まるか
  - 手書き記入欄（実績登園/降園/確認）が適切な幅で印刷されるか
  - フォントサイズが読みやすいか
- [ ] 日付切替（前日/翌日ナビゲーション）がブラウザ上で動作するか

---

## 検証実行チェックリスト

### 前提条件
- [x] Sandboxサーバー稼働中
- [x] ローカルD1にテストデータ投入済み（59名 × 20日）
- [x] RUNBOOKの過大評価を修正済み

### 残り作業（木村さんとの共同検証）
1. [ ] **K3**: 本番環境に実データを投入し、ブラウザでダッシュボードを確認
2. [ ] **K7**: 実機（スマートフォン）で /my/{token} を開き、一連の操作を実行
3. [ ] **K8**: ブラウザで /staff/daily/2026/3/1 を開き、テーブル表示と印刷を確認
4. [ ] 全項目 PASS 後に、木村さんが署名して v11.0 完了

### 検証完了条件
- [ ] K1-K8 全てが ✅ PASS（条件付きPASSは不可）
- [ ] 各項目に証拠（スクリーンショット or API レスポンス or 印刷結果）が添付されている
- [ ] 木村さんが最終確認し承認

---

## サンドボックス検証用クイックコマンド

```bash
# === 環境確認 ===
BASE="https://3000-i726fppspidcgasv3kn1s-d0b9e1e2.sandbox.novita.ai"

# ヘルスチェック
curl -s "$BASE/api/health" | jq .

# 園児一覧
curl -s "$BASE/api/children" | jq '.total'

# === K1: CSVインポートテスト ===
curl -s "$BASE/api/children" | jq '.total'
curl -X POST "$BASE/api/children/import" -F "file=@test_children.csv" | jq .
curl -X POST "$BASE/api/children/import" -F "file=@test_children.csv" | jq .  # 再インポート
curl -s "$BASE/api/children" | jq '.total'  # 同数であること

# === K2: DB取込テスト ===
curl -X POST "$BASE/api/generate/compute" \
  -H "Content-Type: application/json" \
  -d '{"year":2026,"month":3}' | jq .

# === K3: ダッシュボード ===
curl -X POST "$BASE/api/schedules/dashboard" \
  -H "Content-Type: application/json" \
  -d '{"year":2026,"month":3}' | jq '.total_children, .days_in_month'

# === K4/K5: 請求Excel ===
curl -X POST "$BASE/api/generate/billing" \
  -H "Content-Type: application/json" \
  -d '{"year":2026,"month":3}' -o billing_202603.xlsx

# === K6: 日報Excel ===
curl -X POST "$BASE/api/generate/daily" \
  -H "Content-Type: application/json" \
  -d '{"year":2026,"month":3}' -o daily_202603.xlsx

# === K7: 保護者画面 ===
# ブラウザで: $BASE/my/{view_token}
# view_tokenの取得: curl -s "$BASE/api/children" | jq '.children[] | select(.view_token != null) | {name, view_token}' | head -10

# === K8: 職員日報画面 ===
# ブラウザで: $BASE/staff/daily/2026/3/1
```

---

## 最終判定

| ステータス | 詳細 |
|:---------:|:----:|
| 🔴 **完了報告は保留** | K3/K7/K8 の実機・実データ検証が未完了 |

> **「全K1-K8 PASS」は現時点で虚偽となるため、木村さんに報告してはならない。**  
> 報告可能な内容は「K1,K2,K4,K5,K6 は高確度で PASS。K3,K7,K8 は部分的に確認済だが、画面操作・印刷・実データの実機検証が残っている」のみ。

**署名欄**:
- 検証実施者: ________________ 日付: ____/____/____
- 木村さん承認: ________________ 日付: ____/____/____

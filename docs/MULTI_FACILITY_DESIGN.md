# 複数施設対応 & 保護者スマホ入力 — 総合設計書

> **Version**: 2.0 (2026-03-04)
> **Status**: Design Only (実装前)
> **Author**: Ayukko Development Team
> **Parent System**: あゆっこ 業務自動化システム v6.1
> **Reviewed by**: モギモギ（関屋紘之）
> **関連文書**: REQUIREMENTS.md (v3.1), LINE_SCHEDULE_COLLECTION_PLAN.md (v4.0), REQUIREMENTS_CHECK.md (v1.0)

---

## ★★★ 設計の大前提 ★★★

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  保護者のスマホ入力 = Web/PWA ポータルが Primary (100%)         │
│                                                                 │
│  LINE は Phase 2 の Optional 追加チャネルに過ぎない             │
│  （希望する園のみ、Web ポータル完成後に有効化）                 │
│                                                                 │
│  Phase 1 (必須): 全30施設に Web ポータルを展開 → 紙廃止        │
│  Phase 2 (任意): 希望施設のみ LINE AI ヒアリングを追加         │
│                                                                 │
│  要件①「保護者がスマホで月次予定入力」は                       │
│  Web ポータル単体で 100% 充足される。                           │
│  LINE が無くても要件①は完全に達成される。                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 目次

1. [エグゼクティブサマリー](#1-エグゼクティブサマリー)
2. [ビジネス要件の整理 (詳細仕様)](#2-ビジネス要件の整理-詳細仕様)
3. [施設ティア分類と機能マトリックス](#3-施設ティア分類と機能マトリックス)
4. [システムアーキテクチャ (Multi-Tenant)](#4-システムアーキテクチャ-multi-tenant)
5. [DB スキーマ拡張: マルチテナント化](#5-db-スキーマ拡張-マルチテナント化)
6. [要件① 保護者スマホ入力 (Primary — Web/PWA)](#6-要件-保護者スマホ入力-primary--webpwa)
7. [要件② スタッフ共有ビュー・印刷](#7-要件-スタッフ共有ビュー印刷)
8. [要件③ 大学/委託先 PDF レポート](#8-要件-大学委託先-pdf-レポート)
9. [要件④ 経理用 Excel 出力](#9-要件-経理用-excel-出力)
10. [要件⑤ 保護者利用明細 (PDF)](#10-要件-保護者利用明細-pdf)
11. [認証・認可アーキテクチャ](#11-認証認可アーキテクチャ)
12. [LINE連携 (Phase 2 — Optional)](#12-line連携-phase-2--optional)
13. [DB マイグレーション計画](#13-db-マイグレーション計画)
14. [API 設計 (マルチテナント対応)](#14-api-設計-マルチテナント対応)
15. [施設オンボーディングフロー](#15-施設オンボーディングフロー)
16. [コスト見積 (30施設規模)](#16-コスト見積-30施設規模)
17. [実装ロードマップ](#17-実装ロードマップ)
18. [既存あゆっこシステムからの移行計画](#18-既存あゆっこシステムからの移行計画)
19. [次回ミーティング確認事項 (6項目)](#19-次回ミーティング確認事項-6項目)
20. [リスクと未決事項](#20-リスクと未決事項)
21. [付録](#21-付録)

---

## 1. エグゼクティブサマリー

### 1.1 背景

現在のシステムは「滋賀医科大学学内保育所 あゆっこ」1施設専用で構築されている。木村さんの要望を再整理すると、以下の5つの要件が**約30の委託保育施設**に展開される。

### 1.2 5つの要件と適用範囲

| # | 要件 | 対象施設数 | 優先度 | 入力チャネル |
|---|------|-----------|--------|-------------|
| ① | 保護者がスマホで月次利用予定を入力（紙廃止） | **全30施設** | ★★★ 最高 | **Web/PWA (Primary)** |
| ② | スタッフが園児予定を共有ビュー(日報)で閲覧・印刷 | **全30施設** | ★★★ 最高 | Web (スタッフ画面) |
| ③ | 大学提出用PDF（利用実績、一時保育時間、食事等） | **多くの施設** (標準フォーマット) | ★★☆ | ルクミー実績取込 + 予定データ |
| ④ | 経理用Excel出力（保育料明細、大学への料金サマリー） | **2施設** (あゆっこ等) | ★☆☆ | 既存テンプレート |
| ⑤ | 保護者利用明細PDF（スマホ閲覧、配布不要） | **1施設** (あゆっこのみ) | ★☆☆ | ポータル内閲覧 |
| (補助) | LINE AI ヒアリング入力 | **希望施設のみ** | Phase 2 Add-on | LINE Messaging API |

### 1.3 設計原則

```
■ 原則1: 「マルチテナント・シングルインスタンス」
  → 全施設が同一Cloudflare Workers/D1で稼働
  → nursery_id でテナント分離（行レベルRLS的）
  → 施設追加はDBレコード追加のみ、デプロイ不要

■ 原則2: 「段階的機能解放」(Feature Tier)
  → 全施設共通: 保護者入力 + スタッフビュー（①②）
  → 標準施設: + 大学提出PDF（③）
  → あゆっこ等: + 経理Excel + 保護者明細（④⑤）
  → 施設ごとの settings_json で有効/無効制御

■ 原則3: ★★★「保護者入力はWebポータルが Primary」★★★
  → Web/PWA ポータルで要件①は100%充足される
  → LINE は Phase 2 のオプション追加チャネル
  → LINE が無くても紙廃止は達成される
  → Webは全施設で即座に使える汎用性を優先
  → LINE はWebでの入力が難しいと感じる保護者への補助手段

■ 原則4: 「あゆっこの既存機能を壊さない」
  → nursery_id = 'ayukko_001' の既存データ・ロジックは維持
  → 新規施設は新しい nursery_id で追加
  → 既存のダッシュボード、帳票生成パイプラインはそのまま
```

### 1.4 キーとなるアーキテクチャ決定

| 判断項目 | 選択 | 理由 |
|----------|------|------|
| テナント分離方式 | 共有DB + 行レベル分離 | 30施設では1DB/施設は管理コスト過大 |
| **保護者入力手段 (Primary)** | **Web ポータル (PWA)** | **LINE不要で全施設即展開可、要件①を100%充足** |
| 保護者入力手段 (Phase 2) | LINE AI ヒアリング | 希望施設のみの追加チャネル |
| 認証方式 (保護者) | マジックリンク (Email) | パスワード不要で保護者の負荷最小 |
| 認証方式 (スタッフ) | パスワード + TOTP | セキュリティ要件 |
| PDF生成 | jsPDF + テンプレート定義 | Worker内で完結、標準フォーマット対応 |
| Excel生成 | ExcelJS (R2テンプレート読込) | あゆっこ固有、2施設のみ |

---

## 2. ビジネス要件の整理 (詳細仕様)

### 2.1 要件① 保護者月次利用予定入力

> **これが最重要要件。Web/PWA ポータルで 100% 実現する。LINE は不要。**

**目的**: 紙の利用予定表を廃止し、保護者がスマートフォンから直接入力する。

**入力チャネル**:
- **Primary (Phase 1)**: Web/PWA ポータル — 全30施設で必須展開
- **Optional (Phase 2)**: LINE AI ヒアリング — 希望施設のみ追加チャネル

**機能要件**:

| # | 要件 | 詳細 |
|---|------|------|
| ①-1 | ホーム画面追加可能 (PWA) | manifest.json + Service Worker でネイティブアプリに近い体験 |
| ①-2 | マジックリンクログイン | パスワード不要。メールアドレス入力 → リンククリック → ログイン |
| ①-3 | 月カレンダー UI | 対象月を選択し、日別の予定を視覚的に確認・編集 |
| ①-4 | デフォルト曜日パターン | 「月〜金 8:30-17:00」のように基本パターンを一括設定 |
| ①-5 | 例外日の個別編集 | カレンダー上の日付タップで休み/時間変更/食事変更 |
| ①-6 | **入力項目: 登園時間** | HH:MM (時間ピッカー or テキスト入力) |
| ①-7 | **入力項目: 降園時間** | HH:MM |
| ①-8 | **入力項目: 食事 (5種)** | 朝食(※)、昼食、午前おやつ、午後おやつ、夕食 |
| ①-9 | **入力項目: 利用なし** | 特定日を「お休み」にマーク |
| ①-10 | **きょうだい切替** | 複数児童を持つ保護者が画面上で子供を切り替えて入力 |
| ①-11 | 入力後の確認画面 | 全日程一覧で最終確認、修正リンク付き |
| ①-12 | **締切管理 (前月末まで変更可)** | 前月末日23:59 JSTまで自由に入力・変更 |
| ①-13 | **当月ロック (例外あり)** | 当月に入ったら変更不可。ただし**欠席のみ例外で受付** |
| ①-14 | 緊急欠席登録 | 当月ロック中でも「今日/明日休みます」を入力可能 |
| ①-15 | 提出状態管理 | draft → submitted → confirmed → locked の状態遷移 |

**※ 朝食 (breakfast) について**: `breakfast_flag` を `schedule_plans` テーブルに追加するか否かは次回ミーティングで確認（セクション19 確認事項 #3 参照）。

**非機能要件**:
- スマホブラウザで快適に操作（PWA対応）
- 3G/4G回線でも動作（軽量設計、TailwindCSS CDN + Vanilla JS）
- オフライン時はエラー表示（オフラインキャッシュはPhase 2）

### 2.2 要件② スタッフ共有ビュー・印刷

**目的**: 園内スタッフが日ごとの人数・食数を確認し、人員配置・給食発注に使う。

**機能要件**:

| # | 要件 | 詳細 |
|---|------|------|
| ②-1 | 月間カレンダー表示 | 日別の予定人数、食数（朝食・昼食・おやつ・夕食）を一覧 |
| ②-2 | 日別詳細リスト | 園児名、登降園時間、食事フラグ、一時保育表示 |
| ②-3 | クラス別集計 | 年齢別（0歳/1歳/2歳）、月極/一時の内訳 |
| ②-4 | **PDF / 印刷対応** | A4横向き、ワンクリック印刷ボタン |
| ②-5 | 予定と実績の比較 | ルクミー連携施設のみ（Tier 3）|
| ②-6 | 提出状況ダッシュボード | 未提出保護者の一覧、リマインド機能 |

**非機能要件**:
- タブレット・PC対応（スマホは閲覧のみ）
- 印刷ボタンで即座にA4出力（CSS @media print）

### 2.3 要件③ 大学/委託先 PDF レポート

**目的**: 大学（委託元）へ提出する児童利用実績を標準フォーマットPDFで生成。

**機能要件**:

| # | 要件 | 詳細 |
|---|------|------|
| ③-1 | **ルクミー実績取込** | CSV/Excel を取り込み、予定と突合 |
| ③-2 | **一時保育の利用時間集計** | 30分単位ブロック数、料金自動計算 |
| ③-3 | 月次利用サマリー | 園児一覧（氏名、年齢、利用日数、月極/一時）|
| ③-4 | 園児別利用実績 | 日別の登降園時間、利用時間、食事提供記録 |
| ③-5 | 食事提供実績 | 日別の昼食数、おやつ数、夕食数 |
| ③-6 | 特別保育記録 | 早朝、延長、夜間、病児の実績 |
| ③-7 | **病児保育: 打刻なし手動入力** | ルクミーで打刻されないケースを手動記録 |

**施設固有テンプレートの扱い**:
- 標準フォーマットPDFは jsPDF で Worker 内生成
- 施設固有のExcelテンプレートが必要な場合は report_templates テーブルで個別定義

### 2.4 要件④ 経理用 Excel

**目的**: 保育料の請求計算結果をExcelで出力し、経理部門・大学事務局に提出。

**対象**: 2施設（あゆっこ + 1施設） → ティアごとに ON/OFF 制御

**機能要件**:
- 保育料明細（園児別の月額計算）
- 一時保育料、早朝/延長/夜間/病児の加算
- 食事代の集計
- テンプレートExcelへの書き込み（既存フォーマット維持）

### 2.5 要件⑤ 保護者利用明細 PDF

**目的**: 保護者がスマホで月次利用・請求内容を確認できる。紙配布不要。

**対象**: 1施設（あゆっこのみ）。ポータル内で閲覧、またはダウンロードリンクで配布。

**機能要件**:
- 月次利用日数、利用時間
- 保育料内訳（月額、一時、加算、食事）
- 請求合計
- **スマホ表示最適化、PDF保存・印刷対応**
- **ポータルからの直接閲覧** or ダウンロードリンク通知

**配信方法** (次回確認事項):
- 方式A: ポータルにログインして閲覧
- 方式B: メールでPDFリンクを通知
- 方式C: (Phase 2) LINE Push で通知

---

## 3. 施設ティア分類と機能マトリックス

### 3.1 ティア定義

```
Tier 1: Basic (全施設共通) — 約25施設
  ├── 保護者スマホ入力 Web/PWA (①)
  ├── スタッフ共有ビュー・印刷 (②)
  └── 基本ダッシュボード

Tier 2: Standard (大学提出あり) — 約3施設
  ├── Tier 1 全機能
  ├── 大学提出用 PDF (③)
  └── 標準レポート生成

Tier 3: Premium (フル機能) — 2施設 (あゆっこ等)
  ├── Tier 2 全機能
  ├── 経理用 Excel (④)
  ├── 保護者利用明細 PDF (⑤)
  ├── ルクミー連携
  └── Python Generator パイプライン

Add-on: LINE (Phase 2, ティア問わず希望施設のみ)
  └── LINE AI ヒアリング入力 (①の追加チャネル)
```

### 3.2 機能マトリックス

| 機能 | Tier 1 | Tier 2 | Tier 3 | Add-on | 実装方式 |
|------|--------|--------|--------|--------|----------|
| **保護者 Web/PWA ポータル** | **✅** | **✅** | **✅** | - | **Cloudflare Workers + PWA** |
| LINE 予定入力 | - | - | - | ✅ (Phase2) | LINE Messaging API |
| スタッフ管理画面 | ✅ | ✅ | ✅ | - | 既存 Hono + 拡張 |
| 園児マスタ管理 | ✅ | ✅ | ✅ | - | children テーブル |
| 日別人数・食数集計 | ✅ | ✅ | ✅ | - | schedule_plans 集計 |
| 印刷用レイアウト | ✅ | ✅ | ✅ | - | CSS @media print |
| 大学提出 PDF | ❌ | ✅ | ✅ | - | jsPDF テンプレート |
| ルクミー連携 | ❌ | ❌ | ✅ | - | CSV/Excel パーサー |
| 経理 Excel | ❌ | ❌ | ✅ | - | ExcelJS + R2 テンプレ |
| 保護者利用明細 PDF | ❌ | ❌ | ✅ | - | jsPDF / pdf-lib |
| Python Generator | ❌ | ❌ | ✅ | - | 既存パイプライン |
| 料金自動計算 | 簡易 | 簡易 | フル | - | charge-calculator |

### 3.3 施設設定 (settings_json 拡張)

```json
{
  "tier": "basic|standard|premium",
  "features": {
    "parent_portal": true,
    "line_integration": false,
    "university_pdf": false,
    "accounting_excel": false,
    "parent_statement_pdf": false,
    "lukumi_integration": false,
    "python_generator": false,
    "auto_pricing": false
  },
  "branding": {
    "display_name": "○○保育所",
    "short_name": "○○",
    "logo_r2_key": null,
    "primary_color": "#3B82F6"
  },
  "schedule_rules": {
    "deadline_day": 0,
    "allow_emergency_cancel": true,
    "emergency_cancel_scope": "absence_only",
    "open_time": "07:30",
    "close_time": "20:00",
    "operating_days": ["mon","tue","wed","thu","fri"],
    "meal_types": ["lunch","pm_snack"],
    "has_breakfast": false,
    "has_early_morning": false,
    "has_extension": false,
    "has_night": false,
    "has_sick_care": false
  },
  "contact": {
    "phone": "XXX-XXXX-XXXX",
    "email": "info@example.com"
  }
}
```

**`deadline_day` の意味**:
- `0`: 前月末日が締切（デフォルト、あゆっこと同じ）
- `25`: 前月25日が締切
- `-1`: 締切なし（いつでも変更可能）

**`emergency_cancel_scope` の意味**:
- `"absence_only"`: 当月ロック後は欠席のみ受付（デフォルト）
- `"absence_and_meal"`: 欠席 + 食事キャンセルも受付
- `"none"`: 緊急キャンセル不可

---

## 4. システムアーキテクチャ (Multi-Tenant)

### 4.1 アーキテクチャ概要

```
┌────────────────┐    ┌────────────────┐    ┌────────────────┐
│   保護者 A園    │    │   保護者 B園    │    │   保護者 C園    │
│   (スマホ)      │    │   (スマホ)      │    │   (スマホ)      │
└───────┬────────┘    └───────┬────────┘    └───────┬────────┘
        │                     │                     │
        └─────────┬───────────┴─────────────────────┘
                  │
     ┌────────────▼─────────────┐
     │  Cloudflare Workers/Pages │
     │  (Single Deployment)      │
     │                           │
     │  ┌────────────────────┐  │
     │  │ /p/:nurserySlug/*  │  │     ← 保護者ポータル (Primary)
     │  │ Parent Portal      │  │
     │  └────────────────────┘  │
     │  ┌────────────────────┐  │
     │  │ /s/:nurserySlug/*  │  │     ← スタッフ管理画面
     │  │ Staff Dashboard    │  │
     │  └────────────────────┘  │
     │  ┌────────────────────┐  │
     │  │ /api/:nurserySlug/*│  │     ← API (テナント分離)
     │  │ Multi-tenant API   │  │
     │  └────────────────────┘  │
     │  ┌────────────────────┐  │
     │  │ /admin/*           │  │     ← 全施設統括管理
     │  │ Super Admin        │  │
     │  └────────────────────┘  │
     │  ┌────────────────────┐  │
     │  │ /api/line/webhook  │  │     ← LINE (Phase 2, Optional)
     │  │ LINE Integration   │  │
     │  └────────────────────┘  │
     │           │               │
     │  ┌────────▼───────────┐  │
     │  │   D1 Database      │  │     ← 共有DB (行レベル分離)
     │  │   (nursery_id)     │  │
     │  └────────────────────┘  │
     │  ┌────────────────────┐  │
     │  │   R2 Storage       │  │     ← テンプレ・生成物
     │  │   /{nursery_id}/   │  │
     │  └────────────────────┘  │
     └───────────────────────────┘
                  │
     ┌────────────▼─────────────┐     (Tier 3 施設のみ)
     │  Python Generator        │
     │  (あゆっこ専用パイプライン)│
     └──────────────────────────┘
```

### 4.2 URL設計

```
保護者ポータル (Primary — 全施設):
  https://hoikuen.pages.dev/p/{nursery_slug}/
  https://hoikuen.pages.dev/p/{nursery_slug}/schedule
  https://hoikuen.pages.dev/p/{nursery_slug}/statement (Tier 3のみ)

スタッフ管理画面:
  https://hoikuen.pages.dev/s/{nursery_slug}/
  https://hoikuen.pages.dev/s/{nursery_slug}/dashboard
  https://hoikuen.pages.dev/s/{nursery_slug}/children
  https://hoikuen.pages.dev/s/{nursery_slug}/reports

API:
  https://hoikuen.pages.dev/api/{nursery_slug}/schedules
  https://hoikuen.pages.dev/api/{nursery_slug}/children
  https://hoikuen.pages.dev/api/{nursery_slug}/reports

全施設統括管理:
  https://hoikuen.pages.dev/admin/
  https://hoikuen.pages.dev/admin/nurseries
  https://hoikuen.pages.dev/admin/stats

LINE Webhook (Phase 2, 全施設共通):
  https://hoikuen.pages.dev/api/line/webhook
```

**nursery_slug の例**:
- `ayukko` → 滋賀医科大学学内保育所 あゆっこ (nursery_id: ayukko_001)
- `sakura` → さくら保育所 (nursery_id: sakura_001)
- `himawari` → ひまわり保育園 (nursery_id: himawari_001)

### 4.3 テナント解決ミドルウェア

```typescript
// 概念設計: 全APIリクエストで nursery_id を解決
// 実装はコミットしない（設計ドキュメントのみ）

async function resolveNursery(slug: string, db: D1Database) {
  const nursery = await db.prepare(
    `SELECT id, name, settings_json FROM nurseries WHERE slug = ? AND is_active = 1`
  ).bind(slug).first();
  
  if (!nursery) throw new HTTPException(404, { message: 'Facility not found' });
  
  return {
    id: nursery.id,
    name: nursery.name,
    settings: JSON.parse(nursery.settings_json || '{}'),
  };
}
```

### 4.4 R2 ストレージのテナント分離

```
R2 キー構造:
  {nursery_id}/templates/{template_type}/{filename}
  {nursery_id}/outputs/{job_id}/{filename}
  {nursery_id}/parent_statements/{year}/{month}/{child_id}.pdf

例:
  ayukko_001/templates/daily_report/日報202604.xlsx
  ayukko_001/outputs/job_abc123/billing_detail_202604.xlsx
  sakura_001/templates/daily_report/日報テンプレート.xlsx
```

---

## 5. DB スキーマ拡張: マルチテナント化

### 5.1 既存テーブルの変更

#### `nurseries` テーブル拡張

```sql
-- 新カラム追加
ALTER TABLE nurseries ADD COLUMN slug TEXT UNIQUE;
ALTER TABLE nurseries ADD COLUMN is_active INTEGER DEFAULT 1;
ALTER TABLE nurseries ADD COLUMN tier TEXT DEFAULT 'basic' 
  CHECK(tier IN ('basic', 'standard', 'premium'));
ALTER TABLE nurseries ADD COLUMN contact_json TEXT DEFAULT '{}';

-- 既存データへの slug 設定
UPDATE nurseries SET slug = 'ayukko', tier = 'premium' WHERE id = 'ayukko_001';

CREATE UNIQUE INDEX IF NOT EXISTS idx_nurseries_slug ON nurseries(slug);
```

### 5.2 認証関連テーブル (新規)

#### `staff_accounts` --- スタッフアカウント

```sql
CREATE TABLE IF NOT EXISTS staff_accounts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  nursery_id TEXT NOT NULL REFERENCES nurseries(id),
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,          -- bcrypt/argon2id
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff'
    CHECK(role IN ('owner','admin','staff','viewer')),
  is_active INTEGER DEFAULT 1,
  totp_secret TEXT,                      -- TOTP認証 (optional)
  last_login_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(nursery_id, email)
);

CREATE INDEX IF NOT EXISTS idx_staff_nursery ON staff_accounts(nursery_id);
```

#### `parent_accounts` --- 保護者アカウント

```sql
CREATE TABLE IF NOT EXISTS parent_accounts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  nursery_id TEXT NOT NULL REFERENCES nurseries(id),
  email TEXT,                            -- マジックリンク用
  phone TEXT,                            -- SMS認証用 (optional)
  name TEXT NOT NULL,                    -- 保護者氏名
  auth_method TEXT DEFAULT 'magic_link'
    CHECK(auth_method IN ('magic_link', 'sms', 'line', 'password')),
  is_active INTEGER DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(nursery_id, email)
);

CREATE INDEX IF NOT EXISTS idx_parent_nursery ON parent_accounts(nursery_id);
```

#### `parent_children` --- 保護者→児童マッピング

```sql
CREATE TABLE IF NOT EXISTS parent_children (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  parent_id TEXT NOT NULL REFERENCES parent_accounts(id),
  child_id TEXT NOT NULL REFERENCES children(id),
  relationship TEXT DEFAULT 'parent'
    CHECK(relationship IN ('parent','grandparent','guardian','other')),
  is_primary INTEGER DEFAULT 1,          -- 主保護者フラグ
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(parent_id, child_id)
);

CREATE INDEX IF NOT EXISTS idx_pc_parent ON parent_children(parent_id);
CREATE INDEX IF NOT EXISTS idx_pc_child ON parent_children(child_id);
```

#### `auth_sessions` --- 認証セッション

```sql
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  account_type TEXT NOT NULL CHECK(account_type IN ('staff', 'parent', 'admin')),
  account_id TEXT NOT NULL,
  nursery_id TEXT REFERENCES nurseries(id),
  token_hash TEXT NOT NULL UNIQUE,        -- セッショントークンのハッシュ
  user_agent TEXT,
  ip_address TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_token ON auth_sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON auth_sessions(account_type, account_id);
```

#### `magic_links` --- マジックリンク

```sql
CREATE TABLE IF NOT EXISTS magic_links (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  parent_id TEXT NOT NULL REFERENCES parent_accounts(id),
  token TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,               -- 15分後
  used_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_magic_token ON magic_links(token);
```

### 5.3 schedule_plans テーブルの変更

```sql
-- 提出ステータス管理カラム追加
ALTER TABLE schedule_plans ADD COLUMN submitted_by TEXT;  -- parent_account_id or 'staff'
ALTER TABLE schedule_plans ADD COLUMN submitted_at TEXT;

-- 月次提出状態管理テーブル (新規)
CREATE TABLE IF NOT EXISTS schedule_submissions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  child_id TEXT NOT NULL REFERENCES children(id),
  nursery_id TEXT NOT NULL REFERENCES nurseries(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK(status IN ('draft', 'submitted', 'confirmed', 'locked')),
  submitted_by TEXT,                     -- parent_account_id
  submitted_at TEXT,
  confirmed_by TEXT,                     -- staff_account_id
  confirmed_at TEXT,
  locked_at TEXT,                        -- 自動ロック日時
  total_days INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(child_id, year, month)
);

CREATE INDEX IF NOT EXISTS idx_submissions_nursery 
  ON schedule_submissions(nursery_id, year, month);
CREATE INDEX IF NOT EXISTS idx_submissions_child 
  ON schedule_submissions(child_id, year, month);
```

### 5.4 報告書テンプレート管理テーブル (新規)

```sql
-- 標準レポートテンプレート定義
CREATE TABLE IF NOT EXISTS report_templates (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  nursery_id TEXT REFERENCES nurseries(id),  -- NULL = 全施設共通テンプレ
  template_type TEXT NOT NULL CHECK(template_type IN (
    'university_pdf',        -- 大学提出用PDF (③)
    'accounting_excel',      -- 経理用Excel (④)
    'parent_statement_pdf',  -- 保護者利用明細PDF (⑤)
    'daily_summary_pdf',     -- 日報PDF
    'staff_schedule_pdf'     -- スタッフ用予定表
  )),
  template_name TEXT NOT NULL,
  config_json TEXT NOT NULL,              -- レイアウト定義 (JSON)
  r2_key TEXT,                            -- Excelテンプレの場合
  is_default INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_report_templates_nursery 
  ON report_templates(nursery_id, template_type);
```

### 5.5 ER図 (拡張後)

```
                    ┌────────────────────┐
                    │    nurseries       │
                    │ (施設マスタ)        │
                    │ + slug             │
                    │ + tier             │
                    │ + settings_json    │
                    └─────────┬──────────┘
                              │ 1
           ┌──────────────────┼──────────────────┐
           │                  │                  │
     ┌─────▼──────┐    ┌─────▼──────┐    ┌─────▼──────┐
     │ children   │    │ staff_     │    │ parent_    │
     │ (園児)     │    │ accounts   │    │ accounts   │
     └──────┬─────┘    │ (職員)     │    │ (保護者)   │
            │          └────────────┘    └──────┬─────┘
            │ 1                                 │
     ┌──────┼───────────────────┐         ┌─────▼──────┐
     │      │                   │         │ parent_    │
     │ ┌────▼──────┐    ┌──────▼────┐    │ children   │
     │ │ schedule_ │    │ schedule_ │    │ (紐付け)   │
     │ │ plans     │    │ submissions│    └────────────┘
     │ │ (日別予定) │    │ (月次状態) │
     │ └───────────┘    └───────────┘
     │
     │ ┌────────────────┐
     ├─┤ attendance_    │  (Tier 3のみ)
     │ │ records        │
     │ └────────────────┘
     │ ┌────────────────┐
     ├─┤ usage_facts    │  (Tier 3のみ)
     │ └────────────────┘
     │ ┌────────────────┐
     └─┤ charge_lines   │  (Tier 3のみ)
       └────────────────┘

LINE連携 (Phase 2 Optional):
     ┌────────────────┐    ┌────────────────┐
     │ line_accounts  │    │ line_          │
     │                │    │ conversations  │
     └────────────────┘    └────────────────┘
```

---

## 6. 要件① 保護者スマホ入力 (Primary — Web/PWA)

### 6.1 設計方針

```
★★★ Web/PWA ポータルが Primary チャネル ★★★

Phase 1 (全30施設に即展開 — 必須):
  → Webポータル (PWA) で保護者がスマホブラウザから入力
  → 認証: マジックリンク (Email) or 連携コード + PIN
  → LINE不要、アプリダウンロード不要
  → これだけで要件①は100%充足される

Phase 2 (希望施設のみ — Optional):
  → LINE Messaging API 連携
  → AI会話ヒアリング (Web入力が難しい保護者の補助)
  → LINE_SCHEDULE_COLLECTION_PLAN.md v4.0 参照
```

### 6.2 保護者Webポータル画面設計

#### ログイン画面

```
┌─────────────────────────────────────┐
│  🏠 ○○保育所                        │
│                                      │
│  利用予定 入力ポータル                │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ メールアドレス                  │  │
│  │ [example@email.com          ]  │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ 📧 ログインリンクを送信        │  │
│  └────────────────────────────────┘  │
│                                      │
│  または                              │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ 連携コード: [AYK-    ]         │  │
│  │ PIN:        [****   ]          │  │
│  │    [🔑 ログイン]               │  │
│  └────────────────────────────────┘  │
│                                      │
│  📞 お困りの方は保育所にご連絡      │
│     ください (XXX-XXXX)              │
└─────────────────────────────────────┘
```

#### きょうだい選択画面

```
┌─────────────────────────────────────┐
│  🏠 ○○保育所         [ログアウト]   │
├─────────────────────────────────────┤
│                                      │
│  📅 利用予定入力                     │
│                                      │
│  お子さまを選択してください:         │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ 👧 ○○ちゃん (0歳児クラス)      │  │
│  │    4月の予定: 📝 未提出         │  │
│  │    [入力する →]                  │  │
│  └────────────────────────────────┘  │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ 👦 △△くん (2歳児クラス)        │  │
│  │    4月の予定: ✅ 提出済 (19日)  │  │
│  │    [確認・修正 →]               │  │
│  └────────────────────────────────┘  │
│                                      │
│  ⚠️ 4月分の締切: 3月31日まで       │
└─────────────────────────────────────┘
```

#### 予定入力画面 (メイン)

```
┌─────────────────────────────────────┐
│  ← 戻る   ○○ちゃんの予定   4月 ▼   │
├─────────────────────────────────────┤
│                                      │
│  📋 基本パターン設定                 │
│  ┌────────────────────────────────┐  │
│  │ 利用曜日: [月][火][水][木][金] │  │
│  │ 登園時間: [08:30 ▼]           │  │
│  │ 降園時間: [17:00 ▼]           │  │
│  │ 朝食: [ ]  昼食: [✓]          │  │
│  │ 朝おやつ: [✓]  午後おやつ: [✓]│  │
│  │ 夕食: [ ]                      │  │
│  │                                │  │
│  │ [📅 カレンダーに一括反映]      │  │
│  └────────────────────────────────┘  │
│                                      │
│  📅 カレンダー (タップで個別編集)    │
│  ┌──┬──┬──┬──┬──┬──┬──┐           │
│  │月│火│水│木│金│土│日│           │
│  ├──┼──┼──┼──┼──┼──┼──┤           │
│  │ 1│ 2│ 3│ 4│ 5│  │  │           │
│  │8:3│8:3│8:3│8:3│8:3│  │  │        │
│  │🍱│🍱│🍱│🍱│🍱│  │  │           │
│  ├──┼──┼──┼──┼──┼──┼──┤           │
│  │ 7│ 8│ 9│10│11│  │  │           │
│  │8:3│8:3│8:3│❌│8:3│  │  │        │
│  │🍱│🍱│🍱│休│🍱│  │  │           │
│  └──┴──┴──┴──┴──┴──┴──┘           │
│  ...                                 │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ ✅ 確認して提出 (19日分)       │  │
│  └────────────────────────────────┘  │
│                                      │
│  ⚠️ 提出期限: 3月31日まで           │
└─────────────────────────────────────┘
```

#### 確認画面

```
┌─────────────────────────────────────┐
│  ← 修正   予定の確認   ○○ちゃん     │
├─────────────────────────────────────┤
│                                      │
│  📅 2026年4月の利用予定              │
│                                      │
│  基本パターン: 月〜金 8:30-17:00     │
│  食事: 午前おやつ + 昼食 + 午後おやつ │
│                                      │
│  📋 詳細:                            │
│  ┌────────────────────────────────┐  │
│  │ 4/1(水) 8:30-17:00 🍙🍱🍪    │  │
│  │ 4/2(木) 8:30-17:00 🍙🍱🍪    │  │
│  │ 4/3(金) 8:30-17:00 🍙🍱🍪    │  │
│  │ 4/7(月) 8:30-17:00 🍙🍱🍪    │  │
│  │ ...                            │  │
│  │ 4/10(木) お休み ❌              │  │
│  │ ...                            │  │
│  │ 4/15(火) 8:30-19:00 🍙🍱🍪🍽 │  │
│  │ ...                            │  │
│  └────────────────────────────────┘  │
│                                      │
│  合計: 19日利用 / 1日お休み          │
│                                      │
│  ┌────────────────────────────────┐  │
│  │ ✅ この内容で提出する           │  │
│  └────────────────────────────────┘  │
│  ┌────────────────────────────────┐  │
│  │ ✏️ 修正する                    │  │
│  └────────────────────────────────┘  │
└─────────────────────────────────────┘
```

### 6.3 保護者ポータル技術設計

```
技術スタック:
  ├── HTML + TailwindCSS + Vanilla JS (CDN)
  ├── PWA manifest.json (ホーム画面追加対応)
  ├── Service Worker (キャッシュ: CSS/JS/画像のみ)
  ├── Hono で HTML をサーバーサイド生成
  └── API 通信は fetch (Axios不要)

認証フロー:
  1. 保護者が /p/{slug}/ にアクセス
  2. メールアドレス入力 → マジックリンク送信
  3. リンククリック → セッショントークン発行 (HttpOnly Cookie)
  4. 以降はCookieで自動認証 (30日有効)
  
  代替: 連携コード + 4桁PIN
  → 初回のみ入力、以降は Cookie

ページ構成 (SPA的にタブ切替):
  /p/{slug}/          → ログイン
  /p/{slug}/home      → 子供一覧 + 月選択 (きょうだい切替)
  /p/{slug}/schedule  → 予定入力カレンダー
  /p/{slug}/confirm   → 確認画面
  /p/{slug}/history   → 過去の提出履歴
  /p/{slug}/cancel    → 緊急欠席登録 (当月ロック中)
  /p/{slug}/statement → 利用明細 (Tier 3のみ)
```

### 6.4 パターン入力ロジック

```
入力パターン → 日別データ展開のロジック:

1. 保護者が「基本パターン」を設定:
   曜日: [月,火,水,木,金]
   登園: 08:30
   降園: 17:00
   食事: 昼食 + 午後おやつ

2. システムが対象月のカレンダーを展開:
   a. 指定曜日の全日にパターン適用
   b. 祝日を検出して⚠️マーク
   c. 食事フラグを時間帯から自動推定

3. 保護者が個別日を修正:
   a. 特定日を「お休み」に設定
   b. 特定日の時間を変更
   c. 特定日の食事を変更

4. 全営業日カバー確認 → 確認画面 → 提出
```

### 6.5 締切・ロック制御

```
対象月: 2026年4月

┌──────────────────────────────────────────────────────────┐
│                        3月                               │
│  [───────── 自由に入力・変更 ─────────]                  │
│  3/1                                   3/31 23:59        │
│                                        ↑ 変更締切        │
├──────────────────────────────────────────────────────────┤
│                        4月                               │
│  [──── ロック（欠席登録のみ例外で受付） ────]            │
│  4/1                                   4/30              │
└──────────────────────────────────────────────────────────┘

当月ロック中の例外操作:
  ✅ 欠席登録（病欠、家庭都合 etc.）  → 常に受付
  ❌ 新規日追加                        → 不可
  ❌ 時間変更                          → 不可
  ❓ 食事キャンセル                    → 施設設定で ON/OFF (確認事項 #2)
```

```typescript
// 施設ごとの締切ルール
function getDeadline(nursery: NurserySettings, targetYear: number, targetMonth: number): Date {
  const deadlineDay = nursery.schedule_rules.deadline_day;
  
  if (deadlineDay === -1) {
    // 締切なし → 無期限
    return new Date(9999, 11, 31);
  }
  
  if (deadlineDay === 0) {
    // 前月末日 (デフォルト)
    return new Date(targetYear, targetMonth - 1, 0, 23, 59, 59);
  }
  
  // 前月の指定日
  return new Date(targetYear, targetMonth - 2, deadlineDay, 23, 59, 59);
}
```

---

## 7. 要件② スタッフ共有ビュー・印刷

### 7.1 設計方針

既存のダッシュボード（v6.1）を施設別対応に拡張する。

```
既存 (あゆっこ専用):
  /api/schedules/dashboard?year=2026&month=4

マルチテナント版:
  /api/{slug}/schedules/dashboard?year=2026&month=4
  → nursery_id でフィルタリング
```

### 7.2 月間ビュー

```
┌────────────────────────────────────────────────────┐
│ ○○保育所  2026年4月   ← [前月] [翌月] →          │
├────────────────────────────────────────────────────┤
│ 日付  │ 人数 │ 昼食 │ 朝ﾊﾞ │ 午ﾊﾞ │ 夕食 │ 一時 │
│ 4/1(水)│  22  │  20  │  15  │  22  │  3   │  4   │
│ 4/2(木)│  21  │  19  │  14  │  21  │  2   │  3   │
│ ...    │ ...  │ ...  │ ...  │ ...  │ ...  │ ...  │
│ 提出状況: 28/30名 提出済 (2名未提出) [詳細→]      │
└────────────────────────────────────────────────────┘
```

### 7.3 日別詳細 (印刷用) レイアウト

```
┌────────────────────────────────────────────────────┐
│ ○○保育所 園児登園予定表  2026年4月                  │
├────────────────────────────────────────────────────┤
│                                                     │
│  日付: 4月1日(水)                                   │
│  予定人数: 22名 (月極18名 / 一時4名)                │
│                                                     │
│  ┌──────┬──────┬────────┬────────┬──┬──┬──┬──┐     │
│  │クラス│園児名│登園予定│降園予定│昼│朝│午│夕│     │
│  ├──────┼──────┼────────┼────────┼──┼──┼──┼──┤     │
│  │0歳  │○○  │ 8:30  │ 17:00 │〇│〇│〇│  │     │
│  │0歳  │△△  │ 9:00  │ 16:00 │〇│  │〇│  │     │
│  │1歳  │□□  │ 8:00  │ 18:30 │〇│〇│〇│〇│     │
│  │...   │...   │ ...    │ ...    │..│..│..│..│     │
│  ├──────┴──────┴────────┴────────┼──┼──┼──┼──┤     │
│  │ 合計                          │20│15│22│ 3│     │
│  └───────────────────────────────┴──┴──┴──┴──┘     │
│                                                     │
│  印刷日時: 2026-03-20 10:30                         │
└────────────────────────────────────────────────────┘
```

### 7.4 印刷対応CSS設計

```css
@media print {
  /* ナビゲーション非表示 */
  nav, .no-print, .sidebar { display: none !important; }
  
  /* A4横向き */
  @page { size: A4 landscape; margin: 10mm; }
  
  /* テーブル全幅 */
  .print-table { width: 100%; font-size: 10pt; }
  .print-table th, .print-table td { 
    border: 1px solid #333; padding: 2px 4px; 
  }
  
  /* ページ区切り */
  .page-break { page-break-before: always; }
}
```

---

## 8. 要件③ 大学/委託先 PDF レポート

### 8.1 標準フォーマット設計

**多くの施設で共通の標準レポート**。施設固有のテンプレートExcelは不要。

```
標準 大学提出用 PDF 構成:
  ページ1: 月次利用サマリー
    - 施設名、年月
    - 園児一覧 (氏名、年齢、利用日数、月極/一時)
    - 月間合計利用人日

  ページ2-N: 園児別利用実績
    - 園児氏名、クラス
    - 日別: 登園時間、降園時間、利用時間、食事
    - 月間合計: 利用日数、総利用時間
    - 特別保育の記録 (早朝、延長、夜間、病児)

  最終ページ: 食事提供実績
    - 日別: 昼食数、おやつ数、夕食数
    - 月間合計
```

### 8.2 PDF生成方式

```
Tier 2 (標準): 
  → jsPDF で Worker 内生成
  → 日本語フォント: Noto Sans JP (サブセット, ~500KB)
  → テンプレート: JSON定義 (report_templates テーブル)
  → 施設のロゴ・名称はカスタマイズ可能

Tier 3 (あゆっこ等):
  → 既存の Python Generator パイプラインも併用可能
  → ExcelJS でテンプレートベース生成
  → PDFへの変換は pdf-lib or jsPDF
```

### 8.3 ルクミー実績取込 → 予定と突合

```
データフロー (要件③):
  1. ルクミーCSV/Excelアップロード → attendance_records へ保存
  2. schedule_plans (予定) と attendance_records (実績) を突合
  3. usage_facts を算出 (billing_start/end, 食事フラグ, 特別保育)
  4. 一時保育: 打刻なし(病児) → スタッフ手動入力で対応 (確認事項 #4)
  5. PDF生成 → R2保存 → ダウンロード
```

---

## 9. 要件④ 経理用 Excel 出力

### 9.1 設計方針

**2施設のみ**のため、あゆっこの既存パイプライン（ExcelJS + テンプレート）を他1施設にも適用。ティアごとに ON/OFF 制御。

```
既存 (あゆっこ):
  テンプレート: あゆっこ_保育料明細.xlsx (R2保存)
  生成: ExcelJS で数量列に書き込み
  → 数式列は触らない原則

追加1施設:
  テンプレート: その施設固有のExcelテンプレートをR2にアップロード
  mapping_json でセル位置を定義
  → 既存の templates テーブル + mapping_json で対応
```

### 9.2 テンプレートマッピング汎用化

```json
{
  "billing_detail": {
    "sheet_name_pattern": "{month}月",
    "child_start_row": 5,
    "child_row_stride": 1,
    "columns": {
      "name": "K",
      "birth_date": "L",
      "age": "M",
      "enrollment_type": "N",
      "enrolled_at": "O",
      "collection_method": "Q",
      "spot_count": "T",
      "early_morning_count": "W",
      "extension_count": "Z",
      "night_count": "AC",
      "sick_count": "AF",
      "lunch_count": "AI",
      "am_snack_count": "AL",
      "pm_snack_count": "AO",
      "dinner_count": "AR"
    },
    "formula_columns": ["R","S","V","Y","AB","AE","AH","AK","AN","AQ","AT"],
    "readonly_columns": ["U","X","AA","AD","AG","AJ","AM","AP","AS"]
  }
}
```

---

## 10. 要件⑤ 保護者利用明細 (PDF)

### 10.1 設計方針

**あゆっこ1施設のみ**。保護者がスマホの保護者ポータルからPDFを閲覧・ダウンロード。

```
生成タイミング:
  月次帳票生成完了後 → 自動で保護者別PDF生成 → R2保存
  保護者がポータルにログイン → R2から取得してブラウザ表示

アクセス制御:
  /p/ayukko/statement?year=2026&month=4
  → 認証済み保護者のみ
  → 自分の子供の明細のみ表示
```

### 10.2 明細PDF内容

```
┌────────────────────────────────────┐
│  滋賀医科大学学内保育所 あゆっこ    │
│  利用明細書                         │
│                                     │
│  2026年4月分                        │
│  ○○ ○○ さま                       │
│                                     │
│  ■ ご利用実績                      │
│  利用日数: 19日                     │
│  月極保育料: ¥45,000               │
│                                     │
│  ■ 追加料金                        │
│  ┌────────────┬────┬──────┬──────┐ │
│  │ 項目        │回数│単価  │小計  │ │
│  ├────────────┼────┼──────┼──────┤ │
│  │ 延長保育    │  2 │ ¥300 │ ¥600│ │
│  │ 昼食        │ 19 │ ¥300 │¥5700│ │
│  │ 午前おやつ  │ 19 │  ¥50 │ ¥950│ │
│  │ 午後おやつ  │ 19 │ ¥100 │¥1900│ │
│  ├────────────┴────┴──────┼──────┤ │
│  │ 合計                    │¥54150│ │
│  └─────────────────────────┴──────┘ │
│                                     │
│  ■ 日別利用内訳                    │
│  (日付、登降園時間、食事の表)       │
│                                     │
│  発行日: 2026-05-05                 │
└────────────────────────────────────┘
```

### 10.3 配信方法 (確認事項 #5)

| 方式 | 説明 | Phase |
|------|------|-------|
| A. ポータル閲覧 | 保護者がログインして閲覧 | Phase 1 (デフォルト) |
| B. メール通知 | 「明細が確認できます」リンク送信 | Phase 1 (推奨) |
| C. LINE Push | LINE で通知 → ポータルへ遷移 | Phase 2 (LINE有効化時) |

---

## 11. 認証・認可アーキテクチャ

### 11.1 認証方式一覧

| 利用者 | 方式 | 詳細 |
|--------|------|------|
| **保護者 (Primary)** | **マジックリンク (Email)** | **パスワード不要、メール認証** |
| 保護者 (代替) | 連携コード + PIN | メール未登録の場合 |
| 保護者 (Phase 2) | LINE Login | LINE連携施設のみ |
| スタッフ | Email + パスワード | 標準認証 |
| スタッフ (強化) | + TOTP | 管理者ロール以上 |
| スーパー管理者 | Email + パスワード + TOTP | 全施設管理者 |

### 11.2 ロール定義

```
super_admin:  全施設を管理。施設の追加・削除・設定変更。
owner:        自施設の全機能。スタッフアカウント管理。
admin:        自施設の管理機能。園児・保護者管理。帳票生成。
staff:        自施設の閲覧+予定入力代行。ダッシュボード。
viewer:       自施設の閲覧のみ。
parent:       自分の子供の予定入力・明細閲覧。
```

### 11.3 認可マトリックス

| 操作 | super_admin | owner | admin | staff | viewer | parent |
|------|------------|-------|-------|-------|--------|--------|
| 施設追加 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 施設設定変更 | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| スタッフ管理 | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| 園児管理 | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| 保護者管理 | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| ダッシュボード | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ |
| 予定入力 (代行) | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| 帳票生成 | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| 自分の子の予定入力 | - | - | - | - | - | ✅ |
| 利用明細閲覧 | - | - | - | - | - | ✅ |

### 11.4 セッション設計

```typescript
// セッショントークン方式 (HttpOnly Cookie)
// JWT は Cloudflare Workers の 10ms制限内で検証負荷が懸念されるため
// ランダムトークン + DB lookup を採用

interface Session {
  token: string;        // 32バイトランダム (hex)
  account_type: 'staff' | 'parent' | 'admin';
  account_id: string;
  nursery_id: string;
  role: string;
  expires_at: Date;
}

// Cookie 設定
Set-Cookie: session={token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000
```

---

## 12. LINE連携 (Phase 2 — Optional)

### 12.1 方針

```
★★★ LINE は Phase 2 の Optional 追加チャネル ★★★

Phase 1 (Webポータルのみ — 必須):
  → LINE連携なし
  → 全施設が Web ポータルで保護者入力
  → 要件①は100%充足
  
Phase 2 (LINE連携 — 希望施設のみ):
  → Webでの入力が難しいと感じる保護者への補助手段
  → AI会話ヒアリングで同じ schedule_plans データを収集
  → 詳細は LINE_SCHEDULE_COLLECTION_PLAN.md v4.0 参照

LINE の役割:
  × 必須の入力チャネル
  ○ Web ポータルの補助チャネル（使いたい園だけ有効化）
```

### 12.2 LINE の位置付け

```
保護者の入力チャネル:
  [Primary]   Web/PWA ポータル   → 全30施設 (必須)    → source_file='WEB'
  [Optional]  LINE AI ヒアリング → 希望施設のみ (任意) → source_file='LINE'
  [Backup]    スタッフ代行入力   → 全施設 (既存実装)   → source_file='UI入力'
```

### 12.3 LINE連携テーブルの変更 (Phase 2用)

```sql
-- Phase 2 実装時に適用
-- line_accounts に nursery_id 追加
ALTER TABLE line_accounts ADD COLUMN nursery_id TEXT REFERENCES nurseries(id);

-- line_conversations に nursery_id 追加
ALTER TABLE line_conversations ADD COLUMN nursery_id TEXT REFERENCES nurseries(id);
```

### 12.4 LINE連携の詳細設計

→ **LINE_SCHEDULE_COLLECTION_PLAN.md v4.0** を参照

---

## 13. DB マイグレーション計画

### 13.1 マイグレーションファイル一覧

```
migrations/
├── 0001_initial_schema.sql          (既存: あゆっこ基盤)
├── 0002_line_integration.sql        (Phase 2: LINE連携テーブル)
├── 0003_multi_tenant.sql            (Phase 1: マルチテナント化)
├── 0004_auth_system.sql             (Phase 1: 認証テーブル)
├── 0005_schedule_submissions.sql    (Phase 1: 提出状態管理)
├── 0006_report_templates.sql        (Phase 2A: 標準レポートテンプレ)
└── 0007_add_breakfast_flag.sql      (確認後: 朝食フラグ)
```

### 13.2 0003_multi_tenant.sql

```sql
-- ================================================================
-- migrations/0003_multi_tenant.sql
-- Purpose: マルチテナント対応 (nurseries テーブル拡張)
-- Depends: 0001_initial_schema.sql
-- ================================================================

ALTER TABLE nurseries ADD COLUMN slug TEXT;
ALTER TABLE nurseries ADD COLUMN is_active INTEGER DEFAULT 1;
ALTER TABLE nurseries ADD COLUMN tier TEXT DEFAULT 'basic';
ALTER TABLE nurseries ADD COLUMN contact_json TEXT DEFAULT '{}';

UPDATE nurseries 
SET slug = 'ayukko', 
    tier = 'premium',
    settings_json = json_set(
      COALESCE(settings_json, '{}'),
      '$.tier', 'premium',
      '$.features.parent_portal', 1,
      '$.features.line_integration', 0,
      '$.features.university_pdf', 1,
      '$.features.accounting_excel', 1,
      '$.features.parent_statement_pdf', 1,
      '$.features.lukumi_integration', 1,
      '$.features.python_generator', 1,
      '$.features.auto_pricing', 1
    )
WHERE id = 'ayukko_001';

CREATE UNIQUE INDEX IF NOT EXISTS idx_nurseries_slug ON nurseries(slug);
```

### 13.3 0004_auth_system.sql

(セクション5.2の全SQL — 省略なし)

### 13.4 0005_schedule_submissions.sql

(セクション5.3の全SQL — 省略なし)

### 13.5 0006_report_templates.sql

(セクション5.4の全SQL — 省略なし)

---

## 14. API 設計 (マルチテナント対応)

### 14.1 API エンドポイント一覧

#### 認証 API

| Method | Path | 説明 | 認証 |
|--------|------|------|------|
| POST | `/api/auth/staff/login` | スタッフログイン | 不要 |
| POST | `/api/auth/parent/magic-link` | マジックリンク送信 | 不要 |
| GET | `/api/auth/parent/verify/:token` | マジックリンク検証 | 不要 |
| POST | `/api/auth/parent/code-login` | 連携コード+PINログイン | 不要 |
| POST | `/api/auth/logout` | ログアウト | 要 |
| GET | `/api/auth/me` | 現在のユーザー情報 | 要 |

#### 施設管理 API (super_admin)

| Method | Path | 説明 |
|--------|------|------|
| GET | `/api/admin/nurseries` | 全施設一覧 |
| POST | `/api/admin/nurseries` | 施設追加 |
| PUT | `/api/admin/nurseries/:id` | 施設設定変更 |
| GET | `/api/admin/stats` | 全施設統計 |

#### テナント API (施設別)

| Method | Path | 説明 | 最低ロール |
|--------|------|------|-----------|
| GET | `/api/:slug/children` | 園児一覧 | staff |
| POST | `/api/:slug/children` | 園児追加 | admin |
| PUT | `/api/:slug/children/:id` | 園児更新 | admin |
| GET | `/api/:slug/schedules` | 予定一覧 | staff |
| POST | `/api/:slug/schedules` | 予定登録 | staff/parent |
| GET | `/api/:slug/schedules/dashboard` | ダッシュボード | staff |
| GET | `/api/:slug/schedules/submissions` | 提出状態一覧 | staff |
| GET | `/api/:slug/reports/university` | 大学提出PDF生成 | admin |
| GET | `/api/:slug/reports/daily/:date` | 日報PDF生成 | staff |
| GET | `/api/:slug/staff` | スタッフ一覧 | owner |
| POST | `/api/:slug/staff` | スタッフ追加 | owner |
| GET | `/api/:slug/parents` | 保護者一覧 | admin |
| POST | `/api/:slug/parents` | 保護者追加 | admin |
| POST | `/api/:slug/parents/:id/link-code` | 連携コード発行 | admin |

#### 保護者 API (★ Primary — Web/PWA ポータル)

| Method | Path | 説明 |
|--------|------|------|
| GET | `/api/:slug/parent/children` | 自分の子供一覧 (きょうだい一覧) |
| GET | `/api/:slug/parent/schedule/:childId` | 予定取得 |
| POST | `/api/:slug/parent/schedule/:childId` | 予定入力 |
| PUT | `/api/:slug/parent/schedule/:childId` | 予定修正 |
| POST | `/api/:slug/parent/schedule/:childId/submit` | 予定提出 |
| POST | `/api/:slug/parent/schedule/:childId/cancel` | 緊急欠席登録 |
| GET | `/api/:slug/parent/statement/:childId` | 利用明細取得 (Tier 3) |

### 14.2 テナント分離ミドルウェア設計

```typescript
// 概念設計のみ (コード実装はしない)

// 1. slug → nursery_id 解決
app.use('/api/:slug/*', async (c, next) => {
  const slug = c.req.param('slug');
  const nursery = await resolveNursery(slug, c.env.DB);
  c.set('nursery', nursery);
  await next();
});

// 2. 認証ミドルウェア
app.use('/api/:slug/*', async (c, next) => {
  const token = getCookie(c, 'session');
  if (!token) return c.json({ error: 'Unauthorized' }, 401);
  
  const session = await validateSession(token, c.env.DB);
  if (!session) return c.json({ error: 'Session expired' }, 401);
  
  // テナント分離: セッションの nursery_id と URL の nursery が一致するか
  const nursery = c.get('nursery');
  if (session.nursery_id !== nursery.id && session.role !== 'super_admin') {
    return c.json({ error: 'Forbidden' }, 403);
  }
  
  c.set('session', session);
  await next();
});
```

---

## 15. 施設オンボーディングフロー

### 15.1 新規施設追加手順

```
Step 1: スーパー管理者が施設を登録
  → /admin/nurseries → 「施設追加」
  → 必要情報: 施設名, slug, tier, 連絡先, 開園時間, 食事種類等
  → nurseries テーブルに INSERT

Step 2: オーナーアカウント作成
  → 施設の管理者(オーナー)のメールアドレスを登録
  → 初回ログインリンクを送信
  → staff_accounts に INSERT (role='owner')

Step 3: オーナーが初期設定
  → 園児マスタ登録 (CSV一括 or 個別入力)
  → 保護者アカウント作成 + 連携コード発行
  → スタッフアカウント追加 (必要に応じて)

Step 4: 保護者に案内
  → 連携コード + ポータルURL を配布 (紙 or メール)
  → QRコードでポータルに直接アクセス可能
  → 初回ログイン → 以降はCookieで自動認証

Step 5: 運用開始
  → 保護者が翌月の予定を入力 (Web/PWA)
  → スタッフがダッシュボードで確認
  → 月次帳票生成 (Tier 2以上)
```

### 15.2 QRコード設計

```
各施設ごとのQRコード:
  URL: https://hoikuen.pages.dev/p/{slug}/
  用途: 保護者への配布物に印刷

各児童ごとの連携QRコード:
  URL: https://hoikuen.pages.dev/p/{slug}/link?code={AYK-XXXX}
  用途: 連携コード入力を省略してワンタップ連携
```

### 15.3 園児CSV一括登録

```csv
name,name_kana,birth_date,enrollment_type,child_order,is_allergy,parent_name,parent_email
田中太郎,タナカタロウ,2023-06-15,月極,1,0,田中花子,hanako@example.com
田中次郎,タナカジロウ,2025-01-20,月極,2,0,田中花子,hanako@example.com
山田桜,ヤマダサクラ,2024-03-01,一時,1,1,山田由美,yumi@example.com
```

---

## 16. コスト見積 (30施設規模)

### 16.1 Cloudflare Workers / D1

| 項目 | Free Plan上限 | 30施設想定 | 有料プラン |
|------|-------------|-----------|-----------|
| Workers requests | 100,000/日 | ~3,000/日 | 不要 |
| D1 reads | 5M/日 | ~15,000/日 | 不要 |
| D1 writes | 100K/日 | ~3,000/日 | 不要 |
| D1 storage | 5GB | ~500MB | 不要 |
| R2 storage | 10GB/月 | ~2GB | 不要 |
| R2 operations | 10M reads/月 | ~10K/月 | 不要 |

**結論**: 30施設規模ではFree Planで十分。

### 16.2 月額合計見積

| 項目 | Phase 1 (Web のみ) | Phase 2 (+ LINE) |
|------|-------------------|------------------|
| Cloudflare | ¥0 | ¥0 |
| LINE (希望施設のみ) | ¥0 | ~¥5,000 |
| OpenAI (LINE AIヒアリング) | ¥0 | ~¥600 |
| メール送信 (マジックリンク) | ¥0 (Resend free 100通/日) | ¥0 |
| **合計** | **¥0/月** | **~¥5,600/月** |

---

## 17. 実装ロードマップ

### 17.1 Phase 分割

```
Phase 0: 基盤整備 (1-2週)
  ├── DB マイグレーション (0003, 0004, 0005)
  ├── マルチテナントミドルウェア
  ├── 認証基盤 (セッション, マジックリンク)
  └── 既存あゆっこ機能の nursery_id 対応

Phase 1A: 保護者 Web ポータル MVP (2-3週) ← ★★★ 最優先
  ├── 保護者ログイン (マジックリンク)
  ├── きょうだい選択画面
  ├── 予定入力カレンダー (パターン入力)
  ├── 確認画面 + 提出
  ├── 締切管理 + ロック + 緊急欠席
  └── 1施設 (あゆっこ) でパイロット

Phase 1B: スタッフ管理画面 マルチテナント化 (1-2週)
  ├── 施設別ダッシュボード
  ├── 提出状態管理
  ├── 印刷用レイアウト (PDF/A4)
  └── 園児・保護者管理

Phase 2A: 標準帳票 (2-3週)
  ├── 大学提出用 PDF (③)
  ├── 日報 PDF
  ├── テンプレート管理 (0006)
  └── Tier 2 施設に展開

Phase 2B: あゆっこ固有機能 (1-2週)
  ├── 経理用 Excel (④)
  ├── 保護者利用明細 PDF (⑤)
  └── 既存 Python Generator 統合

Phase 3: LINE連携 (4-6週) ← Optional
  ├── LINE_SCHEDULE_COLLECTION_PLAN.md v4.0
  ├── Webhook + アカウント連携
  ├── AI会話エンジン
  └── 希望施設にのみ展開

Phase 4: 横展開 (随時)
  ├── 30施設のオンボーディング
  ├── 施設固有カスタマイズ
  └── 運用安定化
```

### 17.2 依存関係グラフ

```
Phase 0 (基盤)
  ├─────► Phase 1A (保護者ポータル) ─┬─► Phase 2A (標準帳票)
  │       ★★★ 最優先               │
  ├─────► Phase 1B (スタッフ管理)  ───┤
  │                                   │
  │                                   ├─► Phase 2B (あゆっこ固有)
  │                                   │
  │                                   └─► Phase 4 (横展開)
  │
  └─────────────────────────────────────► Phase 3 (LINE — Optional)
```

### 17.3 MVP 定義

**Phase 1A MVP (最小限の保護者入力):**
- ✅ 保護者がスマホでログイン（マジックリンク）
- ✅ きょうだい選択画面（複数児童切替）
- ✅ 1児童、1ヶ月分の予定入力（カレンダーUI）
- ✅ パターン一括入力（曜日 + デフォルト時間 + 食事）
- ✅ 個別日の修正（休み、時間変更、食事変更）
- ✅ 確認画面 → 提出 → schedule_plans に保存 (source_file='WEB')
- ✅ 既存ダッシュボードに保護者入力分が即反映
- ✅ 締切ロック + 緊急欠席登録
- ❌ オフラインキャッシュ (将来)

---

## 18. 既存あゆっこシステムからの移行計画

### 18.1 基本方針

```
1. 既存のテーブル・データは一切削除しない
2. 新テーブルの追加と既存テーブルのカラム追加のみ
3. 既存のAPI (/api/schedules, /api/children 等) は当面維持
4. 新API (/api/{slug}/...) を並行追加
5. あゆっこは nursery_id = 'ayukko_001', slug = 'ayukko' で参照
6. 移行完了後、旧APIは deprecated として段階的に廃止
```

### 18.2 データ移行

```sql
-- 既存データの nursery_id は全て 'ayukko_001' なので変更不要
UPDATE nurseries SET slug = 'ayukko', tier = 'premium' WHERE id = 'ayukko_001';

-- 既存園児データの nursery_id は既に 'ayukko_001'
-- → 追加作業なし

-- 既存 schedule_plans には submitted_by, submitted_at が NULL
-- → 新規入力分から適用
```

### 18.3 URL マッピング

```
既存URL (当面維持):
  / (メインUI)
  /api/schedules
  /api/children

新URL (段階的に追加):
  /p/ayukko/          (保護者ポータル — Primary)
  /s/ayukko/          (スタッフ管理画面)
  /api/ayukko/...     (テナントAPI)
  /admin/             (全施設管理)
```

---

## 19. 次回ミーティング確認事項 (6項目)

> **次回の木村さんミーティングで確認・決定が必要な事項**

### 確認事項 #1: マジックリンク認証の実現可能性

```
問題: マジックリンクは保護者のメールアドレスが必要。
      全保護者のメールアドレスが利用可能か？

確認内容:
  a. 保護者のメールアドレスは園で把握しているか？
  b. メール受信環境（キャリアメール/Gmail等）は問題ないか？
  c. メール以外の代替手段（SMS、連携コード+PIN）の需要は？

決定者: 木村さん
優先度: ★★★ (Phase 1A 開始前に必須)
```

### 確認事項 #2: 当月ロック後の例外操作範囲

```
問題: 当月ロック後に受け付ける例外操作の範囲を確定する。

選択肢:
  A. 欠席のみ受付（推奨デフォルト）
     → 「今日/明日休みます」のみ可能
     → 食事キャンセルは不可（スタッフが代行対応）

  B. 欠席 + 食事キャンセルも受付
     → 「今日はお弁当持参なので昼食キャンセル」も可能
     → 施設によってニーズが異なる可能性

  C. 施設ごとに設定可能 (settings_json で制御)
     → emergency_cancel_scope: "absence_only" | "absence_and_meal"

決定者: 木村さん
優先度: ★★☆ (Phase 1A 実装中に確定)
```

### 確認事項 #3: 午前おやつ・午後おやつの統一的な扱い

```
問題: 
  紙予定表: 「おやつ」1列（am/pm 区別なし）
  DB:        am_snack_flag + pm_snack_flag（2列）
  保育料案内: 午前おやつ 50円、午後おやつ 100円（別料金）
  
  また、朝食（150円）をDBスキーマに追加するかも未決。

確認内容:
  a. 保護者向けUIで am/pm を分けて入力させるか、統合1チェックにするか？
  b. 朝食 (breakfast_flag) は全施設で必要か？あゆっこのみか？
  c. 朝食チェックボックスをUIに追加する場合、どの施設で有効にするか？

決定者: 木村さん
優先度: ★★☆ (Phase 1A UIデザイン確定前)
```

### 確認事項 #4: 施設固有レポートテンプレートの扱い

```
問題: 要件③の大学提出PDFに施設固有のフォーマットがあるか。

確認内容:
  a. 大学提出フォーマットは全施設で統一？施設ごとに異なる？
  b. 統一の場合、標準フォーマットのサンプルを入手可能か？
  c. 施設固有の場合、各施設のテンプレートをどう収集するか？

決定者: 木村さん
優先度: ★☆☆ (Phase 2A 開始前に確定)
```

### 確認事項 #5: 保護者明細のアクセス方法 vs 通知方法

```
問題: 要件⑤の保護者利用明細PDFの配信方法。

選択肢:
  A. ポータルにログインして自分で閲覧（受動的）
  B. メールで「明細が確認できます」通知 + リンク（能動的通知）
  C. (Phase 2) LINE Push で通知
  D. A + B 併用（推奨）

決定者: 木村さん
優先度: ★☆☆ (Phase 2B で実装)
```

### 確認事項 #6: 30施設の仮 Basic/Standard/Premium 分類

```
問題: 実装の優先順位を決めるために、施設ティアの概算が必要。

確認内容:
  a. 30施設のうち、大学提出PDFが必要な施設は何施設？（→ Standard）
  b. 経理Excel・保護者明細が必要な施設はあゆっこ以外にあるか？（→ Premium）
  c. パイロット施設（Phase 1A で最初に展開する施設）はどこか？
  d. 施設名リストと優先順位

決定者: 木村さん
優先度: ★★★ (Phase 0 開始前に概算が必要)
```

---

## 20. リスクと未決事項

### 20.1 リスク

| # | リスク | 影響度 | 緩和策 |
|---|--------|--------|--------|
| 1 | D1の行数制限 (30施設 × 66園児 × 31日 ≈ 60K行/月) | 低 | D1は5GB上限、年間でも~1M行程度 |
| 2 | Worker CPU制限 (10ms free) でPDF生成が間に合わない | 中 | Paid plan (30ms) or バッチ分割 |
| 3 | マジックリンクのメール到達率 | 中 | Resend + SPF/DKIM設定、代替に連携コード+PIN |
| 4 | 30施設の同時オンボーディング | 中 | 5施設ずつ段階的にオンボーディング |
| 5 | 施設固有のカスタマイズ要望増加 | 高 | settings_json で吸収、個別対応は有償 |
| 6 | 保護者のITリテラシー格差 | 中 | シンプルUI + 紙の説明書 + 電話サポート |

### 20.2 未決事項

| # | 項目 | 決定者 | 期限 | 関連確認事項 |
|---|------|--------|------|-------------|
| 1 | 30施設の施設名リストと優先順位 | 木村さん | Phase 0 開始前 | 確認 #6 |
| 2 | 各施設の Tier 分類 | 木村さん | Phase 0 開始前 | 確認 #6 |
| 3 | マジックリンク用のメール利用可否 | 木村さん | Phase 1A 開始前 | 確認 #1 |
| 4 | 当月ロック例外の範囲 | 木村さん | Phase 1A 実装中 | 確認 #2 |
| 5 | おやつの統一扱い + breakfast_flag | 木村さん | Phase 1A UI確定前 | 確認 #3 |
| 6 | 大学提出フォーマットのサンプル入手 | 木村さん | Phase 2A 開始前 | 確認 #4 |
| 7 | 保護者明細の配信方法 | 木村さん | Phase 2B 実装前 | 確認 #5 |
| 8 | LINE公式アカウントの方針 (共有 or 施設別) | 木村さん | Phase 3 開始前 | - |
| 9 | seed.sql の time_boundaries 不整合修正 | 開発チーム | Phase 0 | - |
| 10 | カスタムドメインの要否 | 木村さん | Phase 4 | - |
| 11 | 保護者への案内方法 (紙配布 or メール) | 木村さん | Phase 1A パイロット前 | - |

---

## 21. 付録

### 21.1 既存システムとの変更サマリー

| 変更対象 | v6.1 (現在) | マルチテナント版 | 影響 |
|----------|------------|----------------|------|
| nurseries テーブル | name, settings_json | + slug, tier, is_active, contact_json | 低 |
| children テーブル | nursery_id あり | 変更なし | なし |
| schedule_plans テーブル | source_file | + submitted_by, submitted_at | 低 |
| API ルーティング | /api/xxx | /api/:slug/xxx (並行) | 低 |
| 認証 | なし | セッション + ロール | 新規 |
| UI | 1施設専用 | 施設切替 + 保護者ポータル | 新規 |
| 帳票生成 | Python Generator | + jsPDF 標準テンプレート | 追加 |

### 21.2 技術スタック (全体像)

```
Frontend:
  ├── 保護者ポータル (Primary): HTML + TailwindCSS + Vanilla JS (PWA)
  ├── スタッフ管理画面: HTML + TailwindCSS + Vanilla JS (既存拡張)
  └── 全施設管理画面: HTML + TailwindCSS + Vanilla JS

Backend:
  ├── Hono (Cloudflare Workers)
  ├── D1 (SQLite) — マルチテナント共有DB
  ├── R2 (Object Storage) — テンプレ・生成物
  ├── Cloudflare Secrets — API keys, tokens
  └── Python Generator (Tier 3 施設のみ)

外部サービス:
  ├── Resend (マジックリンクメール送信 — Phase 1)
  ├── @holiday-jp/holiday_jp (祝日判定 — Phase 1)
  ├── LINE Messaging API (Phase 2 — Optional)
  └── OpenAI API (Phase 2 — Optional)
```

### 21.3 用語集

| 用語 | 説明 |
|------|------|
| テナント | 1つの保育施設 = nurseries テーブルの1行 |
| slug | 施設の短縮ID (URL用)。例: ayukko, sakura |
| Tier | 施設の機能レベル (basic/standard/premium) |
| **保護者ポータル (Primary)** | **保護者がスマホでアクセスするWeb/PWA予定入力画面** |
| マジックリンク | パスワード不要のメール認証方式 |
| 連携コード | 保護者⇔児童を紐付ける使い捨てコード (AYK-XXXX) |
| 提出状態 | draft → submitted → confirmed → locked の遷移 |
| schedule_submissions | 月次の提出状態を管理するテーブル |
| LINE (Phase 2 Add-on) | 希望施設のみの追加入力チャネル |

---

## 変更履歴

| バージョン | 日付 | 内容 |
|-----------|------|------|
| 1.0 | 2026-03-04 | 初版作成。5要件の整理、施設ティア分類、マルチテナントDB設計、保護者Webポータル設計、認証アーキテクチャ、APIリファクタリング計画、コスト見積、ロードマップ |
| **2.0** | **2026-03-04** | **★★★ 大幅更新: Web/PWA を Primary チャネルとして明確宣言、LINE を Phase 2 Optional に格下げ。要件①〜⑤の詳細仕様を大幅拡充（食事5種、きょうだい切替、ロック例外範囲、緊急欠席登録）。次回ミーティング6確認事項を新設（セクション19）。ティアにLINE Add-onを追加。ロードマップのPhase 3(LINE)をOptionalとして明記。** |

---

*この文書は設計計画のみです。実装コードは含まれていません。*
*実装着手前に、セクション19の6つの確認事項と、セクション20.2の未決事項の解消が必要です。*
*LINE連携の詳細は LINE_SCHEDULE_COLLECTION_PLAN.md v4.0 を参照。*

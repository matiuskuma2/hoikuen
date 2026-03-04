# マルチ施設展開 設計書 — 保育園業務自動化プラットフォーム

> **Version**: 1.0 (2026-03-04)
> **Status**: Design Only (実装前)
> **Author**: Ayukko Automation Team
> **Reviewed by**: モギモギ（関屋紘之）
> **Origin**: 木村さんヒアリング 2026-03-04 — 5つの要件整理
> **Parent System**: 滋賀医科大学学内保育所 あゆっこ 業務自動化システム v6.1

---

## 目次

1. [エグゼクティブサマリー](#1-エグゼクティブサマリー)
2. [要件の5階層と適用範囲](#2-要件の5階層と適用範囲)
3. [現状アーキテクチャと課題](#3-現状アーキテクチャと課題)
4. [マルチ施設アーキテクチャ設計](#4-マルチ施設アーキテクチャ設計)
5. [要件①: 保護者スマートフォン入力](#5-要件-保護者スマートフォン入力)
6. [要件②: スタッフ共有ビュー](#6-要件-スタッフ共有ビュー)
7. [要件③: 大学提出用帳票PDF](#7-要件-大学提出用帳票pdf)
8. [要件④: 経理向けExcel出力](#8-要件-経理向けexcel出力)
9. [要件⑤: 保護者向け利用明細](#9-要件-保護者向け利用明細)
10. [データベース拡張設計](#10-データベース拡張設計)
11. [認証・マルチテナント設計](#11-認証マルチテナント設計)
12. [LINE連携のマルチ施設拡張](#12-line連携のマルチ施設拡張)
13. [施設オンボーディングフロー](#13-施設オンボーディングフロー)
14. [コスト・スケーラビリティ分析](#14-コストスケーラビリティ分析)
15. [段階的実装ロードマップ](#15-段階的実装ロードマップ)
16. [リスクと制約](#16-リスクと制約)

---

## 1. エグゼクティブサマリー

### 1.1 背景

木村さんからのヒアリング（2026-03-04）で、あゆっこ保育所向けに開発中のシステムを**約30の委託保育施設**に展開するビジョンが示された。各要件の適用範囲に差異があり、段階的なマルチ施設対応が必要。

### 1.2 5つの要件と適用範囲

| # | 要件 | 適用施設数 | 優先度 |
|---|------|-----------|--------|
| ① | 保護者がスマホで月次予定を直接入力（紙廃止） | **全30施設** | ★★★ 最高 |
| ② | スタッフが園児予定を共有閲覧（日報ビュー + 印刷） | **全30施設** | ★★★ 最高 |
| ③ | 大学提出用PDF（児童利用実績、特別保育、食事記録） | **大半の施設**（標準フォーマット） | ★★ 高 |
| ④ | 経理向け保育料明細Excel | **2施設のみ** | ★ 中 |
| ⑤ | 保護者スマホで利用明細PDF閲覧 | **あゆっこのみ** | ★ 中 |

### 1.3 設計原則

```
■ 原則1: 「コア共通、カスタム最小」
  → ①②は全施設共通のコア機能
  → ③④⑤は施設ごとにON/OFFできるプラグイン

■ 原則2: 「テナント分離、データ安全」
  → nursery_id による論理テナント分離
  → 施設Aのデータに施設Bの管理者はアクセス不可
  → 保護者は自分の子のみ閲覧可能

■ 原則3: 「あゆっこファースト」
  → まずあゆっこで全機能を完成・検証
  → 他施設には段階的に展開（共通機能から先に）

■ 原則4: 「LINEは入口、Webはバックオフィス」
  → 保護者の予定入力 = LINE（メイン）+ Webポータル（補助）
  → スタッフの管理 = Webダッシュボード
  → 保護者の明細閲覧 = LINEリッチメニュー + Webリンク

■ 原則5: 「施設固有設定はJSONで柔軟に」
  → 料金体系、開園時間、帳票テンプレート等は施設ごとに設定
  → 新施設追加はDB操作のみ、コード変更不要
```

---

## 2. 要件の5階層と適用範囲

### 2.1 要件マッピング (木村さん原文 → 設計)

```
木村さん原文 → 設計での機能名 → 適用範囲
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

① "保護者がスマホで月次利用予定を入力"
   → Parent Schedule Input (LINE + Web)
   → 全30施設

② "スタッフが日報(園児予定)を共有閲覧＋印刷"
   → Staff Dashboard (Web)
   → 全30施設

③ "大学提出用PDF(一時保育時間・特別保育・食事)"
   → University Report PDF Generator
   → 大半の施設（標準フォーマット準拠）

④ "経理向け保育料明細Excel"
   → Billing Detail Excel Generator
   → 2施設のみ

⑤ "保護者向け利用明細PDF(スマホ閲覧)"
   → Parent Statement PDF (LINE配信)
   → あゆっこのみ
```

### 2.2 機能レイヤー図

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer 3: 施設固有機能 (Config-driven)                            │
│ ┌──────────────┐  ┌──────────────┐  ┌──────────────┐            │
│ │ ④ 経理Excel   │  │ ⑤ 保護者明細  │  │ ③ 大学PDF     │            │
│ │ 2施設         │  │ あゆっこのみ  │  │ 大半の施設    │            │
│ └──────────────┘  └──────────────┘  └──────────────┘            │
├─────────────────────────────────────────────────────────────────┤
│ Layer 2: 共通コア機能 (全施設)                                    │
│ ┌──────────────────────┐  ┌──────────────────────┐              │
│ │ ① 保護者スマホ入力     │  │ ② スタッフ共有ビュー   │              │
│ │   LINE + Web Portal   │  │   Web Dashboard      │              │
│ └──────────────────────┘  └──────────────────────┘              │
├─────────────────────────────────────────────────────────────────┤
│ Layer 1: プラットフォーム基盤                                      │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────────┐│
│ │ 認証/認可  │ │ テナント  │ │ DB/Storage│ │ LINE/OpenAI統合基盤  ││
│ │ (JWT)     │ │ (nursery │ │ (D1/R2)  │ │                     ││
│ │           │ │  _id)    │ │          │ │                     ││
│ └──────────┘ └──────────┘ └──────────┘ └──────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. 現状アーキテクチャと課題

### 3.1 現行システムの設計前提

現在のあゆっこシステムは**シングルテナント設計**:

| 項目 | 現状 | マルチ施設での課題 |
|------|------|------------------|
| `nurseries` テーブル | あゆっこ1園 (`ayukko_001`) | 30園分の登録が必要 |
| `children` テーブル | `nursery_id` FK あり | ✅ テナント分離の基盤はある |
| `pricing_rules` | あゆっこ固有の料金体系 | 施設ごとに異なる料金設定 |
| `templates` | あゆっこ固有の帳票テンプレ | 施設ごとのテンプレ管理 |
| 認証 | なし (全画面公開) | 施設別アクセス制御が必須 |
| LINE連携 | 1公式アカウント想定 | 複数アカウント or 1アカウント+施設選択 |
| ダッシュボード | 全園児表示 | 施設別フィルタリング |

### 3.2 マルチ施設対応に必要な変更

```
変更レベル: 🟢 小 / 🟡 中 / 🔴 大

🟢 DB: nurseries テーブルに施設を追加するだけ
🟢 DB: 既存テーブルは nursery_id FK を持っているので構造変更不要
🟡 API: 全APIに nursery_id スコープフィルタ追加
🟡 認証: JWT + Role-Based Access Control 導入
🟡 LINE: 施設別LINEアカウント or 施設選択フロー
🟡 UI: 施設選択 + 施設別ダッシュボード
🔴 帳票: 施設ごとのテンプレート・料金体系対応
🔴 保護者ポータル: 新規開発（Web + LINE Rich Menu連携）
```

---

## 4. マルチ施設アーキテクチャ設計

### 4.1 全体アーキテクチャ

```
┌─────────────────────────────────────────────────────────────────┐
│                       保護者層                                    │
│                                                                   │
│   ┌───────────┐  ┌───────────┐  ┌───────────┐                    │
│   │ LINE App  │  │ Web Portal│  │ PDF Viewer │                    │
│   │ (予定入力)  │  │ (予定入力)  │  │ (明細閲覧)  │                    │
│   └─────┬─────┘  └─────┬─────┘  └─────┬─────┘                    │
├─────────┼───────────────┼───────────────┼─────────────────────────┤
│         │               │               │          スタッフ層       │
│         │               │               │                          │
│         │     ┌─────────────────────┐   │    ┌──────────────────┐  │
│         │     │ Staff Dashboard     │   │    │ Super Admin      │  │
│         │     │ (施設別ダッシュボード)  │   │    │ (全施設管理)      │  │
│         │     └─────────┬───────────┘   │    └────────┬─────────┘  │
├─────────┼───────────────┼───────────────┼────────────┼─────────────┤
│                         │                                          │
│   ┌─────────────────────▼──────────────────────────────────────┐   │
│   │                  Cloudflare Workers/Pages                   │   │
│   │                                                             │   │
│   │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌──────────────┐  │   │
│   │  │ Auth    │  │ LINE    │  │ Schedule │  │ Report       │  │   │
│   │  │ Module  │  │ Webhook │  │ API      │  │ Generator    │  │   │
│   │  │         │  │ Handler │  │          │  │              │  │   │
│   │  └────┬────┘  └────┬────┘  └────┬────┘  └──────┬───────┘  │   │
│   │       │            │            │               │          │   │
│   │  ┌────▼────────────▼────────────▼───────────────▼────────┐ │   │
│   │  │              Tenant Router (nursery_id scope)          │ │   │
│   │  └────────────────────────┬────────────────────────────── │ │   │
│   │                           │                                │   │
│   │  ┌────────────────────────▼──────────────────────────────┐ │   │
│   │  │     D1 Database           │     R2 Storage            │ │   │
│   │  │ (全施設共有、論理分離)       │ (テンプレ/帳票/PDF)        │ │   │
│   │  └───────────────────────────┴───────────────────────────┘ │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│   ┌──────────────┐  ┌──────────────┐                                │
│   │ LINE Platform │  │ OpenAI API   │                                │
│   └──────────────┘  └──────────────┘                                │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 テナント分離戦略

**選択: 論理テナント分離 (共有DB + nursery_id フィルタ)**

| 戦略 | メリット | デメリット | 採用 |
|------|---------|----------|------|
| DB分離 (施設ごとにDB) | 完全分離 | D1の数制限、管理複雑 | ❌ |
| 論理分離 (nursery_id FK) | 管理容易、コスト低 | SQLインジェクションリスク | ✅ |
| ハイブリッド | バランス | 複雑 | 将来検討 |

**理由**: 
- Cloudflare D1は1プロジェクトあたりのDB数に制限がある
- 30施設分のDBを個別管理するのは運用負荷が大きい
- `nursery_id` FKが既に全テーブルに存在（children, pricing_rules, templates等）
- APIミドルウェアで強制フィルタリングすれば安全

### 4.3 テナントスコープミドルウェア設計

```typescript
// src/middleware/tenant-scope.ts

import { Hono } from 'hono';

/**
 * 全APIリクエストに nursery_id スコープを強制付与
 * - JWT内のnursery_idを取得
 * - 全DBクエリにWHERE nursery_id = ? を自動付与
 * - スーパー管理者は全施設アクセス可
 */
export function tenantScope() {
  return async (c, next) => {
    const user = c.get('user'); // JWT decoded payload
    
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    
    if (user.role === 'super_admin') {
      // スーパー管理者: nursery_id はリクエストパラメータから
      const nurseryId = c.req.query('nursery_id') || c.req.header('X-Nursery-ID');
      c.set('nursery_id', nurseryId); // null = 全施設
    } else {
      // 施設スタッフ/保護者: JWT内のnursery_idを強制
      c.set('nursery_id', user.nursery_id);
    }
    
    await next();
  };
}
```

---

## 5. 要件①: 保護者スマートフォン入力

> **適用: 全30施設 ★★★**
> "保護者がスマホで毎月の利用予定（日付・時間・食事）を直接入力。紙を廃止する。"

### 5.1 入力チャネル設計

```
保護者の入力手段:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. LINE (メインチャネル) ← LINE_SCHEDULE_COLLECTION_PLAN.md
   ・AIヒアリング形式で自然言語入力
   ・Flex Message でボタン操作
   ・リマインド Push通知
   ・利便性 ★★★

2. Web Portal (サブチャネル) ← 新規設計
   ・カレンダーUI でタッチ入力
   ・LINE非利用者への代替手段
   ・PC/タブレットからも入力可能
   ・利便性 ★★

3. スタッフ代行入力 (バックアップ)
   ・管理画面から園児を選んで入力
   ・紙を受け取った場合の過渡期運用
   ・既存実装 (v6.0)
   ・利便性 ★
```

### 5.2 保護者Webポータル設計

**LINE設計は既存のLINE_SCHEDULE_COLLECTION_PLAN.mdに定義済み。ここではWebポータルを設計。**

#### URL構成
```
https://{domain}/parent/login          -- ログイン画面
https://{domain}/parent/schedule       -- 予定入力画面 (メイン)
https://{domain}/parent/schedule/edit  -- 予定修正画面
https://{domain}/parent/statement      -- 利用明細閲覧 (要件⑤)
https://{domain}/parent/profile        -- プロフィール/児童情報確認
```

#### ログイン方式
```
方式A: LINE Login (LIFF) ← 推奨
  ・LINE友だち追加 → LIFFアプリ起動 → 自動ログイン
  ・LINE userId で自動紐付け
  ・追加認証不要

方式B: マジックリンク (Email/SMS)
  ・メールアドレス or 電話番号入力
  ・一時リンク送信 → クリックでログイン
  ・LINE非利用者向け

方式C: 連携コード + パスワード
  ・初回: 連携コード (AYK-XXXX) + パスワード設定
  ・2回目以降: メアド + パスワード
```

#### 予定入力UI (スマホ最適化)

```
┌─────────────────────────────┐
│ ◀ 2026年4月の予定          ▶ │
│ ○○ちゃん (0歳児)             │
├─────────────────────────────┤
│                              │
│ 基本パターン設定:             │
│ ┌──────────────────────────┐│
│ │ 利用曜日: [月][火][水][木][金] ││
│ │ 登園: [08:30] 降園: [17:00] ││
│ │ 昼食 [✓] おやつAM [✓]     ││
│ │ おやつPM [✓] 夕食 [ ]     ││
│ └──────────────────────────┘│
│                              │
│ [パターンを全日に適用]         │
│                              │
│ ━━ カレンダー ━━              │
│ 月 火 水 木 金 土 日           │
│  1  2  3  4  5  6  7         │
│ ✅ ✅ ✅ ✅ ✅  -  -          │
│  8  9 10 11 12 13 14         │
│ ✅ ✅ ❌ ✅ ✅  -  -          │
│ ...                          │
│                              │
│ 例外日:                       │
│ 4/10 (木) → お休み ❌         │
│ 4/15 (火) → 8:30-19:00 🍽    │
│ [+ 例外日を追加]              │
│                              │
│ ━━━━━━━━━━━━━━━━━            │
│ 合計: 19日利用 / 22営業日     │
│                              │
│ [プレビュー] [提出する]       │
│                              │
│ 変更締切: 3月31日まで         │
└─────────────────────────────┘
```

### 5.3 施設別設定項目

```json
{
  "nursery_id": "facility_xxx",
  "schedule_input_config": {
    "enabled_channels": ["line", "web", "staff"],
    "deadline_rule": "previous_month_end",
    "emergency_cancel_allowed": true,
    "required_fields": {
      "planned_start": true,
      "planned_end": true,
      "lunch_flag": true,
      "am_snack_flag": true,
      "pm_snack_flag": true,
      "dinner_flag": true,
      "breakfast_flag": false
    },
    "business_hours": {
      "open": "07:30",
      "close": "20:00",
      "early_start": "07:00"
    },
    "reminders": {
      "enabled": true,
      "first_reminder_day": 15,
      "followup_reminder_day": 25
    }
  }
}
```

---

## 6. 要件②: スタッフ共有ビュー

> **適用: 全30施設 ★★★**
> "日ごとの登園予定・食数を確認して人員配置・給食発注に使いたい。印刷もしたい。"

### 6.1 現行ダッシュボード (v6.1) の状態

**既に実装済みの機能**:
- ✅ 月間カレンダー表示 (`loadDashboardFromDB`)
- ✅ 日別人数・食数集計 (`/api/schedules/dashboard`)
- ✅ クラス別人数 (0歳~5歳 + 一時)
- ✅ 今日/明日/今週/月間のビュー切替
- ✅ ファイルアップロード不要（DB直結）

**マルチ施設対応で必要な拡張**:
- 🟡 施設選択ドロップダウン (スーパー管理者用)
- 🟡 施設別認証 (スタッフは自施設のみ)
- 🟡 印刷最適化CSS (`@media print`)
- 🟢 施設名表示のダッシュボードヘッダ

### 6.2 マルチ施設ダッシュボード拡張

```
┌─────────────────────────────────────────────────────────┐
│ 🏠 施設: [あゆっこ保育所 ▼]  2026年4月  [◀][▶]         │
│                                                          │
│ [今日] [明日] [今週] [月間]                               │
│                                                          │
│ ━━ 本日 (4/8 火曜日) ━━                                  │
│ 登園予定: 25名 (0歳:4 / 1歳:6 / 2歳:8 / 一時:7)         │
│ 食事: 昼食25 / AMおやつ20 / PMおやつ25 / 夕食3           │
│                                                          │
│ [🖨 印刷]                                                │
│                                                          │
│ ┌─────┬──────┬──────┬──────┬──────┬──────┬──────┐        │
│ │ 園児 │ 登園  │ 降園  │ 昼食  │AMお  │PMお  │ 夕食  │        │
│ ├─────┼──────┼──────┼──────┼──────┼──────┼──────┤        │
│ │田中太│ 8:30 │17:00 │ ○   │ ○   │ ○   │      │        │
│ │山田花│ 7:00 │18:30 │ ○   │ ○   │ ○   │ ○   │        │
│ │...  │      │      │      │      │      │      │        │
│ └─────┴──────┴──────┴──────┴──────┴──────┴──────┘        │
│                                                          │
│ ━━ 提出状況 ━━                                            │
│ 連携済保護者: 28名 / 30名                                 │
│ 予定提出済: 22名 ✅ / 未提出: 6名 ⚠️                     │
│ [リマインド送信] [未提出者一覧]                            │
└─────────────────────────────────────────────────────────┘
```

### 6.3 印刷対応設計

```css
/* 印刷用CSS */
@media print {
  /* ヘッダ/フッタ/ナビゲーション非表示 */
  nav, .no-print, .tab-bar { display: none !important; }
  
  /* A4横 */
  @page { size: A4 landscape; margin: 10mm; }
  
  /* テーブルをフル幅に */
  .dashboard-table { 
    width: 100%;
    font-size: 9pt;
    border-collapse: collapse;
  }
  .dashboard-table td, .dashboard-table th {
    border: 1px solid #000;
    padding: 2px 4px;
  }
  
  /* 施設名・日付をヘッダに */
  .print-header { display: block !important; }
}
```

---

## 7. 要件③: 大学提出用帳票PDF

> **適用: 大半の施設（標準フォーマット）**
> "児童の利用実績（一時保育の預かり時間、特別保育、食事記録）をPDFで生成。"

### 7.1 標準フォーマット vs 施設固有

```
大学提出帳票の類型:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

A) 標準フォーマット ← 大半の施設
   ・児童実績表（登降園時刻、利用時間、一時利用ブロック数）
   ・食事提供実績（昼食/おやつ/夕食の実績数）
   ・特別保育記録（早朝/延長/夜間/病児）
   → PDF Generator で共通テンプレートから生成

B) カスタムフォーマット ← 一部施設
   ・大学独自のExcelテンプレートに書き込み
   → あゆっこのように施設固有テンプレートを登録・管理
```

### 7.2 標準帳票PDF設計

```
┌─────────────────────────────────────────────────┐
│         児童利用実績報告書                         │
│                                                   │
│ 施設名: ○○保育所                                 │
│ 対象月: 2026年4月                                 │
│ 報告日: 2026年5月1日                              │
│                                                   │
│ ━━ 園児別利用実績 ━━                              │
│ ┌─────┬────┬────┬────┬────┬────┬────┬────┐      │
│ │園児名│利用│一時│早朝│延長│夜間│病児│食事│      │
│ │      │日数│ブロ│回数│回数│回数│回数│日数│      │
│ ├─────┼────┼────┼────┼────┼────┼────┼────┤      │
│ │田中太│ 19 │  - │  2 │  1 │  0 │  0 │ 19 │      │
│ │山田花│ 15 │ 30 │  0 │  3 │  1 │  0 │ 15 │      │
│ │...  │    │    │    │    │    │    │    │      │
│ └─────┴────┴────┴────┴────┴────┴────┴────┘      │
│                                                   │
│ ━━ 食事提供実績 ━━                                │
│ ┌──────┬──────┬──────┬──────┬──────┐              │
│ │ 日付  │ 昼食  │AMおや│PMおや│ 夕食  │              │
│ ├──────┼──────┼──────┼──────┼──────┤              │
│ │ 4/1  │  22  │  18  │  22  │   3  │              │
│ │ 4/2  │  23  │  19  │  23  │   2  │              │
│ │ ...  │      │      │      │      │              │
│ └──────┴──────┴──────┴──────┴──────┘              │
└─────────────────────────────────────────────────┘
```

### 7.3 帳票ON/OFF設定

```json
{
  "nursery_id": "facility_xxx",
  "report_config": {
    "university_report_pdf": {
      "enabled": true,
      "format": "standard",
      "includes": ["attendance_summary", "meal_summary", "special_care_summary"],
      "submission_deadline_day": 5
    },
    "custom_excel_template": {
      "enabled": false,
      "template_r2_key": null
    }
  }
}
```

---

## 8. 要件④: 経理向けExcel出力

> **適用: 2施設のみ**
> "保育料の明細をExcelで出力し、経理に渡す。大学への料金提出にも使う。"

### 8.1 現行の実装状況

```
あゆっこの保育料明細Excel:
  ・テンプレート: あゆっこ_保育料明細.xlsx
  ・月別シート構成
  ・charge_lines テーブルから数量を書き込み
  ・数式列は触らない（書き込みセル最小化原則）
  ・Python Generator で生成
  ✅ 設計済み・部分実装済み
```

### 8.2 マルチ施設対応

2施設のみなので、施設ごとにテンプレートをアップロード・管理する方式:

```
施設A (あゆっこ):
  templates/ → nursery_id=ayukko_001, template_type=billing_detail
  料金: pricing_rules (nursery_id=ayukko_001, fiscal_year=2025)

施設B (2施設目):
  templates/ → nursery_id=facility_002, template_type=billing_detail
  料金: pricing_rules (nursery_id=facility_002, fiscal_year=2025)

他28施設:
  billing_detail: enabled = false (不要)
```

---

## 9. 要件⑤: 保護者向け利用明細

> **適用: あゆっこのみ**
> "保護者が利用明細PDFをスマホで閲覧。別途紙での配布は不要。"

### 9.1 配信フロー

```
月次処理 (月初5営業日)
  1. 帳票生成ジョブ実行
  2. 保護者向け利用明細PDF生成 (charge_lines → PDF)
  3. R2 に保存 (nursery_id/year/month/child_id.pdf)
  4. LINE Push Message で通知:
     "4月分の利用明細が確認できます。
      [明細を見る]"  ← LIFF or Web URL
  5. 保護者がLINEリッチメニューから閲覧

閲覧URL:
  https://{domain}/parent/statement?year=2026&month=4
  → JWT認証 → 自分の子のPDFのみ表示
  → R2からプリサインドURL生成 → PDF表示
```

### 9.2 利用明細PDF内容

```
┌─────────────────────────────────────────────────┐
│         利用明細書                                │
│                                                   │
│ ○○保育所                                        │
│ 保護者様: 田中 様                                │
│ 園児名: 田中太郎（0歳児クラス）                   │
│ 対象月: 2026年4月                                │
│                                                   │
│ ━━ 利用日数: 19日 ━━                              │
│                                                   │
│ ┌─────────────────────────────────────────┐      │
│ │ 項目              │ 数量  │ 単価  │ 金額  │      │
│ ├──────────────────┼──────┼──────┼──────┤      │
│ │ 月極保育料        │  1   │45,000│45,000│      │
│ │ 早朝保育          │  2回 │  300 │   600│      │
│ │ 延長保育          │  1回 │  300 │   300│      │
│ │ 昼食              │ 19食 │  300 │ 5,700│      │
│ │ 午前おやつ        │ 15食 │   50 │   750│      │
│ │ 午後おやつ        │ 19食 │  100 │ 1,900│      │
│ │ 夕食              │  1食 │  300 │   300│      │
│ ├──────────────────┼──────┼──────┼──────┤      │
│ │ 合計              │      │      │54,550│      │
│ └─────────────────────────────────────────┘      │
│                                                   │
│ ━━ 利用詳細 ━━                                    │
│ 4/1(火) 8:30-17:00 昼・AMお・PMお                │
│ 4/2(水) 7:00-17:00 昼・AMお・PMお [早朝]         │
│ ...                                              │
│ 4/15(火) 8:30-19:00 昼・AMお・PMお・夕 [延長]    │
│ ...                                              │
│ 4/10(木) お休み                                  │
└─────────────────────────────────────────────────┘
```

---

## 10. データベース拡張設計

### 10.1 既存テーブルへの影響

**変更不要** (既に `nursery_id` FK を持つ):
- `children` (nursery_id あり)
- `pricing_rules` (nursery_id あり)
- `templates` (nursery_id あり)
- `jobs` (nursery_id あり)
- `name_mappings` (nursery_id あり)
- `schedule_plans` (children.nursery_id 経由)
- `attendance_records` (children.nursery_id 経由)
- `usage_facts` (children.nursery_id 経由)
- `charge_lines` (children.nursery_id 経由)

### 10.2 新規テーブル

#### 10.2.1 `nursery_settings` — 施設別設定

```sql
CREATE TABLE IF NOT EXISTS nursery_settings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  nursery_id TEXT NOT NULL REFERENCES nurseries(id),
  setting_key TEXT NOT NULL,
  setting_value TEXT NOT NULL,  -- JSON
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(nursery_id, setting_key)
);

CREATE INDEX IF NOT EXISTS idx_nursery_settings_nursery 
  ON nursery_settings(nursery_id);
```

設定キー例:
```
schedule_input_config   -- 予定入力設定 (チャネル、締切ルール等)
report_config           -- 帳票生成設定 (ON/OFF、フォーマット)
line_config             -- LINE連携設定 (チャネルID等)
business_hours          -- 営業時間
meal_config             -- 食事設定 (提供する食事種別)
feature_flags           -- 機能ON/OFF
```

#### 10.2.2 `users` — ユーザーアカウント

```sql
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  email TEXT UNIQUE,
  password_hash TEXT,                       -- bcrypt
  role TEXT NOT NULL CHECK(role IN (
    'super_admin', 'nursery_admin', 'staff', 'parent'
  )),
  nursery_id TEXT REFERENCES nurseries(id), -- NULLならsuper_admin
  display_name TEXT,
  line_user_id TEXT,                        -- LINE連携時
  is_active INTEGER DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_nursery ON users(nursery_id);
CREATE INDEX IF NOT EXISTS idx_users_line ON users(line_user_id);
```

#### 10.2.3 `user_children` — 保護者-児童紐付け

```sql
CREATE TABLE IF NOT EXISTS user_children (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  user_id TEXT NOT NULL REFERENCES users(id),
  child_id TEXT NOT NULL REFERENCES children(id),
  relationship TEXT DEFAULT 'parent',       -- 'parent', 'guardian'
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, child_id)
);

CREATE INDEX IF NOT EXISTS idx_user_children_user ON user_children(user_id);
CREATE INDEX IF NOT EXISTS idx_user_children_child ON user_children(child_id);
```

#### 10.2.4 `sessions` — ログインセッション

```sql
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                      -- JWT jti
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
```

### 10.3 `nurseries` テーブル拡張

```sql
-- 既存テーブルに列追加
ALTER TABLE nurseries ADD COLUMN short_code TEXT;       -- 施設コード (例: 'AYK')
ALTER TABLE nurseries ADD COLUMN region TEXT;            -- 地域
ALTER TABLE nurseries ADD COLUMN contact_email TEXT;
ALTER TABLE nurseries ADD COLUMN contact_phone TEXT;
ALTER TABLE nurseries ADD COLUMN is_active INTEGER DEFAULT 1;
ALTER TABLE nurseries ADD COLUMN features_json TEXT DEFAULT '{}';
-- features_json 例:
-- {
--   "schedule_input": true,       // 要件①
--   "staff_dashboard": true,      // 要件②
--   "university_report": true,    // 要件③
--   "billing_excel": false,       // 要件④ (2施設のみ)
--   "parent_statement": false     // 要件⑤ (あゆっこのみ)
-- }
```

### 10.4 マイグレーション計画

```sql
-- ================================================================
-- migrations/0003_multi_facility.sql
-- マルチ施設対応 + 認証基盤
-- ================================================================

-- 1. nurseries テーブル拡張
ALTER TABLE nurseries ADD COLUMN short_code TEXT;
ALTER TABLE nurseries ADD COLUMN region TEXT;
ALTER TABLE nurseries ADD COLUMN contact_email TEXT;
ALTER TABLE nurseries ADD COLUMN contact_phone TEXT;
ALTER TABLE nurseries ADD COLUMN is_active INTEGER DEFAULT 1;
ALTER TABLE nurseries ADD COLUMN features_json TEXT DEFAULT '{"schedule_input":true,"staff_dashboard":true,"university_report":true,"billing_excel":false,"parent_statement":false}';

-- 既存のあゆっこに全機能ON
UPDATE nurseries SET 
  short_code = 'AYK',
  features_json = '{"schedule_input":true,"staff_dashboard":true,"university_report":true,"billing_excel":true,"parent_statement":true}'
WHERE id = 'ayukko_001';

-- 2. ユーザーテーブル
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  email TEXT UNIQUE,
  password_hash TEXT,
  role TEXT NOT NULL CHECK(role IN (
    'super_admin', 'nursery_admin', 'staff', 'parent'
  )),
  nursery_id TEXT REFERENCES nurseries(id),
  display_name TEXT,
  line_user_id TEXT,
  is_active INTEGER DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_nursery ON users(nursery_id);
CREATE INDEX IF NOT EXISTS idx_users_line ON users(line_user_id);

-- 3. 保護者-児童紐付け
CREATE TABLE IF NOT EXISTS user_children (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  user_id TEXT NOT NULL REFERENCES users(id),
  child_id TEXT NOT NULL REFERENCES children(id),
  relationship TEXT DEFAULT 'parent',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(user_id, child_id)
);
CREATE INDEX IF NOT EXISTS idx_user_children_user ON user_children(user_id);
CREATE INDEX IF NOT EXISTS idx_user_children_child ON user_children(child_id);

-- 4. セッション
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- 5. 施設別設定
CREATE TABLE IF NOT EXISTS nursery_settings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  nursery_id TEXT NOT NULL REFERENCES nurseries(id),
  setting_key TEXT NOT NULL,
  setting_value TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(nursery_id, setting_key)
);
CREATE INDEX IF NOT EXISTS idx_nursery_settings_nursery ON nursery_settings(nursery_id);
```

---

## 11. 認証・マルチテナント設計

### 11.1 ロールモデル

```
┌───────────────────────────────────────────────────────────┐
│ Role: super_admin (スーパー管理者)                          │
│ ・全施設のデータにアクセス可                                │
│ ・施設の新規登録・設定変更                                  │
│ ・ユーザー管理（施設管理者の作成）                          │
│ ・nursery_id = NULL（全施設スコープ）                       │
├───────────────────────────────────────────────────────────┤
│ Role: nursery_admin (施設管理者)                            │
│ ・自施設のデータにのみアクセス                              │
│ ・園児登録、連携コード発行、帳票生成                        │
│ ・スタッフアカウント管理                                    │
│ ・nursery_id = 特定施設                                    │
├───────────────────────────────────────────────────────────┤
│ Role: staff (スタッフ)                                     │
│ ・自施設のダッシュボード閲覧                                │
│ ・予定入力（スタッフ代行）                                  │
│ ・帳票ダウンロード                                         │
│ ・nursery_id = 特定施設                                    │
├───────────────────────────────────────────────────────────┤
│ Role: parent (保護者)                                      │
│ ・自分の子の予定入力のみ                                    │
│ ・自分の子の利用明細閲覧のみ                                │
│ ・LINE連携 or Webポータルからアクセス                       │
│ ・nursery_id = 特定施設 + child_id スコープ                │
└───────────────────────────────────────────────────────────┘
```

### 11.2 JWT設計

```json
{
  "sub": "user_001",
  "role": "nursery_admin",
  "nursery_id": "ayukko_001",
  "child_ids": [],
  "display_name": "木村さん",
  "iat": 1711000000,
  "exp": 1711086400
}
```

保護者の場合:
```json
{
  "sub": "user_parent_001",
  "role": "parent",
  "nursery_id": "ayukko_001",
  "child_ids": ["child_mondal_aum", "child_tanaka_yui"],
  "display_name": "田中",
  "line_user_id": "U1234567890abcdef",
  "iat": 1711000000,
  "exp": 1711086400
}
```

### 11.3 APIアクセス制御マトリックス

| API | super_admin | nursery_admin | staff | parent |
|-----|-------------|---------------|-------|--------|
| GET /api/nurseries | ✅ 全施設 | ✅ 自施設のみ | ❌ | ❌ |
| POST /api/nurseries | ✅ | ❌ | ❌ | ❌ |
| GET /api/children | ✅ 全施設 | ✅ 自施設 | ✅ 自施設 | ✅ 自分の子のみ |
| POST /api/schedules | ✅ | ✅ | ✅ | ✅ 自分の子のみ |
| GET /api/schedules/dashboard | ✅ | ✅ | ✅ | ❌ |
| POST /api/jobs | ✅ | ✅ | ❌ | ❌ |
| GET /api/statement/:childId | ✅ | ✅ | ❌ | ✅ 自分の子のみ |
| POST /api/line/link-codes | ✅ | ✅ | ❌ | ❌ |

---

## 12. LINE連携のマルチ施設拡張

### 12.1 LINE公式アカウント戦略

| 戦略 | 説明 | メリット | デメリット |
|------|------|---------|----------|
| **A: 1アカウント/施設** | 施設ごとに公式アカウント | 明確な分離 | 30アカウント管理 |
| **B: 1統合アカウント** | 全施設で1つのアカウント | 管理楽 | 施設選択フロー必要 |
| **C: ハイブリッド** | グループ単位でアカウント | バランス | 中途半端 |

**推奨: 方式A (1アカウント/施設)**
- 保護者にとって自然（自分の保育所のアカウント）
- 施設名・アイコンをカスタマイズ可能
- Webhook URL は共通（nursery_id パラメータで振り分け）

### 12.2 Webhook共通化設計

```
全施設のLINE Webhook URL:
  https://{domain}/api/line/webhook?nursery={short_code}

例:
  あゆっこ:  /api/line/webhook?nursery=AYK
  施設B:    /api/line/webhook?nursery=FAC002
  施設C:    /api/line/webhook?nursery=FAC003
```

```typescript
// LINE Webhook の施設振り分け
app.post('/api/line/webhook', async (c) => {
  const nurseryCode = c.req.query('nursery');
  
  // 施設コードからnursery_id + LINE設定を取得
  const nursery = await getNurseryByCode(c.env.DB, nurseryCode);
  if (!nursery) return c.text('Unknown nursery', 400);
  
  // 施設ごとのChannel Secretで署名検証
  const lineConfig = await getNurseryLineSetting(c.env.DB, nursery.id);
  const body = await c.req.text();
  const signature = c.req.header('X-Line-Signature');
  
  const isValid = await verifySignature(body, signature, lineConfig.channel_secret);
  if (!isValid) return c.text('Invalid signature', 401);
  
  // 以降の処理はnursery_idスコープで実行
  const events = JSON.parse(body).events;
  for (const event of events) {
    await handleLineEvent(c.env, nursery.id, lineConfig, event);
  }
  
  return c.text('OK');
});
```

### 12.3 LINE Secrets管理

```
方式: nursery_settings テーブルに暗号化して保存

nursery_settings:
  nursery_id: 'ayukko_001'
  setting_key: 'line_config'
  setting_value: {
    "channel_id": "1234567890",
    "channel_secret": "encrypted:xxxxxxx",
    "channel_access_token": "encrypted:xxxxxxx",
    "webhook_path": "/api/line/webhook?nursery=AYK"
  }
```

**暗号化方式**: Cloudflare Workers環境変数で共通暗号化キーを保持し、
DB内のトークンは AES-256-GCM で暗号化。

### 12.4 連携コードの施設スコープ

```
現行: AYK-XXXX (あゆっこ固定)
拡張: {施設コード}-XXXX

例:
  あゆっこ:  AYK-3F7K
  施設B:    FAC-8H2M
  施設C:    SAK-9P4N

link_codes テーブルの nursery_id で施設を自動判定
```

---

## 13. 施設オンボーディングフロー

### 13.1 新施設登録手順

```
Step 1: スーパー管理者が施設を登録
  POST /api/nurseries
  {
    "name": "○○保育所",
    "short_code": "FAC002",
    "region": "滋賀県",
    "features_json": {
      "schedule_input": true,
      "staff_dashboard": true,
      "university_report": true,
      "billing_excel": false,
      "parent_statement": false
    }
  }

Step 2: 施設管理者アカウント作成
  POST /api/users
  {
    "email": "admin@facility002.example.com",
    "role": "nursery_admin",
    "nursery_id": "facility_002",
    "display_name": "○○保育所 管理者"
  }

Step 3: 基本設定投入
  - 営業時間設定
  - 料金ルール (pricing_rules) 登録
  - LINE公式アカウント設定 (任意)
  - テンプレート登録 (③④が必要な場合)

Step 4: 園児データ登録
  - CSV一括インポート or 個別登録
  - 保護者連携コード自動発行

Step 5: 保護者への案内配布
  - LINE QRコード
  - 連携コード
  - Web Portal URL
```

### 13.2 オンボーディング所要時間見積

| 作業 | 所要時間 | 備考 |
|------|---------|------|
| 施設登録 | 5分 | Super Admin |
| 管理者アカウント | 5分 | Super Admin |
| 料金ルール設定 | 30分 | 施設管理者 + 料金表 |
| 園児データCSVインポート | 15分 | 施設管理者 |
| LINE公式アカウント開設 | 1日 | LINE審査待ち |
| 保護者案内配布 | 1日 | 施設管理者 |
| **合計** | **約2-3日** | |

---

## 14. コスト・スケーラビリティ分析

### 14.1 30施設規模でのコスト見積

#### LINE

| 項目 | 1施設 | 30施設 | 備考 |
|------|-------|--------|------|
| アカウント費用 | 0円 or 5,000円 | 0円～150,000円 | Reply Messageメインならフリープラン可 |
| メッセージ通数 | ~510通/月 | ~15,300通/月 | 30園 x 510通 |

**Reply Messageはカウント対象外**のため、大半はフリープランで運用可能。
Push Message（リマインド）のみ課金対象:
- 1施設あたりリマインド: 30名 x 2回 = 60通/月
- 30施設: 1,800通/月
- → フリープラン (200通) 超のためライトプラン推奨施設も出る可能性

**推奨**: 各施設のメッセージ量を計測し、フリー/ライトを施設ごとに判断

#### OpenAI API

| 項目 | 1施設 | 30施設 |
|------|-------|--------|
| 園児数 | ~30名 | ~900名 |
| 月間トークン | ~660K | ~19.8M |
| コスト | ~$0.13 | ~$3.90 (~600円) |

#### Cloudflare

| 項目 | Free Plan上限 | 30施設想定 | 判定 |
|------|-------------|-----------|------|
| Workers requests | 100,000/日 | ~3,000/日 | ✅ 余裕 |
| D1 reads | 5,000,000/日 | ~15,000/日 | ✅ 余裕 |
| D1 writes | 100,000/日 | ~3,000/日 | ✅ 余裕 |
| D1 storage | 5GB | ~300MB | ✅ 余裕 |
| R2 storage | 10GB free | ~1GB | ✅ 余裕 |

#### 月額合計コスト見積

| 項目 | 最小構成 | 最大構成 |
|------|---------|---------|
| LINE (30施設) | 0円 (全施設フリー) | 150,000円 (全施設ライト) |
| OpenAI | 600円 | 600円 |
| Cloudflare | 0円 (Free) | 0円 (Free) |
| **合計** | **600円/月** | **150,600円/月** |

**現実的見積**: ~5施設がライトプラン = 25,600円/月

### 14.2 D1 データ量見積

```
30施設 x 30園児 = 900園児

schedule_plans: 900 x 22日 x 12ヶ月 = 237,600行/年
attendance_records: 同程度
usage_facts: 同程度
charge_lines: 900 x 12 x 10種 = 108,000行/年
line_conversations: 900 x 12 = 10,800行/年
line_conversation_logs: 10,800 x 10 = 108,000行/年

年間合計: ~700,000行 (数十MB程度)
→ D1 Free Plan (5GB) で十分
```

---

## 15. 段階的実装ロードマップ

### 15.1 フェーズ概要

```
Phase 0: あゆっこ完成 (現在進行中)
  ├── 既存のv6.1機能を安定化
  ├── REQUIREMENTS_CHECK.md の最優先修正
  └── LINE連携v2.0設計のレビュー完了

Phase 1: マルチ施設基盤 (2-3週間)
  ├── 認証・ロールモデル導入
  ├── テナントスコープミドルウェア
  ├── nurseries テーブル拡張
  └── 施設管理UI

Phase 2: 保護者入力 — 全30施設 (4-6週間)
  ├── LINE連携実装 (v2.0 → v3.0)
  ├── 保護者Webポータル (サブチャネル)
  └── 施設ごとの予定入力設定

Phase 3: スタッフダッシュボード — 全30施設 (2週間)
  ├── 施設別フィルタリング
  ├── 印刷最適化
  └── 提出状況管理UI

Phase 4: 帳票機能 — 対象施設のみ (3-4週間)
  ├── ③ 大学PDF (標準テンプレ)
  ├── ④ 経理Excel (2施設)
  └── ⑤ 保護者明細PDF (あゆっこ)

Phase 5: 展開・運用 (ongoing)
  ├── 施設オンボーディング
  ├── 運用監視・サポート
  └── フィードバック→改善
```

### 15.2 Phase別の詳細見積

| Phase | 期間 | 成果物 | リスク |
|-------|------|--------|--------|
| Phase 0 | 進行中 | あゆっこ安定稼働 | seed.sql不整合 |
| Phase 1 | 2-3w | 認証+マルチテナント基盤 | JWT設計の複雑さ |
| Phase 2 | 4-6w | LINE+Web保護者入力 | LINE API審査待ち |
| Phase 3 | 2w | 全施設ダッシュボード | 印刷レイアウト調整 |
| Phase 4 | 3-4w | 帳票 (PDF/Excel) | テンプレ互換性 |
| Phase 5 | ongoing | 30施設展開 | オンボーディング負荷 |

### 15.3 優先度マトリックス

```
影響度 ＼ 即効性     高（すぐ使える）     中              低（準備が必要）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

高（全30施設）      Phase 2: LINE入力     Phase 3:         
                    Phase 1: 認証基盤     ダッシュボード     

中（大半の施設）                          Phase 4-③:
                                          大学PDF

低（少数施設）                            Phase 4-④:      Phase 4-⑤:
                                          経理Excel       保護者明細
```

---

## 16. リスクと制約

### 16.1 技術リスク

| リスク | 影響度 | 対策 |
|--------|--------|------|
| D1の同時書き込み制限 | 中 | 30施設でも余裕。万一の場合はキューイング |
| Cloudflare Workersの10ms CPU制限 | 中 | 帳票生成は重い → Python Generatorを継続利用 |
| LINE API審査に時間がかかる | 高 | 早期申請。Webポータルを代替手段として用意 |
| 30施設分のLINE Secretsの管理 | 中 | DB暗号化 + アクセスログ |

### 16.2 運用リスク

| リスク | 影響度 | 対策 |
|--------|--------|------|
| 30施設のオンボーディングが追いつかない | 高 | バッチオンボーディングツール作成 |
| 施設ごとの料金体系バリエーション | 中 | pricing_rules のJSON柔軟性で対応 |
| 保護者のITリテラシー差 | 中 | LINE (直感的) + スタッフ代行入力 |
| 帳票フォーマットの施設間差異 | 高 | 標準テンプレ + カスタムテンプレ対応 |

### 16.3 Phase 0での未解決課題

**LINE実装前に修正必須**:
1. seed.sql の時間帯不整合 (extension_start: 18:00→20:00, night_start: 20:00→21:00)
2. 病児保育の永続化 (manualEdits → DB)
3. breakfast_flag の追加判断
4. PDF空欄問題の実機確認

---

## 変更履歴

| バージョン | 日付 | 内容 |
|-----------|------|------|
| 1.0 | 2026-03-04 | 初版作成。木村さんヒアリングの5要件をマルチ施設展開として設計 |

---

*この文書は設計計画のみです。実装コードは含まれていません。*
*LINE_SCHEDULE_COLLECTION_PLAN.md v3.0 と併せて参照してください。*

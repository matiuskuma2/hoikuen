# LINE Messaging API 月次利用予定収集システム 設計計画書

> **Version**: 2.0 (2026-03-04)
> **Status**: Design Only (実装前)
> **Author**: Ayukko Nursery Automation Team
> **Parent System**: 滋賀医科大学学内保育所 あゆっこ 業務自動化システム v6.1
> **Previous Version**: 1.0 (2026-03-04)

---

## 変更履歴

| バージョン | 日付 | 内容 |
|-----------|------|------|
| 1.0 | 2026-03-04 | 初版作成 |
| 2.0 | 2026-03-04 | ユーザーフィードバック反映: (1) 保護者入力はLINE経由に統一 (2) 紙予定表 vs LINE収集の入力項目対比表を追加 (3) 保育時間(提出用)の朝食列との整合問題を反映し `breakfast_flag` をLINE収集スコープに追加 (4) REQUIREMENTS.md §2.1-A/§3.5/§3.6 との設計差分を明記 (5) SQLマイグレーション完全版を更新 (6) 運用フロー: 毎月固定日にPush配信→期限までに全員提出→ロック (7) schedule_change_requests テーブル追加 |

---

## 目次

1. [エグゼクティブサマリー](#1-エグゼクティブサマリー)
2. [現状分析と課題](#2-現状分析と課題)
3. [紙予定表 vs LINE収集 入力項目対比](#3-紙予定表-vs-line収集-入力項目対比)
4. [システム全体アーキテクチャ](#4-システム全体アーキテクチャ)
5. [LINE連携フロー](#5-line連携フロー)
6. [AIヒアリングエンジン設計](#6-aiヒアリングエンジン設計)
7. [複数児童対応設計](#7-複数児童対応設計)
8. [変更ルール・ロック仕様](#8-変更ルールロック仕様)
9. [データベーススキーマ拡張](#9-データベーススキーマ拡張)
10. [既存スキーマとの設計差分](#10-既存スキーマとの設計差分)
11. [API設計](#11-api設計)
12. [セキュリティ・プライバシー](#12-セキュリティプライバシー)
13. [料金・コスト見積](#13-料金コスト見積)
14. [依存関係・技術スタック](#14-依存関係技術スタック)
15. [マイグレーション計画](#15-マイグレーション計画)
16. [実装ロードマップ](#16-実装ロードマップ)
17. [テスト計画](#17-テスト計画)
18. [運用マニュアル](#18-運用マニュアル)

---

## 1. エグゼクティブサマリー

### 1.1 目的
保護者が毎月紙で提出している「利用予定表」を廃止し、**LINE公式アカウント上でAIがヒアリング形式で予定を収集→自動登録**するシステムを構築する。

### 1.2 v2.0での主要変更点

| # | v1.0 | v2.0 | 理由 |
|---|------|------|------|
| 1 | 保護者入力手段は「LINEまたはWebポータル」 | **LINE経由に一本化** | モギモギ氏フィードバック: 保護者が入力するのはLINE |
| 2 | 食事は4種(昼食/朝おやつ/午後おやつ/夕食) | **5種(朝食を追加)** | 保育時間(提出用)シートにcol+4=朝食列あり。Python Generator既に `has_breakfast` 実装済み |
| 3 | 変更はLINEの自由テキスト | **schedule_change_requestsテーブルで変更履歴管理** | 監査トレイルが必要 |
| 4 | 紙予定表との対比なし | **REQUIREMENTS.md §2.1-Aとの完全対比表追加** | 設計承認時のチェック基準 |

### 1.3 現行フロー (AS-IS)
```
保護者 → 紙の予定表(Excel)を記入 → 保育所に提出 → スタッフが手動入力/Excel転記
```

### 1.4 目標フロー (TO-BE)
```
保護者 → LINEで友だち追加 → アカウント連携(1回)
→ 毎月20日頃にリマインド受信 → LINEでAIとやり取り → 自動でDB登録
→ 変更もLINEで → 締切管理・ロック自動適用
→ schedule_plans テーブルに直接書き込み → 既存の帳票生成パイプラインに合流
```

### 1.5 主要な設計原則
1. **保護者の入力手段はLINE**: 保護者用Webポータルは作らない（管理画面は園スタッフ用のみ）
2. **AIが聞き漏らさない**: 必須項目が揃うまでフォローアップ質問を継続
3. **予定以外は断る**: AIのスコープを予定収集に限定（プロンプトで制御）
4. **複数児童対応**: 1人のLINEユーザーが複数の児童分を管理できる
5. **変更可能 + ロック**: 前月末日まで変更可、当月はロック（緊急キャンセルは例外）
6. **既存DB統合**: 現在の `schedule_plans` テーブルに直接書き込み（source_file = 'LINE'）
7. **紙予定表と同等以上**: 紙の入力項目（日付/登降園時間/食事5種）を全てカバー

---

## 2. 現状分析と課題

### 2.1 現行システムのデータフロー
```
schedule_plans テーブル
├── source: 'UI入力'    ... 管理画面からの手動入力（v6.0で実装済み）
├── source: 'Excel'     ... アップロードされた予定表Excel（v3.1で設計）
└── source: 'LINE'      ... 【今回追加】LINEからのAI収集
```

### 2.2 既存の schedule_plans テーブル構造 (0001_initial_schema.sql)
| カラム | 型 | 説明 |
|--------|-----|------|
| id | TEXT PK | UUID |
| child_id | TEXT FK | children.id |
| year | INTEGER | 年 |
| month | INTEGER | 月 |
| day | INTEGER | 日 (1-31) |
| planned_start | TEXT | 予定登園 HH:MM |
| planned_end | TEXT | 予定降園 HH:MM |
| lunch_flag | INTEGER | 昼食 (0/1) |
| am_snack_flag | INTEGER | 午前おやつ (0/1) |
| pm_snack_flag | INTEGER | 午後おやつ (0/1) |
| dinner_flag | INTEGER | 夕食 (0/1) |
| source_file | TEXT | 入力元 |
| UNIQUE | | (child_id, year, month, day) |

> ⚠️ **v2.0で検出した問題**: `breakfast_flag` カラムが存在しない。
> 保育時間(提出用)シートの col+4 = 朝食(〇) 列、Python Generator の `has_breakfast`、保育料案内の「朝食150円」に対応するカラムが DB に無い。
> → **マイグレーション 0002 で追加する**

### 2.3 既存の children テーブルの主要フィールド
- `id`, `nursery_id`, `lukumi_id`, `name`, `name_kana`, `birth_date`
- `age_class`, `enrollment_type` (月極/一時), `child_order`, `is_allergy`

### 2.4 解決すべき課題
| # | 課題 | 影響 | 設計での対応 |
|---|------|------|-------------|
| 1 | 紙での予定提出は保護者・スタッフ双方に負荷 | 月次作業が数時間 | LINE自動収集 |
| 2 | 転記ミスが発生する | 課金エラー | AIが直接DB書き込み |
| 3 | 変更連絡が口頭ベース | 追跡不可 | LINE会話ログ+変更リクエストテーブルで追跡 |
| 4 | 締切管理が属人的 | 遅延・漏れ | 自動リマインド + ロック |
| 5 | 複数児童の場合、紙が複数枚 | 管理煩雑 | 1会話で全児童分収集 |
| 6 | 朝食(breakfast)がDBスキーマに欠落 | 帳票の朝食列が空 | 0002マイグレーションで追加 |

---

## 3. 紙予定表 vs LINE収集 入力項目対比

### 3.1 紙の予定表 (REQUIREMENTS.md §2.1-A 準拠)

```
ファイル: 児童利用予定表.xlsx
シート: "原本"

左半分（日1-15）:
  B12:B26 = 日付
  D列     = 登所時間 (HH:MM)
  G列     = 降所時間 (HH:MM)
  J列     = 昼食フラグ (〇)
  K列     = おやつフラグ (〇)    ← ★ 朝おやつ+午後おやつの区別なし
  L列     = 夕食フラグ (〇)

右半分（日16-31）:
  M12:M27 = 日付
  O列     = 登所時間
  R列     = 降所時間
  U列     = 昼食フラグ
  V列     = おやつフラグ
  W列     = 夕食フラグ
```

### 3.2 保育時間(提出用)シート (REQUIREMENTS.md §3.6 準拠)

```
col+4 (M) = 朝食 (〇)       ← ★ 紙には無いが帳票にある
col+5 (N) = 昼食 (〇)
col+6 (O) = おやつ (〇)     ← 朝+午後が合算された "おやつ"
col+7 (P) = 夕食 (〇)
```

### 3.3 ◆保育時間シート (REQUIREMENTS.md §3.5 準拠)

```
col+4 (L) = 昼食 (〇)
col+5 (M) = 朝おやつ (〇)
col+6 (N) = 午後おやつ (〇)
col+7 (O) = 夕食 (〇)
```

### 3.4 対比マトリックス

| 入力項目 | 紙予定表 | ◆保育時間 | 保育時間(提出用) | DB schedule_plans (現状) | DB (v2.0後) | LINE収集 |
|---------|---------|-----------|---------------|----------------------|------------|---------|
| 日付 | ✅ | ✅ | ✅ | ✅ year/month/day | 変更なし | ✅ |
| 登園時間 | ✅ D/O列 | ✅ col+0 | ✅ col+0 | ✅ planned_start | 変更なし | ✅ |
| 降園時間 | ✅ G/R列 | ✅ col+1 | ✅ col+1 | ✅ planned_end | 変更なし | ✅ |
| **朝食** | ❌ なし | ❌ なし | ✅ col+4 | ❌ **欠落** | ✅ **追加** | ✅ **収集** |
| 昼食 | ✅ J/U列 | ✅ col+4 | ✅ col+5 | ✅ lunch_flag | 変更なし | ✅ |
| 朝おやつ | (おやつ一括) | ✅ col+5 | (おやつ一括) | ✅ am_snack_flag | 変更なし | ✅ |
| 午後おやつ | (おやつ一括) | ✅ col+6 | (おやつ一括) | ✅ pm_snack_flag | 変更なし | ✅ |
| 夕食 | ✅ L/W列 | ✅ col+7 | ✅ col+7 | ✅ dinner_flag | 変更なし | ✅ |

### 3.5 朝食(breakfast)の扱い方針

**結論**: LINE収集では **朝食を収集対象に含める**。

**根拠**:
1. 保育時間(提出用)シートの col+4 に「朝食(〇)」列が存在
2. Python Generator が `has_breakfast` を使い、charge_calculator が ¥150/食で計算
3. 保育料案内PDFに朝食の記載がある（推定 ¥150）
4. 紙予定表に朝食列が無いのは「紙の制約」であり、LINE化で解消すべき

**食事フラグ自動推定ルール (v2.0)**:
```
登園時間 < 7:30  → breakfast_flag = 1 (早朝保育で朝食提供)
登園時間 ≤ 10:00 → am_snack_flag = 1
登園時間 ≤ 11:30 → lunch_flag = 1
降園時間 ≥ 15:00 → pm_snack_flag = 1
降園時間 ≥ 20:00 → dinner_flag = 1  ← v2.0修正: 18:00→20:00(保育料案内準拠)
```

> **注**: 紙予定表では「おやつ」が1列で朝午後を区別していないが、
> LINE収集では AI が時間帯から自動推定し、必要時のみ確認を行う。
> 保護者に「朝おやつと午後おやつどちらですか？」と聞く必要は通常ない。

---

## 4. システム全体アーキテクチャ

### 4.1 アーキテクチャ概要図
```
┌──────────────┐     ┌────────────────────┐     ┌──────────────────┐
│   保護者     │     │    LINE Platform   │     │  Cloudflare      │
│  (LINE App)  │◄───►│  Messaging API     │────►│  Workers/Pages   │
└──────────────┘     └────────────────────┘     │                  │
                                                 │  ┌────────────┐ │
                                                 │  │ Webhook    │ │
                                                 │  │ Handler    │ │
                                                 │  └─────┬──────┘ │
                                                 │        │        │
                                                 │  ┌─────▼──────┐ │
                                                 │  │ AI Engine  │ │     ┌─────────────┐
                                                 │  │ (LLM API)  │─────►│ OpenAI API  │
                                                 │  └─────┬──────┘ │     │ (GPT-4o)    │
                                                 │        │        │     └─────────────┘
                                                 │  ┌─────▼──────┐ │
                                                 │  │ Schedule   │ │
                                                 │  │ Service    │ │
                                                 │  └─────┬──────┘ │
                                                 │        │        │
                                                 │  ┌─────▼──────┐ │
                                                 │  │ D1 (SQLite)│ │
                                                 │  │ Database   │ │
                                                 │  └────────────┘ │
                                                 └──────────────────┘

既存パイプライン（変更なし）:
schedule_plans (source='LINE')
    ↓
usage_calculator → usage_facts → charge_calculator → charge_lines
    ↓
daily_report_writer / billing_writer / pdf_writer
    ↓
帳票ファイル (Excel/PDF)
```

### 4.2 コンポーネント構成
```
src/
├── routes/
│   ├── line-webhook.ts       # LINE Webhook受信 + 署名検証
│   ├── line-admin.ts         # 管理者向けLINE管理API
│   ├── schedules.ts          # 既存: 予定CRUD API (breakfast_flag対応追加)
│   └── children.ts           # 既存: 園児CRUD API
├── lib/
│   ├── line-client.ts        # LINE Messaging API クライアント (SDK不使用)
│   ├── ai-hearing-engine.ts  # AIヒアリングエンジン (状態管理 + LLM呼出)
│   ├── conversation-state.ts # 会話状態マシン
│   ├── schedule-parser.ts    # AIレスポンスから予定データ抽出
│   ├── change-rules.ts       # 変更ルール・ロック判定
│   └── reminder-service.ts   # リマインド送信 (Cron Trigger)
├── types/
│   ├── index.ts              # 既存型定義 (Bindings拡張)
│   └── line.ts               # LINE関連型定義
└── index.tsx                 # メインアプリ (既存 + LINE route追加)
```

### 4.3 処理フロー概要
```
1. 保護者がLINEでメッセージ送信
2. LINE Platform → Webhook (POST /api/line/webhook)
3. 署名検証 (X-Line-Signature, Web Crypto API)
4. イベント種別判定:
   a. follow     → ウェルカムメッセージ + アカウント連携案内
   b. unfollow   → line_accounts.is_active = 0
   c. message    → AI会話エンジンへ転送
   d. postback   → ボタン操作の処理
5. AI会話エンジン:
   a. 会話状態をDBから取得 (conversations テーブル)
   b. ビジネスルール適用 (変更ロック判定等)
   c. LLM (OpenAI GPT-4o-mini) でテキスト→構造化データ変換
   d. 予定データ抽出 → schedule_plans へ UPSERT
   e. 会話状態をDBに保存
6. LINE Reply API で応答送信
```

---

## 5. LINE連携フロー

### 5.1 LINE公式アカウント設定

#### 必要な設定
| 項目 | 設定値 |
|------|--------|
| アカウント種別 | LINE公式アカウント (Verified推奨) |
| プラン | フリープラン (Reply Message中心ならOK) or ライトプラン |
| Messaging API | 有効化 |
| Webhook URL | `https://ayukko-nursery.pages.dev/api/line/webhook` |
| 応答モード | Webhook |
| 自動応答 | 無効 (Bot側で制御) |
| あいさつメッセージ | カスタム設定 |

#### 必要なトークン
| トークン | 用途 | 保存先 |
|----------|------|--------|
| Channel ID | アプリ識別 | `.dev.vars` / Cloudflare Secret |
| Channel Secret | 署名検証 | `.dev.vars` / Cloudflare Secret |
| Channel Access Token (long-lived) | メッセージ送信 | `.dev.vars` / Cloudflare Secret |

### 5.2 アカウント連携フロー

```
┌─────────────────────────────────────────────────────────┐
│ Step 1: 友だち追加                                       │
│ 保護者 → QRコード/検索 → 友だち追加                       │
│ → follow イベント受信                                    │
├─────────────────────────────────────────────────────────┤
│ Step 2: ウェルカムメッセージ                              │
│ Bot → "あゆっこ保育所へようこそ！                         │
│        お子さまの利用予定をLINEで簡単に提出できます。     │
│        最初にアカウント連携が必要です。                   │
│        保育所から配布された「連携コード」を入力してください │
│        例: AYK-1234"                                     │
├─────────────────────────────────────────────────────────┤
│ Step 3: 連携コード入力                                   │
│ 保護者 → "AYK-1234"                                     │
│ Bot → DB検索(link_codes) → line_accounts に登録          │
│ Bot → "○○ちゃん（0歳児クラス）のアカウント連携が          │
│        完了しました！これ以降、LINEで利用予定を           │
│        提出できます。"                                   │
├─────────────────────────────────────────────────────────┤
│ Step 4: 複数児童の場合                                   │
│ Bot → "他にもお子さまがいらっしゃいますか？              │
│        追加の連携コードを入力してください。              │
│        連携を終了する場合は「完了」と入力してください。" │
│ 保護者 → "AYK-5678"                                     │
│ Bot → ○○ちゃん（1歳児クラス）も連携完了                  │
│ 保護者 → "完了"                                         │
│ Bot → "2名のお子さまが連携されました。"                  │
└─────────────────────────────────────────────────────────┘
```

### 5.3 連携コード設計

| 項目 | 仕様 |
|------|------|
| 形式 | `AYK-XXXX` (英数4桁、大文字) |
| 生成 | 管理画面で園児登録時に自動生成 |
| 有効期限 | 発行から30日 (期限後は再発行) |
| 使い捨て | Yes (1回使用で無効化) |
| 文字種 | 数字 + 大文字英字 (紛らわしい0/O/I/1は除外) |
| 衝突回避 | DB UNIQUE制約 + 再生成ロジック |

### 5.4 リマインド配信フロー

```
┌────────────────────────────────────────────┐
│ Cron Trigger: 毎月20日 10:00 JST           │
│ (別Cloudflare Worker or 外部Cron)          │
├────────────────────────────────────────────┤
│ 1. line_accounts から連携済み+有効ユーザー取得│
│ 2. 翌月の schedule_plans をチェック         │
│    └── 未提出 → リマインド送信             │
│    └── 提出済 → スキップ                   │
│ 3. Push Message 送信:                       │
│    "来月（4月）の利用予定の提出時期です。    │
│     「予定入力」と送信すると、AIが           │
│     お聞きしながら予定を登録します。         │
│     提出期限: 3月31日"                      │
│                                             │
│ フォローアップ: 毎月27日 10:00 JST         │
│ 未提出者のみ再リマインド                    │
│ "まだ4月の利用予定が届いていません。         │
│  3月31日までにご提出をお願いします。"       │
└────────────────────────────────────────────┘
```

---

## 6. AIヒアリングエンジン設計

### 6.1 会話状態マシン (v2.0: 状態追加)

```
                    ┌──────────┐
          start ──► │  IDLE    │ ◄── "最初から" / 前回完了後
                    └────┬─────┘
                         │ follow イベント (未連携ユーザー)
                    ┌────▼─────────────┐
                    │ AUTH_LINK        │ ◄── 連携コード入力待ち
                    │ (アカウント連携)  │
                    └────┬─────────────┘
                         │ 連携完了 / 既に連携済みで「予定入力」
                    ┌────▼─────────────┐
                    │ SELECT_CHILD     │ ◄── 複数児童 → 児童選択
                    │ (対象児童確認)    │     (1名なら自動スキップ)
                    └────┬─────────────┘
                         │ 児童確定
                    ┌────▼─────────────┐
                    │ SELECT_MONTH     │ ◄── 対象月確認
                    │ (対象月確認)      │
                    └────┬─────────────┘
                         │ 月確定
                    ┌────▼─────────────┐
                    │ COLLECTING       │ ◄── メイン: 予定ヒアリング中
                    │ (予定収集中)      │ ←── 不足→フォローアップ
                    └────┬─────────────┘
                         │ 全日程OK
                    ┌────▼─────────────┐
                    │ VALIDATE         │ ◄── ビジネスルール検証
                    │ (検証中)          │     (時間帯・祝日チェック)
                    └────┬─────────────┘
                         │ 検証OK
                    ┌────▼─────────────┐
                    │ CONFIRM          │
                    │ (最終確認)        │
                    └────┬─────────────┘
                    ┌────▼─────┐  ┌────▼─────┐
                    │ SAVED    │  │ EDITING  │
                    │ (保存済) │  │ (修正中) │
                    └────┬─────┘  └────┬─────┘
                         │              │
                    ┌────▼─────────────┐│
                    │ MODIFY           ││ ◄── 「予定変更」(前月末まで)
                    │ (変更受付)        │┘
                    └──────────────────┘
                    ┌──────────────────┐
                    │ CANCEL_REQUEST   │ ◄── 「今日休みます」(当月の緊急)
                    │ (緊急キャンセル)  │
                    └──────────────────┘
```

### 6.2 各状態の詳細

#### IDLE → AUTH_LINK (未連携時)
**トリガー**: follow イベント、または未連携ユーザーからのメッセージ
**Bot応答**:
```
あゆっこ保育所へようこそ！🏫
お子さまの利用予定をLINEで簡単に提出できます。

最初にアカウント連携が必要です。
保育所から配布された「連携コード」を入力してください。
例: AYK-1234
```

#### AUTH_LINK → SELECT_CHILD
**トリガー**: 有効な連携コード入力
**処理**: link_codesテーブル検索 → line_accountsに登録 → 追加連携確認

#### SELECT_CHILD → SELECT_MONTH
**Bot応答例** (複数児童の場合):
```
○○ちゃん、△△くんが登録されています。
どのお子さまの予定を入力しますか？
① ○○ちゃん（0歳児クラス）
② △△くん（1歳児クラス）
③ 全員まとめて入力
```

#### SELECT_MONTH → COLLECTING
**Bot応答例**:
```
○○ちゃんの2026年4月の利用予定を聞きますね📅

まず、基本的な利用パターンを教えてください：
・通常の利用曜日は？（例: 月〜金）
・通常の登園時間と降園時間は？

まとめて教えていただいてもOKです！
例:「月〜金 8:30-17:00」
```

#### COLLECTING (メインヒアリングループ)

**収集すべきデータ（1日分） v2.0**:
```
├── day: 日 (1-31)
├── planned_start: 登園予定時刻 (HH:MM)
├── planned_end: 降園予定時刻 (HH:MM)
├── breakfast_flag: 朝食 (0/1)      ← ★ v2.0追加
├── lunch_flag: 昼食 (0/1)
├── am_snack_flag: 午前おやつ (0/1)
├── pm_snack_flag: 午後おやつ (0/1)
└── dinner_flag: 夕食 (0/1)
```

**ヒアリングの戦略 (v2.0)**:
1. **まずパターン入力**: 「月〜金 8:30-17:00」のように基本パターンを収集
2. **例外日の確認**: 「お休みの日はありますか？」「時間が違う日は？」
3. **食事の自動推定**: 時間帯から5種の食事フラグを自動推定し、確認のみ行う
4. **朝食の確認** (v2.0): 7:30より前の登園がある場合のみ、朝食希望を確認
5. **抜け漏れチェック**: 全営業日をカバーしているか確認

**食事フラグ自動推定 → 確認の流れ**:
```
入力: "月〜金 8:30-17:00"

AIの内部推定:
├── breakfast_flag: 0 (8:30 ≥ 7:30なので朝食なし)
├── lunch_flag: 1 (8:30 ≤ 11:30)
├── am_snack_flag: 1 (8:30 ≤ 10:00)
├── pm_snack_flag: 1 (17:00 ≥ 15:00)
└── dinner_flag: 0 (17:00 < 20:00)

Bot確認:
「食事は以下で合っていますか？
 🍙 朝おやつ + 🍱 昼食 + 🍪 午後おやつ
（朝食・夕食はなし）
① はい
② いいえ、変更があります」
```

**朝食がある場合の追加確認 (v2.0)**:
```
入力: "月〜金 7:00-17:00"

Bot:
「7:00登園ですと早朝保育（7:00-7:30）になります。
 朝食（¥150/食）も希望されますか？
 ① はい、朝食もお願いします
 ② いいえ、朝食は不要です」
```

**フォローアップ質問例**:
```
[不足: 食事情報]
「4/15は20時まで延長とのことですが、夕食（¥300/食）も希望されますか？」

[不足: 土曜日]
「4月の土曜日（5日, 12日, 19日, 26日）はお預かりの予定はありますか？」

[矛盾検出]
「4/29は祝日（昭和の日）ですが、利用予定でよろしいですか？」

[早朝保育料の注意]
「7:00登園ですと早朝保育（7:00-7:30）の扱いになります。
 別途料金: 300円/回。よろしいですか？」

[延長保育料の注意]  ← v2.0修正
「降園が20:30ですと延長保育（20:00-21:00）の扱いになります。
 別途料金: 300円/回。よろしいですか？」
```

#### COLLECTING → VALIDATE → CONFIRM
**全日程がカバーされたとAIが判断したとき:**
```
○○ちゃんの4月の利用予定をまとめました：

📅 基本パターン: 月〜金 8:30-17:00
🍽 食事: 朝おやつ + 昼食 + 午後おやつ

📋 詳細:
4/1(火) 8:30-17:00 🍙🍱🍪
4/2(水) 8:30-17:00 🍙🍱🍪
4/3(木) 8:30-17:00 🍙🍱🍪
...
4/10(木) お休み ❌
...
4/15(火) 7:00-20:30 🍳🍙🍱🍪🍽 ← 早朝+延長+朝食+夕食
...
4/22(火) お休み ❌

合計: 19日利用予定

この内容でよろしいですか？
① はい、登録してください
② 修正があります
```

> **食事アイコン凡例** (v2.0):
> 🍳 = 朝食, 🍙 = 朝おやつ, 🍱 = 昼食, 🍪 = 午後おやつ, 🍽 = 夕食

#### CONFIRM → SAVED
```
✅ 4月の利用予定を登録しました！（19日分）

変更が必要な場合は、3月31日までにこのLINEで
「予定変更」と送ってください。
4月に入ると変更はロックされます（緊急キャンセルを除く）。

他のお子さまの予定も入力しますか？
```

### 6.3 AIプロンプト設計 (v2.0)

#### システムプロンプト
```
あなたは「あゆっこ保育所」の予定入力アシスタントです。

【役割】
保護者から来月の利用予定（登園・降園時間、食事希望）を聞き取り、
データベースに登録可能な構造化データに変換します。

【対応範囲】
✅ 利用予定の入力・変更・確認・キャンセル
❌ 保育の質問、料金の相談、クレーム、雑談、その他一切

予定以外の質問には必ず以下を返してください:
「申し訳ありませんが、利用予定の入力のみ対応しています。
 その他のお問い合わせは保育所（XXX-XXXX）までお電話ください。」

【基本ルール】
1. 対象月の全営業日（月〜金 + 保護者が希望すれば土）をカバーすること
2. 1日あたり必要データ:
   日付, 登園時刻(HH:MM), 降園時刻(HH:MM),
   朝食(0/1), 昼食(0/1), 午前おやつ(0/1), 午後おやつ(0/1), 夕食(0/1)
3. 食事フラグは時間帯から自動推定し、確認のみ行う:
   - 登園 < 7:30  → breakfast = 1 (早朝保育で朝食提供)
   - 登園 ≤ 10:00 → am_snack = 1
   - 登園 ≤ 11:30 → lunch = 1
   - 降園 ≥ 15:00 → pm_snack = 1
   - 降園 ≥ 20:00 → dinner = 1
4. 保護者の入力はパターン指定（「月〜金 8:30-17:00」）を推奨
5. 例外日（休み、時間変更）を個別に確認
6. 祝日は自動判定し、利用の有無を確認
7. 全日程確定後、一覧を表示して最終確認を求める
8. 朝食は早朝保育利用時のみ確認する（通常保育では不要）

【注意: 時間帯の料金情報】★★★ システム側で判定するためLLMは案内のみ ★★★
- 早朝保育: 7:00-7:30 (別途料金)
- 通常保育: 7:30-20:00
- 延長保育: 20:00-21:00 (別途料金) ← ★18:00ではない
- 夜間保育: 21:00以降 (別途料金)

【応答スタイル】
- 丁寧語で、簡潔に
- 絵文字は適度に使用 (🍳🍙🍱🍪🍽📅✅❌)
- 1回の応答は5行以内を目安に
- 選択肢はFlex Messageのボタンを活用

【出力フォーマット】
予定データが確定したら、以下のJSON構造で出力:
{
  "action": "save_schedule",
  "child_id": "...",
  "year": 2026,
  "month": 4,
  "days": [
    {"day": 1, "planned_start": "8:30", "planned_end": "17:00",
     "breakfast_flag": 0, "lunch_flag": 1, "am_snack_flag": 1,
     "pm_snack_flag": 1, "dinner_flag": 0},
    ...
  ]
}
```

#### ツール定義 (Function Calling) v2.0
```json
{
  "name": "save_schedule",
  "description": "確認済みの利用予定をDBに保存する",
  "parameters": {
    "type": "object",
    "properties": {
      "child_id": { "type": "string" },
      "year": { "type": "integer" },
      "month": { "type": "integer" },
      "days": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "day": { "type": "integer" },
            "planned_start": { "type": "string", "pattern": "^\\d{1,2}:\\d{2}$" },
            "planned_end": { "type": "string", "pattern": "^\\d{1,2}:\\d{2}$" },
            "breakfast_flag": { "type": "integer", "enum": [0, 1] },
            "lunch_flag": { "type": "integer", "enum": [0, 1] },
            "am_snack_flag": { "type": "integer", "enum": [0, 1] },
            "pm_snack_flag": { "type": "integer", "enum": [0, 1] },
            "dinner_flag": { "type": "integer", "enum": [0, 1] }
          },
          "required": ["day"]
        }
      }
    },
    "required": ["child_id", "year", "month", "days"]
  }
}
```

### 6.4 LLMプロバイダ設計

| 項目 | 設定 |
|------|------|
| プロバイダ | OpenAI (GPT-4o-mini 推奨) |
| モデル | gpt-4o-mini (コスト効率◎、日本語対応◎) |
| Temperature | 0.3 (一貫性重視) |
| Max tokens | 1024 |
| Timeout | 15秒 |
| Fallback | gpt-4o (mini失敗時) |
| API Key保存 | Cloudflare Secret (`OPENAI_API_KEY`) |

**重要な設計方針**: LLMは「テキスト→構造化データ変換」と「不足項目の質問生成」のみを担当。
ビジネスルール（変更ロック、料金計算、日付検証）は **すべてシステム側のTypeScriptコードで実施**。
LLMにビジネスルール判定を委ねない。

---

## 7. 複数児童対応設計

### 7.1 1LINEユーザー → 複数児童のマッピング

```
line_accounts テーブル:
┌──────────────────┬──────────────────┬─────────────────┐
│ line_user_id     │ child_id         │ display_name    │
│ U1234567890abcd  │ child_mondal_aum │ ○○ちゃん(0歳児) │
│ U1234567890abcd  │ child_tanaka_yui │ △△ちゃん(1歳児) │
│ U9876543210wxyz  │ child_suzuki_ken │ □□くん(2歳児)   │
└──────────────────┴──────────────────┴─────────────────┘
```

### 7.2 複数児童の会話フロー

```
Bot: "予定入力を始めます。お子さまを選択してください：
     ① ○○ちゃん（0歳児クラス）
     ② △△ちゃん（1歳児クラス）
     ③ 全員まとめて入力"

--- パターンA: 個別入力 ---
保護者: "①"
Bot: "○○ちゃんの4月の予定を聞きますね..."
(ヒアリング完了)
Bot: "○○ちゃんの予定を登録しました。
     次に△△ちゃんの予定も入力しますか？"

--- パターンB: まとめて入力 ---
保護者: "③"
Bot: "2名分まとめて入力しますね。
     2人とも同じ利用パターンですか？
     ① 同じパターン
     ② 別々のパターン"

保護者: "①"
Bot: "では、共通の利用パターンを教えてください..."
(共通パターン収集 → 個別の例外確認)
Bot: "○○ちゃんだけの例外日はありますか？"
Bot: "△△ちゃんだけの例外日はありますか？"
```

### 7.3 食事の個別対応

```
Bot: "△△ちゃんはアレルギー食対応ですね。
     食事内容について個別に確認させてください。
     △△ちゃんの昼食は毎日アレルギー対応食でよろしいですか？"
```

> **注**: アレルギーフラグは `children.is_allergy` で管理。
> LINE収集時にAIがアレルギー児童を自動検出し、食事確認時にアレルギー対応を明示。

---

## 8. 変更ルール・ロック仕様

### 8.1 変更可能期間ルール

```
対象月: 2026年4月

┌──────────────────────────────────────────────────────────┐
│                        3月                               │
│  [───────── 自由に入力・変更 ─────────]                  │
│  3/1                                   3/31 23:59 JST   │
│                                        ↑ 変更締切        │
├──────────────────────────────────────────────────────────┤
│                        4月                               │
│  [──── ロック（緊急キャンセルのみ） ────]                 │
│  4/1                                   4/30              │
└──────────────────────────────────────────────────────────┘
```

### 8.2 変更種別と可否マトリックス

| 変更種別 | 前月末まで | 当月(通常) | 当月(緊急) |
|----------|-----------|-----------|-----------|
| 新規入力 | ✅ 可 | ❌ 不可 | ❌ 不可 |
| 新規日追加 | ✅ 可 | ❌ 不可 | ❌ 不可 |
| 日程削除 (お休み) | ✅ 可 | ❌ 不可 | ✅ 可 (病欠等) |
| 時間変更 | ✅ 可 | ❌ 不可 | ❌ 不可 |
| 食事変更 | ✅ 可 | ❌ 不可 | ❌ 不可 |
| 全面差替え | ✅ 可 | ❌ 不可 | ❌ 不可 |

### 8.3 緊急キャンセルフロー

```
保護者: "今日休みます。子供が熱出しました。"

Bot: (ロック中を検出)
     "4月の予定はロックされていますが、
      緊急キャンセル（病欠等）は承ります。
      
      ○○ちゃん 4/8(火) のお休みを登録しますか？
      ① はい（病欠として登録）
      ② いいえ"

保護者: "①"

Bot: "✅ ○○ちゃんの4/8(火)を病欠として登録しました。
      お大事にしてください。🙏"

処理:
  1. emergency_cancellations テーブルに記録
  2. schedule_plans の該当日は削除しない（元の予定は保持）
  3. schedule_change_requests に変更記録を追加
```

### 8.4 ロック判定ロジック

```typescript
function canModifySchedule(
  targetYear: number,
  targetMonth: number,
  changeType: 'add' | 'delete' | 'modify' | 'replace' | 'emergency_cancel',
  now: Date
): { allowed: boolean; reason: string } {
  
  // JST変換
  const nowJST = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  
  // 対象月の前月末日 23:59:59 JST
  const deadline = new Date(targetYear, targetMonth - 1, 0, 23, 59, 59);
  
  // 対象月の初日
  const targetStart = new Date(targetYear, targetMonth - 1, 1);
  
  if (nowJST <= deadline) {
    return { allowed: true, reason: '変更可能期間内' };
  }
  
  if (changeType === 'emergency_cancel' && nowJST >= targetStart) {
    return { allowed: true, reason: '緊急キャンセル（当月中）' };
  }
  
  return { 
    allowed: false, 
    reason: `変更締切を過ぎています（${targetMonth}月分は${targetMonth-1}月末日まで）`
  };
}
```

---

## 9. データベーススキーマ拡張

### 9.1 新規テーブル一覧

#### 9.1.1 `line_accounts` — LINEアカウント連携

```sql
CREATE TABLE IF NOT EXISTS line_accounts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  line_user_id TEXT NOT NULL,             -- LINE userId (U + 32hex)
  child_id TEXT NOT NULL REFERENCES children(id),
  line_display_name TEXT,                 -- LINEの表示名
  linked_at TEXT DEFAULT (datetime('now')),
  is_active INTEGER DEFAULT 1,
  UNIQUE(line_user_id, child_id)
);
CREATE INDEX IF NOT EXISTS idx_line_accounts_user ON line_accounts(line_user_id);
CREATE INDEX IF NOT EXISTS idx_line_accounts_child ON line_accounts(child_id);
```

#### 9.1.2 `link_codes` — アカウント連携コード

```sql
CREATE TABLE IF NOT EXISTS link_codes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  code TEXT NOT NULL UNIQUE,              -- 'AYK-XXXX'
  child_id TEXT NOT NULL REFERENCES children(id),
  nursery_id TEXT NOT NULL REFERENCES nurseries(id),
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,               -- 有効期限 (30日後)
  used_at TEXT,                           -- 使用日時 (NULL=未使用)
  used_by_line_user_id TEXT               -- 使用したLINE userId
);
CREATE INDEX IF NOT EXISTS idx_link_codes_code ON link_codes(code);
CREATE INDEX IF NOT EXISTS idx_link_codes_child ON link_codes(child_id);
```

#### 9.1.3 `conversations` — 会話状態管理

```sql
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  line_user_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'IDLE'
    CHECK(state IN (
      'IDLE','AUTH_LINK','SELECT_CHILD','SELECT_MONTH',
      'COLLECTING','VALIDATE','CONFIRM','SAVED',
      'EDITING','MODIFY','CANCEL_REQUEST'
    )),
  target_child_id TEXT REFERENCES children(id),
  target_year INTEGER,
  target_month INTEGER,
  collected_data_json TEXT,               -- 収集済み予定データ (JSON)
  ai_context_json TEXT,                   -- LLM会話履歴 (最新10ターン)
  multi_child_mode TEXT DEFAULT 'single'  -- 'single' | 'batch'
    CHECK(multi_child_mode IN ('single','batch')),
  batch_children_json TEXT,               -- バッチモード時の対象児童リスト
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT                          -- 24時間後に自動リセット
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(line_user_id);
```

#### 9.1.4 `conversation_logs` — 会話ログ

```sql
CREATE TABLE IF NOT EXISTS conversation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  line_user_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')),
  message_type TEXT NOT NULL,             -- 'text', 'postback', 'flex', 'system'
  content TEXT NOT NULL,                  -- メッセージ本文
  ai_raw_response TEXT,                   -- LLM生レスポンス (outgoing時)
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conv_logs_conv ON conversation_logs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conv_logs_user ON conversation_logs(line_user_id);
```

#### 9.1.5 `emergency_cancellations` — 緊急キャンセル記録

```sql
CREATE TABLE IF NOT EXISTS emergency_cancellations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  child_id TEXT NOT NULL REFERENCES children(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  reason TEXT,                            -- 'illness', 'family', 'other'
  reason_detail TEXT,                     -- 自由テキスト (例: "発熱のため")
  cancelled_by TEXT NOT NULL DEFAULT 'LINE', -- 'LINE' or 'admin'
  line_user_id TEXT,
  original_start TEXT,                    -- 元の予定開始
  original_end TEXT,                      -- 元の予定終了
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(child_id, year, month, day)
);
```

#### 9.1.6 `schedule_change_requests` — 変更リクエスト記録 (v2.0新規)

```sql
CREATE TABLE IF NOT EXISTS schedule_change_requests (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  child_id TEXT NOT NULL REFERENCES children(id),
  line_user_id TEXT,                      -- LINE経由ならセット
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  change_type TEXT NOT NULL CHECK(change_type IN (
    'initial_submit',     -- 初回提出
    'modify',             -- 前月末までの変更
    'replace',            -- 全面差替え
    'emergency_cancel'    -- 緊急キャンセル
  )),
  status TEXT NOT NULL DEFAULT 'applied' CHECK(status IN (
    'pending',            -- 承認待ち (将来: 管理者承認フロー用)
    'applied',            -- 適用済み
    'rejected',           -- 却下
    'expired'             -- 期限切れ
  )),
  changes_json TEXT NOT NULL,             -- 変更内容 (JSON)
  -- changes_json 例:
  -- {"days_added": [5, 12], "days_removed": [10, 22],
  --  "days_modified": [{"day": 15, "field": "planned_end", "from": "17:00", "to": "20:30"}]}
  conversation_id TEXT REFERENCES conversations(id),
  applied_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_change_req_child ON schedule_change_requests(child_id, year, month);
```

### 9.2 既存テーブルへの変更

#### `schedule_plans` テーブル — breakfast_flag 追加

```sql
-- ★ v2.0: 朝食フラグ追加
ALTER TABLE schedule_plans ADD COLUMN breakfast_flag INTEGER DEFAULT 0;
```

**source_file カラムの値追加** (変更不要、既存TEXT型で対応):
```
'UI入力'     → 管理画面 (既存)
'Excel'      → アップロード (既存)
'LINE'       → LINE経由の初回提出
'LINE_修正'  → LINE経由の変更
'LINE_緊急'  → LINE経由の緊急キャンセル
```

#### `usage_facts` テーブル — has_breakfast 追加

```sql
-- ★ v2.0: 朝食フラグ追加 (Python Generator側は既に対応済み)
ALTER TABLE usage_facts ADD COLUMN has_breakfast INTEGER DEFAULT 0;
```

#### `charge_lines` テーブル — breakfast charge_type 追加

```sql
-- ★ v2.0: 朝食の課金種別追加
-- 既存のCHECK制約を更新する必要がある
-- D1ではALTER TABLE ... DROP CONSTRAINTができないため、
-- 新テーブル作成→データ移行→旧テーブル削除→リネームが必要
-- → 実装時に判断（CHECK制約を外すか、マイグレーションで対応）
```

---

## 10. 既存スキーマとの設計差分

### 10.1 REQUIREMENTS.md との対比

| 項目 | REQUIREMENTS.md (v3.1) | 現在のDB (0001) | LINE計画 (v2.0) | 対応方針 |
|------|----------------------|----------------|----------------|---------|
| 食事区分 | 4種 (昼食/朝おやつ/午後おやつ/夕食) | 4カラム | **5種** (+朝食) | 0002マイグレーションで追加 |
| 予定入力元 | Excel or UI入力 | source_file='UI入力' | source_file='LINE' | 既存TEXTカラムで対応 |
| 変更履歴 | なし | なし | schedule_change_requests | 新テーブル |
| 緊急キャンセル | なし | なし | emergency_cancellations | 新テーブル |
| 予定確定/ロック | 未実装 (A-3 ⚠️) | なし | ロック判定ロジック | TypeScriptで実装 |

### 10.2 Python Generator との整合

| 項目 | Python Generator (現状) | TypeScript (現状) | LINE計画 (v2.0) |
|------|----------------------|-------------------|----------------|
| has_breakfast | ✅ usage_calculator.py L133 | ❌ なし | ✅ 追加 |
| breakfast charge | ✅ charge_calculator.py L99 (¥150) | ❌ なし | ✅ 追加 |
| extension_start | ✅ 20:00 | ❌ seed.sql 18:00 | ⚠️ seed.sql修正は別タスク |
| night_start | ✅ 21:00 | ❌ seed.sql 20:00 | ⚠️ seed.sql修正は別タスク |

> **注**: seed.sql の extension_start/night_start の修正は REQUIREMENTS_CHECK.md #1 として
> 別タスクで対応。LINE計画のプロンプトでは正しい値 (20:00/21:00) を使用する。

### 10.3 紙予定表Excel (§2.1-A) からの変換ルール

紙予定表の「おやつ(〇)」は朝おやつ+午後おやつを区別しない。
LINE収集では時間帯から自動分離する:

```
紙: おやつ = 〇 (K列/V列)
LINE:
  登園 ≤ 10:00 → am_snack_flag = 1
  降園 ≥ 15:00 → pm_snack_flag = 1
  両方 → 両方 = 1
```

---

## 11. API設計

### 11.1 LINE Webhook エンドポイント

#### `POST /api/line/webhook`
LINE Platformからのイベント受信。

```
Headers:
  X-Line-Signature: (HMAC-SHA256署名)
  Content-Type: application/json

Body:
{
  "destination": "Uxxxxxxxxx",
  "events": [
    {
      "type": "message",
      "message": { "type": "text", "text": "..." },
      "replyToken": "xxx",
      "source": { "type": "user", "userId": "Uxxxxxxxxx" }
    }
  ]
}

Response: 200 OK (即座に返す)
```

**署名検証 (Cloudflare Workers / Web Crypto API)**:
```typescript
async function verifySignature(
  body: string, signature: string, secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return expected === signature;
}
```

#### イベント種別ハンドリング

| イベント | 処理 |
|---------|------|
| `follow` | ウェルカムメッセージ送信、連携案内 |
| `unfollow` | `line_accounts.is_active = 0` |
| `message` (text) | AI会話エンジンへ |
| `postback` | ボタン操作処理 (児童選択、確認等) |

### 11.2 管理者向け LINE 管理 API

#### `POST /api/line/link-codes`
連携コード発行。
```json
// Request
{ "child_id": "child_mondal_aum" }
// Response
{ "code": "AYK-3F7K", "expires_at": "2026-04-03T00:00:00Z" }
```

#### `GET /api/line/accounts`
LINE連携状態一覧。

#### `GET /api/line/conversations?status=COLLECTING`
進行中の会話一覧 (管理者モニタリング用)。

#### `POST /api/line/send-reminders`
手動リマインド送信 (管理画面から)。

#### `GET /api/line/logs/:lineUserId`
特定ユーザーの会話ログ取得。

#### `GET /api/line/submission-status?year=2026&month=4`
提出状況一覧 (提出済み/未提出)。

#### `GET /api/line/change-requests?child_id=xxx&year=2026&month=4`
変更リクエスト履歴。

### 11.3 Cron Trigger (リマインド)

```
Schedule:
  - "0 1 20 * *"  (毎月20日 10:00 JST = 01:00 UTC)
  - "0 1 27 * *"  (毎月27日 10:00 JST = 01:00 UTC)

実装方法:
  Option 1: 別Cloudflare Worker (ayukko-reminder-worker) + Cron Trigger
  Option 2: 管理画面の「リマインド送信」ボタンで手動送信
  推奨: Option 1 + Option 2 (自動+手動バックアップ)
```

---

## 12. セキュリティ・プライバシー

### 12.1 個人情報保護

| データ | 分類 | 保護措置 |
|--------|------|---------|
| LINE userId | 個人識別子 | DB内のみ保持、外部に露出しない |
| 児童氏名 | 個人情報 | 既存のアクセス制御に準拠 |
| 会話ログ | 個人情報 | 90日後に自動削除 |
| LLM送信データ | 要注意 | 児童名をイニシャルに変換して送信 |

### 12.2 LLMへの送信データのマスキング

```
送信前: "○○ちゃんの4月の予定を登録しました"
LLMへ:  "Child_Aの4月の予定を登録しました"
復元:   Child_A → child_mondal_aum (サーバー側マッピング)
```

### 12.3 Cloudflare Secrets 一覧

```bash
wrangler pages secret put LINE_CHANNEL_ID --project-name ayukko-nursery
wrangler pages secret put LINE_CHANNEL_SECRET --project-name ayukko-nursery
wrangler pages secret put LINE_CHANNEL_ACCESS_TOKEN --project-name ayukko-nursery
wrangler pages secret put OPENAI_API_KEY --project-name ayukko-nursery
```

**`.dev.vars` (ローカル開発用)**:
```
LINE_CHANNEL_ID=your_channel_id
LINE_CHANNEL_SECRET=your_channel_secret
LINE_CHANNEL_ACCESS_TOKEN=your_channel_access_token
OPENAI_API_KEY=your_openai_api_key
```

---

## 13. 料金・コスト見積

### 13.1 LINE公式アカウント

| プラン | 月額 | 無料メッセージ | 追加 |
|--------|------|--------------|------|
| コミュニケーション (無料) | ¥0 | 200通/月 | 不可 |
| ライト | ¥5,000 | 5,000通/月 | ¥3/通 |
| スタンダード | ¥15,000 | 30,000通/月 | ~¥3/通 |

**あゆっこの想定**:
- Reply Message はカウント対象外
- Push Message (リマインド): 30名 × 2回 = 60通/月
- **→ フリープランで運用可能な可能性が高い** (Reply中心)
- Push上限超過に備えてライトプラン (¥5,000) も選択肢

### 13.2 OpenAI API (gpt-4o-mini)

| 項目 | 見積 |
|------|------|
| 1会話あたり | ~10ターン × (2000 input + 200 output) tokens |
| 月間 | 30園児 × 22,000 tokens = 660,000 tokens |
| コスト | Input: $0.15/1M × 0.6M = $0.09, Output: $0.60/1M × 0.06M = $0.036 |
| **月額合計** | **~$0.13 (~20円/月)** |

### 13.3 月額合計

| 項目 | コスト |
|------|--------|
| LINE (フリープラン/Reply中心) | ¥0 |
| OpenAI API | ¥20 |
| Cloudflare (Free) | ¥0 |
| **合計** | **¥20/月** (フリープラン時) |
| LINE ライトプラン利用時 | **¥5,020/月** |

---

## 14. 依存関係・技術スタック

### 14.1 新規依存パッケージ

```json
{
  "dependencies": {
    "hono": "^4.0.0"
    // LINE SDK不要 — Cloudflare Workers非対応のためfetch直接呼出
    // OpenAI SDK不要 — fetch直接呼出 (Workers互換性のため)
  }
}
```

**注意**: `@line/bot-sdk` は Node.js依存 (http, crypto) のため使用不可。
LINE APIはfetch + Web Crypto APIで直接呼び出す。

### 14.2 LINE APIクライアント設計 (SDKなし)

```typescript
// src/lib/line-client.ts
export class LineClient {
  private accessToken: string;
  private channelSecret: string;
  private baseUrl = 'https://api.line.me/v2/bot';

  constructor(accessToken: string, channelSecret: string) {
    this.accessToken = accessToken;
    this.channelSecret = channelSecret;
  }

  async verifySignature(body: string, signature: string): Promise<boolean> {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(this.channelSecret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
    const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
    return expected === signature;
  }

  async reply(replyToken: string, messages: LineMessage[]): Promise<void> {
    await fetch(`${this.baseUrl}/message/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({ replyToken, messages }),
    });
  }

  async push(to: string, messages: LineMessage[]): Promise<void> {
    await fetch(`${this.baseUrl}/message/push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({ to, messages }),
    });
  }

  async getProfile(userId: string): Promise<LineProfile> {
    const res = await fetch(`${this.baseUrl}/profile/${userId}`, {
      headers: { 'Authorization': `Bearer ${this.accessToken}` },
    });
    return res.json();
  }
}
```

### 14.3 Bindings拡張

```typescript
// src/types/index.ts に追加
export type Bindings = {
  DB: D1Database;
  R2: R2Bucket;
  // LINE連携用
  LINE_CHANNEL_ID: string;
  LINE_CHANNEL_SECRET: string;
  LINE_CHANNEL_ACCESS_TOKEN: string;
  OPENAI_API_KEY: string;
};
```

---

## 15. マイグレーション計画

### 15.1 マイグレーションSQL 完全版

```sql
-- ============================================================
-- migrations/0002_line_integration.sql
-- あゆっこ保育園 業務自動化システム
-- Purpose: LINE Messaging API 連携 + 朝食対応
-- Created: 2026-03-XX (実装時に日付確定)
-- ============================================================

-- ============================================================
-- Phase A: 既存テーブルの拡張
-- ============================================================

-- A-1: schedule_plans に朝食フラグ追加
--   紙予定表には朝食列がないが、保育時間(提出用)シートのcol+4に朝食列がある。
--   Python Generator (usage_calculator.py L133) は has_breakfast を使用。
--   charge_calculator.py L99 で ¥150/食として計算済み。
ALTER TABLE schedule_plans ADD COLUMN breakfast_flag INTEGER DEFAULT 0;

-- A-2: usage_facts に朝食フラグ追加
--   Python Generator側は既に has_breakfast を出力しているが、
--   TypeScript側のDBスキーマに反映されていなかった。
ALTER TABLE usage_facts ADD COLUMN has_breakfast INTEGER DEFAULT 0;

-- ============================================================
-- Phase B: LINE連携テーブル
-- ============================================================

-- B-1: LINEアカウント連携
CREATE TABLE IF NOT EXISTS line_accounts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  line_user_id TEXT NOT NULL,
  child_id TEXT NOT NULL REFERENCES children(id),
  line_display_name TEXT,
  linked_at TEXT DEFAULT (datetime('now')),
  is_active INTEGER DEFAULT 1,
  UNIQUE(line_user_id, child_id)
);
CREATE INDEX IF NOT EXISTS idx_line_accounts_user ON line_accounts(line_user_id);
CREATE INDEX IF NOT EXISTS idx_line_accounts_child ON line_accounts(child_id);

-- B-2: アカウント連携コード
CREATE TABLE IF NOT EXISTS link_codes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  code TEXT NOT NULL UNIQUE,
  child_id TEXT NOT NULL REFERENCES children(id),
  nursery_id TEXT NOT NULL REFERENCES nurseries(id),
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by_line_user_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_link_codes_code ON link_codes(code);
CREATE INDEX IF NOT EXISTS idx_link_codes_child ON link_codes(child_id);

-- B-3: 会話状態管理
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  line_user_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'IDLE'
    CHECK(state IN (
      'IDLE','AUTH_LINK','SELECT_CHILD','SELECT_MONTH',
      'COLLECTING','VALIDATE','CONFIRM','SAVED',
      'EDITING','MODIFY','CANCEL_REQUEST'
    )),
  target_child_id TEXT REFERENCES children(id),
  target_year INTEGER,
  target_month INTEGER,
  collected_data_json TEXT,
  ai_context_json TEXT,
  multi_child_mode TEXT DEFAULT 'single'
    CHECK(multi_child_mode IN ('single','batch')),
  batch_children_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(line_user_id);

-- B-4: 会話ログ
CREATE TABLE IF NOT EXISTS conversation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  line_user_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')),
  message_type TEXT NOT NULL,
  content TEXT NOT NULL,
  ai_raw_response TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conv_logs_conv ON conversation_logs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_conv_logs_user ON conversation_logs(line_user_id);

-- ============================================================
-- Phase C: 変更管理テーブル
-- ============================================================

-- C-1: 緊急キャンセル記録
CREATE TABLE IF NOT EXISTS emergency_cancellations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  child_id TEXT NOT NULL REFERENCES children(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  reason TEXT,
  reason_detail TEXT,
  cancelled_by TEXT NOT NULL DEFAULT 'LINE',
  line_user_id TEXT,
  original_start TEXT,
  original_end TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(child_id, year, month, day)
);

-- C-2: 変更リクエスト記録 (監査トレイル)
CREATE TABLE IF NOT EXISTS schedule_change_requests (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  child_id TEXT NOT NULL REFERENCES children(id),
  line_user_id TEXT,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  change_type TEXT NOT NULL CHECK(change_type IN (
    'initial_submit','modify','replace','emergency_cancel'
  )),
  status TEXT NOT NULL DEFAULT 'applied' CHECK(status IN (
    'pending','applied','rejected','expired'
  )),
  changes_json TEXT NOT NULL,
  conversation_id TEXT REFERENCES conversations(id),
  applied_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_change_req_child
  ON schedule_change_requests(child_id, year, month);
```

### 15.2 段階的マイグレーション方針

```
Phase A: 既存テーブル拡張 (LINE実装前でも適用可能)
  └── breakfast_flag, has_breakfast の追加
  └── ★ 既存のUI入力/ダッシュボードにも朝食対応を入れられる

Phase B: LINE連携テーブル (LINE実装と同時)
  └── line_accounts, link_codes, conversations, conversation_logs

Phase C: 変更管理テーブル (LINE実装と同時)
  └── emergency_cancellations, schedule_change_requests
```

---

## 16. 実装ロードマップ

### 16.1 全体スケジュール

```
Week 1-2: 基盤構築
├── Day 1: DBマイグレーション (0002) 適用
├── Day 2: LINE公式アカウント開設 + Messaging API有効化
├── Day 3-4: LINE Webhookハンドラ + 署名検証
├── Day 5-6: アカウント連携 (連携コード発行 + 入力処理)
├── Day 7-8: LINEクライアント (Reply/Push/Profile)
└── Day 9-10: 管理画面に「連携コード発行」「LINE連携状態」UI追加

Week 3-4: AI会話エンジン
├── Day 11-12: 会話状態マシン実装
├── Day 13-14: OpenAI連携 (Function Calling)
├── Day 15-16: 予定収集ロジック (パターン入力→展開→食事5種推定)
├── Day 17-18: フォローアップ質問生成 + 朝食確認フロー
└── Day 19-20: 確認・保存フロー (schedule_plans UPSERT)

Week 5: 変更・ロック・リマインド
├── Day 21-22: 変更ルール判定 + ロックロジック
├── Day 23-24: 緊急キャンセルフロー + schedule_change_requests記録
└── Day 25-26: Cronリマインド (別Worker or 管理画面ボタン)

Week 6: テスト・調整・デプロイ
├── Day 27-28: E2Eテスト (LINEテストツール)
├── Day 29: セキュリティレビュー
└── Day 30: 本番デプロイ + ドキュメント整備
```

### 16.2 MVP定義

**Phase 1 MVP (Week 1-4)**:
- ✅ LINE友だち追加 → アカウント連携
- ✅ 「予定入力」→ AI会話で1児童分の1ヶ月予定収集 (食事5種対応)
- ✅ 確認 → schedule_plansに保存 (source_file='LINE')
- ❌ 複数児童バッチモード (Phase 2)
- ❌ 変更・ロック (Phase 2)
- ❌ Cronリマインド (Phase 2)

**Phase 2 (Week 5-6)**:
- ✅ 複数児童対応
- ✅ 変更ルール + ロック
- ✅ 緊急キャンセル
- ✅ Cronリマインド

### 16.3 実装前の準備チェックリスト

- [ ] LINE公式アカウントの開設 (LINE Business ID)
- [ ] Messaging APIの有効化 (LINE Developers Console)
- [ ] Channel ID / Secret / Access Token の取得
- [ ] OpenAI APIキーの取得
- [ ] 本計画書のレビュー・承認 (モギモギ氏 + 木村さん)
- [ ] 0002マイグレーションの承認

---

## 17. テスト計画

### 17.1 テストシナリオ

#### 正常系
1. 新規ユーザーが友だち追加 → 連携コード入力 → 連携完了
2. 「予定入力」→ 基本パターン入力 → 例外日指定 → 食事5種確認 → 保存
3. 早朝保育児 → 朝食確認フロー発動 → breakfast_flag=1で保存
4. 前月内に変更依頼 → 変更完了 → schedule_change_requestsに記録
5. 複数児童ユーザーが児童選択 → 各児童の予定入力

#### 異常系
6. 無効な連携コード → エラーメッセージ
7. ロック中に変更依頼 → ロック通知
8. 予定以外の質問 → スコープ外メッセージ
9. 不正なWebhook署名 → 401拒否
10. AI応答タイムアウト → リトライ案内

#### 境界値
11. 月末日の23:59に変更 → 可
12. 翌月1日の00:00に変更 → ロック
13. 31日のある月 / 28日の月 → 正しい日数処理
14. 祝日を含む月 → 祝日確認メッセージ

### 17.2 データ整合性テスト

| テスト | 確認内容 |
|--------|---------|
| LINE → schedule_plans | source_file='LINE'で正しく保存 |
| breakfast_flag反映 | 早朝保育児のbreakfast_flag=1がDBに保存 |
| 既存ダッシュボード | LINE入力データがloadDashboardFromDB()で正常表示 |
| Python Generator | LINE入力データ (breakfast_flag含む) が帳票に正しく反映 |

---

## 18. 運用マニュアル

### 18.1 管理者の日常運用

| タイミング | 作業 | 場所 |
|-----------|------|------|
| 園児入園時 | 園児登録 → 連携コード発行 → 保護者に配布 | 管理画面 |
| 毎月20日 | (自動) 未提出者へリマインドPush配信 | 自動 |
| 毎月27日 | (自動) 未提出者へ再リマインド | 自動 |
| 毎月末 | 提出状況確認 → 未提出者への最終連絡 | 管理画面 |
| 翌月1日 | 前月提出分がロック → 緊急のみ受付 | 自動 |
| 退園時 | LINE連携解除 | 管理画面 |

### 18.2 保護者向け説明資料 (案)

```
📱 LINEで利用予定を提出する方法

1. QRコードを読み取って「あゆっこ保育所」を友だちに追加
2. 保育所から渡された「連携コード」(例: AYK-3F7K) をLINEで送信
3. 連携完了！

📅 毎月の予定提出方法:
1. 「予定入力」とLINEで送信
2. AIが聞いてくるので、利用パターンを回答
   例: 「月〜金 8:30-17:00 昼食あり おやつ午後のみ」
3. お休みの日や時間変更があれば伝える
4. 食事の確認画面が出るので確認
5. 最後に一覧が出るので「はい」を押す
6. 完了！

✏️ 変更したい場合:
- 前月末日まで: 「予定変更」とLINEで送信
- 当月: 緊急のお休み（病気等）のみ対応
  → 「今日休みます」とLINEで送信
```

### 18.3 障害対応

| 障害 | 影響 | 対応 |
|------|------|------|
| LINE API障害 | 応答不可 | 管理画面からUI入力で代替 |
| OpenAI API障害 | AI応答不可 | フォールバック定型文で対応 |
| D1障害 | 全機能停止 | Cloudflare Status確認 → 復旧待ち |
| 会話状態不整合 | 会話ループ | 管理画面から会話リセット |

---

## 付録A: Flex Messageテンプレート例

### A.1 児童選択ボタン
```json
{
  "type": "flex",
  "altText": "お子さまを選択してください",
  "contents": {
    "type": "bubble",
    "body": {
      "type": "box", "layout": "vertical",
      "contents": [
        { "type": "text", "text": "お子さまを選択してください", "weight": "bold" }
      ]
    },
    "footer": {
      "type": "box", "layout": "vertical",
      "contents": [
        {
          "type": "button",
          "action": { "type": "postback", "label": "○○ちゃん（0歳児）", "data": "select_child=child_001" },
          "style": "primary"
        },
        {
          "type": "button",
          "action": { "type": "postback", "label": "△△くん（1歳児）", "data": "select_child=child_002" },
          "style": "primary"
        }
      ]
    }
  }
}
```

### A.2 食事確認 (v2.0: 朝食含む)
```json
{
  "type": "flex",
  "altText": "食事の確認",
  "contents": {
    "type": "bubble",
    "body": {
      "type": "box", "layout": "vertical",
      "contents": [
        { "type": "text", "text": "🍽 食事の確認", "weight": "bold" },
        { "type": "separator" },
        { "type": "text", "text": "🍳 朝食: あり（早朝保育利用日のみ）", "size": "sm" },
        { "type": "text", "text": "🍙 朝おやつ: あり", "size": "sm" },
        { "type": "text", "text": "🍱 昼食: あり", "size": "sm" },
        { "type": "text", "text": "🍪 午後おやつ: あり", "size": "sm" },
        { "type": "text", "text": "🍽 夕食: なし", "size": "sm" }
      ]
    },
    "footer": {
      "type": "box", "layout": "horizontal",
      "contents": [
        {
          "type": "button",
          "action": { "type": "postback", "label": "✅ OK", "data": "meal_confirm=yes" },
          "style": "primary"
        },
        {
          "type": "button",
          "action": { "type": "postback", "label": "✏️ 変更", "data": "meal_confirm=edit" },
          "style": "secondary"
        }
      ]
    }
  }
}
```

---

## 付録B: 日本の祝日判定 (2026年)

```
1/1 (木) 元日
1/12 (月) 成人の日
2/11 (水) 建国記念の日
2/23 (月) 天皇誕生日
3/20 (金) 春分の日
4/29 (水) 昭和の日
5/3 (日) 憲法記念日
5/4 (月) みどりの日
5/5 (火) こどもの日
5/6 (水) 振替休日
7/20 (月) 海の日
8/11 (火) 山の日
9/21 (月) 敬老の日
9/22 (火) 秋分の日
10/12 (月) スポーツの日
11/3 (火) 文化の日
11/23 (月) 勤労感謝の日

※ 実装時は @holiday-jp/holiday_jp パッケージまたは
   内閣府APIを利用して自動判定する
```

---

## 付録C: エラーメッセージ一覧

| コード | メッセージ | 対応 |
|--------|----------|------|
| E001 | 連携コードが見つかりません | 正しいコードを再入力 |
| E002 | 連携コードの期限が切れています | 保育所に再発行依頼 |
| E003 | このコードは既に使用されています | 保育所に確認 |
| E004 | 変更締切を過ぎています | 緊急の場合はお電話 |
| E005 | AI応答エラー | しばらくしてから再試行 |
| E006 | 予定の保存に失敗しました | 管理者に連絡 |
| E007 | 対象月の予定は既にロックされています | 緊急キャンセルのみ可能 |
| E008 | アカウント連携が必要です | 連携コードを入力 |
| E009 | 対象の園児が見つかりません | 保育所に確認 |

---

## 付録D: wrangler.jsonc 更新計画

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "ayukko-nursery",
  "compatibility_date": "2024-09-23",
  "compatibility_flags": ["nodejs_compat"],
  "pages_build_output_dir": "./dist",
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "ayukko-production",
      "database_id": "placeholder-will-be-set-on-deploy"
    }
  ],
  "r2_buckets": [
    {
      "binding": "R2",
      "bucket_name": "ayukko-files"
    }
  ]
  // Cron Trigger は Pages では直接使えないため、
  // 別Worker (ayukko-reminder-worker) で実装
  // OR 管理画面の手動ボタンで代用
}
```

---

*この文書は設計計画のみです。実装コードは含まれていません。*
*実装着手前に、LINE公式アカウントの開設とOpenAI APIキーの準備が必要です。*

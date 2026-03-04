# LINE Messaging API 月次利用予定収集システム 設計計画書

> **Version**: 4.0 (2026-03-04)
> **Status**: Design Only (実装前 — Phase 2 Optional)
> **Author**: Ayukko Development Team
> **Parent System**: 保育施設業務自動化システム (マルチテナント版)
> **前版からの変更**: v3.0 → v4.0 LINE を Phase 2 Optional に明確格下げ、Web/PWA ポータルが Primary であることを宣言
> **関連ドキュメント**: [MULTI_FACILITY_DESIGN.md](./MULTI_FACILITY_DESIGN.md) (v2.0) — 複数施設対応 総合設計書

---

## ★★★ 重要: この文書の位置付け ★★★

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  本文書は Phase 2 の Optional 追加チャネル設計です。             │
│                                                                 │
│  要件①「保護者がスマホで月次予定入力」は                       │
│  Web/PWA ポータル単体で 100% 充足されます。                     │
│  (MULTI_FACILITY_DESIGN.md v2.0 セクション6 参照)               │
│                                                                 │
│  LINE は以下の場合にのみ有効化する追加チャネルです:             │
│    ・Web ポータルでの入力が難しいと感じる保護者がいる施設       │
│    ・園側が LINE でのリマインド通知を希望する場合               │
│    ・AI ヒアリングで入力体験を向上させたい施設                  │
│                                                                 │
│  Phase 1 (Web/PWA) の完成が前提条件です。                       │
│  LINE が無くても紙廃止 (要件①) は達成されます。                │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 目次

1. [エグゼクティブサマリー](#1-エグゼクティブサマリー)
2. [現状分析と課題](#2-現状分析と課題)
3. [システム全体アーキテクチャ](#3-システム全体アーキテクチャ)
4. [LINE連携フロー](#4-line連携フロー)
5. [AIヒアリングエンジン設計](#5-aiヒアリングエンジン設計)
6. [複数児童対応設計](#6-複数児童対応設計)
7. [変更ルール・ロック仕様](#7-変更ルールロック仕様)
8. [データベーススキーマ拡張](#8-データベーススキーマ拡張)
9. [API設計](#9-api設計)
10. [運用フロー: 月次リマインドと提出管理](#10-運用フロー-月次リマインドと提出管理)
11. [紙予定表 vs LINE入力 対比表](#11-紙予定表-vs-line入力-対比表)
12. [既存システムとの統合](#12-既存システムとの統合)
13. [セキュリティ・プライバシー](#13-セキュリティプライバシー)
14. [料金・コスト見積](#14-料金コスト見積)
15. [依存関係・技術スタック](#15-依存関係技術スタック)
16. [マイグレーション計画](#16-マイグレーション計画)
17. [実装ロードマップ](#17-実装ロードマップ)
18. [テスト計画](#18-テスト計画)
19. [運用マニュアル](#19-運用マニュアル)
20. [v1.0 → v2.0 設計差分](#20-v10--v20-設計差分)
21. [マルチ施設対応拡張 (v3.0)](#21-マルチ施設対応拡張-v30)
22. [保護者Webポータル設計 (v3.0)](#22-保護者webポータル設計-v30)
23. [v2.0 → v3.0 設計差分](#23-v20--v30-設計差分)

---

## 1. エグゼクティブサマリー

### 1.1 目的
保護者が毎月紙で提出している「利用予定表」の廃止は、**Web/PWA ポータル (Phase 1)** で実現済みとする。
本設計は、さらに**LINE公式アカウント上でAIがヒアリング形式で予定を収集→自動登録**する**追加チャネル**を提供するものである。

### 1.2 システムのスコープ (v4.0)

本設計は**約30の委託保育施設**への展開を前提とする。LINE予定収集は**Phase 2 Optional 追加チャネル**（希望施設のみ適用）。

```
入力チャネルの優先度:
  [Primary]   Web/PWA ポータル   → 全30施設 (必須)    → 要件①を100%充足
  [Optional]  LINE AI ヒアリング → 希望施設のみ (任意) → 要件①の補助チャネル
  [Backup]    スタッフ代行入力   → 全施設 (既存実装)   → 過渡期運用
```

全施設共通の保護者入力は Phase 1 の Web/PWA ポータル (MULTI_FACILITY_DESIGN.md v2.0 セクション6) で実現する。
LINE は「Web入力が難しい保護者がいる施設」向けのオプション追加チャネル。

### 1.3 現行フロー (AS-IS)
```
保護者 → 紙の予定表を記入 → 保育所に提出 → スタッフが手動入力/Excel転記
```

### 1.4 目標フロー (TO-BE)
```
保護者 → LINEで友だち追加 or Webポータルへアクセス → アカウント連携(1回)
→ 毎月リマインド受信 → LINEでAIとやり取り or Webカレンダーで入力 → 自動でDB登録
→ 変更もLINE/Webで → 締切管理・ロック自動適用
→ 既存の帳票生成システムがそのまま利用
→ (あゆっこ) 利用明細をスマホで確認
```

### 1.5 主要な設計原則
1. **1つの識別子で連携**: 保護者はLINE友だち追加 + 簡単な識別コードで紐付け
2. **AIが聞き漏らさない**: 必須項目が揃うまでフォローアップ質問を継続
3. **予定以外は断る**: AIのスコープを予定収集に限定（プロンプトで制御）
4. **複数児童対応**: 1人のLINEユーザーが複数の児童分を管理できる
5. **変更可能 + ロック**: 前月末日まで変更可、当月はロック（緊急キャンセルは例外）
6. **既存DB統合**: 現在の `schedule_plans` テーブルに直接書き込み（`source_file = 'LINE'`）
7. **紙予定表と同等の情報**: 紙で収集していた全項目をLINEで収集する

### 1.6 v3.0 → v4.0 での主な変更
| 項目 | v3.0 | v4.0 |
|------|------|------|
| **LINE の位置付け** | LINE + Webポータル (2チャネル) | **Web が Primary、LINE は Optional 追加チャネル** |
| **保護者入力の大前提** | 両チャネル並列 | **Web/PWA で要件①は100%充足。LINE は補助** |
| **Phase 1 の前提条件** | 未明記 | **Web/PWA ポータル完成が LINE 有効化の前提条件** |
| 関連ドキュメント | MULTI_FACILITY_DESIGN.md v1.0 | **MULTI_FACILITY_DESIGN.md v2.0** |
| 確認事項 | 未整理 | **6確認事項を v2.0 セクション19 に集約** |

### 1.7 v2.0 → v3.0 での変更 (参考)
| 項目 | v2.0 | v3.0 |
|------|------|------|
| 適用範囲 | あゆっこ1施設 | 全30施設 (マルチテナント) |
| LINE構成 | 1公式アカウント | 施設ごとに1アカウント |
| 認証 | なし | JWT + ロールモデル |
| Webhook設計 | 単一エンドポイント | 施設コードパラメータで振分 |
| 連携コード | AYK-XXXX固定 | {施設コード}-XXXX (施設別) |

---

## 2. 現状分析と課題

### 2.1 現行システムのデータフロー
```
schedule_plans テーブル
├── source: 'UI入力'    ... 管理画面からの手動入力（v6.0で実装済み）
├── source: 'Excel'     ... アップロードされた予定表Excel（v3.1で設計）
└── source: 'LINE'      ... 【今回追加】LINEからのAI収集
```

### 2.2 既存の schedule_plans テーブル構造
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

**注意: `breakfast_flag` カラムが存在しない** (→ セクション8.2で対応方針記載)

### 2.3 紙の利用予定表で収集している項目
REQUIREMENTS.md セクション 2.1.A より:
```
紙の利用予定表 (Excel) — 1園児1ファイル
  シート "原本"
  左半分（日1-15）/ 右半分（日16-31）:
    日付, 登所時間 (HH:MM), 降所時間 (HH:MM),
    昼食フラグ (〇), おやつフラグ (〇), 夕食フラグ (〇)
```
紙予定表では食事3区分（昼食・おやつ・夕食）。おやつは am/pm を区別していない。

**保育時間 (提出用) シートでは食事4列:**
```
col+4 (M) = 朝食 (〇)       ← ★紙予定表にない。提出用シートにのみ存在
col+5 (N) = 昼食 (〇)
col+6 (O) = おやつ (〇)     ← am/pm統合
col+7 (P) = 夕食 (〇)
```

### 2.4 既存の children テーブルの主要フィールド
- `id`, `nursery_id`, `lukumi_id`, `name`, `name_kana`, `birth_date`
- `age_class`, `enrollment_type` (月極/一時), `child_order`, `is_allergy`

### 2.5 解決すべき課題
| # | 課題 | 影響 | 設計での対応 |
|---|------|------|-------------|
| 1 | 紙での予定提出は保護者・スタッフ双方に負荷 | 月次作業が数時間 | LINE自動収集 |
| 2 | 転記ミスが発生する | 課金エラー | AIが直接DB書き込み |
| 3 | 変更連絡が口頭ベース | 追跡不可 | LINE会話ログで追跡可能 |
| 4 | 締切管理が属人的 | 遅延・漏れ | 自動リマインド + ロック |
| 5 | 複数児童の場合、紙が複数枚 | 管理煩雑 | 1会話で全児童分収集 |
| 6 | 朝食(150円)がDBスキーマに不在 | 朝食利用児の課金漏れ | breakfast_flag追加を計画 |

---

## 3. システム全体アーキテクチャ

### 3.1 アーキテクチャ概要図
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
```

### 3.2 コンポーネント構成
```
src/
├── routes/
│   ├── line-webhook.ts       # LINE Webhook受信 + 署名検証
│   ├── line-admin.ts         # 管理者向けLINE管理API
│   ├── schedules.ts          # 既存: 予定CRUD API
│   └── children.ts           # 既存: 園児CRUD API
├── lib/
│   ├── line-client.ts        # LINE Messaging API クライアント
│   ├── ai-hearing-engine.ts  # AIヒアリングエンジン (状態管理 + LLM呼出)
│   ├── conversation-state.ts # 会話状態マシン
│   ├── schedule-parser.ts    # AIレスポンスから予定データ抽出
│   ├── change-rules.ts       # 変更ルール・ロック判定
│   └── reminder-service.ts   # リマインド送信 (Cron Trigger)
├── types/
│   └── line.ts               # LINE関連型定義
└── index.tsx                 # メインアプリ (既存 + LINE route追加)
```

### 3.3 処理フロー概要
```
1. 保護者がLINEでメッセージ送信
2. LINE Platform → Webhook (POST /api/line/webhook)
3. 署名検証 (X-Line-Signature)
4. イベント種別判定:
   a. follow     → ウェルカムメッセージ + アカウント連携案内
   b. message    → AI会話エンジンへ転送
   c. postback   → ボタン操作の処理
5. AI会話エンジン:
   a. 会話状態をDBから取得
   b. LLM (OpenAI GPT-4o-mini) でユーザー入力を構造化データに変換
   c. ビジネスルール（ロック、食事推定等）はシステム側で判定
   d. 予定データ抽出 → schedule_plans へ UPSERT
   e. 会話状態をDBに保存
6. LINE Reply API で応答送信
```

### 3.4 LLMとシステムの責務分担 (v2.0 明確化)
```
┌─────────────────────────────────────────────────────────┐
│ LLMの責務 (AIがやること)                                  │
├─────────────────────────────────────────────────────────┤
│ ✅ 自由テキスト → 構造化データ (日付, 時刻, 食事) 変換    │
│ ✅ 不足項目の特定 → フォローアップ質問テキスト生成         │
│ ✅ 予定サマリーの自然言語生成                              │
│ ✅ スコープ外質問の判定 → 定型拒否メッセージ              │
│ ✅ 曖昧表現の解釈 (「来週水曜」→ 具体日付)               │
├─────────────────────────────────────────────────────────┤
│ システムの責務 (コードでやること)                          │
├─────────────────────────────────────────────────────────┤
│ ✅ 会話状態管理 (ステートマシン遷移)                      │
│ ✅ 変更締切・ロック判定                                   │
│ ✅ 食事フラグ自動推定 (時間帯→食事)                      │
│ ✅ 祝日判定                                              │
│ ✅ 全営業日カバー判定                                    │
│ ✅ schedule_plans テーブルへのCRUD                       │
│ ✅ LINE API呼び出し (Reply/Push)                         │
│ ✅ 署名検証、認証、Rate Limiting                         │
└─────────────────────────────────────────────────────────┘
```

---

## 4. LINE連携フロー

### 4.1 LINE公式アカウント設定

#### 必要な設定
| 項目 | 設定値 |
|------|--------|
| アカウント種別 | LINE公式アカウント (Verified推奨) |
| プラン | フリープラン (月200通まで無料) or ライトプラン |
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

### 4.2 アカウント連携フロー

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
│ Bot → DB検索 → line_accounts テーブルに LINE userId 登録 │
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

### 4.3 連携コード設計

| 項目 | 仕様 |
|------|------|
| 形式 | `AYK-XXXX` (英数4桁、大文字) |
| 生成 | 管理画面で園児登録時に自動生成 |
| 有効期限 | 発行から30日 (期限後は再発行) |
| 使い捨て | Yes (1回使用で無効化) |
| 文字種 | 数字 + 大文字英字 (紛らわしい0/O/I/1は除外) |
| 衝突回避 | DB UNIQUE制約 + 再生成ロジック |

---

## 5. AIヒアリングエンジン設計

### 5.1 会話状態マシン (v2.0: 10状態)

```
                    ┌──────────┐
          start ──► │  IDLE    │ ◄── "最初から" / 前回完了後
                    └────┬─────┘
                         │ follow イベント (未連携)
                    ┌────▼─────────────┐
                    │ AUTH_LINK        │ ◄── 連携コード入力待ち
                    │ (アカウント連携)  │
                    └────┬─────────────┘
                         │ 連携完了 (→ IDLEへ戻る)
                         │
          IDLE ──── │ "予定入力" / リマインドへの返信
                    ┌────▼─────────────┐
                    │ SELECT_CHILD     │ ◄── 複数児童 → 児童選択
                    │ (対象児童確認)    │
                    └────┬─────────────┘
                         │ 児童確定 (1名ならスキップ)
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
                    │ CONFIRM          │ ◄── 「はい」→ SAVED
                    │ (最終確認)        │ ◄── 「修正」→ COLLECTING
                    └────┬─────────────┘
                    ┌────▼─────┐  
                    │ SAVED    │ ◄── DB保存完了
                    │ (保存済) │
                    └────┬─────┘
                         │ 「予定変更」(前月末日まで)
                    ┌────▼─────────────┐
                    │ MODIFY           │ ◄── 変更ヒアリング
                    │ (変更受付中)      │
                    └──────────────────┘
                         │ 「今日休みます」(当月、緊急)
                    ┌────▼─────────────┐
                    │ CANCEL_REQUEST   │ ◄── 緊急キャンセル確認
                    │ (緊急キャンセル)  │
                    └──────────────────┘
```

### 5.2 各状態の詳細

#### IDLE → AUTH_LINK (未連携ユーザーのみ)
**トリガー**: follow イベント、または未連携状態でのメッセージ
**処理**: 連携コード入力を案内

#### IDLE → SELECT_CHILD
**トリガー**: 「予定入力」「予定を出したい」「来月の予定」等
**処理**: 
- 連携児童リストを取得
- 1名のみ → SELECT_MONTH に自動遷移
- 複数名 → 児童選択ボタン (Flex Message) を表示

#### SELECT_CHILD → SELECT_MONTH
**Bot応答例**:
```
○○ちゃんの予定を入力しますね。
何月分の予定ですか？
① 4月（来月）
② 5月（再来月）
```

#### SELECT_MONTH → COLLECTING
**Bot応答例**:
```
○○ちゃんの2026年4月の利用予定を聞きますね。

まず、基本的な利用パターンを教えてください：
・ 通常の利用曜日は？（例: 月〜金）
・ 通常の登園時間と降園時間は？
・ 昼食・おやつの希望は？

まとめて教えていただいてもOKです！
例:「月〜金 8:30-17:00 昼食あり おやつ午後のみ」
```

#### COLLECTING (メインヒアリングループ)
**この状態が最も重要。AIが以下を管理:**

```
収集すべきデータ（1日分）:
├── day: 日 (1-31)
├── planned_start: 登園予定時刻 (HH:MM)
├── planned_end: 降園予定時刻 (HH:MM)
├── lunch_flag: 昼食 (0/1)
├── am_snack_flag: 午前おやつ (0/1)
├── pm_snack_flag: 午後おやつ (0/1)
├── dinner_flag: 夕食 (0/1)
└── breakfast_flag: 朝食 (0/1)  ← ★v2.0追加候補 (セクション8.2参照)
```

**ヒアリングの戦略:**
1. **まずパターン入力**: 「月〜金 8:30-17:00」のように基本パターンを収集
2. **例外日の確認**: 「お休みの日はありますか？」「時間が違う日は？」
3. **食事の確認**: 時間帯から自動推定し、確認のみ行う
4. **抜け漏れチェック**: 全営業日をカバーしているか確認

**食事フラグ自動推定ルール:**
```
登園時間 < 07:30 (早朝) → breakfast_flag = 1 (朝食の可能性あり → 要確認)
登園時間 ≤ 10:00        → am_snack_flag = 1
登園時間 ≤ 11:30        → lunch_flag = 1
降園時間 ≥ 15:00        → pm_snack_flag = 1
降園時間 ≥ 18:00        → dinner_flag = 1
```

**保護者入力例と解釈:**
```
入力: "月〜金 8:30-17:00、でも4/10と4/22はお休みで、
       4/15だけ19時まで延長お願いします"

AIの内部解釈:
├── 基本パターン: 月〜金 8:30-17:00
│   ├── lunch_flag: 1 (8:30登園 ≤ 11:30)
│   ├── am_snack_flag: 1 (8:30登園 ≤ 10:00)
│   ├── pm_snack_flag: 1 (17:00降園 ≥ 15:00)
│   └── dinner_flag: 0 (17:00降園 < 18:00)
├── 例外: 4/10(木), 4/22(火) → 削除 (お休み)
└── 例外: 4/15(火) → 8:30-19:00, dinner_flag: 1
```

**フォローアップ質問例:**
```
[不足: 食事情報]
「4/15は19時まで延長とのことですが、夕食も希望されますか？」

[不足: 土曜日]
「4月の土曜日（5日, 12日, 19日, 26日）はお預かりの予定はありますか？」

[矛盾検出]
「4/29は祝日（昭和の日）ですが、利用予定でよろしいですか？」

[時間帯確認]
「登園が7:00ですと早朝保育（7:00-7:30）の扱いになりますが、
 よろしいですか？（別途料金: 300円/回）」

[朝食確認] ← ★v2.0追加
「登園が7:00で、朝食（150円/食）も希望されますか？」
```

#### COLLECTING → CONFIRM
**全日程がカバーされたとAIが判断したとき:**
```
○○ちゃんの4月の利用予定をまとめました：

📅 基本パターン: 月〜金 8:30-17:00
🍽 食事: 午前おやつ + 昼食 + 午後おやつ

📋 詳細:
4/1(火) 8:30-17:00 🍙🍱🍪
4/2(水) 8:30-17:00 🍙🍱🍪
4/3(木) 8:30-17:00 🍙🍱🍪
4/4(金) 8:30-17:00 🍙🍱🍪
4/7(月) 8:30-17:00 🍙🍱🍪
...
4/10(木) お休み ❌
...
4/15(火) 8:30-19:00 🍙🍱🍪🍽 ← 延長+夕食
...
4/22(火) お休み ❌

合計: 19日利用予定

この内容でよろしいですか？
① はい、登録してください
② 修正があります
```

#### CONFIRM → SAVED
```
✅ 4月の利用予定を登録しました！（19日分）

変更が必要な場合は、3月31日までにこのLINEで
「予定変更」と送ってください。
4月に入ると変更はロックされます（緊急キャンセルを除く）。

他のお子さまの予定も入力しますか？
```

#### MODIFY (変更モード、前月末まで)
```
保護者: "予定変更"
Bot: (変更可能期間を確認)
     "4月の予定を変更しますね。どの日の予定を変更しますか？"

保護者: "4/8を休みにして、4/18を8:00-18:30に変更"
Bot: "変更内容を確認します：
     ・4/8(火) → お休み ❌ (削除)
     ・4/18(金) 8:30-17:00 → 8:00-18:30 (変更)
       夕食も希望されますか？"
```

#### CANCEL_REQUEST (緊急キャンセル、当月)
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

処理: schedule_plans の該当日を削除 or status='cancelled'
      + emergency_cancellations テーブルに記録
```

### 5.3 AIプロンプト設計

#### システムプロンプト (概要)
```
あなたは「あゆっこ保育所」の予定入力アシスタントです。

【役割】
保護者から来月の利用予定（登園・降園時間、食事希望）を聞き取り、
データベースに登録可能な構造化データに変換します。

【対応範囲】
✅ 利用予定の入力・変更・確認・キャンセル
❌ 保育の質問、料金の相談、クレーム、雑談、その他一切

予定以外の質問には:
「申し訳ありませんが、利用予定の入力のみ対応しています。
 その他のお問い合わせは保育所（XXX-XXXX）までお電話ください。」

【基本ルール】
1. 対象月の全営業日（月〜金 + 保護者が希望すれば土）をカバーすること
2. 1日あたり必要データ: 日付, 登園時刻(HH:MM), 降園時刻(HH:MM), 
   昼食(0/1), 午前おやつ(0/1), 午後おやつ(0/1), 夕食(0/1)
3. 食事フラグは時間帯から自動推定し、確認のみ行う:
   - 登園 ≤ 10:00 → am_snack = 1
   - 登園 ≤ 11:30 → lunch = 1
   - 降園 ≥ 15:00 → pm_snack = 1
   - 降園 ≥ 18:00 → dinner = 1
4. 保護者の入力はパターン指定（「月〜金 8:30-17:00」）を推奨
5. 例外日（休み、時間変更）を個別に確認
6. 祝日は自動判定し、利用の有無を確認
7. 全日程確定後、一覧を表示して最終確認を求める

【応答スタイル】
- 丁寧語で、簡潔に
- 絵文字は適度に使用 (🍱🍪📅✅❌)
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
     "lunch_flag": 1, "am_snack_flag": 1, "pm_snack_flag": 1, "dinner_flag": 0},
    ...
  ]
}
```

#### ツール定義 (Function Calling)
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

### 5.4 LLMプロバイダ設計

| 項目 | 設定 |
|------|------|
| プロバイダ | OpenAI (GPT-4o-mini 推奨) |
| モデル | gpt-4o-mini (コスト効率◎、日本語対応◎) |
| Temperature | 0.3 (一貫性重視) |
| Max tokens | 1024 (応答は短い想定) |
| Timeout | 15秒 |
| Fallback | gpt-4o (mini失敗時) |
| API Key保存 | Cloudflare Secret (`OPENAI_API_KEY`) |

**コスト見積 (gpt-4o-mini)**:
- 1会話あたり平均10ターン
- Input: ~2000 tokens/turn (システムプロンプト + 会話履歴)
- Output: ~200 tokens/turn
- 1会話コスト: ~$0.003 (~0.5円)
- 30園児 x 1回/月 = ~15円/月

---

## 6. 複数児童対応設計

### 6.1 1LINEユーザー → 複数児童のマッピング

```
line_accounts テーブル:
┌──────────────────┬──────────────────┬─────────────────┐
│ line_user_id     │ child_id         │ display_name    │
│ U1234567890abcd  │ child_mondal_aum │ ○○ちゃん(0歳児) │
│ U1234567890abcd  │ child_tanaka_yui │ △△ちゃん(1歳児) │
│ U9876543210wxyz  │ child_suzuki_ken │ □□くん(2歳児)   │
└──────────────────┴──────────────────┴─────────────────┘
```

### 6.2 複数児童の会話フロー

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

### 6.3 食事の個別対応

```
Bot: "△△ちゃんはアレルギー食対応ですね。
     食事内容について個別に確認させてください。
     △△ちゃんの昼食は毎日アレルギー対応食でよろしいですか？"
```

---

## 7. 変更ルール・ロック仕様

### 7.1 変更可能期間ルール

```
対象月: 2026年4月

┌──────────────────────────────────────────────────────────┐
│                        3月                               │
│  [───────── 自由に入力・変更 ─────────]                  │
│  3/1                                   3/31 23:59        │
│                                        ↑ 変更締切        │
├──────────────────────────────────────────────────────────┤
│                        4月                               │
│  [──── ロック（緊急キャンセルのみ） ────]                 │
│  4/1                                   4/30              │
└──────────────────────────────────────────────────────────┘
```

### 7.2 変更種別と可否マトリックス

| 変更種別 | 前月末まで | 当月(通常) | 当月(緊急) |
|----------|-----------|-----------|-----------|
| 新規日追加 | ✅ 可 | ❌ 不可 | ❌ 不可 |
| 日程削除 (お休み) | ✅ 可 | ❌ 不可 | ✅ 可 (病欠等) |
| 時間変更 | ✅ 可 | ❌ 不可 | ❌ 不可 |
| 食事変更 | ✅ 可 | ❌ 不可 | ❌ 不可 |
| 全面差替え | ✅ 可 | ❌ 不可 | ❌ 不可 |

### 7.3 ロック判定ロジック

```typescript
function canModifySchedule(
  targetYear: number,
  targetMonth: number, 
  changeType: 'add' | 'delete' | 'modify' | 'emergency_cancel',
  now: Date
): { allowed: boolean; reason: string } {
  
  // 対象月の初日
  const targetStart = new Date(targetYear, targetMonth - 1, 1);
  // 前月末日 23:59:59 JST
  const deadline = new Date(targetYear, targetMonth - 1, 0, 23, 59, 59);
  
  // JST変換
  const nowJST = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  
  if (nowJST <= deadline) {
    return { allowed: true, reason: '変更可能期間内' };
  }
  
  if (changeType === 'emergency_cancel' && nowJST >= targetStart) {
    return { allowed: true, reason: '緊急キャンセル（当月中）' };
  }
  
  return { 
    allowed: false, 
    reason: `変更締切（${targetMonth}月分は${targetMonth-1}月末日まで）を過ぎています` 
  };
}
```

---

## 8. データベーススキーマ拡張

### 8.1 新規テーブル一覧

#### 8.1.1 `line_accounts` --- LINEアカウント連携

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

#### 8.1.2 `link_codes` --- アカウント連携コード

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

#### 8.1.3 `line_conversations` --- 会話状態管理

```sql
CREATE TABLE IF NOT EXISTS line_conversations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  line_user_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'IDLE' 
    CHECK(state IN ('IDLE','AUTH_LINK','SELECT_CHILD','SELECT_MONTH',
                     'COLLECTING','CONFIRM','SAVED','MODIFY','CANCEL_REQUEST')),
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

CREATE INDEX IF NOT EXISTS idx_line_conversations_user ON line_conversations(line_user_id);
```

#### 8.1.4 `line_conversation_logs` --- 会話ログ

```sql
CREATE TABLE IF NOT EXISTS line_conversation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES line_conversations(id),
  line_user_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')),
  message_type TEXT NOT NULL,             -- 'text', 'postback', 'flex', 'system'
  content TEXT NOT NULL,                  -- メッセージ本文
  ai_raw_response TEXT,                   -- LLM生レスポンス (outgoing時)
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_line_conv_logs_conv ON line_conversation_logs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_line_conv_logs_user ON line_conversation_logs(line_user_id);
```

#### 8.1.5 `schedule_change_requests` --- 変更リクエスト記録

```sql
CREATE TABLE IF NOT EXISTS schedule_change_requests (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  child_id TEXT NOT NULL REFERENCES children(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  request_type TEXT NOT NULL CHECK(request_type IN (
    'initial_submit', 'modify', 'emergency_cancel'
  )),
  request_source TEXT NOT NULL DEFAULT 'LINE'
    CHECK(request_source IN ('LINE', 'admin', 'UI')),
  line_user_id TEXT,
  changes_json TEXT NOT NULL,             -- 変更内容 (JSON)
  -- changes_json例:
  -- { "added": [{"day": 8, ...}],
  --   "removed": [{"day": 10}],
  --   "modified": [{"day": 15, "old": {...}, "new": {...}}] }
  status TEXT NOT NULL DEFAULT 'applied'
    CHECK(status IN ('applied', 'rejected', 'pending_review')),
  rejection_reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_change_requests_child ON schedule_change_requests(child_id, year, month);
```

#### 8.1.6 `emergency_cancellations` --- 緊急キャンセル記録

```sql
CREATE TABLE IF NOT EXISTS emergency_cancellations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  child_id TEXT NOT NULL REFERENCES children(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  reason TEXT,                            -- 'illness', 'family', 'other'
  cancelled_by TEXT,                      -- 'LINE' or 'admin'
  line_user_id TEXT,
  original_start TEXT,                    -- 元の予定開始
  original_end TEXT,                      -- 元の予定終了
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(child_id, year, month, day)
);
```

### 8.2 既存テーブルへの変更

#### `schedule_plans` テーブル
```sql
-- source_file カラムの値追加 (変更不要、既存TEXT型で対応)
-- 'UI入力'     → 管理画面
-- 'Excel'      → アップロード
-- 'LINE'       → LINE経由 (初回提出)
-- 'LINE_修正'  → LINE経由 (変更)
```

**breakfast_flag 問題への対応方針:**
```
現状:
  - schedule_plans に breakfast_flag カラムが存在しない
  - 予定入力UIにも朝食チェックボックスがない
  - Python Generator (pdf_writer.py) には has_breakfast がある
  - 保育料案内: 朝食 150円/食
  - 保育時間(提出用) シート col+4 = 朝食 (〇)

方針 (LINE連携実装時に同時対応):
  Phase 1 (LINE MVP): breakfast_flag なしで運用
    → 朝食は非常にレアケース（7:00-7:30 早朝利用者のみ対象）
    → AIヒアリングで「朝食希望ですか？」と聞き、
       メモとして collected_data_json に記録
    → 管理者が手動で Python Generator 用に設定

  Phase 2 (LINE + DB統合): breakfast_flag カラムを追加
    → マイグレーション 0003_add_breakfast_flag.sql
    → ALTER TABLE schedule_plans ADD COLUMN breakfast_flag INTEGER DEFAULT 0;
    → UI/API/charge_lines も同時に対応
```

#### `children` テーブル
```sql
-- 追加カラム不要
-- link_codes テーブルで連携管理
```

---

## 9. API設計

### 9.1 LINE Webhook エンドポイント

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

Response: 200 OK (即座に返す、処理は非同期)
```

**署名検証 (Cloudflare Workers版 / Web Crypto API)**:
```typescript
async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
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

### 9.2 管理者向け LINE 管理 API

#### `POST /api/line/link-codes`
連携コード発行。
```json
Request: { "child_id": "child_mondal_aum" }
Response: { "code": "AYK-3F7K", "expires_at": "2026-04-03T00:00:00Z" }
```

#### `GET /api/line/accounts`
LINE連携状態一覧。

#### `GET /api/line/conversations?status=COLLECTING`
進行中の会話一覧 (管理者モニタリング用)。

#### `POST /api/line/send-reminders`
手動リマインド送信 (管理画面から)。

#### `GET /api/line/logs/:lineUserId`
特定ユーザーの会話ログ取得。

#### `POST /api/line/conversation/step`
会話の次ステップ処理（内部使用）。

#### `POST /api/line/confirm`
予定確認・保存処理（内部使用）。

#### `POST /api/line/modify`
変更リクエスト処理（内部使用）。

#### `POST /api/line/cancel`
緊急キャンセル処理（内部使用）。

### 9.3 提出状況確認 API

#### `GET /api/line/submission-status?year=2026&month=4`
```json
Response: {
  "target": "2026年4月",
  "total_linked": 28,
  "submitted": 22,
  "not_submitted": 6,
  "not_submitted_children": [
    { "child_id": "...", "name": "田中太郎", "parent_line_name": "田中" },
    ...
  ],
  "deadline": "2026-03-31T23:59:59+09:00"
}
```

---

## 10. 運用フロー: 月次リマインドと提出管理

### 10.1 月次運用サイクル

```
毎月のサイクル (例: 4月分の予定収集)

3月15日 10:00 JST ── 初回リマインド Push送信
  │  対象: line_accounts で連携済み & 4月の schedule_plans 未提出
  │  メッセージ: "来月（4月）の利用予定の提出時期です。
  │              「予定入力」と送信すると、AIがお聞きしながら
  │              予定を登録します。"
  │
  ├── 保護者が随時LINE入力 ──
  │
3月25日 10:00 JST ── フォローアップリマインド
  │  対象: まだ未提出の保護者のみ
  │  メッセージ: "まだ4月の利用予定が届いていません。
  │              前月末日（3/31）までにご提出をお願いします。"
  │
3月31日 23:59 JST ── 締切
  │  
4月1日 ────────── 4月分ロック開始
  │  ・新規追加/変更は不可
  │  ・緊急キャンセル(病欠等)のみ受付
  │
4月中 ─────────── 実績データ(ルクミー)と突合 → 帳票生成
```

### 10.2 Cron Trigger 実装方針

**Cloudflare Pagesでは Cron Triggers が直接使えないため:**

| 方式 | 説明 | 推奨度 |
|------|------|--------|
| 別途Worker | `ayukko-reminder-worker` でCron Trigger | ★★★ 推奨 |
| 管理画面ボタン | 「リマインド送信」ボタンで手動 | ★★ バックアップ |
| 外部Cron | cron-job.org → 管理API叩く | ★ 予備 |

**推奨: Option 1 (別Worker) + Option 2 (手動バックアップ)**

### 10.3 提出状況の管理画面表示

管理画面に「LINE連携」タブを追加:
```
┌─────────────────────────────────────────────┐
│ 📱 LINE連携状況  2026年4月                   │
├─────────────────────────────────────────────┤
│ 連携済保護者: 28名 / 全30名                  │
│ 予定提出済:   22名 ✅                        │
│ 未提出:       6名 ⚠️                        │
│ 締切:         2026年3月31日 まであと 12日    │
│                                              │
│ [リマインド送信] [未提出者一覧]               │
├─────────────────────────────────────────────┤
│ 未提出:                                      │
│ ・田中太郎 (2歳児) - 最終メッセージ: 3/18    │
│ ・山田花子 (0歳児) - 最終メッセージ: なし    │
│ ・...                                        │
└─────────────────────────────────────────────┘
```

---

## 11. 紙予定表 vs LINE入力 対比表

### 11.1 項目対比

| # | 紙予定表の項目 | LINE収集方法 | DB格納先 | 備考 |
|---|---------------|-------------|---------|------|
| 1 | 園児氏名 (B6) | アカウント連携で自動紐付 | children.name | 連携コードで特定 |
| 2 | 年 (J1) | SELECT_MONTH状態で収集 | schedule_plans.year | 自動判定 |
| 3 | 月 (M1) | SELECT_MONTH状態で収集 | schedule_plans.month | 自動判定 |
| 4 | 日付 (B12:B26等) | パターン指定で全日展開 | schedule_plans.day | AI展開 |
| 5 | 登所時間 (D列/O列) | 自由テキストで収集 | schedule_plans.planned_start | "8:30" |
| 6 | 降所時間 (G列/R列) | 自由テキストで収集 | schedule_plans.planned_end | "17:00" |
| 7 | 昼食フラグ (J/U列) | 時間帯自動推定+確認 | schedule_plans.lunch_flag | 0/1 |
| 8 | おやつフラグ (K/V列) | am/pm分離して推定 | am_snack_flag + pm_snack_flag | 紙は統合1列 |
| 9 | 夕食フラグ (L/W列) | 時間帯自動推定+確認 | schedule_plans.dinner_flag | 0/1 |

### 11.2 紙にない項目 (LINE/システムで追加)

| # | 項目 | LINE収集方法 | 備考 |
|---|------|-------------|------|
| 10 | 朝食 | 早朝利用時にAIが質問 | ★ breakfast_flag (Phase 2) |
| 11 | 変更履歴 | schedule_change_requests | 紙は上書き/口頭 |
| 12 | 提出日時 | line_conversations.updated_at | 紙は不明確 |
| 13 | 緊急キャンセル記録 | emergency_cancellations | 紙は電話のみ |

### 11.3 食事区分の対応関係

```
紙予定表 (3区分)           LINE/DB (5区分)              保育時間(提出用)
─────────────────         ──────────────────           ──────────────────
                          breakfast_flag (朝食150円)    朝食 (〇)
昼食 (〇)                 lunch_flag (昼食300円)        昼食 (〇)
おやつ (〇) ← 統合        am_snack_flag (朝おやつ50円)  おやつ (〇) ← 統合
                          pm_snack_flag (午後おやつ100円)
夕食 (〇)                 dinner_flag (夕食300円)        夕食 (〇)
```

**紙では「おやつ」1列 → DBでは am/pm 2列に分離:**
- LINE AIは時間帯から自動判定:
  - 登園 ≤ 10:00 → am_snack = 1
  - 降園 ≥ 15:00 → pm_snack = 1
- 紙で「おやつ〇」は通常 pm_snack と解釈 (午後のほうが一般的)

---

## 12. 既存システムとの統合

### 12.1 schedule_plans テーブルへの統合

LINE経由で収集した予定は、**既存の schedule_plans テーブルにそのまま書き込む**。

```sql
-- LINE経由の予定保存 (既存 POST /api/schedules の内部ロジックを再利用)
INSERT OR REPLACE INTO schedule_plans
  (id, child_id, year, month, day, planned_start, planned_end,
   lunch_flag, am_snack_flag, pm_snack_flag, dinner_flag, source_file)
VALUES
  (lower(hex(randomblob(8))), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'LINE');
```

### 12.2 既存機能との連携

| 既存機能 | LINE連携の影響 | 対応 |
|---------|--------------|------|
| ダッシュボード (DB直結) | LINE入力分も即座に反映 | 変更不要 |
| 帳票生成 (Python Generator) | schedule_plans を読むので自動対応 | 変更不要 |
| UI予定入力 | LINEと並行利用可能 | 競合時は後勝ち (UPSERT) |
| 課金計算 (usage-calculator) | schedule_plans ベースなので自動対応 | 変更不要 |

### 12.3 データの信頼性

```
データ競合ポリシー:
  1. schedule_plans の UNIQUE(child_id, year, month, day) で保護
  2. INSERT OR REPLACE (UPSERT) で後勝ち
  3. source_file カラムで入力元を区別:
     'UI入力' = 管理画面
     'Excel'  = ファイルアップロード  
     'LINE'   = LINE初回提出
     'LINE_修正' = LINE変更
  4. schedule_change_requests で全変更履歴を保持
```

### 12.4 緊急キャンセルの扱い

```
LINE「今日休みます」→ 2つのDB操作:

1. schedule_plans: 該当日を削除 (or planned_start/end を NULL に)
   DELETE FROM schedule_plans 
   WHERE child_id = ? AND year = ? AND month = ? AND day = ?;

2. emergency_cancellations: 記録を追加
   INSERT INTO emergency_cancellations 
     (child_id, year, month, day, reason, cancelled_by, line_user_id,
      original_start, original_end)
   VALUES (?, ?, ?, ?, 'illness', 'LINE', ?, ?, ?);

→ 既存の帳票生成は schedule_plans に行がない = 欠席として処理
→ emergency_cancellations は管理者の追跡用
```

---

## 13. セキュリティ・プライバシー

### 13.1 個人情報保護

| データ | 分類 | 保護措置 |
|--------|------|---------|
| LINE userId | 個人識別子 | DB暗号化検討、アクセスログ |
| 児童氏名 | 個人情報 | 既存のアクセス制御に準拠 |
| 会話ログ | 個人情報 | 90日後に自動削除 (日単位) |
| LLM送信データ | 要注意 | 児童名をイニシャルに変換して送信 |

### 13.2 LLMへの送信データのマスキング

```
送信前: "○○ちゃんの4月の予定を登録しました"
LLMへ:  "Child_Aの4月の予定を登録しました"

復元:   Child_A → child_mondal_aum (サーバー側マッピング)
```

### 13.3 セキュリティチェックリスト

- [ ] LINE Webhook署名検証 (X-Line-Signature)
- [ ] Channel Secret をCloudflare Secretに保存
- [ ] OpenAI API KeyをCloudflare Secretに保存
- [ ] 会話ログの自動削除 (90日)
- [ ] 管理APIに認証ミドルウェア
- [ ] Rate limiting (1ユーザー10メッセージ/分)
- [ ] LLMへの個人情報マスキング
- [ ] CORS設定 (Webhookは全オリジン許可、管理APIは制限)

### 13.4 Cloudflare Secrets 一覧

```bash
# 本番デプロイ時に設定
wrangler pages secret put LINE_CHANNEL_ID --project-name ayukko-nursery
wrangler pages secret put LINE_CHANNEL_SECRET --project-name ayukko-nursery
wrangler pages secret put LINE_CHANNEL_ACCESS_TOKEN --project-name ayukko-nursery
wrangler pages secret put OPENAI_API_KEY --project-name ayukko-nursery
```

---

## 14. 料金・コスト見積

### 14.1 LINE公式アカウント

| プラン | 月額 | 無料メッセージ | 追加メッセージ |
|--------|------|--------------|--------------|
| コミュニケーション (無料) | 0円 | 200通/月 | 不可 |
| ライト | 5,000円 | 5,000通/月 | 3円/通 |
| スタンダード | 15,000円 | 30,000通/月 | ~3円/通 |

**あゆっこの想定**:
- 園児30名 x 保護者30名 x 1会話あたり約15メッセージ = 450通/月
- リマインド2回 x 30名 = 60通/月
- **合計: 約510通/月 → ライトプラン推奨 (5,000円/月)**
- 注: Reply Message はカウント対象外なので実質フリープランでも可能な場合あり

### 14.2 OpenAI API

| 項目 | 見積 |
|------|------|
| モデル | gpt-4o-mini |
| 1会話あたり | ~10ターン x (2000 input + 200 output) tokens |
| 月間 | 30園児 x 22,000 tokens = 660,000 tokens |
| コスト | Input: $0.15/1M x 0.6M = $0.09, Output: $0.60/1M x 0.06M = $0.036 |
| **月額合計** | **~$0.13 (~20円/月)** |

### 14.3 Cloudflare Workers/D1

| 項目 | Free Plan上限 | 想定使用量 |
|------|-------------|-----------|
| Workers requests | 100,000/日 | ~100/日 (余裕) |
| D1 reads | 5M/日 | ~500/日 |
| D1 writes | 100K/日 | ~100/日 |
| D1 storage | 5GB | <100MB |

### 14.4 月額合計コスト見積

| 項目 | コスト |
|------|--------|
| LINE ライトプラン | 5,000円 |
| OpenAI API | 20円 |
| Cloudflare (Free) | 0円 |
| **合計** | **5,020円/月** |

※ フリープランでReply Message中心なら20円/月のみ

---

## 15. 依存関係・技術スタック

### 15.1 新規依存パッケージ

```json
{
  "dependencies": {
    "hono": "^4.0.0"           // 既存
    // LINE SDK不要 --- Cloudflare Workers非対応のためfetch直接呼出
  },
  "devDependencies": {
    "@cloudflare/workers-types": "4.20250705.0"  // 既存
  }
}
```

**注意: `@line/bot-sdk` は Node.js依存 (http, crypto) のため使用不可。
LINE APIはfetch + Web Crypto APIで直接呼び出す。**

### 15.2 外部API依存関係

| API | 用途 | ドキュメント |
|-----|------|------------|
| LINE Messaging API | メッセージ送受信 | https://developers.line.biz/en/docs/messaging-api/ |
| LINE Reply API | 即座の応答 | https://developers.line.biz/en/reference/messaging-api/#send-reply-message |
| LINE Push API | リマインド送信 | https://developers.line.biz/en/reference/messaging-api/#send-push-message |
| OpenAI Chat Completions | AIヒアリング | https://platform.openai.com/docs/api-reference/chat |

### 15.3 LINE APIクライアント設計 (SDKなし)

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

  // 署名検証 (Web Crypto API)
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

  // Reply Message
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

  // Push Message
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

  // Get User Profile
  async getProfile(userId: string): Promise<LineProfile> {
    const res = await fetch(`${this.baseUrl}/profile/${userId}`, {
      headers: { 'Authorization': `Bearer ${this.accessToken}` },
    });
    return res.json();
  }
}
```

### 15.4 Bindings拡張

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

## 16. マイグレーション計画

### 16.1 段階的マイグレーション

```
Phase 1: DBスキーマ追加 (テーブル作成のみ)
  └── 0002_line_integration.sql

Phase 2: 連携コード生成機能
  └── 管理画面に「連携コード発行」ボタン追加

Phase 3: LINE Webhook + アカウント連携
  └── Webhook受信、署名検証、連携コード入力

Phase 4: AIヒアリングエンジン
  └── 会話状態管理、LLM連携、予定収集

Phase 5: 変更・キャンセル対応
  └── ロック判定、緊急キャンセル

Phase 6: リマインド (Cron)
  └── 自動リマインド配信

Phase 7 (将来): breakfast_flag 追加
  └── 0003_add_breakfast_flag.sql
```

### 16.2 マイグレーションSQL 完全版

```sql
-- ================================================================
-- migrations/0002_line_integration.sql
-- あゆっこ保育園 業務自動化システム
-- Purpose: LINE Messaging API 連携用テーブル追加
-- Created: 2026-03-XX (実装時に日付確定)
-- Depends: 0001_initial_schema.sql
-- ================================================================

-- ============================================================
-- 1. LINEアカウント連携
-- 1つのLINE userId が複数の children に紐づく (兄弟)
-- ============================================================
CREATE TABLE IF NOT EXISTS line_accounts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  line_user_id TEXT NOT NULL,             -- LINE userId (U + 32hex)
  child_id TEXT NOT NULL REFERENCES children(id),
  line_display_name TEXT,                 -- LINEの表示名
  linked_at TEXT DEFAULT (datetime('now')),
  is_active INTEGER DEFAULT 1,           -- 0 = unfollow / 退園
  UNIQUE(line_user_id, child_id)
);
CREATE INDEX IF NOT EXISTS idx_line_accounts_user ON line_accounts(line_user_id);
CREATE INDEX IF NOT EXISTS idx_line_accounts_child ON line_accounts(child_id);

-- ============================================================
-- 2. アカウント連携コード (使い捨て)
-- 管理画面で発行 → 保護者がLINEで入力 → 紐付け完了
-- ============================================================
CREATE TABLE IF NOT EXISTS link_codes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  code TEXT NOT NULL UNIQUE,              -- 'AYK-XXXX'
  child_id TEXT NOT NULL REFERENCES children(id),
  nursery_id TEXT NOT NULL REFERENCES nurseries(id),
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,               -- 有効期限 (発行から30日)
  used_at TEXT,                           -- 使用日時 (NULL=未使用)
  used_by_line_user_id TEXT               -- 使用したLINE userId
);
CREATE INDEX IF NOT EXISTS idx_link_codes_code ON link_codes(code);
CREATE INDEX IF NOT EXISTS idx_link_codes_child ON link_codes(child_id);

-- ============================================================
-- 3. 会話状態管理
-- 1ユーザーにつき1アクティブ会話
-- ============================================================
CREATE TABLE IF NOT EXISTS line_conversations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  line_user_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'IDLE'
    CHECK(state IN ('IDLE','AUTH_LINK','SELECT_CHILD','SELECT_MONTH',
                     'COLLECTING','CONFIRM','SAVED','MODIFY','CANCEL_REQUEST')),
  target_child_id TEXT REFERENCES children(id),
  target_year INTEGER,
  target_month INTEGER,
  collected_data_json TEXT,               -- 収集済み予定データ (JSON)
  ai_context_json TEXT,                   -- LLM会話履歴 (最新10ターン)
  multi_child_mode TEXT DEFAULT 'single'
    CHECK(multi_child_mode IN ('single','batch')),
  batch_children_json TEXT,               -- バッチモード時の対象児童リスト
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT                          -- 24時間後に自動リセット
);
CREATE INDEX IF NOT EXISTS idx_line_conversations_user ON line_conversations(line_user_id);

-- ============================================================
-- 4. 会話ログ (監査・デバッグ・90日保持)
-- ============================================================
CREATE TABLE IF NOT EXISTS line_conversation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES line_conversations(id),
  line_user_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('incoming','outgoing')),
  message_type TEXT NOT NULL,             -- 'text', 'postback', 'flex', 'system'
  content TEXT NOT NULL,                  -- メッセージ本文
  ai_raw_response TEXT,                   -- LLM生レスポンス (outgoing時のみ)
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_line_conv_logs_conv ON line_conversation_logs(conversation_id);
CREATE INDEX IF NOT EXISTS idx_line_conv_logs_user ON line_conversation_logs(line_user_id);

-- ============================================================
-- 5. 予定変更リクエスト記録 (監査証跡)
-- ============================================================
CREATE TABLE IF NOT EXISTS schedule_change_requests (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  child_id TEXT NOT NULL REFERENCES children(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  request_type TEXT NOT NULL CHECK(request_type IN (
    'initial_submit', 'modify', 'emergency_cancel'
  )),
  request_source TEXT NOT NULL DEFAULT 'LINE'
    CHECK(request_source IN ('LINE', 'admin', 'UI')),
  line_user_id TEXT,
  changes_json TEXT NOT NULL,             -- 変更内容 (JSON)
  status TEXT NOT NULL DEFAULT 'applied'
    CHECK(status IN ('applied', 'rejected', 'pending_review')),
  rejection_reason TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_change_requests_child
  ON schedule_change_requests(child_id, year, month);

-- ============================================================
-- 6. 緊急キャンセル記録
-- 当月ロック中に受け付けた欠席のみ記録
-- ============================================================
CREATE TABLE IF NOT EXISTS emergency_cancellations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  child_id TEXT NOT NULL REFERENCES children(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  day INTEGER NOT NULL,
  reason TEXT,                            -- 'illness', 'family', 'other'
  cancelled_by TEXT,                      -- 'LINE' or 'admin'
  line_user_id TEXT,
  original_start TEXT,                    -- 元の予定開始 (HH:MM)
  original_end TEXT,                      -- 元の予定終了 (HH:MM)
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(child_id, year, month, day)
);
```

### 16.3 将来マイグレーション (breakfast_flag)

```sql
-- ================================================================
-- migrations/0003_add_breakfast_flag.sql
-- Purpose: 朝食フラグの追加 (Phase 2)
-- Depends: 0001_initial_schema.sql
-- ================================================================

-- schedule_plans に朝食フラグ追加
ALTER TABLE schedule_plans ADD COLUMN breakfast_flag INTEGER DEFAULT 0;

-- usage_facts に朝食フラグ追加
ALTER TABLE usage_facts ADD COLUMN has_breakfast INTEGER DEFAULT 0;

-- charge_lines の charge_type に 'breakfast' を追加
-- (CHECK制約の変更はSQLiteでは ALTER TABLE では不可のため、
--  アプリケーション側で対応 or テーブル再作成)
```

---

## 17. 実装ロードマップ

### 17.1 全体スケジュール (推奨)

```
Week 1-2: 基盤構築
├── Day 1-2: DBマイグレーション + LINE公式アカウント開設
├── Day 3-4: LINE Webhookハンドラ + 署名検証
├── Day 5-6: アカウント連携 (連携コード発行 + 入力処理)
├── Day 7-8: LINEクライアント (Reply/Push/Profile)
└── Day 9-10: 管理画面に「連携コード発行」「LINE連携状態」UI追加

Week 3-4: AI会話エンジン
├── Day 11-12: 会話状態マシン実装
├── Day 13-14: OpenAI連携 (Function Calling)
├── Day 15-16: 予定収集ロジック (パターン入力 → 展開)
├── Day 17-18: フォローアップ質問生成
└── Day 19-20: 確認・保存フロー

Week 5: 変更・ロック・リマインド
├── Day 21-22: 変更ルール判定 + ロックロジック
├── Day 23-24: 緊急キャンセルフロー
└── Day 25-26: Cron Triggerリマインド

Week 6: テスト・調整・デプロイ
├── Day 27-28: E2Eテスト (LINE Messaging APIテストツール利用)
├── Day 29: セキュリティレビュー
└── Day 30: 本番デプロイ + ドキュメント整備
```

### 17.2 依存関係グラフ

```
DBマイグレーション ─┬─► LINE Webhook ─┬─► AI会話エンジン ─┬─► 変更ルール
                    │                  │                    │
LINE公式アカウント開設──►              │                    ├─► 緊急キャンセル
                    │                  │                    │
                    └─► アカウント連携 ─┘                    └─► Cronリマインド
                    │
                    └─► 管理画面UI
```

### 17.3 MVP定義 (Minimum Viable Product)

**Phase 1 MVP (Week 1-4)**:
- ✅ LINE友だち追加 → アカウント連携
- ✅ 「予定入力」→ AI会話で1児童分の1ヶ月予定収集
- ✅ 確認 → schedule_plansに保存
- ❌ 複数児童バッチモード (Phase 2)
- ❌ 変更・ロック (Phase 2)
- ❌ Cronリマインド (Phase 2)

**Phase 2 (Week 5-6)**:
- ✅ 複数児童対応
- ✅ 変更ルール + ロック
- ✅ 緊急キャンセル
- ✅ Cronリマインド

---

## 18. テスト計画

### 18.1 テスト種別

| 種別 | 対象 | ツール |
|------|------|--------|
| ユニットテスト | ロック判定、食事推定、連携コード生成 | Vitest |
| APIテスト | Webhook受信、管理API | curl / Hoppscotch |
| 会話テスト | AI会話フロー全パターン | LINEテストツール |
| E2Eテスト | 友だち追加→予定登録→確認 | 実機テスト |

### 18.2 テストシナリオ

#### 正常系
1. 新規ユーザーが友だち追加 → 連携コード入力 → 連携完了
2. 「予定入力」→ 基本パターン入力 → 例外日指定 → 確認 → 保存
3. 前月内に変更依頼 → 変更完了
4. 複数児童ユーザーが児童選択 → 各児童の予定入力

#### 異常系
5. 無効な連携コード → エラーメッセージ
6. 期限切れ連携コード → エラー + 再発行案内
7. ロック中に変更依頼 → ロック通知
8. 予定以外の質問 → スコープ外メッセージ
9. AI応答タイムアウト → リトライ案内
10. 不正なWebhook署名 → 401拒否

#### 境界値
11. 月末日の23:59に変更 → 可
12. 翌月1日の00:00に変更 → ロック
13. 緊急キャンセルを当月に → 可
14. 31日のある月 / 28日の月 → 正しい日数処理
15. 祝日を含む月 → 祝日確認メッセージ

---

## 19. 運用マニュアル

### 19.1 管理者の日常運用

| タイミング | 作業 | 場所 |
|-----------|------|------|
| 園児入園時 | 園児登録 → 連携コード発行 → 保護者に配布 | 管理画面 |
| 毎月初 | 未提出者リスト確認 → 必要なら手動リマインド | 管理画面 |
| 毎月末 | 翌月分の提出状況確認 → 未提出者への最終リマインド | 管理画面 |
| 随時 | 会話ログ確認 (異常がないか) | 管理画面 |
| 退園時 | LINE連携解除 | 管理画面 |

### 19.2 保護者向け説明資料 (案)

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
4. 最後に確認画面が出るので「はい」を押す
5. 完了！

✏️ 変更したい場合:
- 前月末日まで: 「予定変更」とLINEで送信
- 当月: 緊急のお休み（病気等）のみ対応
  → 「今日休みます」とLINEで送信
```

### 19.3 障害対応

| 障害 | 影響 | 対応 |
|------|------|------|
| LINE API障害 | 応答不可 | 管理画面からUI入力で代替 |
| OpenAI API障害 | AI応答不可 | フォールバック定型文で対応 |
| D1障害 | 全機能停止 | Cloudflare Status確認 → 復旧待ち |
| 会話状態不整合 | 会話ループ | 管理画面から会話リセット |

---

## 20. v1.0 → v2.0 設計差分

### 20.1 ドキュメント構造の変更

| 変更 | v1.0 | v2.0 | 理由 |
|------|------|------|------|
| テーブル名 | conversations | line_conversations | 既存テーブルとの衝突回避 |
| テーブル名 | conversation_logs | line_conversation_logs | 同上 |
| 新テーブル | - | schedule_change_requests | 変更履歴の監査証跡 |
| 状態マシン | 8状態 | 10状態 | AUTH_LINK, MODIFY, CANCEL_REQUEST追加 |
| セクション追加 | - | 紙予定表対比 (11) | ユーザー要望 |
| セクション追加 | - | 既存システム統合 (12) | 統合設計の明確化 |
| セクション追加 | - | 運用フロー (10) | 月次サイクル詳細化 |
| セクション追加 | - | v1→v2差分 (20) | 変更追跡 |

### 20.2 設計判断の変更

| 判断 | v1.0 | v2.0 | 理由 |
|------|------|------|------|
| breakfast_flag | 未考慮 | Phase 2で対応 | REQUIREMENTS_CHECKで課題発覚 |
| おやつの扱い | am/pm 2列 | 紙は統合、DB分離の対比を明記 | 紙予定表との整合性確認 |
| LLMの責務 | 曖昧 | 明確に分離 (5.3.4) | ビジネスルールはシステム側 |
| Cron方式 | 概要のみ | 3方式比較+推奨 | 実装可能性の検討 |

### 20.3 残課題 (実装着手前に要確認)

| # | 課題 | 担当 | 期限 |
|---|------|------|------|
| 1 | LINE公式アカウントの開設とMessaging API有効化 | 木村さん | 実装前 |
| 2 | OpenAI APIキーの準備 | 開発チーム | 実装前 |
| 3 | breakfast_flag の要否を木村さんに最終確認 | モギモギ | 設計レビュー時 |
| 4 | 紙予定表のおやつ(1列) → am/pm(2列) の運用ルール確認 | 木村さん | 設計レビュー時 |
| 5 | 緊急キャンセル時の schedule_plans 処理方法 (DELETE vs NULL化) | 設計レビュー | 実装前 |
| 6 | 保育料案内の延長/夜間時間帯 (seed.sql不整合問題) の修正 | 開発チーム | LINE実装前 |

---

## 21. マルチ施設対応拡張 (v3.0)

> 詳細は [MULTI_FACILITY_DESIGN.md](./MULTI_FACILITY_DESIGN.md) を参照

### 21.1 LINE公式アカウント戦略

**方式: 1施設1アカウント（推奨）**

| 項目 | v2.0 | v3.0 |
|------|------|------|
| アカウント数 | 1 (あゆっこ) | 施設ごとに1 (最大30) |
| Webhook URL | `/api/line/webhook` | `/api/line/webhook?nursery={code}` |
| Channel Secret | 1つ (env変数) | 施設ごとにDB暗号化保存 |
| 連携コード形式 | `AYK-XXXX` | `{施設コード}-XXXX` |

### 21.2 Webhook 施設振り分け

```
全施設の LINE Webhook URL (共通バックエンド):

  https://{domain}/api/line/webhook?nursery=AYK    → あゆっこ
  https://{domain}/api/line/webhook?nursery=FAC002  → 施設B
  https://{domain}/api/line/webhook?nursery=FAC003  → 施設C
  ...

処理フロー:
  1. nursery パラメータから施設特定
  2. nursery_settings から LINE Channel Secret を復号
  3. 施設ごとのSecretで署名検証
  4. 以降の処理は nursery_id スコープで実行
```

### 21.3 施設別LINE設定 (nursery_settings)

```json
{
  "nursery_id": "facility_xxx",
  "setting_key": "line_config",
  "setting_value": {
    "channel_id": "1234567890",
    "channel_secret": "encrypted:xxxxxxx",
    "channel_access_token": "encrypted:xxxxxxx",
    "webhook_url": "/api/line/webhook?nursery=XXX",
    "welcome_message": "○○保育所へようこそ！",
    "nursery_display_name": "○○保育所"
  }
}
```

### 21.4 会話テーブルのテナント分離

```sql
-- line_conversations に nursery_id を追加
-- v3.0: テナント分離のため
ALTER TABLE line_conversations ADD COLUMN nursery_id TEXT REFERENCES nurseries(id);

-- line_accounts にも nursery_id を追加
-- v3.0: 同一LINE userId が異なる施設に連携する場合を想定
ALTER TABLE line_accounts ADD COLUMN nursery_id TEXT REFERENCES nurseries(id);

-- UNIQUE制約の変更:
-- v2.0: UNIQUE(line_user_id, child_id)
-- v3.0: UNIQUE(line_user_id, child_id, nursery_id)
-- → 異なる施設で同じ保護者が兄弟を登録できる
```

### 21.5 リマインド送信のスコープ

```
v2.0: 全LINE連携ユーザーに一斉送信
v3.0: nursery_id ごとにスコープした送信

Cron Trigger (15日/25日):
  FOR EACH nursery IN active_nurseries:
    lineConfig = nursery_settings WHERE nursery_id = nursery.id
    未提出者 = SELECT ... WHERE nursery_id = nursery.id AND 未提出
    FOR EACH parent IN 未提出者:
      PUSH MESSAGE using lineConfig.channel_access_token
```

### 21.6 コスト影響

```
30施設でのLINEコスト:
  Reply Message: 無料 (大半の応答)
  Push Message: リマインド 30名 x 2回 x 30施設 = 1,800通/月

  各施設のプラン判断:
    ~200通/月: フリープラン → 0円
    ~500通/月: ライトプラン → 5,000円

  現実的見積: 大半がフリープランで運用可能
    → 月額 ~5,000円 (ライト5施設程度)
```

---

## 22. 保護者Webポータル設計 (v3.0)

> **★ Web/PWA ポータルが Primary チャネル。本セクションは参照情報のみ。**
> **詳細は MULTI_FACILITY_DESIGN.md v2.0 セクション6 を参照。**

### 22.1 概要

```
入力チャネルの優先度 (v4.0 更新):
  1. Web/PWA ポータル (Primary) → カレンダーUI、全施設即展開、要件①を100%充足
  2. LINE AI ヒアリング (Optional) → Phase 2、希望施設のみ
  3. スタッフ代行入力 (Backup) → 既存実装
```

### 22.2 URL構成

```
https://{domain}/parent/login          -- ログイン
https://{domain}/parent/schedule       -- 予定入力 (メイン)
https://{domain}/parent/schedule/edit  -- 予定修正
https://{domain}/parent/statement      -- 利用明細閲覧 (⑤ あゆっこのみ)
https://{domain}/parent/profile        -- プロフィール確認
```

### 22.3 ログイン方式

```
方式A: LINE Login (LIFF) ← 推奨
  LINE友だち追加 → LIFFアプリ起動 → LINE userId で自動認証
  → 追加の認証不要

方式B: マジックリンク (Email) ← Web ポータルと共通
  メアド入力 → 一時リンク送信 → クリックでログイン
  → パスワード不要で安全
  → MULTI_FACILITY_DESIGN.md セクション11 参照

方式C: 連携コード + PIN
  初回: 施設から配布された連携コード + 4桁PIN
  → メール未登録の保護者向け
```

### 22.4 予定入力UI (モバイル最適化)

```
ステップ1: 基本パターン設定
  利用曜日チェック: [月][火][水][木][金][土][日]
  登園時刻: [08:30 ▼]
  降園時刻: [17:00 ▼]
  食事: [✓昼食] [✓AMおやつ] [✓PMおやつ] [ 夕食]
  [パターンを全日に適用]

ステップ2: カレンダーで例外日を設定
  タップで日付選択 → 休み/時間変更/食事変更
  祝日はグレーアウトで自動表示

ステップ3: プレビュー + 確認
  全日程の一覧表示
  [提出する] ボタン

→ schedule_plans テーブルに保存 (source_file = 'WEB')
```

### 22.5 保護者向け利用明細閲覧 (要件⑤)

```
あゆっこのみの機能:
  /parent/statement?year=2026&month=4

  1. JWT認証 → 自分の子のみ表示
  2. charge_lines → PDF生成 (jsPDF)
  3. R2にキャッシュ (nursery_id/year/month/child_id.pdf)
  4. ブラウザでPDF表示 (印刷可)

LINE連携:
  月初に Push Message:
  "4月分の利用明細が確認できます → [明細を見る]"
  → LIFF or Webリンクで /parent/statement へ
```

---

## 23. v3.0 → v4.0 設計差分

### 23.1 v4.0 の主要変更

| 変更 | v3.0 | v4.0 | 理由 |
|------|------|------|------|
| **LINE の位置付け** | LINE + Web (2チャネル並列) | **Web が Primary、LINE は Optional** | モギモギ方針: Web/PWA で要件①は100%充足 |
| **入力チャネル優先度** | LINE メイン、Web サブ | **Web Primary → LINE Optional → スタッフ Backup** | LINE不要で紙廃止達成 |
| **Phase 1 前提条件** | 未明記 | **Web/PWA ポータル完成が LINE 有効化の前提条件** | 段階的展開 |
| **宣言文追加** | なし | **文書冒頭に位置付け宣言を追加** | ドキュメント読者への明確な案内 |
| **確認事項** | 各セクションに分散 | **MULTI_FACILITY_DESIGN.md v2.0 セクション19に6項目集約** | 一元管理 |
| 関連ドキュメント | MULTI_FACILITY_DESIGN.md v1.0 | **MULTI_FACILITY_DESIGN.md v2.0** | 連携強化 |

### 23.2 v2.0 → v3.0 設計差分 (参考)

| 判断 | v2.0 | v3.0 | 理由 |
|------|------|------|------|
| LINEアカウント | 1公式アカウント | 施設ごとに1アカウント | テナント分離 |
| Webhook設計 | 単一エンドポイント | nurseryパラメータ振分 | マルチ施設対応 |
| 連携コード | AYK-XXXX固定 | {施設コード}-XXXX | 施設間の衝突回避 |
| Channel Secret | 環境変数1つ | nursery_settingsにDB暗号化保存 | 30施設分の管理 |
| 認証 | なし | JWT + 4ロール | セキュリティ強化 |
| source_file | 'LINE', 'LINE_修正' | 'LINE', 'LINE_修正', 'WEB' 追加 | Webポータル対応 |

### 23.3 DBスキーマの変更 (v3.0追加分、v4.0変更なし)

```sql
-- v3.0: LINE関連テーブルにnursery_id追加
ALTER TABLE line_accounts ADD COLUMN nursery_id TEXT REFERENCES nurseries(id);
ALTER TABLE line_conversations ADD COLUMN nursery_id TEXT REFERENCES nurseries(id);

-- v3.0: ユーザー/セッション/設定テーブル
-- → migrations/0003_multi_facility.sql で定義
-- 詳細は MULTI_FACILITY_DESIGN.md セクション10を参照
```

### 23.4 LINE 実装前の残課題

> **注意**: Phase 1 (Web/PWA) 関連の確認事項は MULTI_FACILITY_DESIGN.md v2.0 セクション19に集約。
> 以下は **Phase 2 (LINE) 固有の残課題** のみ。

| # | 課題 | 由来 | 期限 |
|---|------|------|------|
| 1 | LINE公式アカウントの開設とMessaging API有効化 | v2.0 | Phase 2 実装前 |
| 2 | OpenAI APIキーの準備 | v2.0 | Phase 2 実装前 |
| 3 | 緊急キャンセル時のDB処理方法 (DELETE vs NULL化) | v2.0 | Phase 2 実装前 |
| 4 | 30施設のLINE公式アカウント開設計画 | v3.0 | Phase 2 前 |
| 5 | LINE Channel Secretの暗号化方式確定 | v3.0 | Phase 2 前 |
| 6 | LINE連携を希望する施設の特定 | v4.0 | Phase 2 前 |

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
      "type": "box",
      "layout": "vertical",
      "contents": [
        { "type": "text", "text": "お子さまを選択してください", "weight": "bold" }
      ]
    },
    "footer": {
      "type": "box",
      "layout": "vertical",
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

### A.2 予定確認サマリー
```json
{
  "type": "flex",
  "altText": "4月の利用予定確認",
  "contents": {
    "type": "bubble",
    "header": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        { "type": "text", "text": "4月の利用予定", "weight": "bold", "size": "lg" },
        { "type": "text", "text": "○○ちゃん", "size": "sm", "color": "#666666" }
      ]
    },
    "body": {
      "type": "box",
      "layout": "vertical",
      "contents": [
        { "type": "text", "text": "基本: 月-金 8:30-17:00", "size": "sm" },
        { "type": "text", "text": "食事: 午前おやつ+昼食+午後おやつ", "size": "sm" },
        { "type": "separator" },
        { "type": "text", "text": "例外:", "weight": "bold", "size": "sm" },
        { "type": "text", "text": "4/10(木) お休み", "size": "sm" },
        { "type": "text", "text": "4/15(火) 8:30-19:00 夕食あり", "size": "sm" },
        { "type": "text", "text": "4/22(火) お休み", "size": "sm" },
        { "type": "separator" },
        { "type": "text", "text": "合計: 19日利用予定", "weight": "bold" }
      ]
    },
    "footer": {
      "type": "box",
      "layout": "horizontal",
      "contents": [
        {
          "type": "button",
          "action": { "type": "postback", "label": "登録する", "data": "confirm=yes" },
          "style": "primary"
        },
        {
          "type": "button",
          "action": { "type": "postback", "label": "修正する", "data": "confirm=edit" },
          "style": "secondary"
        }
      ]
    }
  }
}
```

---

## 付録B: 日本の祝日判定

```
2026年の祝日リスト:
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

※ 実装時はnpmパッケージ `@holiday-jp/holiday_jp` または
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

---

## 付録D: wrangler.jsonc 更新 (計画)

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
  // Cron Trigger (リマインド用) - Pages Functionsでは
  // Scheduled Eventsの代わりに別途Workerで実装
  // "triggers": { "crons": ["0 1 15 * *", "0 1 25 * *"] }
}
```

---

## 変更履歴

| バージョン | 日付 | 内容 |
|-----------|------|------|
| 1.0 | 2026-03-04 | 初版作成 |
| 2.0 | 2026-03-04 | v2.0: テーブル名変更(line_prefix追加)、状態マシン10状態化、紙予定表対比、breakfast_flag対応方針、既存システム統合設計、運用フロー詳細化、schedule_change_requestsテーブル追加、設計差分セクション追加 |
| 3.0 | 2026-03-04 | v3.0: マルチ施設対応(30施設展開)、保護者Webポータル設計、施設別LINEアカウント戦略、Webhook施設振分設計、JWT認証+ロールモデル導入、nursery_id テナント分離、MULTI_FACILITY_DESIGN.md連携 |
| **4.0** | **2026-03-04** | **v4.0: LINE を Phase 2 Optional に明確格下げ。Web/PWA ポータルが Primary チャネルであることを文書冒頭に宣言。入力チャネル優先度を Web > LINE > スタッフ代行に更新。MULTI_FACILITY_DESIGN.md v2.0 との連携を強化。6確認事項をv2.0に集約。** |

---

*この文書は Phase 2 Optional の設計計画です。実装コードは含まれていません。*
*★★★ 保護者の月次予定入力 (要件①) は Web/PWA ポータルで 100% 充足されます。LINE は不要です。★★★*
*LINE連携は Phase 2 Optional です。Phase 1 (Web/PWA ポータル) の完成が前提条件です。*
*実装着手前に、LINE公式アカウントの開設と OpenAI APIキーの準備が必要です。*
*マルチテナントアーキテクチャ、保護者 Web ポータル (Primary)、認証設計の詳細は [MULTI_FACILITY_DESIGN.md](./MULTI_FACILITY_DESIGN.md) v2.0 を参照。*

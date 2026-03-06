# あゆっこ保育所 業務自動化システム

> **Version**: 7.0 — LINE Phase 1 MVP (2026-03-06)
> **GitHub**: https://github.com/matiuskuma2/hoikuen
> **本番URL**: https://ayukko-nursery.pages.dev

---

## プロジェクト概要

滋賀医科大学学内保育所「あゆっこ」の月次帳票作成業務を自動化し、
LINE経由で保護者から利用予定を収集するシステム。

**コア体験**:
1. 保護者がLINEで来月の利用予定を提出（日付・登園・降園の3項目のみ）
2. 管理画面で月間ダッシュボード表示
3. ワンクリックで提出物ZIP一括生成（日報・明細・PDF）

---

## 技術スタック

| レイヤー | 技術 |
|---------|------|
| Frontend | HTML + TailwindCSS + Vanilla JS |
| Backend (API) | Hono (Cloudflare Workers/Pages) |
| Backend (Generator) | Python + FastAPI (uvicorn, port 8787) |
| Database | Cloudflare D1 (SQLite) |
| Storage | Cloudflare R2 |
| Excel処理 | ExcelJS (Worker内) + openpyxl (Python) |
| PDF生成 | jsPDF / ReportLab |
| LINE連携 | Web Crypto API + fetch (SDK不使用) |
| プロセス管理 | PM2 |

---

## ディレクトリ構成

```
webapp/
├── src/                          # Hono バックエンド (TypeScript)
│   ├── index.tsx                 # メインアプリ (UI + ルーティング)
│   ├── routes/
│   │   ├── children.ts           # 園児CRUD API
│   │   ├── jobs.ts               # ジョブ管理API
│   │   ├── line.ts               # LINE webhook + 会話状態機械 ★
│   │   ├── schedules.ts          # 予定管理API
│   │   └── templates.ts          # テンプレート管理API
│   ├── lib/
│   │   ├── age-class.ts          # 年齢クラス計算
│   │   ├── charge-calculator.ts  # 料金計算
│   │   ├── conversation.ts       # 会話状態管理・パーサー・UPSERT ★ NEW
│   │   ├── line-client.ts        # LINE署名検証 + HTTP通信
│   │   ├── name-matcher.ts       # 名前マッチング
│   │   └── usage-calculator.ts   # 利用実績計算
│   └── types/
│       └── index.ts              # 型定義 (Bindings含む)
├── generator/                    # Python Generator (帳票生成エンジン)
│   ├── main.py                   # FastAPI エントリ (port 8787)
│   ├── engine/                   # 計算エンジン
│   ├── parsers/                  # Excel/CSVパーサー
│   ├── writers/                  # 帳票書き出し
│   ├── storage.py                # R2ストレージ連携
│   └── requirements.txt          # Python依存
├── public/static/
│   └── app.js                    # フロントエンドJS
├── migrations/
│   ├── 0001_initial_schema.sql   # DBスキーマ（基本テーブル）
│   └── 0002_line_integration.sql # LINE用テーブル ★ NEW
├── docs/                         # 設計ドキュメント一式
│   ├── line-decisions.md         # LINE連携 全決定事項（確定版）
│   ├── line-conversation-flow.md # 会話フロー状態機械設計書
│   ├── line-review-notes.md      # レビュー議事録・計画ノート
│   ├── SETUP.md                  # 環境復旧手順書
│   ├── LINE_SCHEDULE_COLLECTION_PLAN.md
│   ├── MULTI_FACILITY_DESIGN.md
│   └── REQUIREMENTS_CHECK.md
├── tests/                        # テストデータ
├── REQUIREMENTS.md               # 完全要件定義書 v3.1
├── ecosystem.config.cjs          # PM2設定
├── wrangler.jsonc                # Cloudflare設定
├── vite.config.ts                # ビルド設定
├── tsconfig.json                 # TypeScript設定
├── package.json                  # npm依存
├── seed.sql                      # 初期データ（テスト園児+連携コード）
└── .dev.vars                     # 環境変数（gitignore済み、復旧手順→SETUP.md）
```

---

## API エンドポイント一覧

### 基本
| Method | Path | 説明 |
|--------|------|------|
| GET | `/` | メインUI (ダッシュボード) |
| GET | `/api/health` | ヘルスチェック |
| GET | `/api/config` | Generator URL設定 |

### 園児管理
| Method | Path | 説明 |
|--------|------|------|
| GET | `/api/children` | 園児一覧 |
| POST | `/api/children` | 園児登録 |
| PUT | `/api/children/:id` | 園児更新 |
| DELETE | `/api/children/:id` | 園児削除 |

### 予定管理
| Method | Path | 説明 |
|--------|------|------|
| POST | `/api/schedules/dashboard` | ダッシュボード用データ取得 |
| POST | `/api/schedules/upsert` | 予定UPSERT |
| GET | `/api/schedules/:childId/:year/:month` | 園児別予定取得 |

### LINE連携
| Method | Path | 説明 |
|--------|------|------|
| POST | `/api/line/webhook` | LINE Webhookエンドポイント |
| GET | `/api/line/health` | LINE連携ステータス |

### ジョブ・テンプレート
| Method | Path | 説明 |
|--------|------|------|
| POST | `/api/jobs` | ジョブ作成 |
| GET | `/api/jobs/:id` | ジョブ状態取得 |
| POST | `/api/templates` | テンプレート登録 |
| GET | `/api/templates` | テンプレート一覧 |

---

## LINE 予定収集フロー（Phase 1 MVP）

### 状態遷移

```
IDLE → LINKING → LINKED → SELECT_MONTH → COLLECTING → CONFIRM → SAVED
                              ↑                                    |
                              └────────── 追加入力 ────────────────┘
```

### 保護者の操作フロー

1. **友だち追加** → ウェルカムメッセージ（連携コード入力を促す）
2. **連携コード入力** → `AYK-XXXX` で園児と紐づけ
3. **「予定入力」** → 児童自動選択 → 月を聞く
4. **月を入力** → 「4月」で入力モードへ
5. **予定を入力** → 固定フォーマット（例: `1日 8:30-17:30`, `5日-10日 8:30-17:30`）
6. **「確認」** → 入力内容を一覧表示
7. **「確定」** → `schedule_plans` に UPSERT保存（source_file='LINE'）

### 入力形式

```
1日 8:30-17:30          # 単日
4/2 9:00-18:00          # 月/日形式
5日-10日 8:30-17:30     # 範囲指定（5日分まとめて）
```

### グローバルコマンド

| コマンド | 動作 |
|---------|------|
| `リセット` | 最初に戻る |
| `ヘルプ` | 使い方表示 |
| `状態` | 現在の状態確認 |
| `一覧` | 入力中の内容表示 |
| `クリア` | 入力をやり直し |

### 設計原則

- **推定禁止**: 食事は園側管理。LINE入力は日付・登園・降園の3項目のみ
- **LLM不使用** (Phase 1): 固定フォーマット入力のみ
- **部分確定可**: 入力分だけ確定→追加入力ができる
- **即200OK**: LINE Platformの1秒タイムアウト対策

---

## LINE公式アカウント情報

| 項目 | 値 |
|------|-----|
| Channel ID | `2005879095` |
| 友だち追加リンク | https://lin.ee/H02sZM5 |
| Webhook URL（本番） | `https://ayukko-nursery.pages.dev/api/line/webhook` |

---

## DBスキーマ（LINE関連テーブル）

| テーブル | 用途 |
|---------|------|
| `line_accounts` | LINE userId ↔ 保護者の紐づけ |
| `line_account_children` | 保護者 ↔ 園児の紐づけ（1対多） |
| `link_codes` | 連携コード管理（園が発行） |
| `conversations` | 会話状態（1ユーザー1行） |
| `conversation_logs` | 会話ログ（監査用） |
| `schedule_change_requests` | 変更リクエスト記録（前日17時以降用） |

---

## 現在のステータス

### ✅ 完了
- メインUI（ダッシュボード・園児管理・予定入力・ファイル入力・提出物生成）
- Python Generator（帳票生成エンジン）
- **LINE Phase 1 MVP** — 会話状態機械・全フロー動作確認済み
  - 友だち追加 → 連携コード検証 → 園児紐づけ
  - 月選択 → 予定入力（固定フォーマット・範囲指定対応）
  - 確認 → 確定 → schedule_plans UPSERT保存

### 🔨 次のステップ
- 実機LINEテスト（本番Webhook URL設定）
- Cloudflare Pages デプロイ
- 園側管理画面で連携コード発行機能
- 前日17時以降の変更リクエスト処理

### 📋 将来対応
- LLMによる自然言語→構造化変換（Phase 2）
- 園スタッフへの通知機能
- マルチ園対応

---

## ドキュメント一覧

| ファイル | 内容 | 状態 |
|---------|------|------|
| `REQUIREMENTS.md` | 完全要件定義書 v3.1 | 確定 |
| `docs/line-decisions.md` | LINE連携 全6決定事項 | 確定（木村さん回答ベース） |
| `docs/line-conversation-flow.md` | 会話フロー状態機械設計 | 設計完了・実装済み |
| `docs/line-review-notes.md` | レビュー議事録・経緯記録 | 記録済み |
| `docs/SETUP.md` | 環境復旧手順書 | 確定 |

---

## 変更履歴

| 日付 | 内容 |
|------|------|
| 2026-03-06 | **v7.0**: LINE Phase 1 MVP実装 — 会話状態機械・予定入力・UPSERT保存 |
| 2026-03-06 | docs: 設計ドキュメント3件追加、README+SETUP.md作成 |
| 2026-03-04 | LINE webhook初期実装 (署名検証・follow応答) |
| 2026-03-02 | v6.1: ダッシュボードDB直結モード |

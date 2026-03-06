# あゆっこ保育所 業務自動化システム

> **Version**: 6.1 (2026-03-06)
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
│   │   ├── line.ts               # LINE webhook + 管理API ★
│   │   ├── schedules.ts          # 予定管理API
│   │   └── templates.ts          # テンプレート管理API
│   ├── lib/
│   │   ├── age-class.ts          # 年齢クラス計算
│   │   ├── charge-calculator.ts  # 料金計算
│   │   ├── line-client.ts        # LINE署名検証 + HTTP通信 ★
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
│   └── 0001_initial_schema.sql   # DBスキーマ
├── docs/                         # ★ 設計ドキュメント一式
│   ├── line-decisions.md         # LINE連携 全決定事項（確定版）
│   ├── line-conversation-flow.md # 会話フロー状態機械設計書
│   ├── line-review-notes.md      # レビュー議事録・計画ノート
│   ├── LINE_SCHEDULE_COLLECTION_PLAN.md  # LINE予定収集 設計計画書 v2.0
│   ├── MULTI_FACILITY_DESIGN.md  # マルチ園設計（将来）
│   └── REQUIREMENTS_CHECK.md     # 要件チェックリスト
├── tests/                        # テストデータ
├── REQUIREMENTS.md               # 完全要件定義書 v3.1
├── ecosystem.config.cjs          # PM2設定
├── wrangler.jsonc                # Cloudflare設定
├── vite.config.ts                # ビルド設定
├── tsconfig.json                 # TypeScript設定
├── package.json                  # npm依存
├── seed.sql                      # 初期データ
└── .dev.vars                     # 環境変数（※gitignore済み、復旧手順はSETUP.md参照）
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

### LINE連携 ★
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

## LINE公式アカウント情報

| 項目 | 値 |
|------|-----|
| Channel ID | `2005879095` |
| 友だち追加リンク | https://lin.ee/H02sZM5 |
| Webhook URL（本番） | `https://ayukko-nursery.pages.dev/api/line/webhook` |

---

## 現在のステータス

### ✅ 完了
- メインUI（ダッシュボード・園児管理・予定入力・ファイル入力・提出物生成）
- Python Generator（帳票生成エンジン）
- LINE Webhook（署名検証・イベント受信・follow応答）動作確認済み

### 🔨 設計完了・実装待ち
- LINE会話フロー（状態機械）→ `docs/line-conversation-flow.md`
- 会話状態テーブル・変更リクエストテーブル → 同上§4
- アカウント連携（link_codes） → 同上§3.2

### 📋 未着手
- LLMによる自然言語→構造化変換
- 園スタッフへの通知機能
- マルチ園対応

---

## ドキュメント一覧

| ファイル | 内容 | 状態 |
|---------|------|------|
| `REQUIREMENTS.md` | 完全要件定義書 v3.1 | 確定 |
| `docs/line-decisions.md` | LINE連携 全6決定事項 | 確定（木村さん回答ベース） |
| `docs/line-conversation-flow.md` | 会話フロー状態機械設計 | 設計完了 |
| `docs/line-review-notes.md` | レビュー議事録・経緯記録 | 記録済み |
| `docs/LINE_SCHEDULE_COLLECTION_PLAN.md` | LINE予定収集 計画書 v2.0 | 参考（decisionsで上書き） |
| `docs/MULTI_FACILITY_DESIGN.md` | マルチ園設計 | 将来用 |
| `docs/REQUIREMENTS_CHECK.md` | 要件チェックリスト | 参考 |
| `docs/SETUP.md` | 環境復旧手順書 | 確定 |

---

## 変更履歴

| 日付 | 内容 |
|------|------|
| 2026-03-06 | README.md作成。LINE webhook実装済み、会話フロー設計完了 |
| 2026-03-04 | LINE webhook初期実装 (commit dcc7f88) |
| 2026-03-02 | v6.1: ダッシュボードDB直結モード |

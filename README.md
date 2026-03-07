# あゆっこ保育所 業務自動化システム

> **Version**: 8.1 — LINE管理画面追加 (2026-03-07)
> **GitHub**: https://github.com/matiuskuma2/hoikuen

---

## 環境URL

| 環境 | URL | 状態 |
|------|-----|------|
| **Production** | https://ayukko-prod.pages.dev | ✅ 稼働中 |
| **Staging** | https://ayukko-stg.pages.dev | ✅ 稼働中 |
| LINE Health | https://ayukko-prod.pages.dev/api/line/health | ✅ |
| LINE Webhook | https://ayukko-prod.pages.dev/api/line/webhook | ✅ 実機テスト済み |

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
| Backend (API) | Hono (Cloudflare Pages) |
| Backend (Generator) | Python + FastAPI (uvicorn, port 8787) |
| Database | Cloudflare D1 (SQLite) |
| Storage | Cloudflare R2 |
| LINE連携 | Web Crypto API + fetch (SDK不使用) |
| プロセス管理 | PM2 |

---

## Cloudflare リソース構成

| リソース | Staging | Production |
|---------|---------|------------|
| Pages | `ayukko-stg` | `ayukko-prod` |
| D1 | `ayukko-staging` (`285fa9a7...`) | `ayukko-production` (`baef24d6...`) |
| R2 | `ayukko-files-stg` | `ayukko-files-prod` |
| LINE Secrets | ✅ 設定済み | ✅ 設定済み |

---

## LINE 予定収集フロー（Phase 1 MVP — 実機テスト済み）

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

### 現在の制限事項

- 1 LINEユーザー = 1園児（最初の1人を自動選択）
- 固定フォーマット入力のみ（自然言語未対応）
- 食事は保護者入力なし（園側管理）
- 前日17時ルールなど変更受付は未実装

---

## LINE公式アカウント情報

| 項目 | 値 |
|------|-----|
| Channel ID | `2005879095` |
| 友だち追加リンク | https://lin.ee/H02sZM5 |
| Webhook URL | `https://ayukko-prod.pages.dev/api/line/webhook` |

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
| GET | `/api/line/link-codes` | 連携コード一覧 |
| POST | `/api/line/link-codes` | 連携コード新規発行 |
| GET | `/api/line/submission-status` | 月次提出状況（?year=&month=） |

### ジョブ・テンプレート
| Method | Path | 説明 |
|--------|------|------|
| POST | `/api/jobs` | ジョブ作成 |
| GET | `/api/jobs/:id` | ジョブ状態取得 |
| POST | `/api/templates` | テンプレート登録 |
| GET | `/api/templates` | テンプレート一覧 |

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

## Seed データ

| ファイル | 用途 | 対象環境 |
|---------|------|---------|
| `seed.sql` | 本番用（料金ルールのみ） | production |
| `seed.dev.sql` | テスト用（園児＋連携コード） | staging / local |

---

## 現在のステータス

### ✅ 完了
- メインUI（ダッシュボード・園児管理・予定入力・ファイル入力・提出物生成）
- Python Generator（帳票生成エンジン）
- **LINE Phase 1 MVP** — 実機テスト完了 (2026-03-07)
  - 友だち追加 → 連携コード検証 → 園児紐づけ
  - 月選択 → 予定入力（固定フォーマット・範囲指定対応）
  - 確認 → 確定 → schedule_plans UPSERT保存
- **LINE管理画面** (v8.1)
  - 🟢 友だち追加QRコード＆リンク表示
  - 🟢 連携コード発行・一覧表示（使用状況・有効期限・使用者）
  - 🟢 月次提出状況（全園児のLINE連携/提出済み/未提出を一覧表示）
  - 🟢 提出状況サマリー（園児数・連携済・提出済・未提出のカウント）
- Cloudflare Production / Staging 環境構築
- D1 マイグレーション + seed データ投入

### ⚠️ 要対応
- LINE Secret / Token ローテーション（本番運用開始前に必須）
- テストデータを本番DBから除去（実運用開始時）

### 🔨 Phase 2（次フェーズ）
- 前日17時以降の変更リクエスト処理
- 複数園児対応（SELECT_CHILD状態の追加）
- 園スタッフへの通知機能
- LLMによる自然言語→構造化変換

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
| 2026-03-07 | **v8.1**: LINE管理画面（友だち追加リンク・連携コード発行・提出状況一覧）追加 |
| 2026-03-07 | **v8.0**: Production/Staging環境構築、LINE実機テスト完了 |
| 2026-03-06 | **v7.0**: LINE Phase 1 MVP実装 — 会話状態機械・予定入力・UPSERT保存 |
| 2026-03-06 | docs: 設計ドキュメント3件追加、README+SETUP.md作成 |
| 2026-03-04 | LINE webhook初期実装 (署名検証・follow応答) |
| 2026-03-02 | v6.1: ダッシュボードDB直結モード |

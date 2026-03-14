# あゆっこ保育所 業務自動化システム

> **Version**: 9.5 — URL保護・ユニットテスト85件・nursery_id一元化 (2026-03-14)
> **GitHub**: https://github.com/matiuskuma2/hoikuen

---

## 環境URL

| 環境 | URL | 状態 |
|------|-----|------|
| **Production** | https://ayukko-prod-2fx.pages.dev | ✅ v9.5 稼働中 |
| **Staging** | https://ayukko-stg-1gv.pages.dev | ✅ v9.5 稼働中 |
| LINE Health | https://ayukko-prod-2fx.pages.dev/api/line/health | ✅ |
| LINE Webhook | https://ayukko-prod-2fx.pages.dev/api/line/webhook | ⚠️ 要Webhook URL更新 |
| 保護者カレンダー | https://ayukko-prod-2fx.pages.dev/my/{viewToken} | ✅ view_token 保護済み |

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
| Pages | `ayukko-stg` → `ayukko-stg-1gv.pages.dev` | `ayukko-prod` → `ayukko-prod-2fx.pages.dev` |
| D1 | `ayukko-staging` (`6352b540...`) | `ayukko-production` (`92726720...`) |
| R2 | `ayukko-files-stg` | `ayukko-files-prod` |
| Account | `1eb9b7b82253bdac108f0c482dd1c368` | 同左 |
| LINE Secrets | ⚠️ 要設定 | ⚠️ 要設定（新アカウント） |

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
| Webhook URL | `https://ayukko-prod-2fx.pages.dev/api/line/webhook` ⚠️ LINE Developers で更新が必要 |

---

## API エンドポイント一覧

### 基本
| Method | Path | 説明 |
|--------|------|------|
| GET | `/` | メインUI (ダッシュボード) |
| GET | `/my/:viewToken` | 保護者向けカレンダー（view_token認証） |
| GET | `/my/:viewToken/:year/:month` | 保護者向けカレンダー（年月指定） |
| GET | `/api/health` | ヘルスチェック |
| GET | `/api/config` | Generator URL設定 |

### 園児管理
| Method | Path | 説明 |
|--------|------|------|
| GET | `/api/children` | 園児一覧 |
| POST | `/api/children` | 園児登録（view_token 自動生成） |
| PUT | `/api/children/:id` | 園児更新 |
| DELETE | `/api/children/:id` | 園児削除 |
| POST | `/api/children/:id/regenerate-token` | view_token 再発行 |

### 予定管理
| Method | Path | 説明 |
|--------|------|------|
| POST | `/api/schedules/dashboard` | ダッシュボード用データ取得（提出状況概要含む） |
| POST | `/api/schedules/upsert` | 予定UPSERT |
| GET | `/api/schedules/view/:token/:year/:month` | 保護者カレンダーAPI（view_token or childId） |
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
- **URL保護** (v9.5)
  - 🟢 公開カレンダーURLを view_token (32文字ランダム) で保護
  - 🟢 `/my/:viewToken` / `/api/schedules/view/:token/:year/:month` 対応
  - 🟢 childId後方互換維持（既存リンクが動作）
  - 🟢 `POST /api/children/:id/regenerate-token` でトークン再発行可能
- **ユニットテスト** (v9.5)
  - 🟢 Vitest v4.1.0 導入・全85件パス
  - 🟢 閾値境界テスト (17:59/18:00/18:01/19:59/20:00/20:01)
  - 🟢 parseLukumi / parseSchedule / computeUsageFacts / buildDashboardFromFormData
  - 🟢 normalizeName 全角⇔半角変換テスト
- **nursery_id 一元化** (v9.5)
  - 🟢 `DEFAULT_NURSERY_ID` を types/index.ts に一元定義
  - 🟢 children/jobs/schedules/templates/line 全ファイルのハードコード排除
- **保護者カレンダー** (v8.2)
  - 🟢 園児別カレンダーページ `/my/{childId}` — 月ナビゲーション・日別一覧・食事バッジ
  - 🟢 カレンダーURLを管理画面の提出状況テーブルからリンク
- **ダッシュボード提出状況** (v8.2)
  - 🟢 提出済/未提出の園児を名前つきで表示（空スロット対応）
  - 🟢 未提出の園児が赤枠で強調表示
- **コードレビュー Phase 1・2 完了** (v9.3→v9.4)
  - 🟢 ダッシュボード重複ロジックを `dashboard-builder.ts` に集約
  - 🟢 `try/catch` ・入力サニタイズ・`parseInt(...,10)` 追加
  - 🟢 `normalizeName` / `timeToMinutes` 実装統一
  - 🟢 `types/index.ts` に Parsed* 型を集約（excel-parser.ts の重複型定義削除）
  - 🟢 `TIME_BOUNDARIES` を types/index.ts に一元化
    - 延長保育: 18:00 (1080分) / 夜間保育: 20:00 (1200分)
    - 全モジュール (excel-parser, usage-calculator, schedules) が同一値を参照
  - 🟢 `warnings_json` の `JSON.parse` 安全化
  - 🟢 ファイルサイズ上限 50MB チェック追加
- Cloudflare Production / Staging 環境構築
- D1 マイグレーション + seed データ投入

### ⚠️ 要対応
- **LINE Webhook URL更新**: LINE Developers Console で Webhook URL を `https://ayukko-prod-2fx.pages.dev/api/line/webhook` に変更が必要
- LINE Secret / Token ローテーション（本番運用開始前に必須）
- 認証・認可の導入（管理画面保護）
- カスタムドメイン設定（オプション）

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
| 2026-03-14 | **v9.5**: URL保護（view_token 32文字）、ユニットテスト85件追加（Vitest）、nursery_id一元化（DEFAULT_NURSERY_ID）、新Cloudflareアカウントにデプロイ完了（本番+ステージング）、migration 0004適用済み |
| 2026-03-14 | **v9.4**: 型定義統合（Parsed* prefixで excel-parser 独自型を types/index.ts に集約）、延長保育閾値統一（18:00）、schedules.ts のハードコード閾値を TIME_BOUNDARIES に置換 |
| 2026-03-14 | **v9.3**: コードレビュー Phase 1・2 — ダッシュボード集約・try/catch・サニタイズ・normalizeName統一・ファイルサイズ上限追加 |
| 2026-03-07 | **v8.1**: LINE管理画面（友だち追加リンク・連携コード発行・提出状況一覧）追加 |
| 2026-03-07 | **v8.0**: Production/Staging環境構築、LINE実機テスト完了 |
| 2026-03-06 | **v7.0**: LINE Phase 1 MVP実装 — 会話状態機械・予定入力・UPSERT保存 |
| 2026-03-06 | docs: 設計ドキュメント3件追加、README+SETUP.md作成 |
| 2026-03-04 | LINE webhook初期実装 (署名検証・follow応答) |
| 2026-03-02 | v6.1: ダッシュボードDB直結モード |

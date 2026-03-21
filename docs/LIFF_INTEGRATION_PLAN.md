# LIFF統合計画書 — あゆっこ利用予定入力 LINE内完結化

> **Version**: 2.0 (2026-03-21)
> **Status**: Phase 1 実装完了 ✅
> **Author**: GenSpark AI Developer
> **Reviewer**: モギモギ（関屋紘之）

---

## 0. この文書の目的

LINE公式アカウントのリッチメニューから、保護者が「予定入力」を1タップで開き、
LINE内ブラウザ（LIFF）で予定入力・確認・保存を完結させるための
**現状分析 → ギャップ整理 → 実装計画 → 不明点**をまとめる。

---

## 1. 現状の完全棚卸し

### 1-A. 既に動いている（本番稼働中）

| 機能 | 実装状態 | ファイル | 本番URL例 |
|---|---|---|---|
| 保護者入力画面 `/my/:token` | ✅ 本番稼働 | `src/index.tsx` L1339-1878 | `/my/b642e03a...` |
| view_token 発行（園児ごと32文字hex） | ✅ 68名全員発行済み | `migrations/0004_view_token.sql` | — |
| 予定取得 API `GET /api/schedules/view/:token/:year/:month` | ✅ 本番稼働 | `src/routes/schedules.ts` L414-503 | — |
| 予定保存 API `POST /api/schedules/submit/:token` | ✅ 本番稼働 | `src/routes/schedules.ts` L510-610 | — |
| 職員日報画面 `/staff/daily/:year/:month/:day` | ✅ 本番稼働 | `src/index.tsx` L98, L1884-2116 | `/staff/daily/2026/3/21` |
| ダッシュボードAPI `POST /api/schedules/dashboard` | ✅ 本番稼働 | `src/routes/schedules.ts` L158-408 | — |
| 管理画面（6タブ: dashboard, children, line-manage, schedule-input, upload, generate） | ✅ 本番稼働 | `src/index.tsx` L160-530 | `/` |

### 1-B. 実装済みだが本番接続されていない

| 機能 | 実装状態 | ファイル | 問題点 |
|---|---|---|---|
| LINE Webhook `POST /api/line/webhook` | ✅ コード実装済み | `src/routes/line.ts` L53-81 | 本番Webhook URL未設定（LINE Developer Console側） |
| HMAC-SHA256署名検証 | ✅ 動作確認済み | `src/lib/line-client.ts` L22-41 | — |
| LINE会話状態機械（IDLE→LINKING→LINKED→SELECT_MONTH→COLLECTING→CONFIRM→SAVED） | ✅ 全状態実装済み | `src/routes/line.ts` L195-254, `src/lib/conversation.ts` | テスト環境でのみ動作確認 |
| 連携コード検証 `AYK-XXXX` | ✅ 実装済み | `src/lib/conversation.ts` L163-236 | 下記「技術負債」参照 |
| 連携コード管理API (GET/POST `/api/line/link-codes`) | ✅ 実装済み | `src/routes/line.ts` L765-801 | — |
| LINE経由保存 (`source_file='LINE'`) | ✅ 実装済み | `src/lib/conversation.ts` L726-771 | — |
| 提出状況API `GET /api/line/submission-status` | ✅ 実装済み | `src/routes/line.ts` L807-902 | — |
| 管理画面「LINE予定収集」タブ | ✅ UI実装済み | `src/index.tsx` L534-700 | 連携コード発行・提出状況表示のUI完成 |
| Follow/Unfollowハンドラー | ✅ 実装済み | `src/routes/line.ts` L147-189 | — |

### 1-C. Phase 1 実装完了（2026-03-21）

| 機能 | 実装状態 | ファイル | 備考 |
|---|---|---|---|
| LIFF SDK統合 | ✅ 実装済み | `src/index.tsx` L1379-1700 | LINE LIFF SDK 2.x 統合 |
| LIFF起動ページ `/line/entry` | ✅ 実装済み | `src/index.tsx` L103-107, L1379-1700 | リッチメニューのエンドポイント |
| Web経由連携API `POST /api/liff/link` | ✅ 実装済み | `src/routes/liff.ts` L67-149 | userId + code → 紐付け |
| userId → view_token 自動取得API `GET /api/liff/me` | ✅ 実装済み | `src/routes/liff.ts` L24-62 | 連携状態確認 |
| link_code_children テーブル | ✅ 実装済み | `migrations/0006_link_code_children.sql` | TD-1修正 |
| verifyAndLinkCode セキュリティ修正 | ✅ 実装済み | `src/lib/conversation.ts` L169-252 | 全園児→指定園児のみ |
| 管理画面 園児選択コード発行 | ✅ 実装済み | `src/routes/line.ts`, `public/static/app.js` | モーダルUI |
| 提出状況に view_token / active_code 追加 | ✅ 実装済み | `src/routes/line.ts` L885-998 | カレンダーリンク改善 |
| CORS LIFF対応 | ✅ 設定済み | `src/index.tsx` L24-44 | `.line.me`, `.line-scdn.net` 追加済み |

### 1-D. 未実装（要外部設定 or Phase 2）

| 機能 | 必要性 | 備考 |
|---|---|---|
| リッチメニュー設定 | 🔴 要手動設定 | LINE Official Account Manager側 |
| LINE Developer Console でのLIFFアプリ登録 | 🔴 要手動設定 | LIFF IDの発行が前提 |
| 毎月自動Push通知（未提出者催促） | 🟡 Phase 2 | — |

---

## 2. DB構造の現状と変更要否

### 2-A. 使用するテーブル（既存・変更不要）

| テーブル | 用途 | 備考 |
|---|---|---|
| `children` | 園児マスタ。`view_token`で保護者URLと紐付け | 68名、全員view_token発行済み |
| `schedule_plans` | 予定データ本体。UPSERT `ON CONFLICT (child_id, year, month, day)` | source_file で経路識別 |
| `line_accounts` | LINE userId ↔ 園（1:1） | `unlinked_at` で無効化可能 |
| `line_account_children` | LINE account ↔ 園児（多:多） | 兄弟対応設計済み |
| `link_codes` | 連携コード `AYK-XXXX`。90日有効期限 | `used_by_line_account_id` で使用済み管理 |
| `conversations` | 会話状態機械の状態保持 | LIFFでは使わない（LINE会話経路のみ） |
| `conversation_logs` | 監査ログ | LIFFでは使わない |

### 2-B. 必要なDB変更

**なし。** 既存テーブルで完全にカバーできる。

ただし、**`link_codes` テーブルの設計上の問題**がある（下記「技術負債」参照）。

---

## 3. 技術負債・矛盾点・リスクの完全洗い出し

### TD-1: ~~🔴 link_codes → child紐付けが全園児一括（致命的）~~ ✅ 修正済み

**修正内容** (2026-03-21):
- `link_code_children` テーブルを新設 (`migrations/0006_link_code_children.sql`)
- 管理画面でコード発行時に対象園児をチェックボックスで選択
- `verifyAndLinkCode()` は `link_code_children` から指定園児のみ取得・紐付け
- 対象園児が未設定のコードは無効とし、全園児紐付けを完全防止

### TD-2: 🟡 source_file の値が経路ごとにバラバラ

**現状**:
- Web入力（`/my/:token`経由）: `'保護者Web入力'` (schedules.ts L582)
- LINE会話経由: `'LINE'` (conversation.ts L741)
- Excel/CSVアップロード: ファイル名が入る
- LIFF経由: **未定義**

**修正案**: LIFF経由は `'LIFF'` で統一。将来の分析で経路別集計が可能になる。

### TD-3: ~~🟡 CORS設定にLINE LIFF domainが未追加~~ ✅ 修正済み

**修正内容**: `src/index.tsx` L34-35 に `.line.me` と `.line-scdn.net` を追加済み。

### TD-4: 🟡 view_token 直リンクとLIFF経路の二重導線

**現状**: `/my/:token` は認証なしで誰でもアクセス可能（トークンが推測不能なので安全）。
**問題**: LIFF導入後、2つの入口が存在する。
- `/my/:token` → トークン知ってれば誰でもアクセス
- LIFF → LINE userId で本人確認後にリダイレクト

**方針**: 両方残す。`/my/:token` は直リンク共有やLINE外ブラウザ用として有用。LIFF経由が主導線。

### TD-5: 🟢 LINE Webhook本番URLが未設定

**現状**: LINE Developer Consoleで本番Webhook URLが設定されていない。
- 設計書記載: `https://ayukko-nursery.pages.dev/api/line/webhook`
- 実際の本番: `https://ayukko-prod-2fx.pages.dev/api/line/webhook`
**修正**: LIFF統合時に合わせて設定する。

### TD-6: 🟢 LINE環境変数が本番にデプロイされているか未確認

**現状**: `.dev.vars` にはLINE_CHANNEL_SECRETとLINE_CHANNEL_ACCESS_TOKENがある。
**確認必要**: 本番Cloudflare Pagesに `wrangler pages secret put` でセットされているか。

### TD-7: 🟡 mySchedulePageのフロントエンドがインラインHTML（2,100行ファイル）

**現状**: `src/index.tsx` が2,116行。保護者画面・職員画面のHTMLが全てインライン。
**問題**: 保守性が低い。LIFFページ追加でさらに膨張する。
**方針**: 今回は既存構造を踏襲（インラインHTML）。大規模リファクタリングは別タスク。

---

## 4. 実装計画 — LIFF統合最短導線

### 全体フロー

```
保護者がLINEリッチメニュー「予定入力」タップ
  ↓
LIFF起動（LINE内ブラウザ）
  ↓
GET /line/entry
  ↓
LIFF SDK初期化 → liff.getProfile() → userId取得
  ↓
GET /api/liff/me?line_user_id={userId}
  ↓
┌─ 連携済み → children配列返却
│    ↓
│    1名 → /my/{view_token} にリダイレクト
│    複数 → 園児選択画面 → 選んだ子の /my/{view_token} にリダイレクト
│
└─ 未連携 → { linked: false }
     ↓
     連携コード入力画面表示
     ↓
     POST /api/liff/link { line_user_id, code }
     ↓
     成功 → /my/{view_token} にリダイレクト
```

### 作るもの一覧

#### Phase 1: LIFF統合（✅ 実装完了 2026-03-21）

| # | 種別 | パス/ファイル | 概要 | 状態 |
|---|---|---|---|---|
| 1 | 新規ルート | `GET /line/entry` | LIFF起動ページ（HTML） | ✅ 完了 |
| 2 | 新規API | `GET /api/liff/me` | userId → 連携状態＋children＋view_token | ✅ 完了 |
| 3 | 新規API | `POST /api/liff/link` | Web経由連携（userId + code → 紐付け） | ✅ 完了 |
| 4 | DB変更 | `link_code_children` テーブル新設 | TD-1修正 | ✅ 完了 |
| 5 | 既存修正 | `verifyAndLinkCode()` | 全園児一括紐付けを個別紐付けに変更 | ✅ 完了 |
| 6 | 既存修正 | CORS設定 | LIFF origin対応 | ✅ 完了 |
| 7 | 管理画面修正 | LINE予定収集タブ | 連携コード発行時に対象園児を選択可能に | ✅ 完了 |
| 8 | 外部設定 | LINE Developer Console | LIFFアプリ登録、Webhook URL設定 | ⏳ 要手動設定 |
| 9 | 外部設定 | LINE Official Account Manager | リッチメニュー作成 | ⏳ 要手動設定 |
| 10 | 本番デプロイ | wrangler pages secret | LINE環境変数 + LIFF_ID の本番設定 | ⏳ 要設定 |

#### Phase 2: 自動通知（次回スコープ）

| # | 概要 |
|---|---|
| 1 | 月初自動Push通知（来月予定入力依頼） |
| 2 | 未提出者リマインド |
| 3 | 提出済み確認メッセージ |

#### Phase 3: 拡張（将来スコープ）

| # | 概要 |
|---|---|
| 1 | 変更申請（前日17時ルール） |
| 2 | 提出履歴閲覧 |
| 3 | 兄弟切替UI高度化 |

---

## 5. 各実装の詳細設計

### 5-1. LIFF起動ページ `GET /line/entry`

**責務**: LIFF SDK初期化 → userId取得 → 連携チェック → リダイレクト or 連携コード入力

```html
<!-- 概要: LINE内ブラウザで開くページ -->
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
<script>
  liff.init({ liffId: '${LIFF_ID}' }).then(async () => {
    if (!liff.isLoggedIn()) {
      liff.login();  // LINE内ブラウザなら通常自動ログイン済み
      return;
    }
    const profile = await liff.getProfile();
    const userId = profile.userId;
    
    // サーバーに連携状態を問い合わせ
    const res = await fetch('/api/liff/me?line_user_id=' + userId);
    const data = await res.json();
    
    if (data.linked) {
      if (data.children.length === 1) {
        // 1名 → 即リダイレクト
        window.location.href = '/my/' + data.children[0].view_token;
      } else {
        // 複数 → 選択画面表示
        showChildSelector(data.children);
      }
    } else {
      // 未連携 → 連携コード入力フォーム表示
      showLinkForm(userId);
    }
  });
</script>
```

**LINE外ブラウザ対策**:
- `liff.isInClient()` で判定
- LINE外 → 「LINEアプリから開いてください」メッセージ + QRコード表示

### 5-2. API `GET /api/liff/me`

**入力**: `?line_user_id=Uxxxxxx`
**処理**:
1. `line_accounts` で userId 検索
2. 見つかれば `line_account_children` → `children` で紐付き園児取得
3. 各園児の `view_token` を返却

**返却（連携済み）**:
```json
{
  "linked": true,
  "children": [
    {
      "child_id": "abc123",
      "name": "山田 太郎",
      "enrollment_type": "月極",
      "view_token": "b642e03a7ddcbda5f12a48826f7cc624"
    }
  ]
}
```

**返却（未連携）**:
```json
{
  "linked": false
}
```

**セキュリティ考慮**:
- line_user_id は LINE LIFF SDKから取得した値をクライアントが送る
- LIFF内の場合、liff.getIDToken() で JWT を取得し、サーバー側で検証する方がより安全
- Phase 1ではuserIdのみで進め、Phase 2でJWT検証を追加する

### 5-3. API `POST /api/liff/link`

**入力**:
```json
{
  "line_user_id": "Uxxxxx",
  "code": "AYK-1234",
  "display_name": "山田ママ"
}
```

**処理**:
1. `link_codes` から未使用＆有効期限内のコードを検索
2. `link_codes` に紐づく対象園児IDを取得（TD-1修正後）
3. `line_accounts` に登録（既存なら再利用）
4. `line_account_children` に対象園児のみ紐付け
5. `link_codes` を使用済みに更新
6. 紐付いた園児の `view_token` を返却

**返却**:
```json
{
  "success": true,
  "children": [
    {
      "child_id": "abc123",
      "name": "山田 太郎",
      "view_token": "b642e03a7ddcbda5f12a48826f7cc624"
    }
  ]
}
```

### 5-4. TD-1修正: link_codes → 園児紐付けの個別化

**案A: link_codesに`target_child_ids`カラム追加**

```sql
-- migrations/0006_link_code_children.sql
ALTER TABLE link_codes ADD COLUMN target_child_ids TEXT;
-- JSON配列形式: '["child_id_1","child_id_2"]'
-- NULL の場合は全園児（後方互換、ただし非推奨）
```

**案B: 新テーブル `link_code_children`**（推奨）

```sql
-- migrations/0006_link_code_children.sql
CREATE TABLE IF NOT EXISTS link_code_children (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
  link_code_id TEXT NOT NULL REFERENCES link_codes(id),
  child_id TEXT NOT NULL REFERENCES children(id),
  UNIQUE(link_code_id, child_id)
);
```

**推奨**: 案B。正規化されており、将来の拡張（1コード複数園児 = 兄弟対応）に強い。

### 5-5. 管理画面の連携コード発行UI修正

**現状**: `POST /api/line/link-codes` はコードを発行するだけで、園児指定なし。
**修正**: 発行時に対象園児を選択するUIとAPIを追加。

```
管理画面「LINE予定収集」タブ
  → 「連携コード発行」ボタン
  → 園児選択モーダル（チェックボックス）
  → POST /api/line/link-codes { child_ids: ["id1", "id2"] }
  → コード表示（印刷 or コピー）
```

### 5-6. 保護者画面 `/my/:token` の変更

**基本方針: 変更しない。**

既存の保護者入力画面はそのまま流用する。
LIFFからリダイレクトされた時点で `/my/{view_token}` が開くので、
保護者にとっては「LINE内で予定入力している」体験になる。

**唯一の変更点**:
- `source_file` を LIFF経由と判別できるようにする
  - LIFF → `/my/` 遷移時に `?from=liff` パラメータを付与
  - submit API側で `source_file = 'LIFF経由Web入力'` に設定
  - もしくは既存の `'保護者Web入力'` のままで問題なし（経路は分析上の参考情報）

---

## 6. 他機能への影響分析

| 既存機能 | 影響 | 対応 |
|---|---|---|
| 保護者入力画面 `/my/:token` | なし | 既存のまま流用 |
| 職員日報 `/staff/daily/` | なし | schedule_plans を読むだけ |
| ダッシュボード | なし | schedule_plans 集計 |
| LINE会話入力 | 並存 | 将来的にLIFF主導線へ |
| CSVアップロード | なし | 別テーブル/別経路 |
| 帳票生成 | なし | usage_facts/charge_lines ベース |
| 管理画面のLINEタブ | 修正あり | 連携コード発行UIの園児選択追加 |

**影響最小**: 新規追加が中心。既存コードの変更は `verifyAndLinkCode()` と管理画面UIのみ。

---

## 7. 実装順序（依存関係考慮）

```
Step 1: LINE Developer Console設定
  └→ LIFFアプリ作成 → LIFF ID取得
  └→ Webhook URL設定

Step 2: DB migration
  └→ 0006_link_code_children.sql

Step 3: バックエンドAPI
  └→ GET /api/liff/me
  └→ POST /api/liff/link（新verifyAndLinkCode対応）
  └→ POST /api/line/link-codes 修正（園児指定対応）

Step 4: LIFF起動ページ
  └→ GET /line/entry
  └→ LIFF SDK初期化 + 遷移ロジック

Step 5: 管理画面UI修正
  └→ 連携コード発行時の園児選択UI

Step 6: 本番デプロイ & 環境変数確認
  └→ wrangler pages secret（LINE_CHANNEL_SECRET, LINE_CHANNEL_ACCESS_TOKEN）
  └→ wrangler.jsonc（LIFF_ID 追加 or .dev.vars）
  └→ build & deploy

Step 7: リッチメニュー設定
  └→ LINE Official Account Managerでボタン設定

Step 8: E2Eテスト
  └→ リッチメニュー → LIFF → 連携 → 入力 → 保存 → 職員画面確認
```

---

## 8. LINE Developer Console で必要な設定

### LIFFアプリ登録

| 項目 | 値 |
|---|---|
| LIFF app name | あゆっこ予定入力 |
| Size | Full（推奨）or Tall |
| Endpoint URL | `https://ayukko-prod-2fx.pages.dev/line/entry` |
| Scope | `profile`（必須）, `openid`（JWT検証用） |
| Bot link feature | On (Aggressive) ← 未連携ユーザーに友だち追加を促す |

### Webhook設定

| 項目 | 値 |
|---|---|
| Webhook URL | `https://ayukko-prod-2fx.pages.dev/api/line/webhook` |
| Use webhook | ON |
| Webhook redelivery | OFF（推奨） |

---

## 9. 運用インシデント対策

| リスク | 対策 |
|---|---|
| 連携コードの誤配布（他の子のコードを渡してしまう） | コード発行時に園児名を明示表示。印刷用テンプレートに園児名入り。 |
| 保護者がLINE外ブラウザで開いてしまう | LIFF起動ページで `liff.isInClient()` チェック。外部ブラウザなら案内メッセージ表示。 |
| view_tokenの漏洩 | トークンは推測不可能（32文字hex）。万が一漏洩時は管理画面から再発行可能（既存API: `POST /api/children/:id/regenerate-token`）。 |
| 兄弟で別コードを間違える | コード印刷時に園児名をセットで表示。1コード=複数園児も対応可能。 |
| LIFFが開かない（ネットワーク不安定） | エラー画面にリトライボタン＋「問い合わせ先」表示。 |
| 月を間違えて入力 | 保護者画面に確認ダイアログ追加（「4月の予定を提出しますか？」）。 |

---

## 10. 確認が必要な不明点

### Q1: 🔴 LINE Developer Console のアクセス権限

LINE Developer Consoleにログインして設定変更ができるのは誰ですか？
- LIFFアプリの登録
- Webhook URLの設定
- Channel IDの確認

→ **木村さん or モギモギさんが操作する必要があります。**
→ または、ログイン情報を共有いただければ当方で設定可能です。

### Q2: 🔴 LINE公式アカウントのプラン

現在のLINE公式アカウントのプランは何ですか？
- 無料プラン（コミュニケーションプラン）: 月200メッセージまで
- ライトプラン: 月5,000メッセージ
- スタンダードプラン: 月30,000メッセージ

→ LIFF自体はメッセージ消費しないが、Push通知（Phase 2）はメッセージ数に含まれる。
→ 68世帯×月2通（依頼＋リマインド）= 約136通/月。無料プランでもPhase 2は可能。

### Q3: 🟡 連携コードの配布方法

「連携IDはLINEに投稿でいい」とのことですが、具体的にはどちらですか？
- **案A**: 職員がLINEトークで保護者に個別送信（手動）
- **案B**: システムからPush通知で自動送信（友だち追加済みの保護者に）
- **案C**: 管理画面で一覧印刷 → 紙で配布

→ 案Bが最も効率的だが、友だち追加 → Push通知 → コード入力 の順序制御が必要。
→ 案Aが最もシンプル。職員がLINEの個別トークでコードを送る。

### Q4: 🟡 兄弟の扱い

1保護者が複数園児を持つケース（兄弟）はどのくらいありますか？
- 兄弟がいる場合、1コード=複数園児にするか、園児ごとに別コードか？
- LIFF起動時に園児選択画面を出すか、最初の1人だけか？

→ 設計は複数園児対応済み（`line_account_children` がN:N）。
→ UIとしてどう見せるかの確認。

### Q5: 🟢 LIFFサイズ

LIFFのサイズは Full / Tall / Compact のどれが適切ですか？
- Full: 画面全体。保護者画面がフルで使える。
- Tall: 画面80%程度。下部にLINEが少し見える。
- Compact: 画面50%。情報量が足りない。

→ **推奨: Full**（予定入力カレンダーは画面全体を使いたい）

### Q6: 🟢 本番ドメインの確認

現在の本番URLは `https://ayukko-prod-2fx.pages.dev/` ですが、
これをLIFFのEndpoint URLとして登録してよいですか？
将来カスタムドメインに変更する予定はありますか？

→ カスタムドメインに変更した場合、LIFFのEndpoint URLも変更が必要。

---

## 11. 工数見積もり

| ステップ | 内容 | 見積もり |
|---|---|---|
| Step 1 | LINE Developer Console設定（LIFF登録、Webhook） | 要・操作者確認 |
| Step 2 | DB migration (0006) | 15分 |
| Step 3 | バックエンドAPI 3本 | 1-2時間 |
| Step 4 | LIFF起動ページ | 1-2時間 |
| Step 5 | 管理画面UI修正 | 1時間 |
| Step 6 | 本番デプロイ & 環境変数 | 30分 |
| Step 7 | リッチメニュー設定 | 要・操作者確認 |
| Step 8 | E2Eテスト | 1時間 |
| **合計** | | **約5-7時間**（LINE Console設定除く） |

---

## 12. 変更しないもの（明示的スコープ外）

| 項目 | 理由 |
|---|---|
| 保護者入力画面 `/my/:token` のUI | 既に本番稼働中。LIFFからリダイレクトで流用 |
| 職員日報画面 | 変更不要 |
| ダッシュボード | 変更不要 |
| LINE会話入力（状態機械） | 並存させる。削除しない |
| 帳票生成機能 | 無関係 |
| index.tsx の大規模リファクタリング | 今回は追加のみ。分割は別タスク |
| Push通知の自動化 | Phase 2 |
| AI会話入力 (LLM統合) | Phase 3以降 |

---

## 13. まとめ: 変更の全体像

```
【新規追加】
  GET  /line/entry          ← LIFF起動ページ (HTML)
  GET  /api/liff/me         ← 連携状態確認API
  POST /api/liff/link       ← Web経由連携API
  migration 0006            ← link_code_children テーブル

【既存修正】
  verifyAndLinkCode()       ← 全園児一括 → 指定園児のみ
  POST /api/line/link-codes ← 園児ID受取対応
  管理画面 LINE予定収集タブ  ← 園児選択UI追加
  CORS設定                  ← LIFF origin追加（要テスト）
  .dev.vars                 ← LIFF_ID追加

【外部設定】
  LINE Developer Console    ← LIFFアプリ登録 + Webhook URL
  LINE Official Account Mgr ← リッチメニュー設定

【変更しない】
  /my/:token, /staff/daily, /api/schedules/*, 帳票生成, LINE会話入力
```

---

## 付録A: LINE環境情報（既存）

| 項目 | 値 |
|---|---|
| Channel ID | 2005879095 |
| 友だち追加リンク | https://lin.ee/H02sZM5 |
| QRコード | https://qr-official.line.me/gs/M_591xcqds_GW.png |
| Channel Secret | `.dev.vars` に設定済み |
| Channel Access Token | `.dev.vars` に設定済み |
| Webhook URL（開発） | 未設定（要確認） |
| Webhook URL（本番） | 未設定（`https://ayukko-prod-2fx.pages.dev/api/line/webhook` を設定予定） |

---

*文書終了*

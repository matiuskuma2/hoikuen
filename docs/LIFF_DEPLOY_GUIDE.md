# LIFF本番反映手順書 — あゆっこ利用予定入力

> **対象**: 木村さん（LINE Developer Console操作）、開発者（Cloudflare操作）
> **作成日**: 2026-03-21
> **前提**: コード実装は完了済み。この手順は本番環境への反映のみ。

---

## 全体の流れ

```
Step 1: LINE Developer Console で LIFFアプリ作成 → LIFF ID取得
Step 2: Cloudflare に LIFF_ID を secret 設定
Step 3: 本番D1に migration 0006 適用
Step 4: 旧形式link_code 無効化
Step 5: 本番デプロイ
Step 6: LINE Official Account Manager で リッチメニュー設定
Step 7: 実機で通し確認
```

所要時間目安: 30分〜1時間（LINE Console操作含む）

---

## Step 1: LINE Developer Console で LIFFアプリ作成

### 1-1. LINE Developers にログイン

1. https://developers.line.biz/console/ を開く
2. あゆっこのチャネルがある **Provider** を選択
3. **Messaging API チャネル**（Channel ID: `2005879095`）を選択

### 1-2. LIFFタブに移動

1. 左メニューから **「LIFF」** タブをクリック
2. **「追加」** ボタンをクリック

### 1-3. LIFFアプリの設定

以下の通り入力してください。

| 項目 | 設定値 |
|------|--------|
| **LIFFアプリ名** | `あゆっこ 予定入力` |
| **サイズ** | **Full** （画面全体を使用） |
| **エンドポイントURL** | `https://ayukko-prod-2fx.pages.dev/line/entry` |
| **Scope** | ✅ `profile` にチェック、✅ `openid` にチェック |
| **ボットリンク機能** | `Off`（または `Normal`） |
| **Scan QR** | どちらでも可（`Off` で問題なし） |

### 1-4. LIFF ID を控える

作成完了後、一覧に表示される **LIFF ID** をコピーしてください。
形式: `1234567890-xxxxxxxx`

> **この LIFF ID を次のステップで使います。**

---

## Step 2: Cloudflare に LIFF_ID を secret 設定

ターミナルで以下を実行：

```bash
cd /home/user/webapp

# LIFF_ID を本番に設定（対話形式で値を入力）
npx wrangler pages secret put LIFF_ID --project-name ayukko-prod
# → 「Enter a secret value:」と聞かれるので、Step 1で取得した LIFF ID を貼り付け

# 確認
npx wrangler pages secret list --project-name ayukko-prod
# → LIFF_ID が一覧に表示されればOK
```

### ローカル開発用にも設定

```bash
# .dev.vars に追加
echo "LIFF_ID=ここにLIFF_IDを貼る" >> .dev.vars
```

---

## Step 3: 本番D1に migration 0006 適用

```bash
cd /home/user/webapp

# 適用前の確認（何が適用されるか表示）
npx wrangler d1 migrations list ayukko-production --remote

# 適用実行
npx wrangler d1 migrations apply ayukko-production --remote
# → 0006_link_code_children.sql が適用される
```

### 確認

```bash
# link_code_children テーブルの存在確認
npx wrangler d1 execute ayukko-production --remote \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name='link_code_children'"
```

---

## Step 4: 旧形式link_code 無効化

本番DBに旧形式の連携コード（園児未指定）が残っている場合、期限切れにします。

```bash
cd /home/user/webapp

# 旧形式コードの確認
npx wrangler d1 execute ayukko-production --remote --command "
SELECT lc.id, lc.code, lc.used_by_line_account_id,
       (SELECT COUNT(*) FROM link_code_children lcc WHERE lcc.link_code_id = lc.id) as child_count
FROM link_codes lc
WHERE id NOT IN (SELECT DISTINCT link_code_id FROM link_code_children)
  AND used_by_line_account_id IS NULL
"

# 旧形式コードを期限切れにする
npx wrangler d1 execute ayukko-production --remote \
  --file=./scripts/expire_old_link_codes.sql
```

---

## Step 5: 本番デプロイ

```bash
cd /home/user/webapp

# ビルド
npm run build

# デプロイ
npx wrangler pages deploy dist --project-name ayukko-prod
```

### デプロイ後の基本確認

```bash
# ヘルスチェック
curl https://ayukko-prod-2fx.pages.dev/api/health

# LIFF入口ページが返るか
curl -s -o /dev/null -w "%{http_code}" https://ayukko-prod-2fx.pages.dev/line/entry
# → 200

# LIFF APIが動くか
curl -s "https://ayukko-prod-2fx.pages.dev/api/liff/me?line_user_id=U00000000000000000000000000000001"
# → {"linked":false,"line_user_id":"U00000000000000000000000000000001"} (テスト用)
```

---

## Step 6: リッチメニュー設定

### 6-1. LINE Official Account Manager にログイン

1. https://manager.line.biz/ を開く
2. あゆっこの公式アカウントを選択

### 6-2. リッチメニューを作成/編集

1. 左メニューから **「リッチメニュー」** を選択
2. 既存のリッチメニューを編集、または **「作成」** をクリック

### 6-3. ボタンの設定

| 項目 | 設定値 |
|------|--------|
| **ボタン名** | `予定入力` |
| **タイプ** | **リンク** |
| **URL** | `https://liff.line.me/ここにLIFF_ID` |

> **重要**: URLは `https://liff.line.me/{LIFF_ID}` の形式です。
> 例: `https://liff.line.me/1234567890-xxxxxxxx`
>
> `https://ayukko-prod-2fx.pages.dev/line/entry` を直接入れるのではなく、
> LIFF URLを入れてください。これによりLINE内ブラウザでLIFF SDKが正しく動作します。

### 6-4. リッチメニューを公開

- **表示期間**: 設定（常時表示推奨）
- **メニューバーのテキスト**: `メニュー` または `予定入力`
- **デフォルトで表示**: `表示する`

設定後 **「保存」** → **「公開」**

---

## Step 7: 実機確認チェックリスト

スマートフォンのLINEアプリで以下をすべて確認してください。

### 基本動作

| # | 確認項目 | 手順 | 期待結果 | ✅ |
|---|---------|------|---------|-----|
| 1 | リッチメニュー表示 | LINEであゆっこのトークを開く | 「予定入力」ボタンが表示される | ☐ |
| 2 | LIFF起動 | 「予定入力」をタップ | LINE内ブラウザが開き、「LINE連携を確認中...」表示 | ☐ |
| 3 | 未連携時の画面 | 初回、連携コードなしの状態 | 連携コード入力画面が表示される | ☐ |
| 4 | 連携コード発行 | 管理画面で園児を選んでコード発行 | AYK-XXXX形式のコードが発行される | ☐ |
| 5 | 連携コード入力 | LIFF画面で発行されたコードを入力 | 「連携が完了しました」→ カレンダー画面に遷移 | ☐ |
| 6 | 予定入力 | カレンダー画面で日付をタップ、時間入力 | 入力モーダルが表示され、登園・降園時間が入力できる | ☐ |
| 7 | 予定保存 | 入力後「予定を提出」をタップ | 「保存しました」と表示される | ☐ |
| 8 | 再アクセス | リッチメニューから再度「予定入力」をタップ | 連携コード入力なしで直接カレンダー画面に遷移 | ☐ |
| 9 | 管理画面反映 | 管理画面の「LINE予定収集」→「更新」 | 保護者が入力した予定が「提出済」と表示される | ☐ |

### セキュリティ確認

| # | 確認項目 | 手順 | 期待結果 | ✅ |
|---|---------|------|---------|-----|
| 10 | 他の園児が見えない | 連携後、カレンダー画面で表示される園児名 | 自分の子どもの名前のみ表示 | ☐ |
| 11 | 旧コード無効 | 旧形式コード（園児未指定）を入力 | エラー表示「連携コードが無効です」 | ☐ |

### エッジケース

| # | 確認項目 | 手順 | 期待結果 | ✅ |
|---|---------|------|---------|-----|
| 12 | LINE外アクセス | Safari/Chromeで直接URLを開く | 「LINEアプリから開いてください」+ QRコード表示 | ☐ |
| 13 | 兄弟対応 | 2人分のコードで連携 | 園児選択画面が表示される | ☐ |
| 14 | 使用済みコード | 既に使ったコードを再入力 | エラー表示 | ☐ |

---

## トラブルシューティング

### 「channel not found」エラー

**原因**: LIFF_ID が未設定または間違っている
**対処**:
```bash
npx wrangler pages secret list --project-name ayukko-prod
# LIFF_ID が正しい値か確認
```

### 「LIFF IDが未設定です」と表示される

**原因**: 環境変数 LIFF_ID が `PENDING_LIFF_ID` のまま
**対処**: Step 2 の secret 設定を実行後、Step 5 で再デプロイ

### 連携コード入力で「連携コードが無効です」

**原因**:
1. コードが使用済み
2. コードの有効期限切れ（90日）
3. コードに対象園児が未設定（旧形式コード）

**対処**: 管理画面から園児を選択して新しいコードを発行

### リッチメニューが表示されない

**対処**: LINE Official Account Managerで公開状態・表示期間を確認

---

## 木村さんへの伝え方

```
LIFFでLINE内完結にする実装はできています。

これからLINE Developer Console側でLIFFアプリを登録し、
本番に反映します。

反映後、リッチメニューの「予定入力」から
各保護者がそのまま自分の入力画面に入れる形になります。

必要な作業:
1. LINE Developer ConsoleでLIFFアプリ作成（5分）
2. 本番にLIFF IDを設定してデプロイ（5分）
3. リッチメニューに「予定入力」ボタンを設定（5分）
4. 実機で通し確認（10分）

個別URLの配布は不要になります。
保護者はリッチメニュー1タップで自分の入力画面に行けます。
```

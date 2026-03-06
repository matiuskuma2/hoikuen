# 環境復旧手順書（ゼロからのセットアップ）

> **Version**: 1.0 (2026-03-06)
> **目的**: サンドボックスがリセットされた場合、この手順で完全復旧する

---

## 1. リポジトリのクローン

```bash
cd /home/user
git clone https://github.com/matiuskuma2/hoikuen.git webapp
cd webapp
```

---

## 2. 依存パッケージのインストール

### Node.js（Hono + Wrangler）
```bash
cd /home/user/webapp
npm install
```

### Python（Generator）
```bash
cd /home/user/webapp/generator
pip install -r requirements.txt
```

---

## 3. 環境変数の設定

`.dev.vars` はgitignoreされているため、手動で再作成が必要。

```bash
cat > /home/user/webapp/.dev.vars << 'EOF'
LINE_CHANNEL_SECRET=（※LINE Developers Consoleから取得）
LINE_CHANNEL_ACCESS_TOKEN=（※LINE Developers Consoleから取得）
EOF
```

**値の取得方法:**
1. [LINE Developers Console](https://developers.line.biz/) にログイン
2. 該当チャネルを開く
3. 「チャネル基本設定」→ Channel Secret をコピー
4. 「Messaging API設定」→ Channel Access Token → 「発行」してコピー
5. 上記ファイルに貼り付け

**注意: 秘密値はリポジトリ・チャット・ドキュメントに絶対に書かない。**

---

## 4. データベースのセットアップ

```bash
cd /home/user/webapp

# マイグレーション実行（ローカルD1）
npx wrangler d1 migrations apply ayukko-production --local

# 初期データ投入
npx wrangler d1 execute ayukko-production --local --file=./seed.sql
```

---

## 5. ビルド & 起動

```bash
cd /home/user/webapp

# ビルド
npm run build

# PM2で起動（Hono:3000 + Generator:8787）
pm2 start ecosystem.config.cjs

# 動作確認
curl http://localhost:3000/api/health
curl http://localhost:3000/api/line/health
```

---

## 6. LINE Webhook URLの設定

### 開発環境（サンドボックス）
サンドボックスごとにURLが変わるため、起動後に確認:
```bash
# サンドボックスのURLを確認（GetServiceUrl toolで取得）
# 例: https://3000-xxxxx.sandbox.novita.ai/api/line/webhook
```

LINE Developers Console → Messaging API設定 → Webhook URL に設定。

### 本番環境（Cloudflare Pages）
```
https://ayukko-nursery.pages.dev/api/line/webhook
```

---

## 7. 本番デプロイ（Cloudflare Pages）

```bash
cd /home/user/webapp

# Cloudflare認証（setup_cloudflare_api_key toolで設定）
npx wrangler whoami

# ビルド & デプロイ
npm run build
npx wrangler pages deploy dist --project-name ayukko-nursery

# 本番用シークレット設定
npx wrangler pages secret put LINE_CHANNEL_SECRET --project-name ayukko-nursery
npx wrangler pages secret put LINE_CHANNEL_ACCESS_TOKEN --project-name ayukko-nursery
```

---

## 8. GitHub認証（pushする場合）

```bash
# setup_github_environment toolを実行後:
cd /home/user/webapp
git push origin main
```

---

## 重要な設定値一覧

| 項目 | 値 | 保管場所 |
|------|-----|---------|
| LINE Channel ID | `2005879095` | この文書 |
| LINE Channel Secret | （※秘密値。LINE Developers Console → チャネル基本設定） | `.dev.vars` (gitignore) |
| LINE Channel Access Token | （※秘密値。LINE Developers Console → Messaging API設定） | `.dev.vars` (gitignore) |
| LINE 友だち追加リンク | https://lin.ee/H02sZM5 | この文書 |
| D1 Database Name | `ayukko-production` | `wrangler.jsonc` |
| R2 Bucket Name | `ayukko-files` | `wrangler.jsonc` |
| Cloudflare Project Name | `ayukko-nursery` | `wrangler.jsonc` |
| GitHub Repository | `matiuskuma2/hoikuen` | `.git/config` |
| Hono Port | `3000` | `ecosystem.config.cjs` |
| Generator Port | `8787` | `ecosystem.config.cjs` |

---

## PM2コマンド早見表

```bash
pm2 list                         # プロセス一覧
pm2 logs ayukko-hono --nostream  # Honoログ確認
pm2 logs ayukko-generator --nostream  # Generatorログ確認
pm2 restart ayukko-hono          # Hono再起動
pm2 delete all                   # 全プロセス停止
```

---

## npm scripts 早見表

```bash
npm run build                    # Viteビルド
npm run dev:sandbox              # サンドボックス開発サーバー
npm run dev:d1                   # D1付き開発サーバー
npm run deploy                   # 本番デプロイ
npm run db:migrate:local         # ローカルDBマイグレーション
npm run db:seed                  # テストデータ投入
npm run db:reset                 # ローカルDB初期化
```

---

## トラブルシューティング

### ポート3000が使用中
```bash
fuser -k 3000/tcp
```

### D1データベースが壊れた
```bash
rm -rf .wrangler/state/v3/d1
npm run db:migrate:local
npm run db:seed
```

### LINE Webhookが403を返す
- `.dev.vars` の `LINE_CHANNEL_SECRET` が正しいか確認
- LINE Developers Consoleの Channel Secret と一致しているか確認

### ビルドエラー
```bash
rm -rf dist node_modules
npm install
npm run build
```

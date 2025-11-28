# Twitter-IFTTT-Bluesky

IFTTTを使用してTwitter/Xのツイートを監視し、自動的にBlueskyに転送するシステム

## バージョン

v1.00 (2025-11-28)

## 更新情報 (v1.00)

- IFTTT Webhook連携の最適化
- リンクカードのOGP取得改善

## IFTTT連携 (OldTweetDeck代替)

OldTweetDeckが使用不能になった場合のバックアップとして、IFTTTを使用した転送ルートをサポートしています。

### 1. ngrokのセットアップ
ローカルサーバーを外部公開するために `ngrok` を使用します。

1. [ngrok公式サイト](https://ngrok.com/)からアカウント作成・インストール。
2. コマンドプロンプトで以下を実行して起動:
   ```bash
   ngrok http 5000
   ```
3. 表示された `Forwarding` のURL（例: `https://xxxx.ngrok-free.app`）をコピー。

### 2. IFTTTアプレットの作成
1. **If This**: "Twitter" (New tweet by a specific user) を選択。
2. **Then That**: "Webhooks" (Make a web request) を選択。
3. **URL**: `https://xxxx.ngrok-free.app/webhook/ifttt` (ngrokのURL + /webhook/ifttt)
4. **Method**: `POST`
5. **Content Type**: `application/json`
6. **Body**:
   ```json
   {
     "handle": "your-handle.bsky.social",
     "appPassword": "your-app-password",
     "text": "<<<{{Text}}>>>",
     "url": "<<<{{LinkToTweet}}>>>"
   }
   ```
   ※ `your-handle.bsky.social` と `your-app-password` はご自身のものに書き換えてください。
   ※ `<<< >>>` はIFTTTのエスケープ記法です。

## 主な機能

- **IFTTT Webhook連携**: IFTTT経由でツイートを受信しBlueskyへ投稿
- **リンクカード自動生成**: ツイートURLからOGP情報を取得し、リッチなリンクカードを作成
- **自動テキスト切り詰め**: 300文字を超える投稿を自動的に調整
- **ハッシュタグ・メンション処理**: Twitter準拠のハッシュタグとメンションをBluesky形式に変換
- **レート制限対策**: セッションキャッシュによりログイン回数を最小化
- **ログ管理**: 12時間ごとのログローテーションと自動バックアップ
- **サーバーヘルスチェック**: 稼働状況を確認できるエンドポイント

## 技術スタック

- **Python**: 3.11.7
- **FastAPI + uvicorn**: Webサーバー
- **atproto**: Bluesky SDK
- **Pillow**: 画像処理
- **Tampermonkey**: ブラウザ拡張

## セットアップ

詳細なセットアップ手順は別途ドキュメント参照。

## ライセンス

Private - 個人使用のみ

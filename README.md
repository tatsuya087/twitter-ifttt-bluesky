# Twitter-IFTTT-Bluesky

IFTTTを使用してTwitter/Xのツイートを監視し、自動的にBlueskyに転送するシステム

### 1. ngrokのセットアップ
ローカルサーバーを外部公開するために `ngrok` を使用します。

1. [ngrok公式サイト](https://ngrok.com/)からアカウント作成・インストール。
2. コマンドプロンプトで以下を実行して起動:
   ```bash
   ngrok http 5000
   ```
3. 表示された `Forwarding` のURL（例: `https://xxxx.ngrok-free.app`）をコピー。

### 2. IFTTTアプレットの作成
1. **If This**: "Twitter" を選択。
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
- **高度なメディア処理**:
  - **動画/GIF**: サムネイルに再生ボタンを自動合成してリンクカード化
  - **画像**: 自動的にリンクカード化（複数画像の場合は1枚目を使用）
  - **t.co展開**: 本文中の短縮URLを自動展開
- **ロバストなリンクカード生成**:
  - `yt-dlp` によるメディア抽出
  - OGPフォールバック機能（`yt-dlp` 失敗時もOGPから画像とタイトルを取得）
  - 投稿者情報の自動補完（"Unknown" 回避）
- **自動テキスト切り詰め**: 300文字を超える投稿を自動的に調整
- **ハッシュタグ・メンション処理**: Twitter準拠のハッシュタグとメンションをBluesky形式に変換
- **レート制限対策**: セッションキャッシュによりログイン回数を最小化
- **ログ管理**: 12時間ごとのログローテーションと自動バックアップ
- **サーバーヘルスチェック**: 稼働状況を確認できるエンドポイント

## 技術スタック

- **Python**: 3.11.7
- **FastAPI + uvicorn**: Webサーバー
- **atproto**: Bluesky SDK
- **yt-dlp**: メディア抽出
- **Pillow**: 画像処理
- **BeautifulSoup4**: OGP解析

## 既知の制限事項

- **複数画像ツイート**: X (Twitter) の仕様により、**1枚目の画像のみ**を使用したリンクカードとして投稿されます。

## ライセンス

MIT

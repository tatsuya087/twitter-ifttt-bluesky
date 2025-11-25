# Twitter/X → Bluesky 自動転送システム

TweetdeckでTwitter/Xのツイートを監視し、自動的にBlueskyに転送するシステム

## バージョン

v1.10 (2025-11-25)

## 新機能 (v1.10)

- 履歴DB連携による引用リツイート対応
- 引用ツイートのURL自動除去

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

- Tweetdeckカラム単位での監視
- GUI設定モーダル
- キューシステムによる投稿順序の保証
- 多言語ハッシュタグ対応
- 最大4枚までの複数画像結合表示
- 動画およびGIFのサムネイル付きリンクカード作成
- 外部リンクカードのOGP自動取得
- Twitterリンクへのメンション変換
- Twitter仕様に準拠したハッシュタグ処理
- 300文字を超える長文の自動切り詰め
- 12時間ごとのログローテーション
- レート制限対策としてのBlueskyセッションキャッシュ
- 30秒のタイムアウト設定

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

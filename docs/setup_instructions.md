# Twitter/X → Bluesky 自動転送システム v1.00 セットアップ手順

TweetdeckでTwitter/Xのツイートを監視し、自動的にBlueskyに転送するシステムです。

## 📋 システム概要

### 主な機能
- **カラム単位での監視**: Tweetdeckの各カラムを個別に設定可能
- **複数画像の結合**: 1〜4枚の画像を800x418pxに結合してリンクカード表示
- **動画サムネイル対応**: 動画付きツイートはサムネイル画像でリンクカード化
- **外部リンク対応**: リンクカード付きツイートもOGP情報を取得して転送
- **長文対応**: 300文字を超える場合は自動的に切り詰め＋「…Read more」リンク
- **メンション処理**: @usernameをTwitterリンクとして表示
- **ハッシュタグ処理**: Twitter仕様準拠（アンダースコアのみ許可、記号で終了）
- **12時間ごとのログローテーション**: 自動的にログファイルを切り替え
- **30秒タイムアウト**: Bluesky APIへのタイムアウトを30秒に設定
- **セッションキャッシュ**: レート制限対策（24時間で10回のログイン制限を回避）

### 投稿フォーマット
1. **文字のみ**: `[本文]` + リンクカード（画像なし）
2. **画像付き**: `[本文]` + 画像リンクカード（結合画像）
3. **動画付き**: `[本文]` + 動画サムネイルリンクカード
4. **外部リンク**: `[本文]` + 外部サイトのOGP画像付きリンクカード

---

## 🖥️ 必要な環境

- **OS**: Windows 10/11
- **Python**: 3.11.7（3.11系推奨）
- **ブラウザ**: Google Chrome + Tampermonkey
- **Blueskyアカウント**: アプリパスワード必須

---

## 🔧 Step 1: Python環境のセットアップ

### 1-1. Pythonのインストール確認

コマンドプロンプトを開いて実行：

```bash
python --version
```

`Python 3.11.7` が表示されればOK。

なければ[Python公式サイト](https://www.python.org/downloads/release/python-3117/)からインストール。

### 1-2. 必要なライブラリをインストール

```bash
pip install fastapi uvicorn atproto requests beautifulsoup4 Pillow
```

### 1-3. サーバースクリプトの配置

`bluesky_server.py` をプロジェクトフォルダに配置してください。

**推奨フォルダ構成**:
```
tweetdeck-bluesky-bridge/
├── bluesky_server.py
├── tweetdeck_bluesky_tm.js
├── logs/ (自動作成)
└── docs/
```

---

## 🌐 Step 2: Blueskyアプリパスワードの取得

1. Blueskyにログイン
2. **Settings** → **Privacy and security** → **App passwords**
3. **Add App Password** をクリック
4. 名前を入力（例: "Tweetdeck Bridge"）
5. 生成されたパスワードをメモ（**二度と表示されません**）

---

## 🔌 Step 3: Tampermonkeyのセットアップ

### 3-1. Tampermonkeyのインストール

1. [Tampermonkey公式サイト](https://www.tampermonkey.net/)からChrome版をインストール
2. Chromeの右上にTampermonkeyアイコンが表示されることを確認

### 3-2. スクリプトの追加

1. Tampermonkeyアイコン → **ダッシュボード**
2. **新規スクリプトを作成**（+ アイコン）
3. `tweetdeck_bluesky_tm.js` のコードを全てコピー&ペースト
4. **Ctrl + S** で保存

---

## 🚀 Step 4: システムの起動

### 4-1. Pythonサーバーを起動

コマンドプロンプトで：

```bash
cd プロジェクトフォルダのパス
python bluesky_server.py
```

以下のように表示されればOK：

```
作業ディレクトリ: プロジェクトフォルダのパス
✅ ログディレクトリを作成しました: logs
==================================================
ログファイル: logs\server_log_20251113_120000.txt
==================================================
Bluesky投稿サーバー v1.00 起動
URL: http://localhost:5000
==================================================
INFO:     Uvicorn running on http://0.0.0.0:5000
```

**このウィンドウは閉じないでください**（サーバーが停止します）

### 4-2. Tweetdeckを開く

1. Chromeで [https://x.com/i/tweetdeck](https://x.com/i/tweetdeck) にアクセス
2. ログイン
3. **F12** でコンソールを開く

以下のログが表示されていればスクリプトが動作しています：

```
[TweetDeck→Bluesky] ==========================================
[TweetDeck→Bluesky] 🎯 Tweetdeck to Bluesky Bridge v1.00
[TweetDeck→Bluesky] ==========================================
[TweetDeck→Bluesky] ✅ Tweetdeck読み込み完了!
[TweetDeck→Bluesky] 👀 監視開始: Home|@your_username
```

---

## ⚙️ Step 5: カラムの設定

### 5-1. 現在のカラム情報を確認

コンソール（F12）で実行：

```javascript
showTweetdeckBridgeConfig()
```

以下のように表示されます：

```
=== 📋 現在の設定 ===
カラム数: 0
処理済みツイート数: 0

=== 🔍 現在のカラム情報 ===
カラム 1:
  Heading: "Home"
  Attribution: "@your_username"
  Key: "Home|@your_username"
```

### 5-2. 監視するカラムを追加

表示された情報を使って設定：

```javascript
addColumn("Home", "@your_username", "your_handle.bsky.social", "your_app_password")
```

**例**:
```javascript
addColumn("Home", "@y39r8guisgvs", "test.bsky.social", "abcd-efgh-ijkl-mnop")
```

### 5-3. ページをリロード

```
Ctrl + R
```

設定が反映されます。

### 5-4. 複数カラムを追加する場合

```javascript
addColumn("User", "@imas_official", "another.bsky.social", "another_password")
addColumn("List", "@my_list", "third.bsky.social", "third_password")
```

それぞれのカラムを個別のBlueskyアカウントに転送できます。

---

## ✅ Step 6: 動作確認

### 6-1. サーバー接続テスト

コンソールで実行：

```javascript
testServerConnection()
```

`✅ サーバー接続成功!` と表示されればOK。

### 6-2. 実際のツイートでテスト

監視対象のカラムに新しいツイートが流れてくると、自動的に処理されます。

**コンソールログ（成功例）**:
```
[TweetDeck→Bluesky] 🆕 新規ツイート検出!
[TweetDeck→Bluesky] 📷 画像検出: 2枚
[TweetDeck→Bluesky] 📤 投稿試行
[TweetDeck→Bluesky] ✅ 投稿成功
```

**Pythonサーバーログ**:
```
画像結合開始: 2枚
画像結合成功: (800, 418), 136555 bytes, quality=85
投稿成功: at://...
```

Blueskyで投稿を確認してください！

---

## 🔄 Step 7: Windows起動時の自動実行

### 7-1. サーバー自動起動スクリプト作成

メモ帳で以下を入力：

```batch
@echo off
cd /d "プロジェクトフォルダのフルパス"
echo Bluesky投稿サーバーを起動中...
python bluesky_server.py
pause
```

`start_server.bat` として保存。

### 7-2. スタートアップに登録

1. **Win + R** → `shell:startup` と入力 → Enter
2. 開いたフォルダに `start_server.bat` のショートカットを配置

これでWindows起動時に自動的にサーバーが起動します。

---

## 🛠️ トラブルシューティング

### サーバーに接続できない

**症状**: `❌ サーバーに接続できません`

**原因と解決策**:
- Pythonサーバーが起動していない → コマンドプロンプトで確認
- ポート5000が使用中 → 他のアプリを確認
- ファイアウォールでブロックされている → 例外設定を追加

### 投稿されない

**症状**: ツイートは検出されるが投稿されない

**原因と解決策**:
- カラムキーが間違っている → `showTweetdeckBridgeConfig()` で確認
- Blueskyのアプリパスワードが間違っている → 再生成して再設定
- アカウントが凍結されている → Blueskyにログインして確認

### ハッシュタグに記号が含まれる

**仕様**: `#筑西市コラボ」本日` → `#筑西市コラボ` で終了

Twitter仕様に準拠し、記号（アンダースコア以外）で自動終了します。

### タイムアウトエラーが発生する

**対処**: サーバー側で30秒タイムアウトを設定済み。エラーが続く場合はネットワーク環境を確認してください。

### 重複投稿が発生する

**対処**: v1.00でリトライ処理を削除済み。タイムアウト時も処理済みとしてマークします。

---

## 🔧 便利なコマンド

コンソール（F12）で使えるコマンド：

### 設定を確認
```javascript
showTweetdeckBridgeConfig()
```

### カラムを追加
```javascript
addColumn("Heading", "@attribution", "handle.bsky.social", "app_password")
```

### 設定をリセット
```javascript
resetTweetdeckBridgeConfig()
```

### サーバー接続テスト
```javascript
testServerConnection()
```

---

## 📝 運用上の注意点

### セキュリティ
- アプリパスワードは厳重に管理
- 定期的にパスワードを更新することを推奨
- 設定ファイルに機密情報を含めない

### パフォーマンス
- メモリ使用量: サーバー約100MB、Chrome約500MB
- 画像処理時は一時的に増加
- ログファイルは12時間ごとに自動ローテーション

### レート制限
- **ログイン**: 10回/24時間（セッションキャッシュで回避）
- **投稿**: 3000回/5分（Bluesky制限）
- サーバーは再起動せず運用することを推奨

### バックアップ
- 設定はTampermonkeyの内部ストレージに保存されます
- Chromeのユーザーデータをバックアップすることを推奨

---

## 🎉 完了！

設定が完了しました！これで自動的にTwitter/XのツイートがBlueskyに転送されます。

何か問題があれば、コンソールログ（F12）とPythonサーバーログを確認してください。

---

## 📚 参考資料

- [Bluesky公式ドキュメント](https://docs.bsky.app/)
- [atproto Python SDK](https://atproto.blue/)
- [FastAPI公式ドキュメント](https://fastapi.tiangolo.com/)

// ==UserScript==
// @name         Tweetdeck to Bluesky Bridge
// @namespace    https://greasyfork.org/ja/users/1492018-sino87
// @version      1.10
// @description  Monitor Tweetdeck columns and forward tweets to Bluesky
// @author       You
// @match        https://x.com/i/tweetdeck
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      localhost
// @run-at       document-end
// ==/UserScript==

(function () {
    'use strict';

    // ==================== 定数定義 ====================
    const DEBUG = true;
    const MAX_PROCESSED_TWEETS = 500;
    const CONFIG_CACHE_DURATION_MS = 1000;  // 設定キャッシュの有効期間（ミリ秒）
    const TWEETDECK_RETRY_DELAY_MS = 5000;  // Tweetdeck読み込み失敗時のリトライ間隔（ミリ秒）
    const TWEETDECK_MAX_RETRY_ATTEMPTS = 30;  // Tweetdeck読み込みの最大試行回数
    const TOAST_AUTO_HIDE_DELAY_MS = 3000;  // トースト通知の自動消去時間（ミリ秒）
    const TOAST_ANIMATION_DURATION_MS = 300;  // トーストのアニメーション時間（ミリ秒）
    const TWEET_EXPAND_MAX_ATTEMPTS = 50;  // ツイート展開の最大試行回数
    const TWEET_EXPAND_CHECK_INTERVAL_MS = 100;  // ツイート展開確認の間隔（ミリ秒）

    const CONFIG = {
        pythonServerUrl: 'http://localhost:5000/post-to-bluesky',
        checkInterval: 2000,
    };

    // ==================== キャッシュ管理 ====================
    let configCache = null;
    let lastConfigUpdate = 0;

    // ==================== ツイート処理キュー ====================
    let tweetQueue = [];
    let isProcessingQueue = false;
    let queueDebounceTimer = null;
    const QUEUE_DEBOUNCE_MS = 1500; // 同時検出をまとめる待機時間
    const QUEUE_PROCESS_INTERVAL_MS = 2000; // 投稿間の待機時間

    // ==================== デバッグログ ====================
    function log(...args) {
        if (DEBUG) {
            console.log('[TweetDeck→Bluesky]', ...args);
        }
    }

    function error(...args) {
        console.error('[TweetDeck→Bluesky ERROR]', ...args);
    }

    log('スクリプト起動開始 v1.00');

    // ==================== グローバル関数（1箇所に統合） ====================

    const w = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

    // === GUI用グローバル関数 ===

    // サーバー接続テスト
    w.testServerConnection = function () {
        log('🔌 サーバー接続テスト中...');
        GM_xmlhttpRequest({
            method: 'GET',
            url: 'http://localhost:5000/health',
            timeout: 5000,
            onload: function (response) {
                if (response.status === 200) {
                    log('✅ サーバー接続成功!');
                    showToast('✅ サーバー接続成功!', 'success');
                } else {
                    error('❌ サーバーエラー:', response.status);
                    showToast('❌ サーバーエラー', 'error');
                }
            },
            onerror: function (err) {
                error('❌ サーバーに接続できません', err);
                showToast('❌ サーバーに接続できません', 'error');
            },
            ontimeout: function () {
                error('❌ 接続タイムアウト');
                showToast('❌ 接続タイムアウト', 'error');
            }
        });
    };

    // 設定のエクスポート
    w.exportSettings = function () {
        const config = initializeConfig(true);

        const exportData = {
            columns: config.columns
        };

        const dataStr = JSON.stringify(exportData, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const now = new Date();
        const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5);
        const filename = `tweetdeck-bluesky-config_${timestamp}.json`;

        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();

        URL.revokeObjectURL(url);

        log('📥 設定をエクスポートしました:', filename);
        showToast('✅ 設定をエクスポートしました', 'success');
    };

    // 設定のインポート
    w.importSettings = function (event) {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = function (e) {
            try {
                const importedData = JSON.parse(e.target.result);

                if (!importedData.columns || !Array.isArray(importedData.columns)) {
                    throw new Error('無効な設定ファイルです');
                }

                if (!confirm(`設定をインポートしますか?\n\n現在の設定は上書きされます。`)) {
                    event.target.value = '';
                    return;
                }

                const config = initializeConfig(true);
                config.columns = importedData.columns;
                saveConfig(config);

                log('📤 設定をインポートしました');
                showToast('✅ 設定をインポートしました', 'success');

                renderColumnSettings();

                event.target.value = '';
            } catch (error) {
                error('設定のインポートエラー:', error);
                showToast('❌ 無効な設定ファイルです', 'error');
                event.target.value = '';
            }
        };

        reader.readAsText(file);
    };

    // 設定のリセット
    w.resetAllSettings = function () {
        if (!confirm('すべての設定と処理済みツイートを削除しますか?\n\nこの操作は取り消せません。')) {
            return;
        }

        if (!confirm('本当によろしいですか?')) {
            return;
        }

        GM_setValue('config', '');
        configCache = null;
        lastConfigUpdate = 0;

        log('🔄 設定をリセットしました');
        showToast('✅ 設定をリセットしました', 'success');

        setTimeout(() => {
            location.reload();
        }, TOAST_AUTO_HIDE_DELAY_MS);
    };

    // === コンソール用グローバル関数 ===

    // 現在の設定を表示
    w.showTweetdeckBridgeConfig = function () {
        const config = initializeConfig(true);
        console.log('=== 📋 現在の設定 ===');
        console.log(JSON.stringify(config, null, 2));
        console.log('カラム数:', config.columns.length);

        const totalTweets = getTotalProcessedTweetsCount(config.processedTweets);
        console.log('処理済みツイート数:', totalTweets, '件');

        console.log('\n=== 📊 カラム別の内訳 ===');
        for (const columnKey in config.processedTweets) {
            const count = Object.keys(config.processedTweets[columnKey]).length;
            console.log(`├─ ${columnKey}: ${count}件`);
        }

        console.log('\n=== 🔍 現在のカラム情報 ===');
        document.querySelectorAll('.js-column').forEach((section, idx) => {
            const info = getColumnInfo(section);
            if (info) {
                const key = getColumnKeyFromInfo(info);
                console.log(`カラム ${idx + 1}:`);
                console.log(`  Heading: "${info.heading}"`);
                console.log(`  Attribution: "${info.attribution}"`);
                console.log(`  Key: "${key}"`);
            }
        });
    };

    // 設定をリセット（コンソール用）
    w.resetTweetdeckBridgeConfig = function () {
        GM_setValue('config', '');
        configCache = null;
        lastConfigUpdate = 0;
        console.log('✅ 設定をリセットしました。ページをリロードしてください');
    };

    // カラムを追加（コンソール用）
    w.addColumn = function (heading, attribution, handle, appPassword) {
        const config = initializeConfig(true);

        const columnKey = `${heading}|${attribution}`;

        const exists = config.columns.find(col => col.columnKey === columnKey);
        if (exists) {
            console.log('⚠️ このカラムは既に登録されています:', columnKey);
            return;
        }

        config.columns.push({
            columnKey: columnKey,
            heading: heading,
            attribution: attribution,
            bluesky: {
                handle: handle,
                appPassword: appPassword
            }
        });

        saveConfig(config);
        console.log('✅ カラムを追加しました:');
        console.log(`  Heading: "${heading}"`);
        console.log(`  Attribution: "${attribution}"`);
        console.log(`  → Bluesky: ${handle}`);
        console.log('💡 変更を反映するにはページをリロードしてください');
    };

    log('✅ グローバル関数を登録しました');

    // ==================== カラム情報取得 ====================

    function getColumnInfo(section) {
        const header = section.querySelector('.js-column-header');
        if (!header) return null;

        const headingEl = header.querySelector('.column-heading');
        const attributionEl = header.querySelector('.attribution');

        const heading = headingEl ? headingEl.textContent.trim() : '';
        const attribution = attributionEl ? attributionEl.textContent.trim() : '';

        return { heading, attribution };
    }

    function getColumnKeyFromInfo(columnInfo) {
        return `${columnInfo.heading}|${columnInfo.attribution}`;
    }

    function getColumnKeyFromSection(section) {
        const info = getColumnInfo(section);
        if (!info) return null;
        return getColumnKeyFromInfo(info);
    }

    // ==================== 設定管理 ====================

    function migrateOldFormat(config) {
        if (Array.isArray(config.processedTweets)) {
            log('🔄 旧形式の設定を検出。新形式に自動変換します...');

            const newProcessedTweets = {};
            const monitoredColumn = config.columns.length > 0 ? config.columns[0].columnKey : 'Unknown';

            if (monitoredColumn !== 'Unknown') {
                newProcessedTweets[monitoredColumn] = {};

                config.processedTweets.forEach(tweetId => {
                    newProcessedTweets[monitoredColumn][tweetId] = Date.now();
                });

                log(`✅ ${config.processedTweets.length}件のツイートを変換しました → ${monitoredColumn}`);
            } else {
                log('⚠️ 監視中のカラムがないため、処理済みツイートはリセットされます');
            }

            config.processedTweets = newProcessedTweets;
            saveConfig(config);

            return config;
        }

        return config;
    }

    function initializeConfig(forceRefresh = false) {
        try {
            const now = Date.now();

            if (!forceRefresh && configCache && (now - lastConfigUpdate < CONFIG_CACHE_DURATION_MS)) {
                return configCache;
            }

            const configStr = GM_getValue('config', null);

            if (!configStr) {
                const defaultConfig = {
                    columns: [],
                    processedTweets: {}
                };
                GM_setValue('config', JSON.stringify(defaultConfig));
                log('✅ デフォルト設定を作成しました');
                configCache = defaultConfig;
                lastConfigUpdate = now;
                return defaultConfig;
            }

            let config = JSON.parse(configStr);
            config = migrateOldFormat(config);

            // ログは初回読み込み時のみ出力（forceRefreshがtrueの時は出さない）
            if (!forceRefresh) {
                log('✅ 既存の設定を読み込みました。カラム数:', config.columns.length);
            }

            configCache = config;
            lastConfigUpdate = now;
            return config;
        } catch (e) {
            error('設定の初期化エラー:', e);
            return { columns: [], processedTweets: {} };
        }
    }

    function saveConfig(config) {
        try {
            GM_setValue('config', JSON.stringify(config));
            configCache = config;
            lastConfigUpdate = Date.now();
            // ログを削除（呼び出し元で個別にログを出す）
        } catch (e) {
            error('設定の保存エラー:', e);
        }
    }

    function markTweetAsProcessed(tweetId, columnKey, timestamp) {
        const config = initializeConfig();

        if (!config.processedTweets[columnKey]) {
            config.processedTweets[columnKey] = {};
        }

        if (config.processedTweets[columnKey][tweetId]) {
            return;
        }

        config.processedTweets[columnKey][tweetId] = timestamp;

        const totalCount = getTotalProcessedTweetsCount(config.processedTweets);
        if (totalCount > MAX_PROCESSED_TWEETS) {
            trimOldestTweets(config.processedTweets, totalCount - MAX_PROCESSED_TWEETS);
        }

        saveConfig(config);
        log('✅ ツイートを処理済みとしてマーク:', tweetId, '@', columnKey);
    }

    function isTweetProcessed(tweetId, columnKey) {
        const config = initializeConfig();
        return config.processedTweets[columnKey] && config.processedTweets[columnKey][tweetId];
    }

    function getTotalProcessedTweetsCount(processedTweets) {
        let total = 0;
        for (const columnKey in processedTweets) {
            total += Object.keys(processedTweets[columnKey]).length;
        }
        return total;
    }

    function trimOldestTweets(processedTweets, countToRemove) {
        const allTweets = [];
        for (const columnKey in processedTweets) {
            for (const tweetId in processedTweets[columnKey]) {
                allTweets.push({
                    columnKey,
                    tweetId,
                    timestamp: processedTweets[columnKey][tweetId]
                });
            }
        }

        allTweets.sort((a, b) => a.timestamp - b.timestamp);

        for (let i = 0; i < countToRemove && i < allTweets.length; i++) {
            const tweet = allTweets[i];
            delete processedTweets[tweet.columnKey][tweet.tweetId];
        }

        log(`🗑️ ${countToRemove}件の古いツイートを削除しました`);
    }

    function getColumnConfig(columnKey) {
        const config = initializeConfig();
        const found = config.columns.find(col => col.columnKey === columnKey);
        if (found) {
            log('カラム設定発見:', columnKey, '→', found.bluesky.handle);
        }
        return found;
    }

    // ==================== ツイート情報抽出 ====================

    async function expandTweetIfNeeded(article) {
        const expandButton = article.querySelector('a[onclick*="expandTweet"]');
        if (expandButton) {
            log('📄 "Expand tweet" ボタンを検出。クリックして全文展開します...');

            expandButton.click();

            let attempts = 0;

            while (attempts < TWEET_EXPAND_MAX_ATTEMPTS) {
                await new Promise(resolve => setTimeout(resolve, TWEET_EXPAND_CHECK_INTERVAL_MS));

                const button = article.querySelector('a[onclick*="expandTweet"]');
                if (!button) {
                    log('✅ ツイート全文が展開されました');
                    return true;
                }

                attempts++;
            }

            log('⚠️ ツイート展開のタイムアウト(そのまま続行)');
            return false;
        }

        return true;
    }

    function extractTweetText(article) {
        const tweetBody = article.querySelector('.js-tweet-text');
        if (!tweetBody) {
            log('ツイート本文が見つかりません');
            return { text: '', facets: [] };
        }

        // 引用ツイートのIDを取得（URL除去判定用）
        const quotedTweet = article.querySelector('.quoted-tweet');
        const quotedTweetId = quotedTweet ? quotedTweet.getAttribute('data-tweet-id') : null;

        let text = '';
        const facets = [];
        const nodes = tweetBody.childNodes;
        const encoder = new TextEncoder();

        // 現在のバイト長を取得するヘルパー
        const getCurrentByteLength = () => encoder.encode(text).length;

        for (let node of nodes) {
            if (node.nodeType === Node.TEXT_NODE) {
                text += node.textContent;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                if (node.tagName === 'A') {
                    if (node.getAttribute('onclick') && node.getAttribute('onclick').includes('expandTweet')) {
                        continue;
                    }

                    if (node.classList.contains('link-complex')) {
                        const rel = node.getAttribute('rel');
                        const startByte = getCurrentByteLength();

                        if (rel === 'user') {
                            const userName = node.getAttribute('data-user-name');
                            if (userName) {
                                const mentionText = '@' + userName;
                                text += mentionText;

                                facets.push({
                                    index: {
                                        byteStart: startByte,
                                        byteEnd: getCurrentByteLength()
                                    },
                                    features: [{
                                        $type: 'app.bsky.richtext.facet#link',
                                        uri: `https://twitter.com/${userName}/`
                                    }]
                                });
                            }
                        } else if (rel === 'hashtag') {
                            const hashTag = node.querySelector('.link-complex-target');
                            if (hashTag) {
                                const tagText = hashTag.textContent;
                                // DOMから取得したテキストをそのままハッシュタグとして扱う
                                const fullTagText = '#' + tagText;
                                text += fullTagText;

                                facets.push({
                                    index: {
                                        byteStart: startByte,
                                        byteEnd: getCurrentByteLength()
                                    },
                                    features: [{
                                        $type: 'app.bsky.richtext.facet#tag',
                                        tag: tagText
                                    }]
                                });
                            }
                        } else {
                            text += node.textContent;
                        }
                    } else if (node.classList.contains('url-ext')) {
                        const fullUrl = node.getAttribute('data-full-url') || node.href;

                        // 引用ツイートのURLであればスキップ（本文から除去）
                        if (quotedTweetId && fullUrl.includes(quotedTweetId)) {
                            log(`🔗 引用元URLを除去しました: ${fullUrl}`);
                            continue;
                        }

                        const startByte = getCurrentByteLength();
                        text += fullUrl;

                        facets.push({
                            index: {
                                byteStart: startByte,
                                byteEnd: getCurrentByteLength()
                            },
                            features: [{
                                $type: 'app.bsky.richtext.facet#link',
                                uri: fullUrl
                            }]
                        });
                    } else {
                        text += node.textContent;
                    }
                } else if (node.tagName === 'IMG' && node.classList.contains('emoji')) {
                    text += node.alt;
                } else {
                    text += node.textContent;
                }
            }
        }

        return { text: text.trim(), facets: facets };
    }

    function extractTweetTimestamp(article) {
        const timeElement = article.querySelector('.tweet-timestamp');
        if (timeElement) {
            const dataTime = timeElement.getAttribute('data-time');
            if (dataTime) {
                return parseInt(dataTime, 10);
            }

            const datetime = timeElement.getAttribute('datetime');
            if (datetime) {
                return new Date(datetime).getTime();
            }
        }

        return Date.now();
    }

    function extractTweetUrl(article) {
        const tweetId = article.getAttribute('data-tweet-id');
        const usernameElement = article.querySelector('.username');
        let username = '';

        if (usernameElement) {
            username = usernameElement.textContent.trim().replace('@', '');
        }

        if (username && tweetId) {
            return `https://x.com/${username}/status/${tweetId}`;
        }

        log('⚠️ ツイートURL抽出失敗');
        return '';
    }

    function extractTweetAuthor(article) {
        const fullnameElement = article.querySelector('.fullname');
        const usernameElement = article.querySelector('.username');

        const fullname = fullnameElement ? fullnameElement.textContent.trim() : '';
        const username = usernameElement ? usernameElement.textContent.trim() : '';

        return { fullname, username };
    }

    function hasMedia(article) {
        return article.querySelector('.js-media') !== null;
    }

    function hasVideo(article) {
        const mediaElement = article.querySelector('.js-media');
        if (!mediaElement) return false;

        if (mediaElement.getAttribute('data-has-video') === 'true') {
            return true;
        }

        if (mediaElement.querySelector('.video-overlay')) {
            return true;
        }

        if (mediaElement.querySelector('.is-video')) {
            return true;
        }

        if (mediaElement.querySelector('.js-media-gif-container')) {
            return true;
        }

        return false;
    }

    function hasCard(article) {
        return article.querySelector('[data-testid="card"].hw-card-container') !== null;
    }

    function extractMediaUrls(article) {
        const mediaUrls = [];
        const mediaElements = article.querySelectorAll('.js-media-image-link');

        mediaElements.forEach(el => {
            const bgImage = el.style.backgroundImage;
            if (bgImage) {
                const match = bgImage.match(/url\(["']?([^"']+)["']?\)/);
                if (match && match[1]) {
                    let imageUrl = match[1];
                    imageUrl = imageUrl.split('?')[0] + '?format=jpg&name=large';
                    mediaUrls.push(imageUrl);
                }
            }
        });

        return mediaUrls;
    }

    function extractVideoThumbnail(article) {
        const mediaElement = article.querySelector('.js-media');
        if (!mediaElement) return null;

        // GIFの場合の処理 (js-media-gif-container)
        const gifContainer = mediaElement.querySelector('.js-media-gif-container');
        if (gifContainer) {
            const bgImage = gifContainer.style.backgroundImage;
            if (bgImage) {
                const match = bgImage.match(/url\(["']?([^"']+)["']?\)/);
                if (match && match[1]) {
                    let imageUrl = match[1];
                    imageUrl = imageUrl.split('?')[0] + '?format=jpg&name=large';
                    return imageUrl;
                }
            }
        }

        const videoMedia = mediaElement.querySelector('[data-has-video="true"]');
        if (videoMedia) {
            const imageLink = videoMedia.querySelector('.js-media-image-link');
            if (imageLink) {
                const bgImage = imageLink.style.backgroundImage;
                if (bgImage) {
                    const match = bgImage.match(/url\(["']?([^"']+)["']?\)/);
                    if (match && match[1]) {
                        let imageUrl = match[1];
                        imageUrl = imageUrl.split('?')[0] + '?format=jpg&name=large';
                        return imageUrl;
                    }
                }
            }
        }

        const videoOverlay = mediaElement.querySelector('.video-overlay');
        if (videoOverlay) {
            const container = videoOverlay.closest('.js-media-preview-container');
            if (container) {
                const imageLink = container.querySelector('.js-media-image-link');
                if (imageLink) {
                    const bgImage = imageLink.style.backgroundImage;
                    if (bgImage) {
                        const match = bgImage.match(/url\(["']?([^"']+)["']?\)/);
                        if (match && match[1]) {
                            let imageUrl = match[1];
                            imageUrl = imageUrl.split('?')[0] + '?format=jpg&name=large';
                            return imageUrl;
                        }
                    }
                }
            }
        }

        const isVideoContainer = mediaElement.querySelector('.is-video');
        if (isVideoContainer) {
            const imageLink = mediaElement.querySelector('.js-media-image-link');
            if (imageLink) {
                const bgImage = imageLink.style.backgroundImage;
                if (bgImage) {
                    const match = bgImage.match(/url\(["']?([^"']+)["']?\)/);
                    if (match && match[1]) {
                        let imageUrl = match[1];
                        imageUrl = imageUrl.split('?')[0] + '?format=jpg&name=large';
                        return imageUrl;
                    }
                }
            }
        }

        return null;
    }

    function extractCardUrl(article) {
        const cardContainer = article.querySelector('[data-testid="card"].hw-card-container');
        if (!cardContainer) return null;

        const cardLink = cardContainer.querySelector('a[href^="https://t.co/"]');
        if (cardLink) {
            return cardLink.href;
        }
        return null;
    }

    // ==================== Bluesky投稿 ====================

    async function postToBluesky(columnConfig, tweetData, columnKey, timestamp) {
        log(`📤 投稿試行`);
        log('投稿データ:', tweetData);

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: CONFIG.pythonServerUrl,
                headers: {
                    'Content-Type': 'application/json',
                },
                timeout: 30000,
                data: JSON.stringify({
                    handle: columnConfig.bluesky.handle,
                    appPassword: columnConfig.bluesky.appPassword,
                    text: tweetData.text,
                    tweetUrl: tweetData.tweetUrl,
                    author: tweetData.author,
                    mediaUrls: tweetData.mediaUrls,
                    videoThumbnail: tweetData.videoThumbnail,
                    cardShortUrl: tweetData.cardShortUrl,
                    contentType: tweetData.contentType,
                    facets: tweetData.facets,
                    quotedTweetId: tweetData.quotedTweetId
                }),
                onload: function (response) {
                    log('サーバーレスポンス:', response.status, response.responseText);
                    if (response.status === 200) {
                        log('✅ 投稿成功:', tweetData.tweetId);
                        markTweetAsProcessed(tweetData.tweetId, columnKey, timestamp);
                        resolve();
                    } else {
                        error('❌ 投稿失敗:', response.status, response.responseText);
                        markTweetAsProcessed(tweetData.tweetId, columnKey, timestamp);
                        reject(new Error(`Post failed with status ${response.status}`));
                    }
                },
                onerror: function (err) {
                    error('❌ ネットワークエラー:', err);
                    error('Pythonサーバーが起動していますか?');
                    markTweetAsProcessed(tweetData.tweetId, columnKey, timestamp);
                    reject(err);
                },
                ontimeout: function () {
                    error('❌ タイムアウト (30秒)');
                    error(`Tweet ID: ${tweetData.tweetId}, URL: ${tweetData.tweetUrl}`);
                    markTweetAsProcessed(tweetData.tweetId, columnKey, timestamp);
                    reject(new Error('Request timeout'));
                }
            });
        });
    }

    // ==================== ツイート処理 ====================

    // ==================== キュー処理システム ====================

    function addToQueue(article, section) {
        const tweetId = article.getAttribute('data-tweet-id');
        if (!tweetId) return;

        const timestamp = extractTweetTimestamp(article);
        const columnKey = getColumnKeyFromSection(section);

        // 既にキューにあるか確認
        if (tweetQueue.some(item => item.tweetId === tweetId && item.columnKey === columnKey)) {
            return;
        }

        // 処理済みか確認
        if (isTweetProcessed(tweetId, columnKey)) {
            return;
        }

        tweetQueue.push({
            article,
            section,
            tweetId,
            columnKey,
            timestamp
        });

        log(`📥 キューに追加: ${tweetId} (待機中: ${tweetQueue.length}件)`);

        // デバウンス処理（少し待ってからソート＆処理開始）
        if (queueDebounceTimer) {
            clearTimeout(queueDebounceTimer);
        }

        queueDebounceTimer = setTimeout(() => {
            processQueue();
        }, QUEUE_DEBOUNCE_MS);
    }

    async function processQueue() {
        if (isProcessingQueue) return;
        if (tweetQueue.length === 0) return;

        isProcessingQueue = true;

        // ツイートID順（古い順）にソート
        // ツイートIDはSnowflake IDであり、時系列順であることが保証されている
        tweetQueue.sort((a, b) => {
            const idA = BigInt(a.tweetId);
            const idB = BigInt(b.tweetId);
            return idA < idB ? -1 : idA > idB ? 1 : 0;
        });

        log(`🔄 キュー処理開始: ${tweetQueue.length}件`);

        try {
            while (tweetQueue.length > 0) {
                const item = tweetQueue.shift(); // 先頭から取り出し

                // 再度処理済みチェック（念のため）
                if (isTweetProcessed(item.tweetId, item.columnKey)) {
                    log(`⏭️ スキップ(処理済み): ${item.tweetId}`);
                    continue;
                }

                log(`▶️ 処理開始: ${item.tweetId} (${new Date(item.timestamp).toLocaleTimeString()})`);

                // ツイート処理実行
                await processTweet(item.article, item.section);

                // 次の処理まで少し待機（順序保証のため）
                if (tweetQueue.length > 0) {
                    await new Promise(resolve => setTimeout(resolve, QUEUE_PROCESS_INTERVAL_MS));
                }
            }
        } catch (e) {
            error('キュー処理エラー:', e);
        } finally {
            isProcessingQueue = false;
            log('✅ キュー処理完了');
        }
    }

    async function processTweet(article, section) {
        const tweetId = article.getAttribute('data-tweet-id');

        if (!tweetId) {
            log('⚠️ ツイートIDが取得できません');
            return;
        }

        const columnKey = getColumnKeyFromSection(section);
        if (!columnKey) {
            log('⚠️ カラム情報が取得できません');
            return;
        }

        const columnConfig = getColumnConfig(columnKey);
        if (!columnConfig) {
            log(`⚠️ カラム設定が見つかりません: ${columnKey}`);
            return;
        }

        if (isTweetProcessed(tweetId, columnKey)) {
            log('⏭️ スキップ(処理済み):', tweetId);
            return;
        }

        log(`🆕 新規ツイート検出! ID: ${tweetId}, Column: ${columnKey}`);

        try {
            await expandTweetIfNeeded(article);

            // ツイート本文とFacetの抽出
            const { text: tweetText, facets } = extractTweetText(article);
            log('📝 抽出テキスト:', tweetText);
            log('🔗 抽出Facet数:', facets.length);
            const tweetUrl = extractTweetUrl(article);
            const authorInfo = extractTweetAuthor(article);
            const timestamp = extractTweetTimestamp(article);

            const hasCardFlag = hasCard(article);
            const hasVideoFlag = hasVideo(article);
            const hasMediaFlag = hasMedia(article) && !hasVideoFlag;

            log('📊 メディア検出結果:');
            log(`  hasCard: ${hasCardFlag}`);
            log(`  hasVideo: ${hasVideoFlag}`);
            log(`  hasMedia: ${hasMediaFlag}`);

            let contentType = 'text';
            let mediaUrls = [];
            let videoThumbnail = null;
            let cardShortUrl = null;
            let quotedTweetId = null;

            // 引用ツイートの検出
            const quotedTweet = article.querySelector('.quoted-tweet');
            if (quotedTweet) {
                quotedTweetId = quotedTweet.getAttribute('data-tweet-id');
                log('💬 引用ツイート検出:', quotedTweetId);
            }

            if (hasCardFlag) {
                contentType = 'card';
                cardShortUrl = extractCardUrl(article);
                log('🔗 リンクカード検出:', cardShortUrl);
            } else if (hasVideoFlag) {
                contentType = 'video';
                videoThumbnail = extractVideoThumbnail(article);
                log('🎬 動画検出、サムネイル:', videoThumbnail);
            } else if (hasMediaFlag) {
                contentType = 'image';
                mediaUrls = extractMediaUrls(article);
                log('📷 画像検出:', mediaUrls.length, '枚');
            }

            const tweetData = {
                tweetId,
                text: tweetText,
                tweetUrl: tweetUrl,
                author: authorInfo,
                contentType,
                mediaUrls,
                videoThumbnail,
                cardShortUrl,
                facets,
                quotedTweetId
            };

            log('📊 抽出データ:');
            log('  本文:', tweetText.substring(0, 50) + (tweetText.length > 50 ? '...' : ''));
            log('  本文長:', tweetText.length, '文字');
            log('  URL:', tweetUrl);
            log('  タイプ:', contentType);

            await postToBluesky(columnConfig, tweetData, columnKey, timestamp);
        } catch (e) {
            error('処理エラー:', e);
        }
    }

    // ==================== DOM監視 ====================

    function setupColumnObserver(section) {
        const chirpContainer = section.querySelector('.js-chirp-container');
        if (!chirpContainer) {
            log('⚠️ chirp-containerが見つかりません');
            return;
        }

        const columnKey = getColumnKeyFromSection(section);
        if (!columnKey) {
            log('⚠️ カラム情報が取得できません');
            return;
        }

        log(`👀 監視開始: ${columnKey}`);

        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === Node.ELEMENT_NODE && node.tagName === 'ARTICLE') {
                        if (node.classList.contains('stream-item')) {
                            log(`🔔 新しいarticle要素を検出 (カラム: ${columnKey})`);
                            // processTweet(node, section); // 直接呼ばずにキューに追加
                            addToQueue(node, section);
                        }
                    }
                });
            });
        });

        observer.observe(chirpContainer, {
            childList: true,
            subtree: false
        });

        return observer;
    }

    // ==================== メイン処理 ====================

    function initialize() {
        log('🚀 初期化開始');

        const config = initializeConfig();
        log('現在の設定:');
        log('  カラム数:', config.columns.length);

        const columns = document.querySelectorAll('.js-column');
        log(`🔍 検出: ${columns.length} 個のカラムを発見`);

        if (columns.length === 0) {
            log('⚠️ カラムが見つかりません。5秒後に再試行します...');
            setTimeout(initialize, TWEETDECK_RETRY_DELAY_MS);
            return;
        }

        let monitoredCount = 0;

        columns.forEach((section, index) => {
            const columnInfo = getColumnInfo(section);
            if (columnInfo) {
                const columnKey = getColumnKeyFromInfo(columnInfo);
                log(`📋 カラム ${index + 1}: ${columnKey}`);

                const columnConfig = getColumnConfig(columnKey);
                if (columnConfig && columnConfig.enabled !== false) {
                    log(`  ✅ 設定あり → 監視開始`);
                    setupColumnObserver(section);
                    monitoredCount++;
                } else {
                    log(`  ⏭️ 設定なし/無効 → 監視対象外`);
                }
            }
        });

        const appColumns = document.querySelector('.js-app-columns');
        if (appColumns) {
            const columnsObserver = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === Node.ELEMENT_NODE && node.classList.contains('js-column')) {
                            const columnInfo = getColumnInfo(node);
                            if (columnInfo) {
                                const columnKey = getColumnKeyFromInfo(columnInfo);
                                const columnConfig = getColumnConfig(columnKey);

                                if (columnConfig && columnConfig.enabled !== false) {
                                    log('🆕 新カラム検出(設定あり)! 監視を開始します');
                                    setupColumnObserver(node);
                                } else {
                                    log('🆕 新カラム検出(設定なし/無効): 監視対象外');
                                }
                            }
                        }
                    });
                });
            });

            columnsObserver.observe(appColumns, {
                childList: true,
                subtree: false
            });
        }

        log(`✅ 初期化完了! ${monitoredCount}個のカラムを監視中`);
    }

    function waitForTweetdeck() {
        log('⏳ Tweetdeck読み込み待機中...');

        let attempts = 0;

        const checkInterval = setInterval(() => {
            attempts++;
            const appColumns = document.querySelector('.js-app-columns');

            if (appColumns) {
                clearInterval(checkInterval);
                log('✅ Tweetdeck読み込み完了!');
                setTimeout(initialize, 2000);
            } else if (attempts >= TWEETDECK_MAX_RETRY_ATTEMPTS) {
                clearInterval(checkInterval);
                error('❌ Tweetdeck読み込みタイムアウト');
            }
        }, TWEETDECK_RETRY_DELAY_MS);
    }

    // ==================== 設定モーダル ====================

    GM_registerMenuCommand('⚙️ 設定を開く', openSettingsModal);

    function openSettingsModal() {
        const existingModal = document.getElementById('bluesky-settings-modal');
        if (existingModal) {
            existingModal.remove();
        }

        const modal = createModalElement();
        document.body.appendChild(modal);

        initializeTabs();
        showTab('column-settings');
    }

    function createModalElement() {
        const modal = document.createElement('div');
        modal.id = 'bluesky-settings-modal';
        modal.innerHTML = `
            <style>
                #bluesky-settings-modal {
                    position: fixed !important;
                    top: 0 !important;
                    left: 0 !important;
                    width: 100vw !important;
                    height: 100vh !important;
                    background: rgba(0, 0, 0, 0.85) !important;
                    z-index: 100000 !important;
                    display: flex !important;
                    justify-content: center !important;
                    align-items: center !important;
                    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
                }

                #bluesky-settings-modal * {
                    box-sizing: border-box !important;
                }

                .bluesky-modal-container {
                    background: #15202b !important;
                    width: 100% !important;
                    height: 100% !important;
                    display: flex !important;
                    flex-direction: column !important;
                    color: #ffffff !important;
                }

                .bluesky-modal-header {
                    padding: 20px 24px !important;
                    border-bottom: 1px solid #38444d !important;
                    display: flex !important;
                    justify-content: space-between !important;
                    align-items: center !important;
                }

                .bluesky-modal-title {
                    font-size: 20px !important;
                    font-weight: bold !important;
                    color: #ffffff !important;
                }

                .bluesky-modal-close {
                    background: none !important;
                    border: none !important;
                    color: #8899a6 !important;
                    font-size: 24px !important;
                    cursor: pointer !important;
                    padding: 0 !important;
                    width: 32px !important;
                    height: 32px !important;
                    display: flex !important;
                    align-items: center !important;
                    justify-content: center !important;
                    border-radius: 50% !important;
                    transition: background 0.2s !important;
                    outline: none !important;
                    box-shadow: none !important;
                }

                .bluesky-modal-close:hover {
                    background: rgba(136, 153, 166, 0.1) !important;
                }

                .bluesky-modal-close:active {
                    outline: none !important;
                    box-shadow: none !important;
                    border: none !important;
                }

                .bluesky-modal-close:focus {
                    outline: none !important;
                    box-shadow: none !important;
                }

                .bluesky-modal-tabs {
                    display: flex !important;
                    border-bottom: 1px solid #38444d !important;
                    padding: 0 24px !important;
                    background: #15202b !important;
                }

                .bluesky-modal-tab {
                    padding: 16px 20px !important;
                    background: none !important;
                    border: none !important;
                    color: #8899a6 !important;
                    font-size: 15px !important;
                    font-weight: 600 !important;
                    cursor: pointer !important;
                    border-bottom: 2px solid transparent !important;
                    transition: all 0.2s !important;
                    outline: none !important;
                    box-shadow: none !important;
                    border-radius: 0 !important;
                }

                .bluesky-modal-tab:hover {
                    color: #ffffff !important;
                    background: none !important;
                }

                .bluesky-modal-tab:active {
                    outline: none !important;
                    box-shadow: none !important;
                    border-top: none !important;
                    border-left: none !important;
                    border-right: none !important;
                }

                .bluesky-modal-tab:focus {
                    outline: none !important;
                    box-shadow: none !important;
                }

                .bluesky-modal-tab.active {
                    color: #794bc4 !important;
                    border-bottom: 2px solid #794bc4 !important;
                    background: none !important;
                    border-radius: 0 !important;
                }

                .bluesky-modal-content {
                    flex: 1 !important;
                    overflow-y: auto !important;
                    padding: 24px !important;
                    background: #15202b !important;
                }

                .bluesky-modal-tab-pane {
                    display: none !important;
                }

                .bluesky-modal-tab-pane.active {
                    display: block !important;
                }

                .bluesky-modal-footer {
                    padding: 16px 24px !important;
                    border-top: 1px solid #38444d !important;
                    display: flex !important;
                    justify-content: flex-end !important;
                    gap: 12px !important;
                    background: #15202b !important;
                }

                .bluesky-btn {
                    padding: 10px 20px !important;
                    border: none !important;
                    border-radius: 6px !important;
                    font-size: 15px !important;
                    font-weight: 600 !important;
                    cursor: pointer !important;
                    transition: all 0.2s !important;
                    outline: none !important;
                    box-shadow: none !important;
                }

                .bluesky-btn:active {
                    outline: none !important;
                    box-shadow: none !important;
                    border: none !important;
                }

                .bluesky-btn:focus {
                    outline: none !important;
                    box-shadow: none !important;
                }

                .bluesky-btn-primary {
                    background: #794bc4 !important;
                    color: #ffffff !important;
                    border: none !important;
                }

                .bluesky-btn-primary:hover {
                    background: #8c5fd6 !important;
                }

                .bluesky-btn-primary:active {
                    background: #6a3fb0 !important;
                    outline: none !important;
                    box-shadow: none !important;
                    border: none !important;
                }

                .bluesky-btn-secondary {
                    background: transparent !important;
                    color: #8899a6 !important;
                    border: 1px solid #38444d !important;
                }

                .bluesky-btn-secondary:hover {
                    background: rgba(136, 153, 166, 0.1) !important;
                }

                .bluesky-btn-secondary:active {
                    background: rgba(136, 153, 166, 0.2) !important;
                    outline: none !important;
                    box-shadow: none !important;
                }

                .bluesky-column-item {
                    background: #192734 !important;
                    border: 1px solid #38444d !important;
                    border-radius: 8px !important;
                    padding: 16px !important;
                    margin-bottom: 12px !important;
                }

                .bluesky-column-header {
                    display: flex !important;
                    align-items: center !important;
                    gap: 12px !important;
                    margin-bottom: 12px !important;
                }

                .bluesky-column-title {
                    font-size: 16px !important;
                    font-weight: 600 !important;
                    color: #ffffff !important;
                    flex: 1 !important;
                }

                .bluesky-toggle {
                    position: relative !important;
                    display: inline-block !important;
                    width: 48px !important;
                    height: 24px !important;
                }

                .bluesky-toggle input {
                    opacity: 0 !important;
                    width: 0 !important;
                    height: 0 !important;
                }

                .bluesky-toggle-slider {
                    position: absolute !important;
                    cursor: pointer !important;
                    top: 0 !important;
                    left: 0 !important;
                    right: 0 !important;
                    bottom: 0 !important;
                    background-color: #38444d !important;
                    transition: 0.3s !important;
                    border-radius: 24px !important;
                }

                .bluesky-toggle-slider:before {
                    position: absolute !important;
                    content: "" !important;
                    height: 18px !important;
                    width: 18px !important;
                    left: 3px !important;
                    bottom: 3px !important;
                    background-color: white !important;
                    transition: 0.3s !important;
                    border-radius: 50% !important;
                }

                .bluesky-toggle input:checked + .bluesky-toggle-slider {
                    background-color: #794bc4 !important;
                }

                .bluesky-toggle input:checked + .bluesky-toggle-slider:before {
                    transform: translateX(24px) !important;
                }

                .bluesky-form-group {
                    margin-bottom: 12px !important;
                }

                .bluesky-form-label {
                    display: block !important;
                    font-size: 13px !important;
                    font-weight: 600 !important;
                    color: #8899a6 !important;
                    margin-bottom: 6px !important;
                }

                .bluesky-form-input,
                .bluesky-form-textarea {
                    width: 100% !important;
                    padding: 10px 12px !important;
                    background: #15202b !important;
                    border: 1px solid #38444d !important;
                    border-radius: 6px !important;
                    color: #ffffff !important;
                    font-size: 14px !important;
                    transition: border-color 0.2s !important;
                }

                .bluesky-form-input:focus,
                .bluesky-form-textarea:focus {
                    outline: none !important;
                    border-color: #794bc4 !important;
                }

                .bluesky-system-section {
                    background: #192734 !important;
                    border: 1px solid #38444d !important;
                    border-radius: 8px !important;
                    padding: 20px !important;
                    margin-bottom: 16px !important;
                }

                .bluesky-system-title {
                    font-size: 16px !important;
                    font-weight: 600 !important;
                    color: #ffffff !important;
                    margin-bottom: 12px !important;
                }

                .bluesky-system-description {
                    font-size: 14px !important;
                    color: #8899a6 !important;
                    margin-bottom: 16px !important;
                    line-height: 1.5 !important;
                }

                .bluesky-stats-grid {
                    display: grid !important;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)) !important;
                    gap: 12px !important;
                    margin-bottom: 16px !important;
                }

                .bluesky-stat-item {
                    background: #15202b !important;
                    padding: 12px !important;
                    border-radius: 6px !important;
                }

                .bluesky-stat-label {
                    font-size: 12px !important;
                    color: #8899a6 !important;
                    margin-bottom: 4px !important;
                }

                .bluesky-stat-value {
                    font-size: 24px !important;
                    font-weight: 600 !important;
                    color: #ffffff !important;
                }

                .bluesky-stat-detail {
                    font-size: 13px !important;
                    color: #8899a6 !important;
                    margin-top: 8px !important;
                    max-height: 150px !important;
                    overflow-y: auto !important;
                }

                .bluesky-file-input {
                    display: none !important;
                }

                .bluesky-file-label {
                    display: inline-block !important;
                    padding: 10px 20px !important;
                    background: #794bc4 !important;
                    color: #ffffff !important;
                    border-radius: 6px !important;
                    cursor: pointer !important;
                    font-size: 15px !important;
                    font-weight: 600 !important;
                    transition: background 0.2s !important;
                }

                .bluesky-file-label:hover {
                    background: #8c5fd6 !important;
                }
            </style>

            <div class="bluesky-modal-container">
                <div class="bluesky-modal-header">
                    <div class="bluesky-modal-title">Bluesky転送設定</div>
                    <button class="bluesky-modal-close" id="bluesky-close-modal">×</button>
                </div>

                <div class="bluesky-modal-tabs">
                    <button class="bluesky-modal-tab active" data-tab="column-settings">カラム設定</button>
                    <button class="bluesky-modal-tab" data-tab="system">システム</button>
                </div>

                <div class="bluesky-modal-content">
                    <div class="bluesky-modal-tab-pane active" id="tab-column-settings">
                        <p style="color: #8899a6;">カラム設定タブ(実装中)</p>
                    </div>

                    <div class="bluesky-modal-tab-pane" id="tab-system">
                        <p style="color: #8899a6;">システムタブ(実装中)</p>
                    </div>
                </div>

                <div class="bluesky-modal-footer">
                    <button class="bluesky-btn bluesky-btn-secondary" id="bluesky-cancel-btn">キャンセル</button>
                    <button class="bluesky-btn bluesky-btn-primary" id="bluesky-save-btn">保存</button>
                    <button class="bluesky-btn bluesky-btn-primary" id="bluesky-save-reload-btn">保存して更新</button>
                </div>
            </div>
        `;

        return modal;
    }

    function initializeTabs() {
        document.querySelectorAll('.bluesky-modal-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const tabName = tab.getAttribute('data-tab');
                showTab(tabName);
            });
        });

        document.getElementById('bluesky-close-modal').addEventListener('click', closeSettingsModal);
        document.getElementById('bluesky-cancel-btn').addEventListener('click', closeSettingsModal);
        document.getElementById('bluesky-save-btn').addEventListener('click', () => {
            saveSettings();
        });
        document.getElementById('bluesky-save-reload-btn').addEventListener('click', () => {
            saveAndReload();
        });
    }

    function showTab(tabName) {
        document.querySelectorAll('.bluesky-modal-tab').forEach(tab => {
            tab.classList.remove('active');
        });

        document.querySelectorAll('.bluesky-modal-tab-pane').forEach(pane => {
            pane.classList.remove('active');
        });

        const activeTab = document.querySelector(`.bluesky-modal-tab[data-tab="${tabName}"]`);
        const activePane = document.getElementById(`tab-${tabName}`);

        if (activeTab && activePane) {
            activeTab.classList.add('active');
            activePane.classList.add('active');

            if (tabName === 'column-settings') {
                renderColumnSettings();
            } else if (tabName === 'system') {
                renderSystemTab();
            }
        }
    }

    function renderColumnSettings() {
        const container = document.getElementById('tab-column-settings');
        if (!container) {
            error('カラム設定タブが見つかりません');
            return;
        }

        const config = initializeConfig(true);
        const columns = document.querySelectorAll('.js-column');

        let html = '';

        columns.forEach((section, index) => {
            const columnInfo = getColumnInfo(section);
            if (!columnInfo) return;

            const columnKey = getColumnKeyFromInfo(columnInfo);
            const columnConfig = config.columns.find(col => col.columnKey === columnKey);

            // 設定が存在し、かつ enabled が false でない場合（undefinedはtrue扱い＝後方互換）
            const isEnabled = columnConfig ? (columnConfig.enabled !== false) : false;
            const handle = columnConfig?.bluesky?.handle || '';
            const password = columnConfig?.bluesky?.appPassword || '';

            html += `
            <div class="bluesky-column-item" data-column-key="${columnKey}">
                <div class="bluesky-column-header">
                        <div class="bluesky-column-title">
                            📋 ${columnInfo.heading} (${columnInfo.attribution})
                        </div>
                        <label class="bluesky-toggle">
                            <input type="checkbox" ${isEnabled ? 'checked' : ''}>
                            <span class="bluesky-toggle-slider"></span>
                        </label>
                    </div>

                    <div class="bluesky-form-group">
                        <label class="bluesky-form-label">Bluesky Handle</label>
                        <input type="text"
                               class="bluesky-form-input"
                               placeholder="example.bsky.social"
                               value="${handle}"
                               data-field="handle"
                               data-column-key="${columnKey}"
                               autocomplete="off"
                               spellcheck="false">
                    </div>

                    <div class="bluesky-form-group">
                        <label class="bluesky-form-label">App Password</label>
                        <input type="text"
                               class="bluesky-form-input"
                               placeholder="xxxx-xxxx-xxxx-xxxx"
                               value="${password}"
                               data-field="password"
                               data-column-key="${columnKey}"
                               autocomplete="off"
                               spellcheck="false"
                               style="font-family: monospace;">
                    </div>
                </div>
            `;
        });

        if (html === '') {
            html = '<p style="color: #8899a6;">カラムが見つかりませんでした。</p>';
        }

        container.innerHTML = html;
    }

    function renderSystemTab() {
        const container = document.getElementById('tab-system');
        if (!container) {
            error('システムタブが見つかりません');
            return;
        }

        const config = initializeConfig(true);
        const totalTweets = getTotalProcessedTweetsCount(config.processedTweets);

        let tweetBreakdown = '';
        for (const columnKey in config.processedTweets) {
            const count = Object.keys(config.processedTweets[columnKey]).length;
            if (count > 0) {
                tweetBreakdown += `<div>├─ ${columnKey}: ${count}件</div>`;
            }
        }

        if (!tweetBreakdown) {
            tweetBreakdown = '<div style="color: #8899a6;">処理済みツイートがありません</div>';
        }

        container.innerHTML = `
            <div class="bluesky-system-section">
                <div class="bluesky-system-title">📊 統計情報</div>
                <div class="bluesky-stats-grid">
                    <div class="bluesky-stat-item">
                        <div class="bluesky-stat-label">監視中のカラム</div>
                        <div class="bluesky-stat-value">${config.columns.length}</div>
                    </div>
                    <div class="bluesky-stat-item">
                        <div class="bluesky-stat-label">処理済みツイート</div>
                        <div class="bluesky-stat-value">${totalTweets}</div>
                        <div class="bluesky-stat-detail">${tweetBreakdown}</div>
                    </div>
                </div>
            </div>

            <div class="bluesky-system-section">
                <div class="bluesky-system-title">🔌 サーバー接続テスト</div>
                <div class="bluesky-system-description">
                    Pythonサーバー (localhost:5000) との接続を確認します。
                </div>
                <button class="bluesky-btn bluesky-btn-primary" id="test-server-btn">
                    接続テスト実行
                </button>
            </div>

            <div class="bluesky-system-section">
                <div class="bluesky-system-title">📥 設定のエクスポート</div>
                <div class="bluesky-system-description">
                    カラム設定をJSONファイルとしてエクスポートします。<br>
                    処理済みツイートの情報は含まれません。
                </div>
                <button class="bluesky-btn bluesky-btn-primary" id="export-settings-btn">
                    設定をエクスポート
                </button>
            </div>

            <div class="bluesky-system-section">
                <div class="bluesky-system-title">📤 設定のインポート</div>
                <div class="bluesky-system-description">
                    エクスポートしたJSONファイルから設定を読み込みます。<br>
                    ⚠️ 既存の設定は上書きされます。
                </div>
                <input type="file"
                       id="import-file-input"
                       class="bluesky-file-input"
                       accept=".json">
                <label for="import-file-input" class="bluesky-file-label">
                    ファイルを選択
                </label>
            </div>

            <div class="bluesky-system-section">
                <div class="bluesky-system-title">🔄 設定のリセット</div>
                <div class="bluesky-system-description">
                    すべての設定と処理済みツイートの記録を削除します。<br>
                    ⚠️ この操作は取り消せません。
                </div>
                <button class="bluesky-btn bluesky-btn-secondary" id="reset-settings-btn">
                    すべての設定をリセット
                </button>
            </div>
        `;

        // イベントリスナーを追加（エラーハンドリング付き）
        const testServerBtn = document.getElementById('test-server-btn');
        const exportSettingsBtn = document.getElementById('export-settings-btn');
        const importFileInput = document.getElementById('import-file-input');
        const resetSettingsBtn = document.getElementById('reset-settings-btn');

        if (testServerBtn) {
            testServerBtn.addEventListener('click', w.testServerConnection);
        } else {
            error('サーバー接続テストボタンが見つかりません');
        }

        if (exportSettingsBtn) {
            exportSettingsBtn.addEventListener('click', w.exportSettings);
        } else {
            error('設定エクスポートボタンが見つかりません');
        }

        if (importFileInput) {
            importFileInput.addEventListener('change', w.importSettings);
        } else {
            error('ファイルインポート要素が見つかりません');
        }

        if (resetSettingsBtn) {
            resetSettingsBtn.addEventListener('click', w.resetAllSettings);
        } else {
            error('設定リセットボタンが見つかりません');
        }
    }

    function showToast(message, type = 'info') {
        const existingToast = document.getElementById('bluesky-toast');
        if (existingToast) {
            existingToast.remove();
        }

        const toast = document.createElement('div');
        toast.id = 'bluesky-toast';
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${type === 'success' ? '#794bc4' : '#e0245e'};
            color: #ffffff;
            padding: 16px 24px;
            border-radius: 8px;
            font-size: 15px;
            font-weight: 600;
            z-index: 100001;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            animation: slideIn 0.3s ease-out;
        `;
        toast.textContent = message;

        document.body.appendChild(toast);

        setTimeout(() => {
            toast.style.animation = 'slideOut 0.3s ease-out';
            setTimeout(() => toast.remove(), TOAST_ANIMATION_DURATION_MS);
        }, TOAST_AUTO_HIDE_DELAY_MS);
    }

    // トースト通知用のスタイルを初期化時に1回だけ注入
    function injectToastStyles() {
        if (!document.getElementById('bluesky-toast-styles')) {
            const style = document.createElement('style');
            style.id = 'bluesky-toast-styles';
            style.textContent = `
                @keyframes slideIn {
                    from {
                        transform: translateX(400px);
                        opacity: 0;
                    }
                    to {
                        transform: translateX(0);
                        opacity: 1;
                    }
                }
                @keyframes slideOut {
                    from {
                        transform: translateX(0);
                        opacity: 1;
                    }
                    to {
                        transform: translateX(400px);
                        opacity: 0;
                    }
                }
            `;
            document.head.appendChild(style);
        }
    }

    function closeSettingsModal() {
        const modal = document.getElementById('bluesky-settings-modal');
        if (modal) {
            modal.remove();
        }
    }

    function saveSettings() {
        const config = initializeConfig(true);
        const columnItems = document.querySelectorAll('.bluesky-column-item');

        const newColumns = [];

        columnItems.forEach(item => {
            const columnKey = item.getAttribute('data-column-key');
            const checkbox = item.querySelector('input[type="checkbox"]');
            const handleInput = item.querySelector('input[data-field="handle"]');
            const passwordInput = item.querySelector('input[data-field="password"]');

            const isEnabled = checkbox.checked;
            const handle = handleInput.value.trim();
            const password = passwordInput.value.trim();

            // 有効化する場合は入力必須
            if (isEnabled && (!handle || !password)) {
                alert(`カラム "${columnKey}" を有効にするには、Bluesky情報が必要です。`);
                return;
            }

            // 入力がある場合、または有効化されている場合は保存
            if (handle || password || isEnabled) {
                const [heading, attribution] = columnKey.split('|');

                newColumns.push({
                    columnKey: columnKey,
                    heading: heading,
                    attribution: attribution,
                    enabled: isEnabled,
                    bluesky: {
                        handle: handle,
                        appPassword: password
                    }
                });
            }
        });

        config.columns = newColumns;
        saveConfig(config);

        log('💾 設定を保存しました');
        alert('✅ 設定を保存しました');
    }

    function saveAndReload() {
        saveSettings();
        log('🔄 ページをリロードします');
        location.reload();
    }

    // ==================== 既存のグローバル関数 ====================

    log('✅ グローバル関数を登録しました');

    // ==================== スクリプト開始 ====================

    log('==========================================');
    log('🎯 Tweetdeck to Bluesky Bridge v1.00');
    log('==========================================');

    // トースト通知用のスタイルを注入
    injectToastStyles();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', waitForTweetdeck);
    } else {
        waitForTweetdeck();
    }

})();
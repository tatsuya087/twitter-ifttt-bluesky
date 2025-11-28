"""
Bluesky投稿サーバー v1.00
"""

import re
import logging
import sqlite3
import uvicorn
from logging.handlers import TimedRotatingFileHandler
from datetime import datetime
from typing import List, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from atproto import Client, models
from PIL import Image, ImageDraw, ImageFont
from io import BytesIO
import requests
from bs4 import BeautifulSoup
from urllib.parse import urlparse
import time
import os
import sys
import asyncio
import yt_dlp

# 定数定義
REQUEST_TIMEOUT = 15  # リクエストタイムアウト（秒）
MAX_IMAGE_SIZE_BYTES = 950 * 1024  # 最大画像サイズ（バイト）
INITIAL_IMAGE_QUALITY = 85  # 初期JPEG品質
MIN_IMAGE_QUALITY = 20  # 最小JPEG品質
PLAY_BUTTON_IMAGE_PATH = "assets/play-circle.png"  # 再生ボタン画像のパス

# スクリプトのディレクトリに移動（重要！）
script_dir = os.path.dirname(os.path.abspath(__file__))
os.chdir(script_dir)
print(f"作業ディレクトリ: {script_dir}")

# ログディレクトリの作成
LOGS_DIR = "logs"
if not os.path.exists(LOGS_DIR):
    os.makedirs(LOGS_DIR)
    print(f"✅ ログディレクトリを作成しました: {LOGS_DIR}")

# ログ設定
log_filename = os.path.join(LOGS_DIR, "server.log")

# ルートロガーの設定
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# 既存のハンドラーをクリア（再読み込み時などの重複防止）
if logger.hasHandlers():
    logger.handlers.clear()

# フォーマッター作成
formatter = logging.Formatter('%(asctime)s - %(levelname)s - %(message)s')

# ファイルハンドラー (TimedRotatingFileHandler)
# 12時間ごとにローテーション、バックアップは7世代分保存
file_handler = TimedRotatingFileHandler(
    log_filename,
    when='H',
    interval=12,
    backupCount=7,
    encoding='utf-8'
)
file_handler.setFormatter(formatter)
logger.addHandler(file_handler)

# ストリームハンドラー (コンソール出力)
stream_handler = logging.StreamHandler()
stream_handler.setFormatter(formatter)
logger.addHandler(stream_handler)

logger.info("=" * 50)
logger.info(f"ログファイル: {log_filename}")
logger.info("=" * 50)

server_start_time = time.time()

# ==================== データベース管理 ====================
class HistoryDB:
    def __init__(self, db_path="history.db"):
        self.db_path = db_path
        self._init_db()

    def _init_db(self):
        with sqlite3.connect(self.db_path) as conn:
            cursor = conn.cursor()
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS posts (
                    tweet_id TEXT PRIMARY KEY,
                    bluesky_uri TEXT,
                    bluesky_cid TEXT,
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            """)
            conn.commit()

    def save_post(self, tweet_id: str, bluesky_uri: str, bluesky_cid: str):
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                cursor.execute("""
                    INSERT OR REPLACE INTO posts (tweet_id, bluesky_uri, bluesky_cid)
                    VALUES (?, ?, ?)
                """, (tweet_id, bluesky_uri, bluesky_cid))
                conn.commit()
        except Exception as e:
            logger.error(f"DB保存エラー: {e}")

    def get_post(self, tweet_id: str):
        try:
            with sqlite3.connect(self.db_path) as conn:
                cursor = conn.cursor()
                cursor.execute("SELECT bluesky_uri, bluesky_cid FROM posts WHERE tweet_id = ?", (tweet_id,))
                return cursor.fetchone()
        except Exception as e:
            logger.error(f"DB取得エラー: {e}")
            return None

# グローバルDBインスタンス
history_db = HistoryDB()

app = FastAPI(title="Twitter-IFTTT-Bluesky v1.00")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://x.com"],  # Tweetdeckのみ許可
    allow_credentials=True,
    allow_methods=["POST", "GET"],
    allow_headers=["Content-Type"],
)


class PostRequest(BaseModel):
    handle: str
    appPassword: str
    text: str
    tweetUrl: str
    author: dict
    contentType: str
    mediaUrls: List[str] = []
    videoThumbnail: Optional[str] = None
    cardShortUrl: Optional[str] = None
    facets: Optional[List[dict]] = None
    quotedTweetId: Optional[str] = None

class IFTTTRequest(BaseModel):
    handle: str
    appPassword: str
    text: str
    url: str

def compress_image_to_limit(img: Image.Image, max_size_bytes: int = MAX_IMAGE_SIZE_BYTES, initial_quality: int = INITIAL_IMAGE_QUALITY) -> bytes:
    """画像を指定サイズ以下に圧縮"""
    if img.mode != 'RGB':
        img = img.convert('RGB')
    
    output = BytesIO()
    quality = initial_quality
    
    while quality > MIN_IMAGE_QUALITY:
        output.seek(0)
        output.truncate()
        img.save(output, format='JPEG', quality=quality)
        size = output.tell()
        
        if size <= max_size_bytes:
            break
        
        quality -= 5
        logger.info(f"画像が大きすぎます({size} bytes)。品質を{quality}に下げます")
    
    output.seek(0)
    final_size = len(output.getvalue())
    logger.info(f"画像圧縮完了: {final_size} bytes, quality={quality}")
    
    return output.getvalue()


def expand_short_url(short_url: str) -> str:
    """短縮URL(t.co)を展開"""
    try:
        logger.info(f"短縮URL展開: {short_url}")
        response = requests.head(short_url, allow_redirects=True, timeout=REQUEST_TIMEOUT)
        expanded_url = response.url
        logger.info(f"展開後URL: {expanded_url}")
        return expanded_url
    except requests.RequestException as e:
        logger.error(f"短縮URL展開エラー (ネットワーク): {e}")
        return short_url
    except Exception as e:
        logger.error(f"短縮URL展開エラー (予期しないエラー): {e}", exc_info=True)
        return short_url


def expand_tco_links_in_text(text: str) -> str:
    """テキスト内のt.coリンクを全て展開"""
    tco_pattern = r'https://t\.co/[a-zA-Z0-9]+'
    
    def replace_link(match):
        tco_url = match.group(0)
        return expand_short_url(tco_url)
            
    return re.sub(tco_pattern, replace_link, text)


def extract_media_info(url: str) -> dict:
    """yt-dlpを使用してメディア情報を抽出"""
    try:
        logger.info(f"メディア情報抽出開始: {url}")
        ydl_opts = {
            'quiet': True,
            'no_warnings': True,
            'extract_flat': True, # flatに戻す (画像ツイートで動画検索エラーになるのを防ぐ)
            'ignoreerrors': True, # エラーが出ても続行
        }
        
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            
            if not info:
                logger.warning("yt-dlpから情報を取得できませんでした")
                return None # Noneを返してフォールバックさせる

            media_info = {
                'type': 'card', # デフォルト
                'media_urls': [],
                'thumbnail': None,
                'text': info.get('description', ''),
                'author': {
                    'name': info.get('uploader', ''),
                    'screen_name': info.get('uploader_id', ''),
                    'avatar_url': ''
                }
            }
            
            # 複数画像 (entriesがある場合)
            if 'entries' in info:
                logger.info(f"複数メディア候補を検出: {len(info['entries'])}件")
                images = []
                for entry in info['entries']:
                    if entry.get('thumbnail'):
                         images.append(entry['thumbnail'])
                    elif entry.get('url') and 'pbs.twimg.com' in entry.get('url'):
                         images.append(entry['url'])

                # 重複除去
                images = list(dict.fromkeys(images))
                
                if images:
                    media_info['type'] = 'image'
                    media_info['media_urls'] = images
                    logger.info(f"画像URL抽出: {len(images)}枚")
                    return media_info

            # 単一動画/GIF
            if info.get('_type') == 'video' or info.get('ext') in ['mp4', 'gif'] or 'formats' in info:
                 media_info['type'] = 'video'
                 media_info['thumbnail'] = info.get('thumbnail')
                 logger.info(f"動画/GIFを検出: thumb={bool(media_info['thumbnail'])}")
                 return media_info
            
            # 単一画像
            if info.get('thumbnail'):
                media_info['type'] = 'image'
                media_info['media_urls'] = [info['thumbnail']]
                logger.info("単一画像を検出")
                return media_info
                
            logger.info("メディアは見つかりませんでした。")
            return media_info

    except Exception as e:
        logger.error(f"メディア抽出エラー: {e}")
        return None


def fetch_ogp_data(url: str) -> dict:
    """URLからOGP情報を取得"""
    try:
        logger.info(f"OGP取得開始: {url}")
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)'
        }
        
        response = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        
        soup = BeautifulSoup(response.content, 'html.parser')
        
        ogp_data = {
            'title': '',
            'description': '',
            'image': '',
            'url': url
        }
        
        og_title = soup.find('meta', property='og:title')
        twitter_title = soup.find('meta', attrs={'name': 'twitter:title'})
        title_tag = soup.find('title')
        
        if og_title and og_title.get('content'):
            ogp_data['title'] = og_title.get('content', '')
        elif twitter_title and twitter_title.get('content'):
            ogp_data['title'] = twitter_title.get('content', '')
        elif title_tag:
            ogp_data['title'] = title_tag.string or ''
        
        og_desc = soup.find('meta', property='og:description')
        twitter_desc = soup.find('meta', attrs={'name': 'twitter:description'})
        meta_desc = soup.find('meta', attrs={'name': 'description'})
        
        if og_desc and og_desc.get('content'):
            ogp_data['description'] = og_desc.get('content', '')
        elif twitter_desc and twitter_desc.get('content'):
            ogp_data['description'] = twitter_desc.get('content', '')
        elif meta_desc and meta_desc.get('content'):
            ogp_data['description'] = meta_desc.get('content', '')
        
        og_image = soup.find('meta', property='og:image')
        twitter_image = soup.find('meta', attrs={'name': 'twitter:image'})
        twitter_image_src = soup.find('meta', attrs={'name': 'twitter:image:src'})
        
        image_url = ''
        if og_image and og_image.get('content'):
            image_url = og_image.get('content', '')
        elif twitter_image and twitter_image.get('content'):
            image_url = twitter_image.get('content', '')
        elif twitter_image_src and twitter_image_src.get('content'):
            image_url = twitter_image_src.get('content', '')
        
        if image_url and not image_url.startswith('http'):
            parsed = urlparse(url)
            base_url = f"{parsed.scheme}://{parsed.netloc}"
            if image_url.startswith('/'):
                image_url = base_url + image_url
            else:
                image_url = base_url + '/' + image_url
        
        ogp_data['image'] = image_url
        
        logger.info(f"OGP取得成功: title='{ogp_data['title'][:50]}', image={bool(ogp_data['image'])}")
        
        return ogp_data
        
    except requests.RequestException as e:
        logger.error(f"OGP取得エラー (ネットワーク): {e}")
        return {
            'title': url,
            'description': '',
            'image': '',
            'url': url
        }
    except Exception as e:
        logger.error(f"OGP取得エラー (予期しないエラー): {e}", exc_info=True)
        return {
            'title': url,
            'description': '',
            'image': '',
            'url': url
        }


def download_image(url: str) -> Image.Image:
    """画像をダウンロードしてPIL Imageオブジェクトを返す"""
    try:
        logger.info(f"画像ダウンロード: {url}")
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
        response = requests.get(url, headers=headers, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
        
        img = Image.open(BytesIO(response.content))
        logger.info(f"画像ダウンロード成功: {img.size}")
        return img
    except requests.RequestException as e:
        logger.error(f"画像ダウンロードエラー (ネットワーク): {e}")
        return None
    except Exception as e:
        logger.error(f"画像ダウンロードエラー (予期しないエラー): {e}", exc_info=True)
        return None


def add_play_button(img: Image.Image) -> Image.Image:
    """画像の中央に再生ボタンを合成
    
    外部画像ファイル (play-circle.png) を使用
    サイズ: 144x144px（固定）
    """
    # 再生ボタン画像を読み込み
    play_button_path = os.path.join(script_dir, PLAY_BUTTON_IMAGE_PATH)
    
    if not os.path.exists(play_button_path):
        logger.error(f"再生ボタン画像が見つかりません: {play_button_path}")
        logger.warning("再生ボタンなしで続行します")
        return img
    
    try:
        # 再生ボタン画像を読み込み
        play_button = Image.open(play_button_path)
        
        # 再生ボタンがRGBAモードでない場合は変換
        if play_button.mode != 'RGBA':
            play_button = play_button.convert('RGBA')
        
        # 元画像をRGBAモードに変換
        if img.mode != 'RGBA':
            img_rgba = img.convert('RGBA')
        else:
            img_rgba = img.copy()
        
        # 画像サイズと中心点
        img_width, img_height = img_rgba.size
        center_x = img_width // 2
        center_y = img_height // 2
        
        # 再生ボタンのサイズ（144x144pxで固定）
        button_width, button_height = play_button.size
        
        # 画像サイズに応じてスケーリング
        # 画像の短辺の1/4のサイズにする
        min_dimension = min(img_width, img_height)
        target_button_size = int(min_dimension / 4)
        
        # 最低サイズ制限（任意、例えば32px以下にはしないなど）
        target_button_size = max(target_button_size, 32)
        
        play_button = play_button.resize((target_button_size, target_button_size), Image.LANCZOS)
        button_width, button_height = target_button_size, target_button_size
        logger.info(f"再生ボタンをリサイズ: {button_width}x{button_height}px (元画像の短辺: {min_dimension}px)")
        
        # 再生ボタンを中央に配置
        position = (
            center_x - button_width // 2,
            center_y - button_height // 2
        )
        
        # アルファチャンネルを使って合成
        img_rgba.paste(play_button, position, play_button)
        
        # 元の画像モードがRGBだった場合は戻す
        if img.mode == 'RGB':
            img_with_button = img_rgba.convert('RGB')
        else:
            img_with_button = img_rgba
        
        logger.info(f"再生ボタンを追加: {button_width}x{button_height}px at {position}")
        
        return img_with_button
        
    except Exception as e:
        logger.error(f"再生ボタン合成エラー: {e}", exc_info=True)
        logger.warning("再生ボタンなしで続行します")
        return img


def resize_and_crop(img: Image.Image, target_width: int, target_height: int) -> Image.Image:
    """画像を目標サイズにリサイズ&クロップ(余白なし)"""
    target_ratio = target_width / target_height
    img_ratio = img.width / img.height
    
    if img_ratio > target_ratio:
        new_height = target_height
        new_width = int(new_height * img_ratio)
    else:
        new_width = target_width
        new_height = int(new_width / img_ratio)
    
    img_resized = img.resize((new_width, new_height), Image.LANCZOS)
    
    left = (new_width - target_width) // 2
    top = (new_height - target_height) // 2
    right = left + target_width
    bottom = top + target_height
    
    img_cropped = img_resized.crop((left, top, right, bottom))
    
    return img_cropped


def combine_images(image_urls: List[str], target_width: int = 800, target_height: int = 418) -> bytes:
    """複数の画像を1つに結合"""
    try:
        logger.info(f"画像結合開始: {len(image_urls)}枚")
        
        images = []
        for url in image_urls:
            img = download_image(url)
            if img:
                if img.mode in ('RGBA', 'LA', 'P'):
                    background = Image.new('RGB', img.size, (255, 255, 255))
                    if img.mode == 'P':
                        img = img.convert('RGBA')
                    background.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
                    img = background
                elif img.mode != 'RGB':
                    img = img.convert('RGB')
                images.append(img)
        
        if not images:
            logger.error("有効な画像がありません")
            return None
        
        if len(images) == 1:
            combined = resize_and_crop(images[0], target_width, target_height)
            
        elif len(images) == 2:
            half_width = target_width // 2
            
            img1 = resize_and_crop(images[0], half_width, target_height)
            img2 = resize_and_crop(images[1], half_width, target_height)
            
            combined = Image.new('RGB', (target_width, target_height))
            combined.paste(img1, (0, 0))
            combined.paste(img2, (half_width, 0))
                
        elif len(images) == 3:
            half_width = target_width // 2
            half_height = target_height // 2
            
            img1 = resize_and_crop(images[0], half_width, target_height)
            img2 = resize_and_crop(images[1], half_width, half_height)
            img3 = resize_and_crop(images[2], half_width, half_height)
            
            combined = Image.new('RGB', (target_width, target_height))
            combined.paste(img1, (0, 0))
            combined.paste(img2, (half_width, 0))
            combined.paste(img3, (half_width, half_height))
            
        else:
            images = images[:4]
            
            quarter_width = target_width // 2
            quarter_height = target_height // 2
            
            combined = Image.new('RGB', (target_width, target_height))
            
            positions = [
                (0, 0),
                (quarter_width, 0),
                (0, quarter_height),
                (quarter_width, quarter_height)
            ]
            
            for idx, (img, pos) in enumerate(zip(images, positions)):
                img_cropped = resize_and_crop(img, quarter_width, quarter_height)
                combined.paste(img_cropped, pos)
        
        # 画像圧縮（共通関数を使用）
        image_data = compress_image_to_limit(combined)
        
        logger.info(f"画像結合成功: {combined.size}, {len(image_data)} bytes")
        return image_data
        
    except Exception as e:
        logger.error(f"画像結合エラー: {e}", exc_info=True)
        return None


def extract_mentions(text: str) -> list:
    """テキストからメンション(@username)を抽出"""
    mention_pattern = r'(?:^|\s)@([A-Za-z0-9_]+)'
    mentions = []
    
    for match in re.finditer(mention_pattern, text):
        username_start = match.start(1)
        at_position = username_start - 1
        
        if at_position > 0 and text[at_position - 1].isspace():
            start = at_position
        elif at_position == 0:
            start = 0
        else:
            start = at_position
        
        end = match.end(1)
        username = match.group(1)
        
        mentions.append({
            'start': start,
            'end': end,
            'username': username
        })
    
    return mentions


def extract_hashtags(text: str) -> list:
    """テキストからハッシュタグを抽出
    
    Twitter仕様:
    - 英数字、アンダースコア、CJK文字(漢字・ひらがな・カタカナ)
    - 記号(アンダースコア以外)で終了
    """
    # CJK統合漢字、ひらがな、カタカナの範囲を明示的に指定
    # \u3040-\u309F: ひらがな
    # \u30A0-\u30FF: カタカナ
    # \u4E00-\u9FFF: CJK統合漢字
    # \uFF66-\uFF9F: 半角カタカナ
    hashtag_pattern = r'#([A-Za-z0-9_\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\uFF66-\uFF9F]+)'
    hashtags = []
    
    for match in re.finditer(hashtag_pattern, text):
        start = match.start()
        tag = match.group(1)
        
        # 末尾から記号を削除(英数字・アンダースコア・CJK文字以外)
        clean_tag = tag
        while clean_tag and not (clean_tag[-1].isalnum() or 
                                 clean_tag[-1] == '_' or 
                                 '\u3040' <= clean_tag[-1] <= '\u309F' or  # ひらがな
                                 '\u30A0' <= clean_tag[-1] <= '\u30FF' or  # カタカナ
                                 '\u4E00' <= clean_tag[-1] <= '\u9FFF' or  # 漢字
                                 '\uFF66' <= clean_tag[-1] <= '\uFF9F'):   # 半角カナ
            clean_tag = clean_tag[:-1]
        
        if clean_tag:
            actual_end = start + 1 + len(clean_tag)  # +1 は # の分
            hashtags.append({
                'start': start,
                'end': actual_end,
                'tag': clean_tag
            })
    
    return hashtags


def extract_urls(text: str) -> list:
    """テキストからURLを抽出"""
    url_pattern = r'https?://[^\s]+'
    urls = []
    
    for match in re.finditer(url_pattern, text):
        start = match.start()
        end = match.end()
        url = match.group(0)
        urls.append({
            'start': start,
            'end': end,
            'url': url
        })
    
    return urls


def create_facets(text: str):
    """RichText facets を作成"""
    facets = []
    
    mentions = extract_mentions(text)
    for mention in mentions:
        facets.append({
            "index": {
                "byteStart": len(text[:mention['start']].encode('utf-8')),
                "byteEnd": len(text[:mention['end']].encode('utf-8'))
            },
            "features": [{
                "$type": "app.bsky.richtext.facet#link",
                "uri": f"https://twitter.com/{mention['username']}/"
            }]
        })
    
    hashtags = extract_hashtags(text)
    for ht in hashtags:
        facets.append({
            "index": {
                "byteStart": len(text[:ht['start']].encode('utf-8')),
                "byteEnd": len(text[:ht['end']].encode('utf-8'))
            },
            "features": [{
                "$type": "app.bsky.richtext.facet#tag",
                "tag": ht['tag']
            }]
        })
    
    urls = extract_urls(text)
    for url_info in urls:
        facets.append({
            "index": {
                "byteStart": len(text[:url_info['start']].encode('utf-8')),
                "byteEnd": len(text[:url_info['end']].encode('utf-8'))
            },
            "features": [{
                "$type": "app.bsky.richtext.facet#link",
                "uri": url_info['url']
            }]
        })
    
    return facets if facets else None


def upload_blob(client: Client, image_data: bytes):
    """画像データをBlobとしてアップロード"""
    try:
        logger.info(f"Blobアップロード開始: {len(image_data)} bytes")
        blob = client.upload_blob(image_data)
        logger.info(f"Blobアップロード成功")
        return blob.blob
    except Exception as e:
        logger.error(f"Blobアップロードエラー: {e}", exc_info=True)
        return None


def create_tweet_link_card(client: Client, tweet_url: str, author: dict, text: str, thumbnail_data: bytes = None):
    """ツイートのリンクカードを作成"""
    try:
        thumb = None
        
        if thumbnail_data:
            thumb = upload_blob(client, thumbnail_data)
            if not thumb:
                logger.warning("サムネイルのアップロードに失敗しました。画像なしで続行します。")
        
        title = f"{author.get('fullname', '')} ({author.get('username', '')})"
        description = text[:1000] if text else ''
        
        external = {
            "uri": tweet_url,
            "title": title[:300],
            "description": description,
        }
        
        if thumb:
            external["thumb"] = thumb
        
        embed = {
            "$type": "app.bsky.embed.external",
            "external": external
        }
        
        logger.info(f"ツイートリンクカード作成成功: thumb={bool(thumb)}")
        return embed
        
    except Exception as e:
        logger.error(f"ツイートリンクカード作成エラー: {type(e).__name__}: {str(e)}", exc_info=True)
        return None


def create_external_link_card(client: Client, url: str, ogp_data: dict):
    """外部サイトのリンクカードを作成"""
    try:
        thumb = None
        
        if ogp_data.get('image'):
            img = download_image(ogp_data['image'])
            if img:
                max_width = 1200
                max_height = 630
                
                if img.width > max_width or img.height > max_height:
                    ratio = min(max_width / img.width, max_height / img.height)
                    new_size = (int(img.width * ratio), int(img.height * ratio))
                    img = img.resize(new_size, Image.LANCZOS)
                    logger.info(f"OG画像をリサイズ: {new_size}")
                
                # 画像圧縮（共通関数を使用）
                image_data = compress_image_to_limit(img)
                thumb = upload_blob(client, image_data)
                
                if not thumb:
                    logger.warning("OG画像のアップロードに失敗しました。画像なしで続行します。")
        
        external = {
            "uri": url,
            "title": ogp_data.get('title', url)[:300],
            "description": ogp_data.get('description', '')[:1000],
        }
        
        if thumb:
            external["thumb"] = thumb
        
        embed = {
            "$type": "app.bsky.embed.external",
            "external": external
        }
        
        logger.info(f"外部リンクカード作成成功: thumb={bool(thumb)}")
        return embed
        
    except Exception as e:
        logger.error(f"外部リンクカード作成エラー: {type(e).__name__}: {str(e)}", exc_info=True)
        return None


def count_graphemes(text: str) -> int:
    """テキストのgrapheme数をカウント"""
    return len(text)


def truncate_text_for_bluesky(text: str, tweet_url: str, max_graphemes: int = 300) -> tuple:
    """Blueskyの文字数制限に収まるようにテキストを切り詰める"""
    if count_graphemes(text) <= max_graphemes:
        return text, None
    
    suffix = "\n…Read more"
    suffix_length = count_graphemes(suffix)
    
    max_text_length = max_graphemes - suffix_length
    
    if max_text_length <= 0:
        logger.warning("テキストが切り詰められすぎます")
        return text[:max_graphemes], None
    
    truncated_text = text[:max_text_length]
    truncated_text = truncated_text.rstrip()
    
    result = f"{truncated_text}{suffix}"
    
    link_text = "…Read more"
    link_start_pos = len(truncated_text) + 1
    link_end_pos = link_start_pos + len(link_text)
    
    link_facet = {
        "index": {
            "byteStart": len(result[:link_start_pos].encode('utf-8')),
            "byteEnd": len(result[:link_end_pos].encode('utf-8'))
        },
        "features": [{
            "$type": "app.bsky.richtext.facet#link",
            "uri": tweet_url
        }]
    }
    
    logger.info(f"テキストを切り詰めました: {len(text)}文字 → {len(result)}文字")
    
    return result, link_facet


client_sessions = {}


def get_bluesky_client(handle: str, app_password: str) -> Client:
    """Blueskyクライアントを取得(セッションを再利用)"""
    try:
        if handle in client_sessions:
            client = client_sessions[handle]
            try:
                client.app.bsky.actor.get_profile({'actor': handle})
                logger.info(f"既存セッションを再利用: {handle}")
                return client
            except Exception as e:
                logger.warning(f"セッション期限切れ、再ログイン: {e}")
                del client_sessions[handle]
        
        logger.info(f"新規ログイン: {handle}")
        
        import httpx
        http_client = httpx.Client(timeout=30.0)
        
        client = Client()
        client._client = http_client
        client.login(handle, app_password)
        client_sessions[handle] = client
        return client
        
    except Exception as e:
        if hasattr(e, 'response') and e.response.status_code == 429:
            logger.error(f"⚠️ レート制限エラー: {handle}")
            logger.error(f"💡 24時間で10回のログイン制限に達しました")
            logger.error(f"💡 リセット時刻まで待つか、サーバーを再起動せずに運用してください")
        else:
            logger.error(f"ログインエラー: {e}", exc_info=True)
        raise


@app.post("/post-to-bluesky")
async def post_to_bluesky(request: PostRequest):
    """Blueskyに投稿するエンドポイント"""
    try:
        logger.info("-" * 50)
        clean_handle = request.handle.strip()
        clean_handle = ''.join(char for char in clean_handle if char.isprintable())
        
        logger.info(f"投稿リクエスト受信: {clean_handle}, タイプ: {request.contentType}")
        
        try:
            client = get_bluesky_client(clean_handle, request.appPassword)
        except Exception as e:
            if hasattr(e, 'response') and e.response.status_code == 429:
                logger.warning(f"⚠️ レート制限のため投稿をスキップします")
                raise HTTPException(status_code=429, detail="Rate limit exceeded. Please wait for reset.")
            raise
        
        post_text = request.text
        embed = None
        truncate_facet = None
        
        if request.contentType == 'text':
            logger.info("テキストのみツイート処理")
            embed = create_tweet_link_card(
                client,
                request.tweetUrl,
                request.author,
                request.text,
                None
            )
            
        elif request.contentType == 'image':
            logger.info("画像付きツイート処理")
            combined_image = combine_images(request.mediaUrls)
            if combined_image:
                embed = create_tweet_link_card(
                    client, 
                    request.tweetUrl, 
                    request.author, 
                    request.text,
                    combined_image
                )
            
        elif request.contentType == 'video':
            logger.info("動画付きツイート処理")
            if request.videoThumbnail:
                img = download_image(request.videoThumbnail)
                if img:
                    # 再生ボタンを追加
                    img_with_play_button = add_play_button(img)
                    
                    output = BytesIO()
                    if img_with_play_button.mode != 'RGB':
                        img_with_play_button = img_with_play_button.convert('RGB')
                    img_with_play_button.save(output, format='JPEG', quality=90)
                    output.seek(0)
                    embed = create_tweet_link_card(
                        client,
                        request.tweetUrl,
                        request.author,
                        request.text,
                        output.getvalue()
                    )
            
        elif request.contentType == 'card':
            logger.info("リンクカード付きツイート処理")
            if request.cardShortUrl:
                expanded_url = expand_short_url(request.cardShortUrl)
                ogp_data = fetch_ogp_data(expanded_url)
                embed = create_external_link_card(client, expanded_url, ogp_data)
        
        if count_graphemes(post_text) > 300:
            logger.warning(f"テキストが長すぎます: {count_graphemes(post_text)} graphemes")
            post_text, truncate_facet = truncate_text_for_bluesky(post_text, request.tweetUrl)
        
        # クライアントからfacetsが送られてきた場合はそれを使用、なければサーバーで生成
        if request.facets is not None:
            facets = request.facets
            # 切り詰められた場合、範囲外のfacetを除外・調整する必要があるが、
            # 簡易的に、切り詰め発生時はサーバー側で再生成するか、
            # あるいはtruncate_facetだけ追加して許容するか。
            # ここでは、切り詰めが発生した場合はサーバー側で再生成する方が安全かもしれないが、
            # DOMベースの正確さを優先するなら、切り詰め位置より前のfacetだけ残すのがベスト。
            
            if truncate_facet:
                # 切り詰め後のバイト長
                truncated_byte_len = len(post_text.encode('utf-8')) - len("…Read more".encode('utf-8'))
                # 範囲内のfacetのみ残す
                valid_facets = []
                for f in facets:
                    if f['index']['byteEnd'] <= truncated_byte_len:
                        valid_facets.append(f)
                facets = valid_facets
        else:
            facets = create_facets(post_text)
        
        if truncate_facet:
            if facets:
                facets.append(truncate_facet)
            else:
                facets = [truncate_facet]
        
        # 引用ツイート処理
        if request.quotedTweetId:
            logger.info(f"引用ツイート処理: {request.quotedTweetId}")
            quoted_post = history_db.get_post(request.quotedTweetId)
            
            if quoted_post:
                logger.info("引用元ツイートのBluesky投稿が見つかりました")
                quoted_uri, quoted_cid = quoted_post
                
                # 引用レコードを作成
                record_embed = models.AppBskyEmbedRecord.Main(
                    record=models.ComAtprotoRepoStrongRef.Main(
                        uri=quoted_uri,
                        cid=quoted_cid
                    )
                )
                
                if embed:
                    # 既に画像や動画がある場合は RecordWithMedia を使用
                    logger.info("メディア付き引用投稿")
                    embed = models.AppBskyEmbedRecordWithMedia.Main(
                        media=embed,
                        record=record_embed
                    )
                else:
                    # テキストのみの場合は Record を使用
                    logger.info("テキストのみ引用投稿")
                    embed = record_embed
            else:
                logger.warning("引用元ツイートがBlueskyに転送されていないか、見つかりません。通常のリンクカードとして処理します。")

        logger.info(f"投稿実行: text_length={len(post_text)}, graphemes={count_graphemes(post_text)}, has_embed={bool(embed)}")
        response = client.send_post(
            text=post_text,
            facets=facets,
            embed=embed
        )
        
        logger.info(f"投稿成功: {response.uri}")
        
        # 投稿履歴を保存
        tweet_id = request.tweetUrl.split('/')[-1]
        history_db.save_post(tweet_id, response.uri, response.cid)
        
        return {
            "status": "success",
            "uri": response.uri,
            "cid": response.cid
        }
        
    except Exception as e:
        logger.error(f"投稿エラー: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/webhook/ifttt")
async def webhook_ifttt(request: IFTTTRequest):
    """IFTTTからのWebhookを受け取るエンドポイント (最適化版)"""
    try:
        logger.info("-" * 50)
        logger.info(f"IFTTT Webhook受信: {request.handle}")
        
        # 1. ツイート本文から末尾のt.coリンクを削除 (メディア用URLなどのため)
        clean_text = re.sub(r'https:\/\/t\.co\/[a-zA-Z0-9]+$', '', request.text).strip()
        if clean_text != request.text:
            logger.info(f"末尾のt.coリンクを削除しました: {request.text} -> {clean_text}")
            
        # 2. 本文中の残りのt.coリンクを展開
        clean_text = expand_tco_links_in_text(clean_text)
        
        # ツイートURLをそのまま使用 (空白除去)
        tweet_url = request.url.strip()
        # IFTTTの仕様で <<< >>> で囲まれている場合があるので除去
        tweet_url = tweet_url.replace('<<<', '').replace('>>>', '').strip()
        logger.info(f"解析対象URL: {tweet_url}")
        
        # 3. メディア情報の抽出 (yt-dlp使用)
        loop = asyncio.get_event_loop()
        media_info = await loop.run_in_executor(None, extract_media_info, tweet_url)
        
        # yt-dlpが失敗した場合はOGPフォールバック
        if not media_info:
            logger.info("yt-dlp失敗のため、OGP情報を使用します")
            ogp_data = fetch_ogp_data(tweet_url)
            media_info = {
                'type': 'card',
                'media_urls': [],
                'thumbnail': ogp_data.get('image'),
                'author': {}
            }
            # OGPタイトルから投稿者情報を抽出 "Name (@screen_name) on X"
            title = ogp_data.get('title', '')
            match = re.search(r'(.+?)\s\(@([A-Za-z0-9_]+)\)', title)
            if match:
                media_info['author']['name'] = match.group(1)
                media_info['author']['screen_name'] = match.group(2)
        
        content_type = media_info.get('type', 'card')
        card_short_url = tweet_url
        
        # 投稿者情報の構築
        author_info = {
            "name": "Unknown",
            "screen_name": "unknown",
            "avatar_url": ""
        }
        
        # 取得できた情報で上書き
        if media_info.get('author'):
            extracted_author = media_info['author']
            if extracted_author.get('name'):
                author_info['name'] = extracted_author['name']
            if extracted_author.get('screen_name'):
                author_info['screen_name'] = extracted_author['screen_name']
                if author_info['name'] == "Unknown":
                    author_info['name'] = author_info['screen_name']
        
        # メディアなしの場合のロジック分岐
        if content_type == 'card':
            # 本文からURLを抽出
            urls = extract_urls(clean_text)
            if urls:
                # URLがある場合 -> そのURLのリンクカード (1つ目を使用)
                target_url = urls[0]['url']
                logger.info(f"メディアなし・URLあり: {target_url} のリンクカードを作成します")
                card_short_url = target_url
            elif media_info.get('thumbnail'):
                 # URLはないがサムネイル（OGP画像など）がある場合 -> ツイート自体のリンクカード（画像あり）
                 logger.info("メディアなし・URLなし・サムネイルあり: ツイートのリンクカードを作成します")
                 card_short_url = tweet_url
            else:
                # URLもサムネイルもない場合 -> ツイート自体のリンクカード (サムネイルなし)
                # post_to_blueskyで contentType='text' として扱うことでサムネイルなしリンクカードになる
                logger.info("メディアなし・URLなし・サムネイルなし: テキストのみの投稿として処理します")
                content_type = 'text'
                card_short_url = None

        # PostRequestオブジェクトの構築
        post_request = PostRequest(
            handle=request.handle,
            appPassword=request.appPassword,
            text=clean_text,
            tweetUrl=tweet_url,
            author={
                "fullname": author_info['name'], # create_tweet_link_cardで使われるキーに合わせる
                "username": author_info['screen_name'],
                "avatar_url": ""
            },
            contentType=content_type,
            mediaUrls=media_info.get('media_urls', []),
            videoThumbnail=media_info.get('thumbnail'),
            cardShortUrl=card_short_url,
            facets=None,
            quotedTweetId=None
        )
            
        # 投稿ロジック呼び出し
        return await post_to_bluesky(post_request)
        
    except Exception as e:
        logger.error(f"IFTTT Webhookエラー: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/")
async def root():
    """ヘルスチェック"""
    return {
        "status": "running",
        "service": "Twitter-IFTTT-Bluesky v1.00",
        "uptime_hours": round((time.time() - server_start_time) / 3600, 2),
        "current_log_file": log_filename
    }


@app.get("/health")
async def health():
    """ヘルスチェック"""
    return {"status": "ok"}


if __name__ == "__main__":
    logger.info("=" * 50)
    logger.info("Twitter-IFTTT-Bluesky v1.00 起動")
    logger.info("URL: http://localhost:5000")
    logger.info("=" * 50)
    
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=5000,
        log_level="info"
    )
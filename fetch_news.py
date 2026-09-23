# -*- coding: utf-8 -*-
"""国际新闻抓取 v5.4（重要性筛选 + 全文优先）
- 媒体: 五国15家主流媒体(含栏目RSS)
- 选稿: ①社论全收(op-ed) ②时政要闻≥50%(领导人/政府议会/涉华/国际大事) ③财经科技为辅 ④无聊社会新闻一律丢弃
- 全文: 对候选条目抓文章页正文, 抓不到全文的降权少放
- 翻译: 百度→有道(失效跳过)→MyMemory 三级备用, 仅翻新条目
- translate_by="api" 标记; 本地豆包AI翻译优先, 本脚本只兜底(不重翻AI已翻的)
- 踩坑记录(不要再犯):
  1. RSS正文可能在content字段, 必须兜底提取; 正文<80字符丢弃
  2. feedparser.parse无超时会卡死, 用requests下载+超时
  3. 选稿不能按时间取前N条(德媒霸屏), 时政池优先+按国家轮流
  4. 有道网页接口2026-09起失效, 失败快速跳过
  5. 社论/时政靠多语言关键词判定, 无聊词(娱乐/犯罪/交通/天气/健康)硬过滤; 重大灾难保留
  6. 全文抓取: 多路选择器提<p>, 失败降权, 不做硬失败
"""
import os, re, json, base64, time, hashlib, random, sys, threading
import xml.etree.ElementTree as ET
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(line_buffering=True)
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor
import urllib.request
import urllib.parse
import feedparser
import requests
from bs4 import BeautifulSoup

# v9: 懒安装 google-news-api(解码Google链接) / trafilatura(正文提取); 云端自动装, 本地失败降级
_GN = None
_TR = None
def _lazy_load():
    global _GN, _TR
    import subprocess
    if _GN is None:
        try:
            import google_news_api
            _GN = google_news_api
        except Exception:
            try:
                subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet",
                                       "google-news-api", "trafilatura"], timeout=200)
                import google_news_api
                _GN = google_news_api
            except Exception:
                _GN = False
    if _TR is None:
        try:
            import trafilatura
            _TR = trafilatura
        except Exception:
            try:
                subprocess.check_call([sys.executable, "-m", "pip", "install", "--quiet",
                                       "trafilatura"], timeout=120)
                import trafilatura
                _TR = trafilatura
            except Exception:
                _TR = False

_GN_client = None
def decode_google_urls(urls):
    """批量解码 Google News RSS 链接 -> 真实媒体URL(顺序对应, 失败为None)"""
    if not urls:
        return []
    global _GN_client
    try:
        _lazy_load()
        if not _GN:
            return [None] * len(urls)
        if _GN_client is None:
            _GN_client = _GN.GoogleNewsClient(language="en", country="US")
        out = []
        for u in urls:
            try:
                d = _GN_client.decode_url(u)
                r = (d or {}).get("url") if isinstance(d, dict) else d
                if r and "news.google.com" not in str(r):
                    out.append(str(r))
                else:
                    out.append(None)
            except Exception:
                out.append(None)
        return out
    except Exception:
        return [None] * len(urls)

_wayback_calls = [0]
WAYBACK_CALL_LIMIT = 40
def wayback_url(url):
    """Wayback Machine 快照查寻: 返回最近快照URL或None (免费无key, 单轮限量)"""
    if _wayback_calls[0] >= WAYBACK_CALL_LIMIT:
        return None
    _wayback_calls[0] += 1
    try:
        r = requests.get("https://archive.org/wayback/available",
                         params={"url": url, "timestamp": str(int(time.time()))},
                         timeout=15, headers={"User-Agent": UA})
        if r.status_code == 200:
            js = r.json()
            cl = (js.get("archived_snapshots") or {}).get("closest") or {}
            u = cl.get("url") or ""
            return u if u else None
    except Exception:
        pass
    return None

GITEE_TOKEN = os.environ["GITEE_TOKEN"]
GITEE_OWNER = "t7950288"
GITEE_REPO = "news"
GITEE_PATH = "news.json"  # v8.4: 单文件100条全量(网页翻页用); 手机端APK取前50
CST = timezone(timedelta(hours=8))
MIN_BODY = 80        # RSS导语最小长度
MAX_BODY = 8000      # 原文全文保留上限(Edge右键翻译, 不翻译了)
TARGET = 42          # v8: 热榜前42条
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

# 15家媒体白名单 + 去重权威分
WHITELIST = {
    ("UK", "BBC"), ("UK", "卫报"), ("UK", "每日邮报"),
    ("US", "CNN"), ("US", "NPR"), ("US", "纽约时报"), ("US", "华尔街日报"),
    ("FR", "世界报"), ("FR", "费加罗报"),
    ("DE", "世界报"), ("DE", "明镜"), ("DE", "图片报"),
    ("JP", "读卖新闻"), ("JP", "朝日新闻"), ("JP", "NHK"),
}
SOURCE_RANK = {
    "BBC": 0, "CNN": 0, "Reuters": 0, "Associated Press": 0, "AP": 0, "The Associated Press": 0,
    "卫报": 1, "The Guardian": 1, "NPR": 1, "纽约时报": 1, "The New York Times": 1, "华尔街日报": 1,
    "Wall Street Journal": 1, "Bloomberg": 1, "The Economist": 1, "Washington Post": 1, "Financial Times": 1,
    "每日邮报": 2, "Daily Mail": 2, "世界报": 2, "Le Monde": 2, "费加罗报": 2, "Le Figaro": 2,
    "明镜": 2, "Der Spiegel": 2, "图片报": 2, "Bild": 2, "Die Welt": 2, "The Times": 2,
    "读卖新闻": 3, "朝日新闻": 3, "NHK": 3, "NHK World": 3, "Kyodo": 3,
}

# v6 用户指定: 不要五国媒体, 30条全部照搬 Google News 当时主热榜(Top Stories), 不做喜好挑选
FEEDS = [
    ("https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en", "GOOGLE_TOP", "US", "world", True),
    ("https://news.google.com/rss/search?q=China&hl=en-US&gl=US&ceid=US:en", "GOOGLE_CHINA", "CN", "world", True),
]

# Google热门源: 真实媒体名 -> 国家
GOOGLE_SKIP_SOURCES = {
    "game informer", "eurogamer", "ign", "kotaku", "polygon", "gamerant",
    "vogue", "elle", "cosmopolitan", "tmz", "people", "us weekly",
    "e! online", "hollywood reporter", "variety", "deadline",
    "mirror", "the sun", "daily star", "metro", "ok! magazine", "gq",
    "marie claire", "glamour", "refinery29", "buzzfeed", "mashable",
    "the verge", "wired", "techcrunch", "engadget", "arstechnica",
    "motorsport.com", "espn", "sky sports", "formula 1", "f1", "bleacher report",
    "sporting news", "the athletic", "sports illustrated", "talksport",
    "cnet", "gizmodo", "toms hardware", "pc gamer", "digital trends",
    "screen rant", "comicbook", "cinemablend", "gamingbolt",
}

GOOGLE_COUNTRY = {
    "bbc": "UK", "the guardian": "UK", "guardian": "UK", "dailymail": "UK", "daily mail": "UK",
    "the times": "UK", "telegraph": "UK", "independent": "UK", "sky news": "UK",
    "reuters": "UK", "the economist": "UK", "financial times": "UK", "ft": "UK",
    "ap": "US", "associated press": "US", "the associated press": "US",
    "the new york times": "US", "new york times": "US", "nytimes": "US",
    "wall street journal": "US", "wsj": "US", "cnn": "US", "nbc news": "US", "nbc": "US",
    "fox news": "US", "npr": "US", "washington post": "US", "bloomberg": "US",
    "los angeles times": "US", "usa today": "US", "newsweek": "US", "time": "US",
    "forbes": "US", "cnbc": "US", "politico": "US", "axios": "US", "the hill": "US",
    "abc news": "US", "cbs news": "US", "the verge": "US", "ars technica": "US",
    "le monde": "FR", "le figaro": "FR", "france 24": "FR", "france24": "FR", "afp": "FR",
    "liberation": "FR", "les echos": "FR", "le parisien": "FR", "bfm tv": "FR",
    "ouest-france": "FR", "la croix": "FR",
    "der spiegel": "DE", "spiegel": "DE", "die welt": "DE", "welt": "DE",
    "dw": "DE", "deutsche welle": "DE", "zeit": "DE", "die zeit": "DE", "faz": "DE",
    "handelsblatt": "DE", "bild": "DE", "sueddeutsche zeitung": "DE", "tagesschau": "DE",
    "nhk": "JP", "nhk world": "JP", "kyodo": "JP", "japan times": "JP",
    "asahi": "JP", "asahi shimbun": "JP", "yomiuri": "JP", "yomiuri shimbun": "JP",
    "mainichi": "JP", "nikkei": "JP", "japan today": "JP",
    "al jazeera": "UK", "euronews": "UK", "scmp": "UK", "south china morning post": "UK",
    "the hindu": "UK", "times of india": "UK", "straits times": "UK", "cbc": "UK",
}

COUNTRY_LANG = {"UK": "en", "US": "en", "FR": "fr", "DE": "de", "JP": "ja"}

# ============ 重要性判定 (多语言) ============
# 社论/观点标记 -> op-ed, 全收
OPED_MARKERS = [
    "editorial", "opinion", "comment", "analysis", "leader", "view",
    "社説", "社说", "論説", "論説委員", "社論", "评论", "評論", "觀點", "观点",
    "tribune", "chronique", "éditorial", "editoriale", "meinung", "kommentar", "gastbeitrag",
    "コラム", "論壇", "論点",
]

# 时政要闻(硬保留) -> world: 各国领导人/政府议会/涉华/国际大事
HARD_WORLD = [
    # 国际大事
    "russia", "ukraine", "putin", "zelensky", "moscow", "kiev", "kyiv",
    "israel", "iran", "netanyahu", "hamas", "hezbollah", "gaza", "palestin",
    "united nations", "un security council", "u.n.", "nato", "european union", "eu ",
    "united nations", "g7", "g20", "world bank", "imf", "wto", "nuclear", "missile",
    "war", "ceasefire", "cease-fire", "sanction", "embargo", "invasion", "strike",
    "peace", "negotiation", "talks", "deal", "treaty", "summit", "diplomacy", "ambassador",
    "北朝鲜", "朝鲜", "核", "导弹", "导弹", "停火", "制裁", "峰会", "谈判", "协议", "战争",
    "ロシア", "ウクライナ", "プーチン", "イスラエル", "イラン", "ガザ", "国連", "安保理",
    "停戦", "制裁", "核", "ミサイル", "首脳会談", "戦争", "交渉", "協定",
    # 涉华
    "china", "chinese", "beijing", "xi jinping", "taiwan", "hong kong", "taipei strait",
    "中美", "中欧", "中俄", "中日", "中国", "习近平", "北京", "台湾", "香港",
    "中国", "習近平", "台湾", "香港", "米中", "日米", "日中",
    # 选举/政府/议会/领导人
    "election", "president", "prime minister", "chancellor", "government", "parliament",
    "congress", "senate", "house of representatives", "cabinet", "minister", "vote",
    "选举", "总统", "总理", "首相", "政府", "议会", "国会", "内阁", "选举",
    "選挙", "大統領", "総理", "首相", "政府", "議会", "国会", "内閣", "閣僚", "投票",
    # 各国政要/党魁
    "trump", "biden", "harris", "starmer", "macron", "le pen", "merz", "scholz",
    "modi", "netanyahu", "erdogan", "zelensky", "putin", "kim jong", "yoon", "trump",
    "马克龙", "默茨", "斯塔默", "特朗普", "拜登", "特朗普", "尹锡悦", "石破",
    "トランプ", "バイデン", "マクロン", "石破", "韓国", "尹", "金正恩",
    # 重大国际事件/灾害(用户明确保留)
    "earthquake", "typhoon", "hurricane", "flood", "wildfire", "tsunami", "landslide",
    "地震", "台风", "台风", "洪水", "山火", "海啸", "火山", "地震", "台風", "洪水", "津波",
]

# 财经/科技(软保留) -> finance/tech
SOFT_KEYS = [
    "economy", "economic", "inflation", "interest rate", "central bank", "fed", "ecb",
    "gdp", "stock", "market", "oil", "gold", "tariff", "trade", "export", "import",
    "company", "corporate", "earnings", "profit", "bank", "finance", "recession",
    "经济", "通胀", "央行", "股市", "市场", "油价", "关税", "贸易", "公司", "财报", "降息", "加息",
    "経済", "インフレ", "金利", "中央銀行", "株価", "市場", "原油", "関税", "貿易", "決算", "企業",
    "ai", "artificial intelligence", "chip", "semiconductor", "technology", "tech",
    "apple", "google", "microsoft", "nvidia", "openai", "tesla", "samsung", "spacex", "robot",
    "人工智能", "芯片", "半导体", "科技", "苹果", "谷歌", "微软", "英伟达", "火箭", "机器人",
    "人工知能", "半導体", "チップ", "テクノロジー", "アップル", "グーグル", "マイクロソフト", "ロボット",
]

# 重大灾难关键词: 命中即使带天气/事故字样也放行
DISASTER_KEYS = [
    "earthquake", "typhoon", "hurricane", "flood", "wildfire", "tsunami", "landslide", "volcano", "eruption",
    "地震", "台风", "台风", "洪水", "山火", "海啸", "火山", "地震", "台風", "洪水", "津波", "噴火",
]

# 无聊社会新闻(硬过滤): 娱乐/犯罪/交通/天气/健康/体育/生活
SKIP_KEYS = {
    "en": ["weather", "cloudy", "sunny", "forecast", "motorway", "road closure",
           "football", "soccer", "basketball", "tennis", "golf", "cricket", "rugby",
           "premier league", "champions league", "match", "game result", "score",
           "celebrity", "actor", "actress", "movie", "film", "singer", "concert",
           "hollywood", "entertainment", "taylor swift", "tv ratings", "shopping",
           "collagen", "discount code", "penis", "ufo", "alien", "nepo baby",
           "murder", "stabbing", "robbery", "burglary", "car crash", "car crash",
           "traffic accident", "house fire", "lottery", "recipe", "diet",
           "weight loss", "blood pressure", "vitamin", "health tips", "yoga",
           "garden", "pets", "dogs ", "cats ", "horoscope", "quiz"],
    "de": ["wetter", "unfall", "verkehrsunfall", "fussball", "fußball", "bundesliga",
           "tennis", "schauspieler", "promi", "musik", "konzert", "film", "fernsehen",
           "tv-sendung", "penis", "ufo", "alien", "kosmetik", "abnehmen",
           "shopping", "mord", "raub", "unfall", "wetter", "rezept", "diät",
           "horoskop", "haustier", "säugling", "babys", "fussball-wm", "fußball-wm"],
    "fr": ["météo", "meteo", "accident", "circulation", "football", "ligue 1",
           "tennis", "acteur", "actrice", "star", "concert", "musique", "film",
           "télévision", "television", "temps", "meurtre", "braquage", "recette",
           "régime", "horoscope", "animaux"],
    "ja": ["天気", "事故", "サッカー", "野球", "テニス", "ゴルフ", "芸能", "俳優",
           "映画", "音楽", "コンサート", "アイドル", "レシピ", "ダイエット",
           "占い", "ペット", "殺人", "強盗", "交通", "天気予報"],
}


SKIP_URL_PARTS = [
    "/kultur/", "/panorama/", "/vermischtes/", "/tvshowbiz/", "/femail/", "/sport",
    "/culture/", "/film/", "/music/", "/books/", "/lifeandstyle/", "/football/",
    "/faits-divers/", "/people/", "/entertainment/", "/movies/", "/celebrity/",
    "/health/", "/food/", "/artanddesign/", "/games/", "/technology/",
    # 科学科普/健康生活(重大科技大事标题含AI/芯片等科技词会经SKIP_KEYS外的SOFT命中保留, 此处仅拦普通科普)
    "/wissenschaft/", "/gesundheit/",
]


def skip_news(title, desc, lang, url=""):
    t = (title + " " + desc).lower()
    if any(k in t for k in DISASTER_KEYS):
        return False  # 重大灾难保留
    u = (url or "").lower()
    for part in SKIP_URL_PARTS:
        if part in u:
            # 娱乐/生活/体育版块: 无条件丢弃(重大灾难已在上方DISASTER_KEYS放行)。
            # 不做HARD_WORLD放行——正文里的deal/war/talks等泛词会把八卦误判为时政。
            # 仅当标题含具体政要/国家专名时视为政要动态放行。
            head = t[:160]
            strong = ["trump", "putin", "zelensky", "macron", "merz", "starmer", "biden",
                      "harris", "netanyahu", "erdogan", "modi", "kim jong", "yoon", "xi jinping",
                      "china", "chinese", "beijing", "taiwan", "ukraine", "russia", "moscow",
                      "israel", "iran", "gaza", "nato", "united nations", "联合国", "习近平",
                      "中国", "台湾", "俄", "乌", "特朗普", "普京", "泽连斯基", "马克龙", "默茨",
                      "トランプ", "プーチン", "習近平", "中国", "台湾", "ウクライナ", "ロシア"]
            if any(k in head for k in strong):
                return False
            return True
    keys = SKIP_KEYS.get(lang, []) + SKIP_KEYS.get("en", [])
    return any(k in t for k in keys)


def classify(title, desc, lang, hint):
    """返回 (category, weight); weight小=优先; 返回 None = 丢弃"""
    t = (title + " " + desc).lower()
    for m in OPED_MARKERS:
        if m in t:
            return "op-ed", 0
    for m in HARD_WORLD:
        if m in t:
            return "world", 1
    if hint in ("finance", "tech"):
        for m in SOFT_KEYS:
            if m in t:
                return hint, 2
        return hint, 3  # 财经科技栏目可信, 保留但降权
    if lang == "ja":
        return "world", 1  # 日文源默认时政待遇(日本媒体标题本身即要闻)
    # 普通world栏目无关键词命中 -> 降权(宁缺毋滥)
    return "world", 4


def clean_gn_title(title):
    """Google News标题清洗: 去掉' - 媒体名'后缀, 返回(标题, 媒体名)"""
    for sep in (" - ", " – ", " — "):
        if sep in title:
            parts = title.rsplit(sep, 1)
            media = parts[-1].strip()
            # 媒体名通常短(<=40字)且不以句尾标点结尾
            if 0 < len(media) <= 40 and not media.endswith((".", "。", "!", "？", "?", "…")):
                return parts[0].strip(), media
    return title, ""


def clean_html(html):
    if not html:
        return ""
    soup = BeautifulSoup(html, "lxml")
    return soup.get_text(separator="\n").strip()


DIAG = {"resolve_ok": 0, "resolve_page": 0, "fetch_ok": 0, "jina_ok": 0,
         "traf_ok": 0, "amp_ok": 0, "wayback_ok": 0, "decode_ok": 0,
        "agency_search_ok": 0, "agency_fetch_ok": 0, "http_err": 0, "parse_empty": 0}


def _log(*args):
    print(*args, flush=True)


PAYWALL_MARKERS = [
    "cet article est réservé aux abonnés",
    "pour sauvegarder un article vous devez être connecté",
    "you have reached your article limit",
    "this article is reserved for subscribers",
    "sie können den artikel leider nicht mehr aufrufen",
    "sie haben bereits ein digital-abo",
    "um spiegel+ außerhalb",
    "subscribe to read", "log in to read", "sign in to continue",
    "get full access", "you must be logged in",
]


def _fetch_jina(url):
    """jina reader 兜底: 服务端渲染跟随重定向, 返回markdown文本; 429限流重试2次"""
    for _att in range(3):
        try:
            r = requests.get("https://r.jina.ai/" + url, timeout=25,
                             headers={"User-Agent": UA, "Accept": "text/plain"})
            if r.status_code == 429:
                time.sleep(2.5)
                continue
            if r.status_code != 200:
                return None
            txt = r.text or ""
            idx = txt.find("---")
            if idx > 0:
                txt = txt[idx + 3:]
            lines = [ln.strip() for ln in txt.split("\n") if ln.strip()]
            paras = [ln for ln in lines if len(ln) > 25 and not ln.startswith(
                ("#", "![", "[", ">", "*", "-", "|", "```"))]
            body = "\n".join(paras)
            if len(body) >= 200:
                return body[:MAX_BODY]
        except Exception:
            pass
    return None


def fetch_full_text(url, lang):
    """抓文章页全文; 成功返回正文(最多MAX_BODY), 失败返回None (v9: trafilatura优先 + AMP变体)"""
    try:
        _lazy_load()
        if _TR:
            hd = _TR.fetch_url(url)
            if hd:
                txt = _TR.extract(hd, include_comments=False, include_tables=False)
                if txt:
                    paras = [p.strip() for p in txt.split("\n") if len(p.strip()) > 25]
                    text = "\n".join(paras)[:MAX_BODY]
                    if len(text) >= 200:
                        DIAG["traf_ok"] += 1
                        return text
    except Exception:
        pass
    # AMP / 打印版变体
    for v in ("?output=1", "?amp=1"):
        try:
            r = requests.get(url + v, timeout=12, headers={"User-Agent": UA})
            if r.status_code == 200 and "news.google.com" not in (r.url or ""):
                soup = BeautifulSoup(r.text, "lxml")
                for tag in soup(["script", "style", "noscript", "nav", "aside", "header", "footer", "form", "iframe"]):
                    tag.decompose()
                paras = [p.get_text(" ", strip=True) for p in soup.find_all("p")]
                text = "\n".join(p for p in paras if len(p) > 25)[:MAX_BODY]
                if len(text) >= 200:
                    DIAG["amp_ok"] += 1
                    return text
        except Exception:
            pass
    sels = ["article", "[itemprop='articleBody']", "[class*='article-body']",
            "[class*='story-body']", "[class*='article__body']", "[class*='article-content']",
            "[class*='post-content']", "[class*='content-body']", "[class*='story-content']",
            "[class*='article_text']", "[class*='mol-para-with-font']",
            "[class*='fig-article']", "[class*='c-article']", "[class*='news_text']",
            "[id*='news_text']", "[data-component='text-block']", "main", "body"]
    for attempt in range(2):
        try:
            r = requests.get(url, timeout=15, headers={"User-Agent": UA})
            if r.status_code != 200:
                DIAG["http_err"] += 1
                if attempt == 0:
                    time.sleep(1)
                continue
            soup = BeautifulSoup(r.text, "lxml")
            for tag in soup(["script", "style", "noscript", "nav", "aside", "header", "footer", "form", "iframe"]):
                tag.decompose()
            best = ""
            for sel in sels:
                node = soup.select_one(sel)
                if not node:
                    continue
                paras = [p.get_text(" ", strip=True) for p in node.find_all("p")]
                text = "\n".join(p for p in paras if len(p) > 25)
                if len(text) > len(best):
                    best = text
            if len(best) >= 200:
                low = best.lower()
                pay = [m for m in PAYWALL_MARKERS if m in low]
                if pay:
                    keep = [ln for ln in best.split("\n")
                            if not any(m in ln.lower() for m in PAYWALL_MARKERS)]
                    clean = "\n".join(keep).strip()
                    if len(clean) < 200:
                        return None  # 正文被付费墙吞掉, 视为抓不到全文
                    return clean[:MAX_BODY]
                return best[:MAX_BODY]
            DIAG["parse_empty"] += 1
        except Exception:
            pass
        if attempt == 0:
            time.sleep(1)
    j = _fetch_jina(url)
    if j:
        DIAG["jina_ok"] += 1
        return j
    return None


def fetch_one(url, source, country, hint, is_google=False):
    arts = []
    is_china = source == "GOOGLE_CHINA"
    max_per = 30  # v6 照搬当时热榜前30
    urls = url if isinstance(url, list) else [url]
    content = None
    now = datetime.now(CST)
    for u in urls:
        for attempt in range(3):
            try:
                r = requests.get(u, timeout=12, headers={"User-Agent": UA})
                if r.status_code == 200:
                    content = r.content
                    break
                elif r.status_code == 429:
                    print(f"  {source}: HTTP 429, retry {attempt+1}")
                    time.sleep(3 * (attempt + 1))
                else:
                    print(f"  {source}: HTTP {r.status_code} ({u.split('/')[2]})")
                    break
            except Exception as e:
                print(f"  {source}: ERR {str(e)[:60]}")
                break
        if content:
            break
    if not content:
        return arts
    try:
        d = feedparser.parse(content)
    except Exception as e:
        print(f"  {source}: PARSE ERR {str(e)[:60]}")
        return arts
    lang = COUNTRY_LANG.get(country, "en")
    for e in d.entries[:max_per]:
        title, media = clean_gn_title(getattr(e, "title", ""))
        title = title.strip()
        link = getattr(e, "link", "").strip()
        if not title or not link:
            continue
        if is_google:
            # Google热榜: 媒体名取title后缀, 国家按媒体映射 (v6 全收, 不挑媒体)
            if not media:
                media = (getattr(e, "source", None) and getattr(e.source, "title", "")) or ""
            media = media.strip()
            if media:
                source = media
                country = GOOGLE_COUNTRY.get(media.lower(), country)
                lang = COUNTRY_LANG.get(country, "en")
        raw_summary = getattr(e, "summary", "") or getattr(e, "description", "")
        if is_google and raw_summary:
            _links = []
            try:
                _soup = BeautifulSoup(raw_summary, "lxml")
                for _a in _soup.find_all("a"):
                    _h = (_a.get("href") or "").strip()
                    _t = (_a.get_text(strip=True) or "").strip()
                    if _h and _t:
                        _links.append((_t, _h))
            except Exception:
                _links = []
        else:
            _links = []
        desc = clean_html(raw_summary)
        # RSS自带全文(content:encoded)优先: 摘要太短时取content字段的完整正文
        if len(desc) < 300:
            for c in (getattr(e, "content", None) or []):
                full = clean_html(c.get("value", ""))
                if len(full) > len(desc):
                    desc = full
                if len(desc) >= 300:
                    break
        if not is_google and skip_news(title, desc, lang, link):
            continue
        cls = classify(title, desc, lang, hint)
        if cls is None:
            if is_google:
                cat, weight = "general", 5  # v6 全收: 判不出类别也照搬
            else:
                continue
        else:
            cat, weight = cls
        min_body = 30 if country == "JP" else MIN_BODY
        if len(desc) < min_body:
            continue
        pub = None
        for k in ("published_parsed", "updated_parsed"):
            t = getattr(e, k, None)
            if t:
                pub = datetime(*t[:6], tzinfo=timezone.utc).astimezone(CST).isoformat()
                break
        if not pub:
            pub = datetime.now(CST).isoformat()
        # 未来时间(源站pubDate时区错乱/预排)直接丢弃
        try:
            if datetime.fromisoformat(pub) > now + timedelta(minutes=15):
                continue
        except Exception:
            pass
        arts.append({
            "title_orig": title,
            "title_zh": title,
            "source": source,
            "country": country,
            "category": cat,
            "published_at": pub,
            "summary_zh": "",
            "content_orig": desc[:MAX_BODY],
            "content_zh": "",
            "url": link,
            "_lang": lang,
            "_w": weight,
            "_full": False,
            "_google": is_google,
            "_china": is_china,
            "_src_links": _links if is_google else [],
        })
    print(f"  {source}: {len(arts)} ok")
    return arts


def gitee_get():
    # v8.4: 读 news.json(全量100条)
    for path in (GITEE_PATH,):
        try:
            url = (f"https://gitee.com/api/v5/repos/{GITEE_OWNER}/{GITEE_REPO}/contents/{path}"
                   f"?ref=master&access_token={GITEE_TOKEN}")
            with urllib.request.urlopen(urllib.request.Request(url), timeout=15) as r:
                info = json.loads(r.read())
            data = json.loads(base64.b64decode(info["content"]).decode("utf-8"))
            return data, info["sha"]
        except Exception:
            continue
    raise RuntimeError("no gitee file available")


def gitee_put(data, sha, tries=4):
    # v9.5: 上传超时修复——①PUT超时90s ②超时/URLError也重试(之前只重试HTTP 400/409/404,
    #       超时异常直接raise导致云端每轮UPLOAD ERR却显示success, 数据卡住不更新)
    for i in range(tries):
        url_get = (f"https://gitee.com/api/v5/repos/{GITEE_OWNER}/{GITEE_REPO}/contents/{GITEE_PATH}"
                   f"?ref=master&access_token={GITEE_TOKEN}")
        try:
            with urllib.request.urlopen(urllib.request.Request(url_get), timeout=20) as r:
                sha = json.loads(r.read())["sha"]
        except Exception:
            sha = None
        body_text = json.dumps(data, ensure_ascii=False)
        b64 = base64.b64encode(body_text.encode("utf-8")).decode()
        body = {"access_token": GITEE_TOKEN, "content": b64, "message": "auto update"}
        if sha:
            body["sha"] = sha  # v8.3: 文件不存在(sha=None)时不带sha, 避免400
        url = f"https://gitee.com/api/v5/repos/{GITEE_OWNER}/{GITEE_REPO}/contents/{GITEE_PATH}"
        req = urllib.request.Request(url, data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json"}, method="PUT")
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                json.loads(r.read())
            return True
        except urllib.error.HTTPError as e:
            if e.code in (400, 409, 404) and i < tries - 1:
                time.sleep(6)
                continue
            raise
        except Exception as e:
            # 超时/连接错误: 等待后重试
            print(f"  gitee put retry {i+1}/{tries}: {str(e)[:80]}")
            if i < tries - 1:
                time.sleep(8)
                continue
            raise


def gitee_put_phone(data):
    """v8.1: 手机端 news.json = 最新50条"""
    url_get = (f"https://gitee.com/api/v5/repos/{GITEE_OWNER}/{GITEE_REPO}/contents/news.json"
               f"?ref=master&access_token={GITEE_TOKEN}")
    sha = None
    try:
        with urllib.request.urlopen(urllib.request.Request(url_get), timeout=15) as r:
            sha = json.loads(r.read())["sha"]
    except Exception:
        sha = None
    body_text = json.dumps(data, ensure_ascii=False)
    b64 = base64.b64encode(body_text.encode("utf-8")).decode()
    body = {"access_token": GITEE_TOKEN, "content": b64, "message": "auto update phone"}
    if sha:
        body["sha"] = sha
    url = f"https://gitee.com/api/v5/repos/{GITEE_OWNER}/{GITEE_REPO}/contents/news.json"
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="PUT")
    with urllib.request.urlopen(req, timeout=30) as r:
        json.loads(r.read())


def pick_news(arts, target=TARGET):
    """v6 用户指定: 全部照搬 Google 当时热榜, 不做喜好挑选; 保持时间倒序取前target"""
    return arts[:target]


# ===== v7: 通讯社/免费媒体全文优先 =====
AGENCY_NAMES = ["associated press", "ap news", "ap ", "reuters", "afp", "agence france"]
FREE_NAMES = ["bbc", "the guardian", "guardian", "npr", "al jazeera", "cbs news", "cnbc",
              "pbs", "dw", "dw.com", "sky news", "the independent", "usa today", "nbc news",
              "abc news", "yahoo finance", "yahoo", "business insider", "the verge", "fortune",
              "fox news", "axios", "time", "huffpost", "huffington post", "new york post",
              "washington post", "daily mail", "the telegraph", "telegraph", "politico",
              "the hill", "newsweek", "los angeles times", "la times", "bloomberg",
              "cnn", "wsj", "wall street journal", "new york times", "npr.org"]
SOURCE_DOMAIN = {
    "ap": "apnews.com", "ap news": "apnews.com", "associated press": "apnews.com",
    "reuters": "reuters.com", "afp": "afp.com", "agence france": "afp.com",
    "bbc": "bbc.com", "the guardian": "theguardian.com", "guardian": "theguardian.com",
    "npr": "npr.org", "al jazeera": "aljazeera.com", "cbs news": "cbsnews.com",
    "cnbc": "cnbc.com", "pbs": "pbs.org", "dw": "dw.com", "sky news": "news.sky.com",
    "the independent": "independent.co.uk", "usa today": "usatoday.com",
    "nbc news": "nbcnews.com", "abc news": "abcnews.go.com", "yahoo finance": "finance.yahoo.com",
    "yahoo": "yahoo.com", "business insider": "businessinsider.com",
    "the verge": "theverge.com", "fortune": "fortune.com",
    "fox news": "foxnews.com", "axios": "axios.com", "time": "time.com",
    "huffpost": "huffpost.com", "huffington post": "huffpost.com",
    "new york post": "nypost.com", "washington post": "washingtonpost.com",
    "daily mail": "dailymail.co.uk", "the telegraph": "telegraph.co.uk",
    "telegraph": "telegraph.co.uk", "politico": "politico.com",
    "the hill": "thehill.com", "newsweek": "newsweek.com",
    "los angeles times": "latimes.com", "la times": "latimes.com",
    "bloomberg": "bloomberg.com", "cnn": "cnn.com",
    "wsj": "wsj.com", "wall street journal": "wsj.com",
    "new york times": "nytimes.com", "npr.org": "npr.org",
}


def _norm_src(s):
    return re.sub(r"[^a-z0-9 ]", "", (s or "").lower()).strip()


def parse_pairs(text):
    """聚合desc -> [(子标题, 媒体名), ...]  格式: 首行主标题, 之后 媒体名->子标题 交替"""
    lines = [ln.strip() for ln in (text or "").split("\n") if ln.strip()]
    pairs = []
    if not lines:
        return pairs
    i = 1
    while i + 1 < len(lines):
        pairs.append((lines[i + 1], lines[i]))  # (子标题, 媒体名)
        i += 2
    if i < len(lines):
        pairs.append((lines[i], ""))
    return pairs


def pick_agency(pairs):
    """按 AP/路透/法新 -> 免费全文媒体 顺序挑选; 返回 (标题, 来源名) 或 None"""
    for name in AGENCY_NAMES:
        for t, src in pairs:
            if _norm_src(src).startswith(name.strip()) or name.strip() in _norm_src(src):
                return t, src
    for name in FREE_NAMES:
        for t, src in pairs:
            if _norm_src(src).startswith(name.strip()) or name.strip() in _norm_src(src):
                return t, src
    return None


def find_domain(source):
    """来源名 -> 媒体域名: 本身是域名直接用; 精确键; 前缀/包含兜底"""
    low = (source or "").lower().strip()
    m = re.match(r'^([a-z0-9-]+\.(?:com|org|net|co\.uk|io))$', low)
    if m:
        return m.group(1)
    n = _norm_src(source)
    if n in SOURCE_DOMAIN:
        return SOURCE_DOMAIN[n]
    for k, dom in SOURCE_DOMAIN.items():
        kn = _norm_src(k)
        if n.startswith(kn) or kn in n:
            return dom
    return None


def _title_sim(a, b):
    """标题相似度: 归一化token重叠率"""
    sa = set(re.sub(r"[^a-z0-9 ]", "", a.lower()).split())
    sb = set(re.sub(r"[^a-z0-9 ]", "", b.lower()).split())
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / max(len(sa), len(sb))


GDELT_DOMAINS = {
    "apnews.com", "reuters.com", "afp.com", "bbc.com", "theguardian.com", "npr.org",
    "cnn.com", "cbsnews.com", "nbcnews.com", "abcnews.go.com", "usatoday.com",
    "independent.co.uk", "yahoo.com", "aljazeera.com", "cnbc.com", "theverge.com",
    "businessinsider.com", "fortune.com", "newsweek.com", "axios.com", "politico.com",
    "thehill.com", "scmp.com", "dw.com", "latimes.com", "wsj.com", "nytimes.com",
    "ft.com", "bloomberg.com", "reutersagency.com",
}
STOPWORDS = set(("the a an and or of in on to for with from by at is are was were be been "
                  "this that these those it its as but not his her their our your new says said "
                  "after before amid over under into about out off up down more most other such "
                  "will would can could should may might has have had do does did live updates "
                  "breaking news update updates").split())
_gdelt_lock = threading.Lock()
_gdelt_last = [0.0]
_gdelt_calls = [0]
GDELT_CALL_LIMIT = 14


PAYWALL_DOMAINS = {
    "nytimes.com", "wsj.com", "ft.com", "bloomberg.com", "washingtonpost.com",
    "telegraph.co.uk", "scmp.com", "latimes.com", "politico.com", "axios.com",
    "businessinsider.com", "reuters.com", "apnews.com", "afp.com",
}

RSS_POOL = [
    ("apnews.com", "https://apnews.com/apf-topnews?format=rss"),
    ("bbc.com", "https://feeds.bbci.co.uk/news/world/rss.xml"),
    ("theguardian.com", "https://www.theguardian.com/world/rss"),
    ("cnn.com", "http://rss.cnn.com/rss/edition_world.rss"),
    ("npr.org", "https://feeds.npr.org/1001/rss.xml"),
    ("cbsnews.com", "https://www.cbsnews.com/latest/rss/main"),
    ("nbcnews.com", "https://feeds.nbcnews.com/nbcnews/public/news"),
    ("abcnews.go.com", "https://abcnews.go.com/abcnews/topstories"),
    ("usatoday.com", "https://www.usatoday.com/arc/outboundfeeds/rss/?outputType=xml"),
    ("independent.co.uk", "https://www.independent.co.uk/news/world/rss"),
    ("cnbc.com", "https://www.cnbc.com/id/100003114/device/rss/rss.html"),
    ("yahoo.com", "https://news.yahoo.com/rss/world"),
    ("aljazeera.com", "https://www.aljazeera.com/xml/rss/all.xml"),
    ("dw.com", "https://rss.dw.com/rdf/rss-en-world"),
    ("pbs.org", "https://www.pbs.org/newshour/feeds/rss/headlines"),
    ("wsj.com", "https://feeds.a.dj.com/rss/RSSWorldNews.xml"),
    ("nytimes.com", "https://rss.nytimes.com/services/xml/rss/nyt/World.xml"),
    ("ft.com", "https://www.ft.com/world?format=rss"),
    ("latimes.com", "https://www.latimes.com/world-nation/rss2.0.xml"),
    ("politico.com", "https://www.politico.com/rss/politicopicks.xml"),
    ("thehill.com", "https://thehill.com/feed/"),
    ("newsweek.com", "https://www.newsweek.com/rss"),
    ("scmp.com", "https://www.scmp.com/rss/91/feed"),
    ("bloomberg.com", "https://feeds.bloomberg.com/markets/news.rss"),
    ("foxnews.com", "https://moxie.foxnews.com/google-publisher/world.xml"),
    ("axios.com", "https://api.axios.com/feed/"),
    ("time.com", "https://time.com/feed/"),
    ("huffpost.com", "https://www.huffpost.com/feeds/news.xml?country=US"),
    ("nypost.com", "https://nypost.com/feed/"),
    ("washingtonpost.com", "https://feeds.washingtonpost.com/rss/world"),
    ("dailymail.co.uk", "https://www.dailymail.co.uk/articles.rss"),
    ("telegraph.co.uk", "https://www.telegraph.co.uk/rss.xml"),
]


def fetch_rss_pool():
    """并行抓取全部RSS源 -> {domain: [(title, url), ...]}"""
    pool = {}

    def one(src):
        dom, url = src
        if not url:
            return
        try:
            r = requests.get(url, timeout=12, headers={"User-Agent": UA,
                                                       "Accept-Language": "en-US,en;q=0.9"})
            if r.status_code != 200:
                return
            root = ET.fromstring(r.content)
            items = []
            for it in root.iter("item"):
                t = (it.findtext("title") or "").strip()
                u = (it.findtext("link") or "").strip()
                if t and u and "news.google.com" not in u:
                    items.append((t, u))
            if items:
                pool[dom] = items
        except Exception:
            pass

    with ThreadPoolExecutor(max_workers=8) as ex:
        list(ex.map(one, RSS_POOL))
    return pool


def match_rss(pool, title, source, scan_all=False):
    """RSS池找真实URL: 默认按source对应媒体匹配(可靠); scan_all=True 时全池扫描兜底(相似度收紧防误配)"""
    dom = find_domain(source)
    tt = set(re.sub(r"[^a-z0-9 ]", "", title.lower()).split()) - STOPWORDS
    if not tt:
        return None
    best = None
    bests = 0.0

    def _scan(items, th, ov):
        nonlocal best, bests
        for rt, ru in items:
            sc = _title_sim(rt, title)
            rts = set(re.sub(r"[^a-z0-9 ]", "", rt.lower()).split()) - STOPWORDS
            overlap = len(tt & rts)
            if sc >= th or (overlap >= ov and len(tt) >= 3):
                if sc > bests:
                    bests = sc
                    best = ru

    if dom and dom in pool:
        _scan(pool[dom], 0.45, 2)
    if not best and scan_all:
        for d, items in pool.items():
            if d == dom:
                continue
            _scan(items, 0.52, 3)
    return best


def _gdelt_query(title):
    words = [w for w in re.sub(r"[^a-z0-9 ]", " ", title.lower()).split() if w not in STOPWORDS]
    picks = words[:3]
    if not picks:
        return None
    return urllib.parse.quote(" ".join('"%s"' % w for w in picks))


def gdelt_lookup(title):
    """L1: GDELT DOC 2.0 全文检索 -> 真实文章URL (官方限流 5s/次, 全局串行, 单轮限量)"""
    if _gdelt_calls[0] >= GDELT_CALL_LIMIT:
        return None
    _gdelt_calls[0] += 1
    q = _gdelt_query(title)
    if not q:
        return None
    with _gdelt_lock:
        wait = 5.0 - (time.time() - _gdelt_last[0])
        if wait > 0:
            time.sleep(wait)
        _gdelt_last[0] = time.time()
    try:
        r = requests.get(
            f"https://api.gdeltproject.org/api/v2/doc/doc?query={q}&mode=artlist&format=json&maxrecords=8&sort=datedesc",
            timeout=20, headers={"User-Agent": UA})
        if r.status_code != 200:
            return None
        for a in (r.json().get("articles") or []):
            u = (a.get("url") or "").strip()
            dom = (a.get("domain") or "").strip().lower()
            if not dom and u:
                try:
                    dom = urllib.parse.urlparse(u).netloc
                except Exception:
                    dom = ""
            if dom not in PAYWALL_DOMAINS and _title_sim((a.get("title") or ""), title) >= 0.45:
                DIAG["gdelt_ok"] = DIAG.get("gdelt_ok", 0) + 1
                return u
    except Exception:
        pass
    return None


def _order_pairs(pairs):
    """(标题,媒体名) 对: 通讯社 -> 免费媒体 -> 其他, 保持优先级"""
    ordered = []
    for name in AGENCY_NAMES:
        for t, s in pairs:
            if name.strip() in _norm_src(s) and (t, s) not in ordered:
                ordered.append((t, s))
    for name in FREE_NAMES:
        for t, s in pairs:
            if name.strip() in _norm_src(s) and (t, s) not in ordered:
                ordered.append((t, s))
    for t, s in pairs:
        if (t, s) not in ordered:
            ordered.append((t, s))
    return ordered


def _bing_real(url):
    """Bing News RSS redirect -> 真实媒体URL"""
    if "bing.com/news/redirect" in url:
        m = re.search(r'[?&]url=([^&]+)', url)
        if m:
            try:
                return urllib.parse.unquote(m.group(1))
            except Exception:
                pass
    return url


def search_article_url(title, source):
    """四路级联找真实URL: L1 GDELT -> L2 Bing News RSS -> L3 DDG/Mojeek; 失败返回 None"""
    domain = find_domain(source)
    hdrs = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"}
    # L1: GDELT DOC 2.0 (不依赖 domain 白名单里的 source, 直接全文检索)
    u1 = gdelt_lookup(title)
    if u1:
        return u1
    if not domain:
        return None
    q = urllib.parse.quote(f'{title[:120]} site:{domain}')
    # L2: Bing News RSS(真实链接, 低反爬, 无硬限流; redirect链接解出真实媒体URL)
    try:
        bq = urllib.parse.quote(title[:100])
        r = requests.get(f"https://www.bing.com/news/search?q={bq}&format=rss",
                         timeout=12, headers=hdrs)
        if r.status_code == 200:
            d = feedparser.parse(r.content)
            for e in d.entries[:15]:
                u = (e.get("link") or "").strip()
                u = _bing_real(u)
                if not u or "bing.com" in u or "msn.com" in u:
                    continue
                try:
                    ud = urllib.parse.urlparse(u).netloc
                except Exception:
                    ud = ""
                if ud in PAYWALL_DOMAINS:
                    continue
                if _title_sim(e.get("title", ""), title) >= 0.5:
                    DIAG["bing_ok"] = DIAG.get("bing_ok", 0) + 1
                    return u
    except Exception:
        pass
    # 3) DDG html / lite
    for base in ["https://html.duckduckgo.com/html/?q=", "https://lite.duckduckgo.com/lite/?q="]:
        try:
            r = requests.get(base + q, timeout=12, headers=hdrs)
            if r.status_code != 200:
                continue
            for h in re.findall(r'uddg=([^&"]+)', r.text):
                u = urllib.parse.unquote(h)
                if domain in u and "duckduckgo" not in u:
                    return u
        except Exception:
            continue
    # 4) Mojeek
    try:
        r = requests.get("https://www.mojeek.com/search?q=" + q, timeout=12, headers=hdrs)
        if r.status_code == 200:
            for h in re.findall(r'<a class="ob"[^>]*href="(https?://[^"]+)"', r.text):
                if domain in h:
                    return h
    except Exception:
        pass
    return None


def pick_agency_from_links(links):
    """从 (媒体名, 真实URL) 列表里按 通讯社->免费媒体 优先级挑"""
    for name in AGENCY_NAMES:
        for t, u in links:
            if name.strip() in _norm_src(t):
                return t, u
    for name in FREE_NAMES:
        for t, u in links:
            if name.strip() in _norm_src(t):
                return t, u
    return None


def agency_full_text(a):
    """v7: 优先用summary里的真实媒体链接(通讯社->免费媒体)直接抓全文;
        links为空时才退化走搜索引擎; 全失败保留聚合标题"""
    links = a.get("_src_links") or []
    if links:
        picked = pick_agency_from_links(links)
        if picked:
            t, u = picked
            ft = fetch_full_text(u, a.get("_lang", "en"))
            if ft:
                a["content_orig"] = ft
                a["agency"] = t
                a["_full"] = True
                a["url"] = u
                DIAG["agency_fetch_ok"] += 1
                return a
        # 兜底: 逐个试其它媒体真实链接(跳过google跳转)
        for t, u in links:
            if "news.google.com" in u:
                continue
            ft = fetch_full_text(u, a.get("_lang", "en"))
            if ft:
                a["content_orig"] = ft
                a["agency"] = t
                a["_full"] = True
                a["url"] = u
                DIAG["agency_fetch_ok"] += 1
                return a
        return a
    # 老路径: 从聚合文本解析 + 搜索引擎(碰运气)
    pairs = parse_pairs(a.get("content_orig", ""))
    if not pairs:
        return a
    picked = pick_agency(pairs)
    if not picked:
        return a
    t, src = picked
    u = search_article_url(t, src)
    if not u:
        return a
    DIAG["agency_search_ok"] += 1
    ft = fetch_full_text(u, a.get("_lang", "en"))
    if not ft:
        return a
    DIAG["agency_fetch_ok"] += 1
    a["content_orig"] = ft
    a["agency"] = src
    a["_full"] = True
    a["url"] = u
    return a


def main():
    t0 = time.time()
    _log("fetching sources...")
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(lambda f: fetch_one(*f), FEEDS))
    all_arts = []
    for r in results:
        all_arts.extend(r)
    _log(f"fetched {len(all_arts)} raw")

    seen = set()
    uniq = []
    for a in all_arts:
        key = re.sub(r"\W+", "", a["title_orig"].lower())[:60]
        if key in seen:
            continue
        seen.add(key)
        a["id"] = "g" + hashlib.md5(a["url"].encode()).hexdigest()[:8]
        uniq.append(a)
    # 跨源去重: 同标题保留权威分高的
    best = {}
    for a in uniq:
        key = re.sub(r"\W+", "", a["title_orig"].lower())[:60]
        if key not in best or SOURCE_RANK.get(a["source"], 9) < SOURCE_RANK.get(best[key]["source"], 9):
            best[key] = a
    uniq = sorted(best.values(), key=lambda x: x["published_at"], reverse=True)
    _log(f"unique {len(uniq)}")

    # 全文抓取(去重后量小, 8线程并行)
    _log("fetching full text...")
    with ThreadPoolExecutor(max_workers=4) as ex:
        def resolve_google_link(url):
            """Google中转链接 -> 真实媒体URL: /articles/CODE?oc=5 变体302跟随 + canonical/og:url提取"""
            if "news.google.com" not in url:
                return url
            hdrs = {"User-Agent": UA,
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "Accept-Language": "en-US,en;q=0.9"}
            cands = [url]
            code = re.search(r'/articles/([^?&]+)', url)
            if code:
                c = code.group(1)
                cands += [f"https://news.google.com/articles/{c}?oc=5",
                          f"https://news.google.com/articles/{c}"]
            for u in cands:
                try:
                    r = requests.get(u, timeout=12, headers=hdrs, allow_redirects=True)
                    final = (r.url or "").strip()
                    if final and "news.google.com" not in final:
                        return final
                    for pat in (r'<link[^>]+rel="canonical"[^>]+href="([^"]+)"',
                                r'<meta[^>]+property="og:url"[^>]+content="([^"]+)"'):
                        m = re.search(pat, r.text or "")
                        if m and "news.google.com" not in m.group(1):
                            return m.group(1)
                except Exception:
                    continue
            return url

        def enrich(a):
            if not a.get("_google"):
                return a
            lang = a.get("_lang", "en")
            main_title = a.get("title_orig", "")
            # 通讯社/免费媒体优先排序, 取前4家, 用聚合主标题匹配各家RSS
            pairs = parse_pairs(a.get("content_orig", ""))
            srcs = []
            for _t, src in _order_pairs(pairs):
                if not src or src in srcs:
                    continue
                dom = find_domain(src)
                is_agency = any(nm.strip() in _norm_src(src) for nm in AGENCY_NAMES)
                if dom in PAYWALL_DOMAINS and not is_agency:
                    continue  # 付费墙且非通讯社 -> 跳过, 换下一家
                srcs.append(src)
                if len(srcs) >= 4:
                    break
            if a.get("source") and a["source"] not in srcs:
                dom = find_domain(a["source"])
                if dom not in PAYWALL_DOMAINS or any(nm.strip() in _norm_src(a["source"]) for nm in AGENCY_NAMES):
                    srcs.append(a["source"])
            # L0: 解码五家媒体的Google链接 -> 真实URL (媒体优先级排序)
            links = [u for _, u in (a.get("_src_links") or []) if "news.google.com" in u]
            if not links and "news.google.com" in a.get("url", ""):
                links = [a["url"]]
            dec = decode_google_urls(links) if links else []
            DIAG["decode_ok"] += sum(1 for d in dec if d)
            real = [d for d in dec if d]
            cands = [(srcs[i] if i < len(srcs) else "decoded", u) for i, u in enumerate(real)]
            for src in srcs:
                ux = match_rss(pool, main_title, src, scan_all=True)
                if ux and ux not in [c[1] for c in cands]:
                    cands.append((src, ux))
            for src, u in cands:
                ft = fetch_full_text(u, lang)
                if ft and len(ft) >= 300:
                    a["content_orig"] = ft
                    a["agency"] = src
                    a["_full"] = True
                    a["url"] = u
                    DIAG["fetch_ok"] += 1
                    return a
            # L4: Wayback 快照 (付费墙救星, 限量)
            for src, u in cands[:3]:
                wu = wayback_url(u)
                if not wu:
                    continue
                ft = fetch_full_text(wu, lang)
                if ft and len(ft) >= 300:
                    a["content_orig"] = ft
                    a["agency"] = src + " (wayback)"
                    a["_full"] = True
                    a["url"] = u
                    DIAG["wayback_ok"] += 1
                    return a
            # 兜底: GDELT/Bing 反查
            u2 = search_article_url(main_title, a.get("source") or "")
            if u2:
                ft2 = fetch_full_text(u2, lang)
                if ft2 and len(ft2) >= 300:
                    a["content_orig"] = ft2
                    a["agency"] = "search"
                    a["_full"] = True
                    a["url"] = u2
                    DIAG["fetch_ok"] += 1
            return a
        pool = fetch_rss_pool()  # v7.9: 全量RSS池并行抓一次
        DIAG["rss_domains"] = len(pool)
        uniq = list(ex.map(enrich, uniq))
    full_n = sum(1 for a in uniq if a.get("_full"))
    agency_n = sum(1 for a in uniq if a.get("agency"))
    china_n = sum(1 for a in uniq if a.get("_china"))
    _log(f"full_text ok {full_n}/{len(uniq)}  agency {agency_n}  china {china_n}")
    DIAG["gdelt_ok"] = DIAG.get("gdelt_ok", 0)
    DIAG["rss_domains"] = DIAG.get("rss_domains", 0)
    DIAG["rss_hits"] = 0
    DIAG["src_links"] = sum(1 for a in uniq if a.get("_src_links"))
    DIAG["src_links_real"] = sum(
        1 for a in uniq if any("news.google.com" not in u for _, u in (a.get("_src_links") or [])))
    _log("DIAG " + json.dumps(DIAG))

    now = datetime.now(CST)
    china_list = [a for a in uniq if a.get("_china")]
    main_list = [a for a in uniq if not a.get("_china")]
    recent_main = [a for a in main_list
                   if 0 <= (now - datetime.fromisoformat(a["published_at"])).total_seconds() < 86400]
    recent_main = pick_news(recent_main, TARGET)
    recent_china = [a for a in china_list
                    if 0 <= (now - datetime.fromisoformat(a["published_at"])).total_seconds() < 86400]
    # 中国相关: 保持Google搜索排序取前6; 与主榜重复标题跳过
    main_keys = {re.sub(r"\W+", "", a["title_orig"].lower())[:60] for a in recent_main}
    recent_china = [a for a in recent_china
                    if re.sub(r"\W+", "", a["title_orig"].lower())[:60] not in main_keys][:8]
    recent = recent_main + recent_china
    from collections import Counter as _C
    _log(f"picked {len(recent)} (main {len(recent_main)} + china {len(recent_china)})",
          dict(_C(a["country"] for a in recent)))
    print("picked cat", dict(_C(a["category"] for a in recent)))
    print("picked full", sum(1 for a in recent if a.get("_full")))

    try:
        old, sha = gitee_get()
    except Exception as e:
        print("GITEE GET ERR", e)
        old, sha = {"articles": []}, None

    old_ids = {a["id"] for a in old["articles"]}
    # v6: 全部照搬Google热榜, 旧库全部有正文条目进 old_by_id, 同id带翻译不重复翻
    old_by_id = {}
    for a in old["articles"]:
        if (a.get("content_orig") or "").strip():
            old_by_id[a["id"]] = a
    # 关键修复v5.15/v6: 以本轮最新picked为主, 同id的AI翻译成果自动带上, 杜绝旧条目挤占新条目配额
    for a in recent:
        o = old_by_id.get(a["id"])
        if o and (o.get("content_zh") or "").strip():
            # 历史译文(之前AI/API翻过)保留; 未翻过的字段为原文
            a["title_zh"] = o.get("title_zh") or a["title_orig"]
            a["summary_zh"] = o.get("summary_zh") or ""
            a["content_zh"] = o.get("content_zh") or ""
            a["translate_by"] = o.get("translate_by") or "none"
        else:
            a["title_zh"] = a["title_orig"]
            a["content_zh"] = ""
            a["summary_zh"] = ""
            a["translate_by"] = "none"
    MAX_TOTAL = 100  # v8: 网页第1页最新50条 + 第2页被覆盖旧闻50条
    merged2 = recent[:TARGET + len(recent_china)]  # 本轮 42+8 = 50 条
    # 24h内被覆盖的旧条目(有正文即可), 按时间倒序补位到最多100条 —— 翻译取消后不再限已翻译
    have = {a["id"] for a in merged2}
    for a in sorted(old_by_id.values(), key=lambda x: x.get("published_at", ""), reverse=True):
        if len(merged2) >= MAX_TOTAL:
            break
        if a["id"] in have:
            continue
        if not (a.get("content_orig") or "").strip():
            continue
        merged2.append(a)
    merged2 = [a for a in merged2
               if 0 <= (now - datetime.fromisoformat(a["published_at"])).total_seconds() < 86400]
    merged2 = merged2[:MAX_TOTAL]
    print("MERGED country", dict(_C(a["country"] for a in merged2)))
    print("MERGED ai", sum(1 for a in merged2 if a.get("translate_by") == "ai"))
    new_data = {"version": "1.0", "updated_at": now.isoformat(), "articles": merged2}
    if sha:
        try:
            gitee_put(new_data, sha)
            print(f"OK total={len(merged2)} cost={int(time.time()-t0)}s")
        except Exception as e:
            # v9.5: 上传失败必须失败退出, 让GitHub run显示failure, 不再假success
            print("UPLOAD ERR", e)
            sys.exit(1)
    else:
        print("NO SHA, SKIP UPLOAD")
        sys.exit(1)


if __name__ == "__main__":
    main()

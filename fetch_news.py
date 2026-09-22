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
import os, re, json, base64, time, hashlib, random
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor
import urllib.request
import urllib.parse
import feedparser
import requests
from bs4 import BeautifulSoup

GITEE_TOKEN = os.environ["GITEE_TOKEN"]
GITEE_OWNER = "t7950288"
GITEE_REPO = "news"
GITEE_PATH = "news.json"
CST = timezone(timedelta(hours=8))
MIN_BODY = 80        # RSS导语最小长度
MAX_BODY = 2500      # 原文保留上限(翻译时分块)
TARGET = 30          # 每次最多30条
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

# 五国15家媒体 + 财经科技栏目 + Google全球热榜 (25源)
FEEDS = [
    # UK 3家
    ("http://feeds.bbci.co.uk/news/world/rss.xml", "BBC", "UK", "world", False),
    ("http://feeds.bbci.co.uk/news/business/rss.xml", "BBC", "UK", "finance", False),
    ("http://feeds.bbci.co.uk/news/technology/rss.xml", "BBC", "UK", "tech", False),
    ("https://www.theguardian.com/world/rss", "卫报", "UK", "world", False),
    ("https://www.theguardian.com/business/rss", "卫报", "UK", "finance", False),
    ("https://www.theguardian.com/technology/rss", "卫报", "UK", "tech", False),
    ("https://www.theguardian.com/tone/editorials/rss", "卫报", "UK", "op-ed", False),
    ("https://www.dailymail.co.uk/home/index.rss", "每日邮报", "UK", "world", False),
    # US 4家
    ("http://rss.cnn.com/rss/edition.rss", "CNN", "US", "world", False),
    ("https://feeds.npr.org/1001/rss.xml", "NPR", "US", "world", False),
    ("https://feeds.npr.org/1006/rss.xml", "NPR", "US", "finance", False),
    ("https://feeds.npr.org/1019/rss.xml", "NPR", "US", "tech", False),
    ("https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", "纽约时报", "US", "world", False),
    ("https://rss.nytimes.com/services/xml/rss/nyt/Editorials.xml", "纽约时报", "US", "op-ed", False),
    ("https://feeds.a.dj.com/rss/RSSWorldNews.xml", "华尔街日报", "US", "finance", False),
    ("https://feeds.a.dj.com/rss/RSSOpinion.xml", "华尔街日报", "US", "op-ed", False),
    # FR 2家
    ("https://www.lemonde.fr/rss/une.xml", "世界报", "FR", "world", False),
    ("https://www.lemonde.fr/economie/rss_full.xml", "世界报", "FR", "finance", False),
    ("https://www.lemonde.fr/idees/rss_full.xml", "世界报", "FR", "op-ed", False),
    ("http://www.lefigaro.fr/rss/figaro_actualites.xml", "费加罗报", "FR", "world", False),
    # DE 3家
    ("https://www.welt.de/feeds/latest.rss", "世界报", "DE", "world", False),
    ("https://www.spiegel.de/schlagzeilen/index.rss", "明镜", "DE", "world", False),
    ("https://www.spiegel.de/wirtschaft/index.rss", "明镜", "DE", "finance", False),
    ("https://www.spiegel.de/meinung/index.rss", "明镜", "DE", "op-ed", False),
    ("https://www.bild.de/rss-feeds/rss-16725492,feed=home.bild.html", "图片报", "DE", "world", False),
    # JP 3家 (Google News聚合保24h最新; 原站限流/旧缓存作备选)
    (["https://news.google.com/rss/search?q=site:yomiuri.co.jp&hl=ja&gl=JP&ceid=JP:ja",
      "https://japannews.yomiuri.co.jp/feed", "https://www.yomiuri.co.jp/news_rss.xml"], "读卖新闻", "JP", "world", False),
    (["https://news.google.com/rss/search?q=site:asahi.com&hl=ja&gl=JP&ceid=JP:ja",
      "https://www.asahi.com/ajw/rss/", "http://rss.asahi.com/rss/asahi/newsheadlines.rdf"], "朝日新闻", "JP", "world", False),
    (["https://news.google.com/rss/search?q=site:nhk.or.jp&hl=ja&gl=JP&ceid=JP:ja",
      "https://rsshub.app/nhk/news/en", "https://www3.nhk.or.jp/rss/news/cat4.xml"], "NHK", "JP", "world", False),
    # Google全球热榜 (世界/财经/科技), 来源不限15家, 全球热门优先
    ("https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en", "GOOGLE_WORLD", "UK", "world", True),
    ("https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=en-US&gl=US&ceid=US:en", "GOOGLE_BUSINESS", "UK", "finance", True),
    ("https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=en-US&gl=US&ceid=US:en", "GOOGLE_TECH", "UK", "tech", True),
]

# Google热门源: 真实媒体名 -> 国家
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

BAIDU_APPID = "20260917002686240"
BAIDU_SECRET = "6JZO5lWQ2F4GbXr2ycjN"
BAIDU_LANG = {"en": "en", "fr": "fra", "de": "de", "ja": "jp"}
BAIDU_ON = True  # 由Gitee config.json控制(用户可网页/手机开关)

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
    "de": ["wetter", "unfall", "verkehrsunfall", "fussball", "bundesliga", "tennis",
           "schauspieler", "promi", "musik", "konzert", "film", "fernsehen",
           "tv-sendung", "penis", "ufo", "alien", "kosmetik", "abnehmen",
           "shopping", "mord", "raub", "unfall", "wetter", "rezept", "diät",
           "horoskop", "haustier"],
    "fr": ["météo", "meteo", "accident", "circulation", "football", "ligue 1",
           "tennis", "acteur", "actrice", "star", "concert", "musique", "film",
           "télévision", "television", "temps", "meurtre", "braquage", "recette",
           "régime", "horoscope", "animaux"],
    "ja": ["天気", "事故", "サッカー", "野球", "テニス", "ゴルフ", "芸能", "俳優",
           "映画", "音楽", "コンサート", "アイドル", "レシピ", "ダイエット",
           "占い", "ペット", "殺人", "強盗", "交通", "天気予報"],
}


def skip_news(title, desc, lang):
    t = (title + " " + desc).lower()
    if any(k in t for k in DISASTER_KEYS):
        return False  # 重大灾难保留
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


def load_config():
    """读Gitee config.json获取百度翻译开关"""
    global BAIDU_ON
    try:
        url = (f"https://gitee.com/api/v5/repos/{GITEE_OWNER}/{GITEE_REPO}/contents/config.json"
               f"?ref=master&access_token={GITEE_TOKEN}")
        info = json.loads(urllib.request.urlopen(urllib.request.Request(url), timeout=10).read())
        cfg = json.loads(base64.b64decode(info["content"]).decode("utf-8"))
        BAIDU_ON = bool(cfg.get("baidu_enabled", False))
        print("config baidu_enabled =", BAIDU_ON)
    except Exception as e:
        print("config read err, default OFF:", str(e)[:60])
        BAIDU_ON = False


def clean_html(html):
    if not html:
        return ""
    soup = BeautifulSoup(html, "lxml")
    return soup.get_text(separator="\n").strip()


def _baidu(text, src):
    salt = str(int(time.time() * 1000))
    sign = hashlib.md5((BAIDU_APPID + text + salt + BAIDU_SECRET).encode()).hexdigest()
    from_lang = BAIDU_LANG.get(src, "en")
    url = ("https://fanyi-api.baidu.com/api/trans/vip/translate?q=" +
           urllib.parse.quote(text) + f"&from={from_lang}&to=zh&appid={BAIDU_APPID}&salt={salt}&sign={sign}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=8) as r:
        data = json.loads(r.read())
        if "trans_result" in data:
            return "".join(x["dst"] for x in data["trans_result"])
    return None


def _youdao(text, src):
    ts = str(int(time.time() * 1000))
    salt = ts + str(random.randint(10, 99))
    bv = hashlib.md5(b"5.0 (Windows NT 10.0; Win64; x64)").hexdigest()
    sign_str = "fanyideskweb" + text + salt + "Ygy_4c=r#e#4EX^NUGUc5"
    sign = hashlib.md5(sign_str.encode()).hexdigest()
    body = urllib.parse.urlencode({
        "i": text, "from": "AUTO", "to": "AUTO",
        "smartresult": "dict", "client": "fanyideskweb",
        "salt": salt, "sign": sign, "ts": ts, "bv": bv,
        "doctype": "json", "version": "2.1", "action": "FANY"
    }).encode()
    req = urllib.request.Request("http://fanyi.youdao.com/translate",
        data=body, headers={"User-Agent": "Mozilla/5.0", "Content-Type": "application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=8) as r:
        data = json.loads(r.read())
        if data.get("errorCode") == 0:
            return "".join(x["tgt"] for x in data["translateResult"])
    return None


def _mymemory(text, src):
    url = ("https://api.mymemory.translated.net/get?q=" + urllib.parse.quote(text) +
           f"&langpair={src}|zh-CN&de=7950288@sina.com.cn")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=5) as r:
        data = json.loads(r.read())
        return data["responseData"]["translatedText"]


def translate(text, src="en"):
    if not text:
        return ""
    text = text.strip()
    if len(text) < 2:
        return text
    text = text[:900]
    for attempt in range(2):
        for fn in (_baidu, _youdao, _mymemory):
            try:
                r = fn(text, src)
                if r and len(r) > 2 and r != text:
                    return r
            except Exception:
                continue
        if attempt == 0:
            time.sleep(2)
    return text


def split_chunks(text, size=600):
    paras = [p.strip() for p in re.split(r"\n+", text) if p.strip()]
    if not paras:
        return [text] if text else []
    chunks, cur = [], ""
    for p in paras:
        while len(p) > size:
            cut = p[:size]
            idx = max(cut.rfind(" "), cut.rfind("."), cut.rfind("。"), cut.rfind("，"), cut.rfind(","))
            if idx < size // 2:
                idx = size
            chunks.append(p[:idx])
            p = p[idx:].strip()
        if len(cur) + len(p) + 1 > size:
            if cur:
                chunks.append(cur)
            cur = p
        else:
            cur = (cur + "\n" + p).strip()
    if cur:
        chunks.append(cur)
    return chunks


def translate_long(text, src):
    if not text:
        return ""
    text = text.strip()
    if len(text) <= 600:
        return translate(text, src)
    out = []
    for c in split_chunks(text, 600):
        t = translate(c, src)
        out.append(t if t else c)
    return "\n".join(out)


def fetch_full_text(url, lang):
    """抓文章页全文; 成功返回正文(最多MAX_BODY), 失败返回None"""
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
                return best[:MAX_BODY]
        except Exception:
            pass
        if attempt == 0:
            time.sleep(1)
    return None


def fetch_one(url, source, country, hint, is_google=False):
    arts = []
    max_per = 8  # Google热榜也是8条
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
            # Google热榜: 媒体名取title后缀, 国家按媒体映射
            if not media:
                media = (getattr(e, "source", None) and getattr(e.source, "title", "")) or ""
            media = media.strip()
            if media:
                source = media
                country = GOOGLE_COUNTRY.get(media.lower(), country)
                lang = COUNTRY_LANG.get(country, "en")
        desc = clean_html(getattr(e, "summary", "") or getattr(e, "description", ""))
        # RSS自带全文(content:encoded)优先: 摘要太短时取content字段的完整正文
        if len(desc) < 300:
            for c in (getattr(e, "content", None) or []):
                full = clean_html(c.get("value", ""))
                if len(full) > len(desc):
                    desc = full
                if len(desc) >= 300:
                    break
        if skip_news(title, desc, lang):
            continue
        cls = classify(title, desc, lang, hint)
        if cls is None:
            continue
        cat, weight = cls
        if is_google:
            weight = min(weight, 0)  # 全球热门最优先
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
        })
    print(f"  {source}: {len(arts)} ok")
    return arts


def translate_article(a):
    lang = a.pop("_lang", "en")
    if not BAIDU_ON:
        # 用户关闭百度: 云端不翻译, 等本地豆包AI接管
        a["title_zh"] = a["title_orig"]
        a["content_zh"] = ""
        a["summary_zh"] = ""
        a["translate_by"] = "none"
        return a
    a["title_zh"] = translate(a["title_orig"], lang)
    body = a.get("content_orig", "") or ""
    if body.strip():
        zh = translate_long(body, lang)
        a["content_zh"] = zh
        first = [l for l in zh.split("\n") if l.strip()]
        a["summary_zh"] = (first[0] if first else zh)[:200]
    else:
        a["content_zh"] = a["title_zh"]
        a["summary_zh"] = a["title_zh"]
    a["translate_by"] = "api"
    return a


def gitee_get():
    url = (f"https://gitee.com/api/v5/repos/{GITEE_OWNER}/{GITEE_REPO}/contents/{GITEE_PATH}"
           f"?ref=master&access_token={GITEE_TOKEN}")
    with urllib.request.urlopen(urllib.request.Request(url), timeout=15) as r:
        info = json.loads(r.read())
    data = json.loads(base64.b64decode(info["content"]).decode("utf-8"))
    return data, info["sha"]


def gitee_put(data, sha):
    body_text = json.dumps(data, ensure_ascii=False)
    b64 = base64.b64encode(body_text.encode("utf-8")).decode()
    body = {"access_token": GITEE_TOKEN, "content": b64, "message": "auto update", "sha": sha}
    url = f"https://gitee.com/api/v5/repos/{GITEE_OWNER}/{GITEE_REPO}/contents/{GITEE_PATH}"
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="PUT")
    with urllib.request.urlopen(req, timeout=30) as r:
        json.loads(r.read())


def pick_news(arts, target=TARGET):
    """全文优先(抓不到全文的尽量不放); 社论全收+时政优先填到70%; 每类内五国轮流"""
    def importance(a):
        return (a.get("_w", 9), 0 if a.get("_full") else 1)

    full = [a for a in arts if a.get("_full")]
    summary = [a for a in arts if not a.get("_full")]
    # 全文条目够就不放摘要条目(宁缺毋滥, 用户要求无法全文的尽量少放)
    pool = full if len(full) >= max(round(target * 0.6), 1) else full + summary

    world = sorted([a for a in pool if a["category"] in ("world", "op-ed")], key=importance)
    rest = sorted([a for a in pool if a["category"] not in ("world", "op-ed")], key=importance)
    nw = min(len(world), max(round(target * 0.7), 1))  # 时政优先填到70%

    def pick_cat(items, n):
        if not items or n <= 0:
            return []
        by_country = {}
        for a in items:
            by_country.setdefault(a["country"], []).append(a)
        picks = []
        while len(picks) < n and any(v for v in by_country.values()):
            for c in sorted(by_country.keys()):
                if by_country[c]:
                    picks.append(by_country[c].pop(0))
                if len(picks) >= n:
                    break
            by_country = {k: v for k, v in by_country.items() if v}
        return picks

    picks = pick_cat(world, nw)
    picks += pick_cat(rest, target - len(picks))
    if len(picks) < target:
        seen_ids = {p["id"] for p in picks}
        extra = sorted([a for a in arts if a["id"] not in seen_ids], key=importance)
        picks += extra[:target - len(picks)]
    return picks[:target]


def main():
    t0 = time.time()
    load_config()
    print("fetching sources...")
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(lambda f: fetch_one(*f), FEEDS))
    all_arts = []
    for r in results:
        all_arts.extend(r)
    print(f"fetched {len(all_arts)} raw")

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
    print(f"unique {len(uniq)}")

    # 全文抓取(去重后量小, 8线程并行)
    print("fetching full text...")
    with ThreadPoolExecutor(max_workers=8) as ex:
        def enrich(a):
            ft = fetch_full_text(a["url"], a["_lang"])
            if ft:
                a["content_orig"] = ft
                a["_full"] = True
            return a
        uniq = list(ex.map(enrich, uniq))
    full_n = sum(1 for a in uniq if a.get("_full"))
    print(f"full_text ok {full_n}/{len(uniq)}")

    now = datetime.now(CST)
    recent = [a for a in uniq
              if 0 <= (now - datetime.fromisoformat(a["published_at"])).total_seconds() < 86400]
    recent = pick_news(recent, TARGET)
    from collections import Counter as _C
    print(f"picked {len(recent)}", dict(_C(a["country"] for a in recent)))
    print("picked cat", dict(_C(a["category"] for a in recent)))
    print("picked full", sum(1 for a in recent if a.get("_full")))

    try:
        old, sha = gitee_get()
    except Exception as e:
        print("GITEE GET ERR", e)
        old, sha = {"articles": []}, None

    old_ids = {a["id"] for a in old["articles"]}
    # 只保留15家白名单媒体的旧条目
    old["articles"] = [a for a in old["articles"] if (a.get("country"), a.get("source")) in WHITELIST]
    # 关键修复: AI翻译过的条目必须保留(否则每轮覆盖, 翻译成果全丢)
    keep_old = []
    for a in old["articles"]:
        co = (a.get("content_orig") or "").strip()
        cz = (a.get("content_zh") or "").strip()
        if not co:
            continue
        if a.get("translate_by") == "ai" and len(cz) >= 20:
            keep_old.append(a)  # 保留AI翻译成果, 参与30条截断
        else:
            rep = dict(a)
            rep["_lang"] = COUNTRY_LANG.get(a.get("country", "UK"), "en")
            keep_old.append(rep)  # 非AI/空白的补翻

    to_translate = [a for a in recent if a["id"] not in old_ids]
    to_translate += [a for a in keep_old if "_lang" in a]
    keep_old = [a for a in keep_old if "_lang" not in a]
    print(f"translating {len(to_translate)} new/repair...")
    if to_translate:
        with ThreadPoolExecutor(max_workers=10) as ex:
            to_translate = list(ex.map(translate_article, to_translate))

    merged = to_translate + keep_old
    d = {}
    for a in merged:
        if a["id"] not in d:
            d[a["id"]] = a
    merged2 = sorted(d.values(), key=lambda x: x["published_at"], reverse=True)
    merged2 = [a for a in merged2
               if 0 <= (now - datetime.fromisoformat(a["published_at"])).total_seconds() < 86400]
    merged2 = merged2[:TARGET]
    print("MERGED country", dict(_C(a["country"] for a in merged2)))
    new_data = {"version": "1.0", "updated_at": now.isoformat(), "articles": merged2}
    if sha:
        try:
            gitee_put(new_data, sha)
            print(f"OK total={len(merged2)} cost={int(time.time()-t0)}s")
        except Exception as e:
            print("UPLOAD ERR", e)
    else:
        print("NO SHA, SKIP UPLOAD")


if __name__ == "__main__":
    main()

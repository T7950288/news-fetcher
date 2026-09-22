# -*- coding: utf-8 -*-
"""每小时从五国主流媒体RSS抓取新闻，翻译成中文，上传Gitee。

【踩坑记录 - 不要再犯】
1. MyMemory翻译API的langpair不能用"auto"作源语言。
2. 只翻译标题，不翻译摘要正文，避免API调用太多超时。
3. 上传Gitee前先GET拿最新sha避免冲突。
4. 每个RSS源超时8秒，翻译超时5秒，失败快速跳过。
"""
import os, re, json, base64, time, hashlib, random
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor
import urllib.request
import urllib.parse
import feedparser
from bs4 import BeautifulSoup

GITEE_TOKEN = os.environ["GITEE_TOKEN"]
GITEE_OWNER = "t7950288"
GITEE_REPO = "news"
GITEE_PATH = "news.json"
CST = timezone(timedelta(hours=8))

# 18个核心源，每源8条
FEEDS = [
    ("http://feeds.bbci.co.uk/news/world/rss.xml", "BBC", "UK", "world"),
    ("https://www.theguardian.com/world/rss", "The Guardian", "UK", "world"),
    ("https://news.sky.com/rss/world", "Sky News", "UK", "world"),
    ("http://feeds.bbci.co.uk/news/business/rss.xml", "BBC Business", "UK", "finance"),
    ("http://feeds.bbci.co.uk/news/technology/rss.xml", "BBC Tech", "UK", "tech"),
    ("http://rss.cnn.com/rss/edition.rss", "CNN", "US", "world"),
    ("https://feeds.npr.org/1001/rss.xml", "NPR", "US", "world"),
    ("https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", "NY Times", "US", "world"),
    ("https://feeds.npr.org/1006/rss.xml", "NPR Business", "US", "finance"),
    ("https://feeds.npr.org/1019/rss.xml", "NPR Tech", "US", "tech"),
    ("https://www.lemonde.fr/rss/une.xml", "Le Monde", "FR", "world"),
    ("http://www.lefigaro.fr/rss/figaro_actualites.xml", "Le Figaro", "FR", "world"),
    ("https://www.spiegel.de/schlagzeilen/index.rss", "Der Spiegel", "DE", "world"),
    ("https://www.welt.de/feeds/latest.rss", "Die Welt", "DE", "world"),
    ("https://newsfeed.zeit.de/index", "Die Zeit", "DE", "world"),
    ("https://www3.nhk.or.jp/nhkworld/en/news/feed.xml", "NHK World", "JP", "world"),
    ("https://english.kyodonews.net/rss/news.rss", "Kyodo News", "JP", "world"),
    ("https://www.rtl.fr/flash-actu/rss", "RTL", "FR", "general"),
]

COUNTRY_LANG = {"UK":"en","US":"en","FR":"fr","DE":"de","JP":"ja"}

BAIDU_APPID = "20260917002686240"
BAIDU_SECRET = "6JZO5lWQ2F4GbXr2ycjN"
BAIDU_LANG = {"en":"en","fr":"fra","de":"de","ja":"jp"}

def _baidu(text, src):
    """百度翻译：主引擎，每月100万字符免费"""
    salt = str(int(time.time()*1000))
    sign = hashlib.md5((BAIDU_APPID + text + salt + BAIDU_SECRET).encode()).hexdigest()
    from_lang = BAIDU_LANG.get(src, "en")
    url = f"https://fanyi-api.baidu.com/api/trans/vip/translate?q={urllib.parse.quote(text)}&from={from_lang}&to=zh&appid={BAIDU_APPID}&salt={salt}&sign={sign}"
    req = urllib.request.Request(url, headers={"User-Agent":"Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=8) as r:
        data = json.loads(r.read())
        if "trans_result" in data:
            return "".join(x["dst"] for x in data["trans_result"])
    return None

def _youdao(text, src):
    """有道网页翻译：第二备用，免注册"""
    ts = str(int(time.time()*1000))
    salt = ts + str(random.randint(10,99))
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
        data=body, headers={"User-Agent":"Mozilla/5.0","Content-Type":"application/x-www-form-urlencoded"})
    with urllib.request.urlopen(req, timeout=8) as r:
        data = json.loads(r.read())
        if data.get("errorCode") == 0:
            return "".join(x["tgt"] for x in data["translateResult"])
    return None

def _mymemory(text, src):
    """MyMemory：第三备用，带邮箱50000字符/天"""
    url = f"https://api.mymemory.translated.net/get?q={urllib.parse.quote(text)}&langpair={src}|zh-CN&de=7950288@sina.com.cn"
    req = urllib.request.Request(url, headers={"User-Agent":"Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=5) as r:
        data = json.loads(r.read())
        return data["responseData"]["translatedText"]

def translate(text, src="en"):
    """三级备用+退避重试：百度→有道→MyMemory，全部免费"""
    if not text or len(text) < 5:
        return text
    text = text[:500]
    for attempt in range(2):
        for fn in (_baidu, _youdao, _mymemory):
            try:
                r = fn(text, src)
                if r and len(r) > 3 and r != text:
                    return r
            except:
                continue
        if attempt == 0:
            time.sleep(2)
    return text

def clean_html(html):
    if not html: return ""
    soup = BeautifulSoup(html, "lxml")
    return soup.get_text(separator="\n").strip()

def categorize(title, summary, hint):
    t = (title + " " + summary).lower()
    if any(k in t for k in ["opinion","editorial","comment","column"]): return "op-ed"
    if any(k in t for k in ["stock","market","economy","fed","oil","price","trade","gdp","earnings"]): return "finance"
    if any(k in t for k in ["ai","tech","google","apple","microsoft","chip","software","internet"]): return "tech"
    return "world"

# 过滤无聊的社会新闻+娱乐新闻，重大灾难保留
SKIP = ["motorcycle","traffic accident","car crash","weather","cloudy","sunny",
        "football","soccer","basketball","tennis","score",
        "house fire","celebrity","actor","actress","movie","film",
        "singer","music","concert","hollywood","entertainment","taylor swift"]

def skip_news(title, desc):
    t = (title + " " + desc).lower()
    return any(k in t for k in SKIP)

def fetch_one(url, source, country, hint):
    arts = []
    try:
        d = feedparser.parse(url)
    except Exception:
        return arts
    lang = COUNTRY_LANG.get(country, "en")
    for e in d.entries[:8]:
        title = getattr(e, "title", "").strip()
        link = getattr(e, "link", "").strip()
        if not title or not link: continue
        desc = clean_html(getattr(e, "summary", "") or getattr(e, "description", ""))
        if skip_news(title, desc): continue
        pub = None
        for k in ("published_parsed","updated_parsed"):
            t = getattr(e, k, None)
            if t:
                pub = datetime(*t[:6], tzinfo=timezone.utc).astimezone(CST).isoformat()
                break
        if not pub: pub = datetime.now(CST).isoformat()
        arts.append({
            "title_orig": title,
            "title_zh": title,
            "source": source,
            "country": country,
            "category": categorize(title, desc, hint),
            "published_at": pub,
            "summary_zh": "",
            "content_orig": desc[:1500],
            "content_zh": "",
            "url": link,
            "_lang": lang,
        })
    return arts

def translate_article(a):
    """并行翻译单条：标题+摘要前500字"""
    lang = a.pop("_lang", "en")
    a["title_zh"] = translate(a["title_orig"], lang)
    s = translate(a["content_orig"][:500], lang)
    a["summary_zh"] = s
    a["content_zh"] = s
    return a

def gitee_get():
    url = f"https://gitee.com/api/v5/repos/{GITEE_OWNER}/{GITEE_REPO}/contents/{GITEE_PATH}?ref=master&access_token={GITEE_TOKEN}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=15) as r:
        info = json.loads(r.read())
    data = json.loads(base64.b64decode(info["content"]).decode("utf-8"))
    return data, info["sha"]

def gitee_put(data, sha):
    body_text = json.dumps(data, ensure_ascii=False)
    b64 = base64.b64encode(body_text.encode("utf-8")).decode()
    body = {"access_token": GITEE_TOKEN, "content": b64, "message": "auto update", "sha": sha}
    url = f"https://gitee.com/api/v5/repos/{GITEE_OWNER}/{GITEE_REPO}/contents/{GITEE_PATH}"
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
        headers={"Content-Type":"application/json"}, method="PUT")
    with urllib.request.urlopen(req, timeout=30) as r:
        json.loads(r.read())

def main():
    all_arts = []
    for url, src, country, hint in FEEDS:
        try:
            all_arts.extend(fetch_one(url, src, country, hint))
        except Exception as e:
            print("ERR", src, e)
    # 去重
    seen = set()
    uniq = []
    for a in all_arts:
        key = a["title_orig"][:30].lower()
        if key in seen: continue
        seen.add(key)
        a["id"] = "g" + hashlib.md5(a["url"].encode()).hexdigest()[:8]
        uniq.append(a)
    uniq.sort(key=lambda x: x["published_at"], reverse=True)
    now = datetime.now(CST)
    recent = [a for a in uniq if (now - datetime.fromisoformat(a["published_at"])).total_seconds() < 86400]
    recent = recent[:60]
    # 并行翻译：10个线程同时翻译标题+摘要
    print(f"translating {len(recent)} articles in parallel...")
    with ThreadPoolExecutor(max_workers=10) as ex:
        recent = list(ex.map(translate_article, recent))
    # 合并到现有
    try:
        old, sha = gitee_get()
        old_ids = {a["id"] for a in old["articles"]}
        merged = old["articles"] + [a for a in recent if a["id"] not in old_ids]
        seen2 = set()
        merged2 = []
        for a in sorted(merged, key=lambda x: x["published_at"], reverse=True):
            if a["id"] in seen2: continue
            seen2.add(a["id"])
            merged2.append(a)
        merged2 = merged2[:80]
        new_data = {"version":"1.0","updated_at": now.isoformat(), "articles": merged2}
        gitee_put(new_data, sha)
        print(f"OK total={len(merged2)} new={len(recent)}")
    except Exception as e:
        print("UPLOAD ERR", e)

if __name__ == "__main__":
    main()

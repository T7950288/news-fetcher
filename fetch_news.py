# -*- coding: utf-8 -*-
"""每小时从五国主流媒体RSS抓取新闻，翻译成中文，上传Gitee。

【踩坑记录 - 不要再犯】
1. MyMemory翻译API的langpair不能用"auto"作源语言。
2. 只翻译标题，不翻译摘要正文，避免API调用太多超时。
3. 上传Gitee前先GET拿最新sha避免冲突。
4. 每个RSS源超时8秒，翻译超时5秒，失败快速跳过。
"""
import os, re, json, base64, time, hashlib
from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor
import urllib.request
import feedparser
from bs4 import BeautifulSoup

GITEE_TOKEN = os.environ["GITEE_TOKEN"]
GITEE_OWNER = "t7950288"
GITEE_REPO = "news"
GITEE_PATH = "news.json"
CST = timezone(timedelta(hours=8))

# 精简到12个核心源，每源5条
FEEDS = [
    ("http://feeds.bbci.co.uk/news/world/rss.xml", "BBC", "UK", "world", 1),
    ("https://www.theguardian.com/world/rss", "The Guardian", "UK", "world", 1),
    ("https://news.sky.com/rss/world", "Sky News", "UK", "world", 1),
    ("http://rss.cnn.com/rss/edition.rss", "CNN", "US", "world", 1),
    ("https://feeds.npr.org/1001/rss.xml", "NPR", "US", "world", 1),
    ("https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", "NY Times", "US", "world", 1),
    ("https://www.lemonde.fr/rss/une.xml", "Le Monde", "FR", "world", 1),
    ("http://www.lefigaro.fr/rss/figaro_actualites.xml", "Le Figaro", "FR", "world", 1),
    ("https://www.spiegel.de/schlagzeilen/index.rss", "Der Spiegel", "DE", "world", 1),
    ("https://www.welt.de/feeds/latest.rss", "Die Welt", "DE", "world", 1),
    ("https://www3.nhk.or.jp/nhkworld/en/news/feed.xml", "NHK World", "JP", "world", 1),
    ("https://english.kyodonews.net/rss/news.rss", "Kyodo News", "JP", "world", 1),
]

COUNTRY_LANG = {"UK":"en","US":"en","FR":"fr","DE":"de","JP":"ja"}

def translate(text, src="en"):
    if not text or len(text) < 5:
        return text
    text = text[:200]
    try:
        url = f"https://api.mymemory.translated.net/get?q={urllib.parse.quote(text)}&langpair={src}|zh-CN"
        req = urllib.request.Request(url, headers={"User-Agent":"Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=5) as r:
            data = json.loads(r.read())
            return data["responseData"]["translatedText"]
    except:
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

def fetch_one(url, source, country, hint):
    arts = []
    try:
        d = feedparser.parse(url)
    except Exception:
        return arts
    lang = COUNTRY_LANG.get(country, "en")
    for e in d.entries[:5]:
        title = getattr(e, "title", "").strip()
        link = getattr(e, "link", "").strip()
        if not title or not link: continue
        desc = clean_html(getattr(e, "summary", "") or getattr(e, "description", ""))
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
    """并行翻译单条：标题+摘要前300字"""
    lang = a.pop("_lang", "en")
    a["title_zh"] = translate(a["title_orig"], lang)
    a["summary_zh"] = translate(a["content_orig"][:300], lang)
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
    for url, src, country, hint, prio in FEEDS:
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

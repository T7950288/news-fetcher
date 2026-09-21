# -*- coding: utf-8 -*-
"""每小时从五国主流媒体RSS抓取新闻，翻译成中文，上传Gitee。"""
import os, re, json, base64, time, hashlib
from datetime import datetime, timezone, timedelta
import urllib.request
import feedparser
from bs4 import BeautifulSoup

GITEE_TOKEN = os.environ["GITEE_TOKEN"]
GITEE_OWNER = "t7950288"
GITEE_REPO = "news"
GITEE_PATH = "news.json"
CST = timezone(timedelta(hours=8))

FEEDS = [
    # (rss_url, source, country, category_hint)
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
    ("https://www.rtl.fr/flash-actu/rss", "RTL", "FR", "general"),
    ("https://www.spiegel.de/schlagzeilen/index.rss", "Der Spiegel", "DE", "world"),
    ("https://www.welt.de/feeds/latest.rss", "Die Welt", "DE", "world"),
    ("https://newsfeed.zeit.de/index", "Die Zeit", "DE", "world"),
    ("https://www3.nhk.or.jp/nhkworld/en/news/feed.xml", "NHK World", "JP", "world"),
    ("https://english.kyodonews.net/rss/news.rss", "Kyodo News", "JP", "world"),
]

def http_get(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent":"Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def translate(text, src="en"):
    """MyMemory免费翻译API，src->zh-CN"""
    if not text or len(text) < 5:
        return text
    text = text[:800]  # 避免超长
    try:
        url = f"https://api.mymemory.translated.net/get?q={urllib.parse.quote(text)}&langpair={src}|zh-CN"
        req = urllib.request.Request(url, headers={"User-Agent":"Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read())
            return data["responseData"]["translatedText"]
    except Exception as e:
        return text

COUNTRY_LANG = {"UK":"en","US":"en","FR":"fr","DE":"de","JP":"ja"}

def clean_html(html):
    if not html:
        return ""
    soup = BeautifulSoup(html, "lxml")
    return soup.get_text(separator="\n").strip()

def categorize(title, summary, hint):
    t = (title + " " + summary).lower()
    if hint in ("finance",): return "finance"
    if hint in ("tech",): return "tech"
    if any(k in t for k in ["opinion","editorial","comment","column","editorial board"]):
        return "op-ed"
    if any(k in t for k in ["stock","market","economy","fed","oil","price","trade","gdp","earnings","company","business"]):
        return "finance"
    if any(k in t for k in ["ai","tech","google","apple","microsoft","chip","software","internet","cyber","robot","quantum"]):
        return "tech"
    if hint != "world": return hint
    return "world"

def fetch_one(url, source, country, hint):
    arts = []
    try:
        d = feedparser.parse(url)
    except Exception:
        return arts
    for e in d.entries[:6]:
        title = getattr(e, "title", "").strip()
        link = getattr(e, "link", "").strip()
        if not title or not link:
            continue
        desc = clean_html(getattr(e, "summary", "") or getattr(e, "description", ""))
        # 发布时间
        pub = None
        for k in ("published_parsed","updated_parsed"):
            t = getattr(e, k, None)
            if t:
                pub = datetime(*t[:6], tzinfo=timezone.utc).astimezone(CST).isoformat()
                break
        if not pub:
            pub = datetime.now(CST).isoformat()
        lang = COUNTRY_LANG.get(country, "en")
        arts.append({
            "title_orig": title,
            "title_zh": translate(title, lang),
            "source": source,
            "country": country,
            "category": categorize(title, desc, hint),
            "published_at": pub,
            "summary_zh": translate(desc[:200], lang)[:200],
            "content_orig": desc[:1500],
            "content_zh": translate(desc[:800], lang),
            "url": link,
        })
    return arts

def gitee_get():
    url = f"https://gitee.com/api/v5/repos/{GITEE_OWNER}/{GITEE_REPO}/contents/{GITEE_PATH}?ref=master&access_token={GITEE_TOKEN}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=30) as r:
        info = json.loads(r.read())
    data = json.loads(base64.b64decode(info["content"]).decode("utf-8"))
    return data, info["sha"]

def gitee_put(data, sha):
    body_text = json.dumps(data, ensure_ascii=False)
    b64 = base64.b64encode(body_text.encode("utf-8")).decode()
    body = {"access_token": GITEE_TOKEN, "content": b64,
            "message": "auto update", "sha": sha}
    url = f"https://gitee.com/api/v5/repos/{GITEE_OWNER}/{GITEE_REPO}/contents/{GITEE_PATH}"
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
        headers={"Content-Type":"application/json"}, method="PUT")
    with urllib.request.urlopen(req, timeout=60) as r:
        json.loads(r.read())

def main():
    all_arts = []
    for url, src, country, hint in FEEDS:
        try:
            all_arts.extend(fetch_one(url, src, country, hint))
            time.sleep(1)
        except Exception as e:
            print("ERR", src, e)
    # 去重
    seen = set()
    uniq = []
    for a in all_arts:
        key = a["url"] or a["title_orig"]
        if key in seen: continue
        seen.add(key)
        a["id"] = "g" + hashlib.md5(key.encode()).hexdigest()[:8]
        uniq.append(a)
    # 按时间倒序
    uniq.sort(key=lambda x: x["published_at"], reverse=True)
    # 保留最近24小时，最多100条
    now = datetime.now(CST)
    recent = [a for a in uniq if (now - datetime.fromisoformat(a["published_at"])).total_seconds() < 86400]
    recent = recent[:100]
    # 合并到现有
    try:
        old, sha = gitee_get()
        old_ids = {a["id"] for a in old["articles"]}
        merged = old["articles"] + [a for a in recent if a["id"] not in old_ids]
        # 去重并保留24小时
        seen2 = set()
        merged2 = []
        for a in sorted(merged, key=lambda x: x["published_at"], reverse=True):
            if a["id"] in seen2: continue
            seen2.add(a["id"])
            merged2.append(a)
        merged2 = merged2[:100]
        new_data = {"version":"1.0","updated_at": now.isoformat(), "articles": merged2}
        gitee_put(new_data, sha)
        print(f"OK total={len(merged2)} new={len(recent)}")
    except Exception as e:
        print("UPLOAD ERR", e)

if __name__ == "__main__":
    main()

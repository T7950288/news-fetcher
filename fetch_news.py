# -*- coding: utf-8 -*-
"""每小时从五国主流媒体RSS抓取新闻，翻译成中文，上传Gitee。

【踩坑记录 - 不要再犯】
1. MyMemory翻译API的langpair不能用"auto"作源语言，否则返回"'AUTO' IS AN INVALID SOURCE LANGUAGE"。
   必须根据国家传具体语言代码：UK/US=en, FR=fr, DE=de, JP=ja。
2. GitHub Actions的fine-grained token要触发workflow_dispatch，必须额外给"Actions"权限，只给Contents权限会403。
3. 翻译时每调一次sleep 0.3秒，MyMemory免费版有频率限制，连续快速调用会卡住。
4. 上传Gitee前先GET拿最新sha，避免sha冲突；每次修改后重新GET sha再PUT。
5. RSS源要选稳定的，NYT/WSJ等付费墙源全文抓不到，只能拿标题+导语。
"""
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
    # (rss_url, source, country, category_hint, priority)
    # 五国前三媒体priority=1（重要），其他priority=2
    ("http://feeds.bbci.co.uk/news/world/rss.xml", "BBC", "UK", "world", 1),
    ("https://www.theguardian.com/world/rss", "The Guardian", "UK", "world", 1),
    ("https://news.sky.com/rss/world", "Sky News", "UK", "world", 1),
    ("http://feeds.bbci.co.uk/news/business/rss.xml", "BBC Business", "UK", "finance", 2),
    ("http://feeds.bbci.co.uk/news/technology/rss.xml", "BBC Tech", "UK", "tech", 2),
    ("http://rss.cnn.com/rss/edition.rss", "CNN", "US", "world", 1),
    ("https://feeds.npr.org/1001/rss.xml", "NPR", "US", "world", 1),
    ("https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", "NY Times", "US", "world", 1),
    ("https://feeds.npr.org/1006/rss.xml", "NPR Business", "US", "finance", 2),
    ("https://feeds.npr.org/1019/rss.xml", "NPR Tech", "US", "tech", 2),
    ("https://www.lemonde.fr/rss/une.xml", "Le Monde", "FR", "world", 1),
    ("http://www.lefigaro.fr/rss/figaro_actualites.xml", "Le Figaro", "FR", "world", 1),
    ("https://www.rtl.fr/flash-actu/rss", "RTL", "FR", "general", 1),
    ("https://www.spiegel.de/schlagzeilen/index.rss", "Der Spiegel", "DE", "world", 1),
    ("https://www.welt.de/feeds/latest.rss", "Die Welt", "DE", "world", 1),
    ("https://newsfeed.zeit.de/index", "Die Zeit", "DE", "world", 1),
    ("https://www3.nhk.or.jp/nhkworld/en/news/feed.xml", "NHK World", "JP", "world", 1),
    ("https://english.kyodonews.net/rss/news.rss", "Kyodo News", "JP", "world", 1),
]

def http_get(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent":"Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

def translate(text, src="en"):
    """MyMemory免费翻译API，src->zh-CN"""
    if not text or len(text) < 5:
        return text
    text = text[:800]
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

def fetch_one(url, source, country, hint, priority=2):
    arts = []
    try:
        d = feedparser.parse(url)
    except Exception:
        return arts
    limit = 8 if priority == 1 else 5
    for e in d.entries[:limit]:
        title = getattr(e, "title", "").strip()
        link = getattr(e, "link", "").strip()
        if not title or not link:
            continue
        desc = clean_html(getattr(e, "summary", "") or getattr(e, "description", ""))
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
            "_prio": priority,
        })
        time.sleep(0.3)
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
    for url, src, country, hint, prio in FEEDS:
        try:
            all_arts.extend(fetch_one(url, src, country, hint, prio))
            time.sleep(1)
        except Exception as e:
            print("ERR", src, e)
    # 去重：标题前30字符相似算同一新闻，优先保留priority=1（前三媒体）
    all_arts.sort(key=lambda x: (x["_prio"], x["published_at"]), reverse=True)
    seen_titles = {}
    uniq = []
    for a in all_arts:
        key = a["title_orig"][:30].lower()
        if key in seen_titles:
            continue
        seen_titles[key] = True
        a["id"] = "g" + hashlib.md5(a["url"].encode()).hexdigest()[:8]
        uniq.append(a)
    # 按时间倒序
    uniq.sort(key=lambda x: x["published_at"], reverse=True)
    # 保留最近24小时，最多80条
    now = datetime.now(CST)
    recent = [a for a in uniq if (now - datetime.fromisoformat(a["published_at"])).total_seconds() < 86400]
    recent = recent[:80]
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

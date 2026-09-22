# -*- coding: utf-8 -*-
"""国际新闻抓取 v3.1
- 选稿: 时政50% 经济30% 科技20%，不要社会新闻/娱乐
- 一次最多50条，仅24小时内
- 增量: 旧新闻不重复翻译(只翻新抓到的)
- 翻译: 百度(主)→有道(备用,2026-09起失效自动跳过)→MyMemory(兜底)，全文分段翻译
- 踩坑记录(不要再犯):
  1. RSS正文可能在content字段而非summary，必须兜底提取，否则content_orig为空→中文全文空白
  2. 有道网页接口返回非JSON(已失效)，失败快速跳过即可
  3. 上传Gitee前先GET拿sha
  4. 德/法/日新闻过滤词要用对应语言，英文关键词匹配不到德文标题
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

# 25个源：时政/经济/科技全覆盖，每源8条
FEEDS = [
    # UK 7
    ("http://feeds.bbci.co.uk/news/world/rss.xml", "BBC", "UK", "world"),
    ("https://www.theguardian.com/world/rss", "The Guardian", "UK", "world"),
    ("https://news.sky.com/rss/world", "Sky News", "UK", "world"),
    ("http://feeds.bbci.co.uk/news/business/rss.xml", "BBC Business", "UK", "finance"),
    ("http://feeds.bbci.co.uk/news/technology/rss.xml", "BBC Tech", "UK", "tech"),
    ("https://www.theguardian.com/business/rss", "Guardian Business", "UK", "finance"),
    ("https://www.theguardian.com/technology/rss", "Guardian Tech", "UK", "tech"),
    # US 7
    ("http://rss.cnn.com/rss/edition.rss", "CNN", "US", "world"),
    ("https://feeds.npr.org/1001/rss.xml", "NPR", "US", "world"),
    ("https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", "NY Times", "US", "world"),
    ("https://feeds.npr.org/1006/rss.xml", "NPR Business", "US", "finance"),
    ("https://feeds.npr.org/1019/rss.xml", "NPR Tech", "US", "tech"),
    ("https://rss.nytimes.com/services/xml/rss/nyt/Business.xml", "NYT Business", "US", "finance"),
    ("https://rss.nytimes.com/services/xml/rss/nyt/Technology.xml", "NYT Tech", "US", "tech"),
    # FR 4
    ("https://www.lemonde.fr/rss/une.xml", "Le Monde", "FR", "world"),
    ("http://www.lefigaro.fr/rss/figaro_actualites.xml", "Le Figaro", "FR", "world"),
    ("https://www.lemonde.fr/economie/rss_full.xml", "Le Monde Éco", "FR", "finance"),
    ("https://www.lefigaro.fr/rss/figaro_economie.xml", "Le Figaro Éco", "FR", "finance"),
    # DE 4
    ("https://www.spiegel.de/schlagzeilen/index.rss", "Der Spiegel", "DE", "world"),
    ("https://www.welt.de/feeds/latest.rss", "Die Welt", "DE", "world"),
    ("https://newsfeed.zeit.de/index", "Die Zeit", "DE", "world"),
    ("https://www.handelsblatt.com/contentexport/feed/finanzen", "Handelsblatt", "DE", "finance"),
    # JP 3
    ("https://www3.nhk.or.jp/nhkworld/en/news/feed.xml", "NHK World", "JP", "world"),
    ("https://english.kyodonews.net/rss/news.rss", "Kyodo News", "JP", "world"),
    ("https://asia.nikkei.com/rss", "Nikkei Asia", "JP", "finance"),
]

COUNTRY_LANG = {"UK": "en", "US": "en", "FR": "fr", "DE": "de", "JP": "ja"}

BAIDU_APPID = "20260917002686240"
BAIDU_SECRET = "6JZO5lWQ2F4GbXr2ycjN"
BAIDU_LANG = {"en": "en", "fr": "fra", "de": "de", "ja": "jp"}


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
    """三级备用：百度→有道→MyMemory，全部免费，失败返回原文"""
    if not text:
        return ""
    text = text.strip()
    if len(text) < 2:
        return text
    text = text[:800]
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


def split_chunks(text, size=700):
    """按段落切块，段落超长再按窗口切，保证每块<=size字符"""
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
    """全文分段翻译：每段<=700字符，逐段翻译后拼回"""
    if not text:
        return ""
    text = text.strip()
    if len(text) <= 700:
        return translate(text, src)
    out = []
    for c in split_chunks(text, 700):
        t = translate(c, src)
        out.append(t if t else c)
    return "\n".join(out)


def clean_html(html):
    if not html:
        return ""
    soup = BeautifulSoup(html, "lxml")
    return soup.get_text(separator="\n").strip()


def categorize(title, summary):
    t = (title + " " + summary).lower()
    if any(k in t for k in ["stock", "market", "economy", "fed", "oil", "price", "trade", "gdp", "earnings",
                            "bank", "tariff", "inflation", "bond", "bourse", "wirtschaft", "économie", "経済"]):
        return "finance"
    if any(k in t for k in ["ai", "tech", "google", "apple", "microsoft", "chip", "software", "internet",
                            "technology", "techologie", "technik", "テクノロジー"]):
        return "tech"
    return "world"


# 多语言无聊社会新闻+娱乐过滤（重大灾难如地震台风不在列表，保留）
SKIP_KEYS = {
    "en": ["motorcycle", "traffic accident", "car crash", "weather", "cloudy", "sunny", "forecast",
           "football", "soccer", "basketball", "tennis", "score", "match result", "house fire",
           "celebrity", "actor", "actress", "movie", "film", "singer", "music", "concert",
           "hollywood", "entertainment", "taylor swift", "tv ratings"],
    "de": ["wetter", "unfall", "verkehrsunfall", "fussball", "bundesliga", "tennis", "schauspieler",
           "promi", "musik", "konzert", "film", "fernsehen", "tv-sendung", "unwetter"],
    "fr": ["météo", "meteo", "accident", "circulation", "football", "ligue 1", "tennis", "acteur",
           "actrice", "star", "concert", "musique", "film", "télévision", "television", "temps"],
    "ja": ["天気", "事故", "サッカー", "野球", "テニス", "芸能", "俳優", "映画", "音楽", "コンサート"],
}


def skip_news(title, desc, lang):
    t = (title + " " + desc).lower()
    keys = SKIP_KEYS.get(lang, []) + SKIP_KEYS.get("en", [])
    return any(k in t for k in keys)


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
        if not title or not link:
            continue
        # 正文提取：summary/description → content兜底
        desc = clean_html(getattr(e, "summary", "") or getattr(e, "description", ""))
        if not desc:
            for c in (getattr(e, "content", None) or []):
                desc = clean_html(c.get("value", ""))
                if desc:
                    break
        if skip_news(title, desc, lang):
            continue
        pub = None
        for k in ("published_parsed", "updated_parsed"):
            t = getattr(e, k, None)
            if t:
                pub = datetime(*t[:6], tzinfo=timezone.utc).astimezone(CST).isoformat()
                break
        if not pub:
            pub = datetime.now(CST).isoformat()
        arts.append({
            "title_orig": title,
            "title_zh": title,
            "source": source,
            "country": country,
            "category": categorize(title, desc) if hint == "auto" else hint,
            "published_at": pub,
            "summary_zh": "",
            "content_orig": desc[:2000],
            "content_zh": "",
            "url": link,
            "_lang": lang,
        })
    return arts


def translate_article(a):
    """并行翻译单条：标题 + 全文分段翻译"""
    lang = a.pop("_lang", "en")
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


def pick_by_ratio(arts, target=50):
    """时政50% 经济30% 科技20%"""
    world = [a for a in arts if a["category"] in ("world", "op-ed")]
    fin = [a for a in arts if a["category"] == "finance"]
    tech = [a for a in arts if a["category"] == "tech"]
    nw = round(target * 0.5)
    nf = round(target * 0.3)
    nt = target - nw - nf
    picks = world[:nw] + fin[:nf] + tech[:nt]
    if len(picks) < target:
        rest = [a for a in arts if a not in picks]
        picks += rest[:target - len(picks)]
    return picks[:target]


def main():
    t0 = time.time()
    # 并行抓源
    with ThreadPoolExecutor(max_workers=8) as ex:
        results = list(ex.map(lambda f: fetch_one(*f), FEEDS))
    all_arts = []
    for r in results:
        all_arts.extend(r)
    print(f"fetched {len(all_arts)} raw")

    # 去重
    seen = set()
    uniq = []
    for a in all_arts:
        key = a["title_orig"][:30].lower()
        if key in seen:
            continue
        seen.add(key)
        a["id"] = "g" + hashlib.md5(a["url"].encode()).hexdigest()[:8]
        uniq.append(a)
    uniq.sort(key=lambda x: x["published_at"], reverse=True)
    now = datetime.now(CST)
    recent = [a for a in uniq if (now - datetime.fromisoformat(a["published_at"])).total_seconds() < 86400]
    recent = pick_by_ratio(recent, 50)
    print(f"picked {len(recent)}")

    # 增量：只翻译本轮新抓到的（旧新闻不重复更新）
    try:
        old, sha = gitee_get()
    except Exception as e:
        print("GITEE GET ERR", e)
        old, sha = {"articles": []}, None
    old_ids = {a["id"] for a in old["articles"]}
    to_translate = [a for a in recent if a["id"] not in old_ids]
    print(f"translating {len(to_translate)} new articles...")
    if to_translate:
        with ThreadPoolExecutor(max_workers=10) as ex:
            to_translate = list(ex.map(translate_article, to_translate))

    merged = old["articles"] + to_translate
    seen2 = set()
    merged2 = []
    for a in sorted(merged, key=lambda x: x["published_at"], reverse=True):
        if a["id"] in seen2:
            continue
        seen2.add(a["id"])
        merged2.append(a)
    # 只保留24小时内，最多50条
    merged2 = [a for a in merged2 if (now - datetime.fromisoformat(a["published_at"])).total_seconds() < 86400]
    merged2 = merged2[:50]
    new_data = {"version": "1.0", "updated_at": now.isoformat(), "articles": merged2}
    if sha:
        try:
            gitee_put(new_data, sha)
            print(f"OK total={len(merged2)} new_translated={len(to_translate)} cost={int(time.time()-t0)}s")
        except Exception as e:
            print("UPLOAD ERR", e)
    else:
        print("NO SHA, SKIP UPLOAD")


if __name__ == "__main__":
    main()

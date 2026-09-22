# -*- coding: utf-8 -*-
"""国际新闻抓取 v4.0（云端兜底版）
- 媒体: 五国15家主流媒体(含栏目RSS)
- 选稿: 时政至少50%, 其余按时事自然浮动; 每次最多30条, 仅24小时内
- 翻译: 百度→有道(失效跳过)→MyMemory 三级备用, 仅翻新条目, 正文上限1000字符
- translate_by="api" 标记; 本地豆包AI翻译优先, 本脚本只兜底(不重翻AI已翻的)
- 踩坑记录(不要再犯):
  1. RSS正文可能在content字段, 必须兜底提取; 正文<80字符丢弃
  2. feedparser.parse无超时会卡死, 用requests下载+超时
  3. 选稿不能按时间取前N条(德媒霸屏), 时政池优先+按国家轮流
  4. 有道网页接口2026-09起失效, 失败快速跳过
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
MIN_BODY = 80        # 正文最小长度
MAX_BODY = 1000      # 正文翻译上限
TARGET = 30          # 每次最多30条

# 15家媒体白名单 + 去重权威分
WHITELIST = {
    ("UK", "BBC"), ("UK", "卫报"), ("UK", "每日邮报"),
    ("US", "CNN"), ("US", "NPR"), ("US", "纽约时报"), ("US", "华尔街日报"),
    ("FR", "世界报"), ("FR", "费加罗报"),
    ("DE", "世界报"), ("DE", "明镜"), ("DE", "图片报"),
    ("JP", "读卖新闻"), ("JP", "朝日新闻"), ("JP", "NHK"),
}
SOURCE_RANK = {
    "BBC": 0, "CNN": 0,
    "卫报": 1, "NPR": 1, "纽约时报": 1, "华尔街日报": 1,
    "每日邮报": 2, "世界报": 2, "费加罗报": 2, "明镜": 2, "图片报": 2,
    "读卖新闻": 3, "朝日新闻": 3, "NHK": 3,
}

# 五国15家媒体 + 财经科技栏目 (20源)
FEEDS = [
    # UK 3家
    ("http://feeds.bbci.co.uk/news/world/rss.xml", "BBC", "UK", "world"),
    ("http://feeds.bbci.co.uk/news/business/rss.xml", "BBC", "UK", "finance"),
    ("http://feeds.bbci.co.uk/news/technology/rss.xml", "BBC", "UK", "tech"),
    ("https://www.theguardian.com/world/rss", "卫报", "UK", "world"),
    ("https://www.theguardian.com/business/rss", "卫报", "UK", "finance"),
    ("https://www.theguardian.com/technology/rss", "卫报", "UK", "tech"),
    ("https://www.dailymail.co.uk/home/index.rss", "每日邮报", "UK", "world"),
    # US 4家
    ("http://rss.cnn.com/rss/edition.rss", "CNN", "US", "world"),
    ("https://feeds.npr.org/1001/rss.xml", "NPR", "US", "world"),
    ("https://feeds.npr.org/1006/rss.xml", "NPR", "US", "finance"),
    ("https://feeds.npr.org/1019/rss.xml", "NPR", "US", "tech"),
    ("https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml", "纽约时报", "US", "world"),
    ("https://feeds.a.dj.com/rss/RSSWorldNews.xml", "华尔街日报", "US", "finance"),
    # FR 2家
    ("https://www.lemonde.fr/rss/une.xml", "世界报", "FR", "world"),
    ("https://www.lemonde.fr/economie/rss_full.xml", "世界报", "FR", "finance"),
    ("http://www.lefigaro.fr/rss/figaro_actualites.xml", "费加罗报", "FR", "world"),
    # DE 3家
    ("https://www.welt.de/feeds/latest.rss", "世界报", "DE", "world"),
    ("https://www.spiegel.de/schlagzeilen/index.rss", "明镜", "DE", "world"),
    ("https://www.spiegel.de/wirtschaft/index.rss", "明镜", "DE", "finance"),
    ("https://www.bild.de/rss-feeds/rss-16725492,feed=home.bild.html", "图片报", "DE", "world"),
    # JP 3家 (多备选RSS)
    (["https://www3.nhk.or.jp/nhkworld/en/news/feed.xml", "https://www3.nhk.or.jp/rss/news/cat0.xml"], "NHK", "JP", "world"),
    (["https://www.yomiuri.co.jp/news_rss.xml", "https://japannews.yomiuri.co.jp/feed/"], "读卖新闻", "JP", "world"),
    ("http://rss.asahi.com/rss/asahi/newsheadlines.rdf", "朝日新闻", "JP", "world"),
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


def clean_html(html):
    if not html:
        return ""
    soup = BeautifulSoup(html, "lxml")
    return soup.get_text(separator="\n").strip()


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
    urls = url if isinstance(url, list) else [url]
    content = None
    for u in urls:
        for attempt in range(3):
            try:
                r = requests.get(u, timeout=12, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"})
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
    for e in d.entries[:8]:
        title = getattr(e, "title", "").strip()
        link = getattr(e, "link", "").strip()
        if not title or not link:
            continue
        desc = clean_html(getattr(e, "summary", "") or getattr(e, "description", ""))
        if not desc:
            for c in (getattr(e, "content", None) or []):
                desc = clean_html(c.get("value", ""))
                if desc:
                    break
        if skip_news(title, desc, lang):
            continue
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
        arts.append({
            "title_orig": title,
            "title_zh": title,
            "source": source,
            "country": country,
            "category": hint,
            "published_at": pub,
            "summary_zh": "",
            "content_orig": desc[:MAX_BODY],
            "content_zh": "",
            "url": link,
            "_lang": lang,
        })
    print(f"  {source}: {len(arts)} ok")
    return arts


def translate_article(a):
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
    """时政至少50%，其余按时事自然补足；每类内五国轮流"""
    nw = max(round(target * 0.5), 1)
    world = [a for a in arts if a["category"] in ("world", "op-ed")]
    rest = [a for a in arts if a["category"] not in ("world", "op-ed")]

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
        extra = [a for a in arts if a not in picks]
        picks += extra[:target - len(picks)]
    return picks[:target]


def main():
    t0 = time.time()
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
    now = datetime.now(CST)
    jp_items = [a for a in uniq if a["country"] == "JP"]
    print("JP raw:", len(jp_items))
    for a in jp_items[:6]:
        print(f"  JP {a['source']} {a['published_at'][:19]} len={len(a['content_orig'])} {a['title_orig'][:40]}")
    recent = [a for a in uniq if (now - datetime.fromisoformat(a["published_at"])).total_seconds() < 86400]
    recent = pick_news(recent, TARGET)
    from collections import Counter as _C
    print(f"picked {len(recent)}", dict(_C(a["country"] for a in recent)))
    for a in recent:
        if a["country"] == "JP":
            print(f"  PICK-JP {a['source']} {a['published_at'][:19]} {a['title_orig'][:40]}")

    try:
        old, sha = gitee_get()
    except Exception as e:
        print("GITEE GET ERR", e)
        old, sha = {"articles": []}, None

    old_ids = {a["id"] for a in old["articles"]}
    # 只保留15家白名单媒体的旧条目
    old["articles"] = [a for a in old["articles"] if (a.get("country"), a.get("source")) in WHITELIST]
    # 云端只兜底：只翻新条目；AI翻过的(translate_by=ai)不碰
    keep_old = []
    for a in old["articles"]:
        co = (a.get("content_orig") or "").strip()
        cz = (a.get("content_zh") or "").strip()
        if not co:
            continue
        if len(cz) < 20 and a.get("translate_by") != "ai":
            rep = dict(a)
            rep["_lang"] = COUNTRY_LANG.get(a.get("country", "UK"), "en")
            keep_old.append(rep)  # 非AI且空白的旧条目补翻
        else:
            keep_old.append(a)

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
    merged2 = [a for a in merged2 if (now - datetime.fromisoformat(a["published_at"])).total_seconds() < 86400]
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

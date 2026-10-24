#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
云端清单脚本：遍历史藏/集藏/诗藏/艺藏，统计各藏文件数、字节数，生成 manifest.json。
第一步只统计大小，不算 md5（速度快）；打包阶段由 pack.sh 调用带 md5 的清单。
"""
import os
import json
import hashlib

ROOT = os.getcwd()
COLLS = ["史藏", "集藏", "诗藏", "艺藏"]
INCLUDE_MD5 = os.environ.get("INCLUDE_MD5", "0") == "1"


def md5_of(path: str) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


records = []
per_coll = {}

for coll in COLLS:
    coll_dir = os.path.join(ROOT, coll)
    n_files = 0
    n_bytes = 0
    if not os.path.isdir(coll_dir):
        per_coll[coll] = {"files": 0, "bytes": 0, "missing": True}
        continue
    for dirpath, _, files in os.walk(coll_dir):
        for fn in files:
            p = os.path.join(dirpath, fn)
            rel = os.path.relpath(p, ROOT).replace("\\", "/")
            size = os.path.getsize(p)
            rec = {"path": rel, "size": size}
            if INCLUDE_MD5:
                rec["md5"] = md5_of(p)
            records.append(rec)
            n_files += 1
            n_bytes += size
    per_coll[coll] = {"files": n_files, "bytes": n_bytes}

summary = {
    "source": "https://github.com/daizhige-org/daizhigev20  branch: data",
    "collections": per_coll,
    "total_files": len(records),
    "total_bytes": sum(r["size"] for r in records),
    "files": records,
}

with open("manifest.json", "w", encoding="utf-8") as f:
    json.dump(summary, f, ensure_ascii=False, indent=1)

# 日志只打印汇总，不打印全量清单
print(json.dumps({k: v for k, v in summary.items() if k != "files"},
                 ensure_ascii=False, indent=2))

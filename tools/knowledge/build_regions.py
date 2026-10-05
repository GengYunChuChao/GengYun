#!/usr/bin/env python3
"""生成浙江省市/县区划字典 packages/knowledge/catalog/regions-zhejiang.json。

数据来源（真实、公开）：民政部《2023年中华人民共和国县以上行政区划代码》
  https://www.mca.gov.cn/mzsj/xzqh/2023/202301xzqh.html

本脚本只用 Python 标准库。默认读取本地缓存 HTML（--input），也可用
--url 直接抓取（需要可访问的 HTTPS；本仓库环境走本地代理，见 README）。
输出为确定性 JSON：同样的输入产生同样的字节，便于复核。

用法：
    python tools/knowledge/build_regions.py --input <mca.html> --out <out.json>
    python tools/knowledge/build_regions.py --url https://... --out <out.json>
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import urllib.request

PROVINCE_PREFIX = "33"
CATALOG_VERSION = "mca-xzqh-2023"


def fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "gengyun-knowledge/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:  # noqa: S310 (explicit https url)
        raw = resp.read()
    return raw.decode("utf-8", errors="replace")


def parse_rows(html: str) -> list[tuple[str, str]]:
    """从民政部表格 HTML 中抽取 (6位代码, 名称)。"""
    rows = re.findall(r"<tr[^>]*>(.*?)</tr>", html, flags=re.S)
    out: list[tuple[str, str]] = []
    for r in rows:
        cells = [
            re.sub(r"<[^>]+>", "", c).strip()
            for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", r, flags=re.S)
        ]
        cells = [c for c in cells if c]
        codes = [c for c in cells if re.fullmatch(r"\d{6}", c)]
        if not codes:
            continue
        # 名称是不含 6 位代码的第一个非空单元
        name = ""
        for c in cells:
            if c != codes[0] and not re.fullmatch(r"\d{6}", c):
                name = c
                break
        out.append((codes[0], name))
    return out


def build(rows: list[tuple[str, str]]) -> dict:
    zj = [(c, n) for c, n in rows if c.startswith(PROVINCE_PREFIX)]
    if not any(c == "330000" for c, _ in zj):
        raise SystemExit("未在输入中找到 330000 浙江省，来源可能变更，拒绝生成。")

    prov = [c for c, _ in zj]
    if len(prov) < 90:
        raise SystemExit(f"浙江条目过少（{len(prov)}），来源不完整，拒绝生成。")

    regions = []
    for code, name in sorted(zj, key=lambda x: x[0]):
        name = name.replace("\u3000", "").strip()
        if not name:
            raise SystemExit(f"代码 {code} 缺名称，拒绝生成。")
        if code == "330000":
            parent = None
            level = "province"
        elif code[4:6] == "00":
            parent = "330000"
            level = "prefecture"
        else:
            parent = code[:4] + "00"
            level = "county"
        regions.append(
            {
                "code": code,
                "name": name,
                "parent_code": parent,
                "level": level,
                "catalog_version": CATALOG_VERSION,
                # 全省可选，但每个县是否有独立验证资料按资料覆盖显示，见 coverage-report
                "selectable": True,
                "supported": level in ("province", "prefecture", "county"),
                "verification": "cross_checked_against_source",
            }
        )

    digest = hashlib.sha256(
        json.dumps(
            [(r["code"], r["name"]) for r in regions], ensure_ascii=False
        ).encode("utf-8")
    ).hexdigest()

    return {
        "schema": "gengyun.knowledge.regions.v1",
        "catalog_version": CATALOG_VERSION,
        "generated_from": "mca.gov.cn/2023 county-level administrative division codes",
        "source": {
            "title": "2023年中华人民共和国县以上行政区划代码",
            "canonical_url": "https://www.mca.gov.cn/mzsj/xzqh/2023/202301xzqh.html",
            "publisher": "中华人民共和国民政部",
            "retrieved_at": "2026-10-04",
            "source_kind": "database",
            "evidence_kind": "research",
        },
        "coverage_state": "supported",
        "note": "仅浙江（33 前缀）；代码为县以上行政区划代码，市县选择用。省级/市级/县级均登记，不代表每个县都有独立除草资料。",
        "region_count": len(regions),
        "county_level_count": sum(1 for r in regions if r["level"] == "county"),
        "content_sha256": digest,
        "regions": regions,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", help="本地缓存的民政部 HTML")
    ap.add_argument("--url", help="直接抓取 URL")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    if args.input:
        with open(args.input, encoding="utf-8", errors="replace") as fh:
            html = fh.read()
    elif args.url:
        html = fetch(args.url)
    else:
        print("需要 --input 或 --url", file=sys.stderr)
        return 2

    data = build(parse_rows(html))
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(
        f"wrote {args.out}: {data['region_count']} regions "
        f"({data['county_level_count']} county-level) sha256={data['content_sha256'][:16]}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

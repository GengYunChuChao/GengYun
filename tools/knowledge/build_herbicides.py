#!/usr/bin/env python3
"""从官方公告附表生成浙江首批普通除草剂资料清单（真实登记证号）。

数据来源（真实、公开、可复核）：
  农业农村部农药管理司《农药登记信息》公告附表（.xls），经中国农药信息网
  「数据中心 / 登记信息发布」与农业农村部种植业管理司原文页公开。
    2026年第9期 https://zzys.moa.gov.cn/gzdt/202606/t20260604_6484759.htm
    2026年第7期 https://zzys.moa.gov.cn/gzdt/202606/t20260604_6484757.htm
    2026年第1期 https://zzys.moa.gov.cn/gzdt/202603/t20260325_6482643.htm

本脚本读取已下载的 .xls 附表与一个显式选号清单，只做字段抽取与整理，
不生成任何登记号、成分、含量或来源。缺字段一律留空，不推断。

依赖：xlrd（仅本采集脚本需要；仓库校验脚本 tools/knowledge/validate_knowledge.py
只用标准库）。安装示例：
    python -m pip install --target <tmpdir> --proxy=http://127.0.0.1:7897 xlrd

用法：
    python tools/knowledge/build_herbicides.py \
        --ann 2026-09=ann9.xls --ann 2026-01=ann1.xls \
        --out packages/knowledge/herbicides/records-2026.json
"""
from __future__ import annotations

import argparse
import json
import sys

import xlrd  # type: ignore

# 显式选号（来自官方附表；此处只登记证号与作物归属，其余字段从附表原文抽取）
SELECTION = [
    # ---- 水稻 ----
    ("PD20161371", ["crop_rice"], "水稻移栽田、小麦田"),
    ("PD20211218", ["crop_rice"], "水稻旱直播田"),
    ("PD20211629", ["crop_rice"], "水稻移栽田"),
    ("PD20212142", ["crop_rice"], "水稻移栽田"),
    ("PD20212101", ["crop_rice"], "水稻移栽田"),
    ("PD20212271", ["crop_rice"], "水稻田(直播)"),
    # ---- 玉米 ----
    ("PD20161376", ["crop_corn"], "玉米田"),
    ("PD20211624", ["crop_corn"], "玉米田"),
    ("PD20161175", ["crop_corn"], "玉米田"),
    ("PD20110805", ["crop_corn"], "玉米田"),
    ("PD20212226", ["crop_corn"], "玉米田"),
    # ---- 大豆 ----
    ("PD20211628", ["crop_soybean", "crop_rapeseed"], "大豆田、花生田、马铃薯田、油菜田"),
    ("PD20212137", ["crop_soybean"], "春大豆田"),
    ("PD20212138", ["crop_soybean"], "春大豆田、花生田"),
    ("PD20211640", ["crop_soybean"], "春大豆田"),
    # ---- 油菜 ----
    ("PD20111018", ["crop_rapeseed"], "油菜田"),
    ("PD20161375", ["crop_rapeseed"], "油菜田"),
    ("PD20260472", ["crop_rapeseed"], "冬油菜田"),
    # ---- 跨作物 ----
    ("PD20212148", ["crop_soybean", "crop_corn"], "春大豆田、春玉米田"),
    ("PD20211636", ["crop_soybean", "crop_corn"], "春大豆田、春玉米田"),
]

ISSUE_SOURCE = {
    "2026-09": {
        "issue": "农药登记信息（2026年第9期）",
        "published_at": "2026-06-04",
        "moa_url": "https://zzys.moa.gov.cn/gzdt/202606/t20260604_6484759.htm",
        "attachment_url": "https://zzys.moa.gov.cn/gzdt/202606/P020260604741615151859.xls",
        "attachment_sha256": "bfe97d34e2197341ba37571615c771147e7215c1b99d4210f6b0f7d397ace768",
        "icama_url": "http://www.chinapesticide.org.cn/zwb/detail/32599",
    },
    "2026-07": {
        "issue": "农药登记信息（2026年第7期）",
        "published_at": "2026-06-04",
        "moa_url": "https://zzys.moa.gov.cn/gzdt/202606/t20260604_6484757.htm",
        "attachment_url": "https://zzys.moa.gov.cn/gzdt/202606/P020260604734015232729.xls",
        "attachment_sha256": "e60f0e4777f79e2566b77cc4df84983cf306797a7125d0871bf6832429b11d18",
        "icama_url": "http://www.chinapesticide.org.cn/zwb/detail/32591",
    },
    "2026-01": {
        "issue": "农药登记信息（2026年第1期）",
        "published_at": "2026-03-26",
        "moa_url": "https://zzys.moa.gov.cn/gzdt/202603/t20260325_6482643.htm",
        "attachment_url": "https://zzys.moa.gov.cn/gzdt/202603/P020260325742775767461.xls",
        "attachment_sha256": "c82c43361c0b75303287de7cf92f91a3574bdde58f3d63fcde93719ab6d5462d",
        "icama_url": "http://www.chinapesticide.org.cn/zwb/detail/32280",
    },
}

HEADER_ALIASES = {
    "登记证号": ["登记证号", "农药登记证号"],
    "登记证持有人": ["登记证持有人"],
    "农药名称": ["农药名称"],
    "剂型": ["剂型"],
    "毒性": ["毒性"],
    "有效成分及其含量": ["有效成分及其含量", "有效成分及含量"],
    "农药类别": ["农药类别"],
    "作物/场所": ["作物/场所"],
    "防治对象": ["防治对象"],
    "产品质量标准号": ["产品质量标准号"],
    "不同意登记的内容": ["不同意登记的内容"],
}


def norm(s: object) -> str:
    return str(s).strip()


def pick(rec: dict, key: str) -> str:
    for alias in HEADER_ALIASES.get(key, [key]):
        if alias in rec and norm(rec[alias]):
            return norm(rec[alias])
    return ""


def load_issue(path: str) -> dict[str, dict]:
    book = xlrd.open_workbook(path)
    sheet = book.sheet_by_index(0)
    header = [norm(sheet.cell_value(2, c)) for c in range(sheet.ncols)]
    out: dict[str, dict] = {}
    for r in range(3, sheet.nrows):
        vals = [norm(sheet.cell_value(r, c)) for c in range(sheet.ncols)]
        if not any(vals):
            continue
        rec = {header[i]: vals[i] for i in range(len(header))}
        num = pick(rec, "登记证号")
        if num and num not in out:
            out[num] = rec
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ann", action="append", default=[], help="issue=path，可多次")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    pools: dict[str, dict] = {}
    for spec in args.ann:
        issue, _, path = spec.partition("=")
        pools[issue] = load_issue(path)

    records = []
    missing = []
    for idx, (num, crop_ids, scene_expected) in enumerate(SELECTION, start=1):
        found = None
        found_issue = None
        for issue, pool in pools.items():
            if num in pool:
                found, found_issue = pool[num], issue
                break
        if not found:
            missing.append(num)
            continue
        src = ISSUE_SOURCE.get(found_issue)
        if src is None:
            missing.append(num)
            continue
        scene = pick(found, "作物/场所")
        if scene_expected and scene != scene_expected:
            print(f"警告：{num} 附表作物/场所与选号登记不一致：{scene!r} vs {scene_expected!r}", file=sys.stderr)
        records.append(
            {
                "record_id": f"gy-i03-hb-{idx:03d}",
                "registration_number": num,
                "registered_name": pick(found, "农药名称"),
                "producer": pick(found, "登记证持有人"),
                "dosage_form": pick(found, "剂型"),
                "toxicity": pick(found, "毒性"),
                "pesticide_class": pick(found, "农药类别"),
                "ingredients_text": pick(found, "有效成分及其含量"),
                "product_standard": pick(found, "产品质量标准号"),
                "use_scene": scene,
                "target_original": pick(found, "防治对象"),
                "crop_ids": crop_ids,
                "source": {
                    "source_id": "src_moa_pd_2026",
                    "issue": src["issue"],
                    "published_at": src["published_at"],
                    "original_url": src["moa_url"],
                    "attachment_url": src["attachment_url"],
                    "attachment_sha256": src["attachment_sha256"],
                    "index_url": src["icama_url"],
                    "publisher": "农业农村部农药管理司",
                    "source_kind": "verified_seed",
                    "evidence_kind": "research",
                    "retrieved_at": "2026-10-04",
                    "source_validity": "valid",
                },
                "record_status": "partial",
                "verification": {
                    "source_checked": True,
                    "source_checked_scope": [
                        "登记证号",
                        "农药名称",
                        "登记证持有人",
                        "剂型",
                        "毒性",
                        "有效成分及其含量",
                        "农药类别",
                        "作物/场所",
                        "防治对象",
                    ],
                    "not_collected": [
                        "用药量（制剂量/亩）",
                        "施用方法",
                        "注意事项",
                        "登记有效期起止日期",
                        "禁限用状态",
                    ],
                    "review_status": "unverified",
                    "card_eligible": False,
                    "usable_as_dose": False,
                    "note": "字段来自官方公告附表原文；未逐字段与ICAMA登记详情/标签原文复核，禁止作为用药量依据。",
                },
            }
        )

    out = {
        "schema": "gengyun.knowledge.herbicides.v1",
        "notice": "登记证号与字段均取自农业农村部农药管理司公开公告附表（登记延续信息），非编造；用药量/施用方法/禁限用状态本轮未采集，记录状态为 partial，不可作为用药依据。",
        "retrieved_at": "2026-10-04",
        "target": 20,
        "achieved": len(records),
        "gap": max(0, 20 - len(records)),
        "missing_registration_numbers": missing,
        "records": records,
    }
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"wrote {args.out}: achieved={len(records)} gap={out['gap']} missing={missing}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

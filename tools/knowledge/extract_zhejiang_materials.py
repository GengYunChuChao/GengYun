#!/usr/bin/env python3
"""GY-I03 浙江首批资料抽取（只读仓外样本 → 可复核派生数据）。

数据源（**仓外只读**，原文件与原始媒体一律不入库）：
  1. `中国各省份农田常见杂草识别与防除时期汇总表.xlsx`
     工作表：杂草总表 / 省份索引表 / 防除时期速查 / 说明与使用提示
  2. `市面常见除草剂环境风险与适用信息汇总表.xlsx`
     工作表：除草剂汇总表 / 说明与使用提示

本工具做什么：
  * 有界读取（复用 `import_workbook_staging.inspect_workbook`：≤25MB、拒绝外部链接工作表、
    不执行公式），先按 MANIFEST 的 sha256 校验，再逐行抽成**浙江适用条目**；
  * 每条记录带 `file_sha256 / sheet / excel_row / cell_range / row_sha256 / locator`，
    可逐条回源复核；
  * 行指纹 `row_sha256 = sha256(json.dumps({"sheet","excel_row","cells"},
    ensure_ascii=False, sort_keys=True, separators=(",",":")))`，其中 `cells` 是源 XML 该行
    实际出现单元格的「坐标 → 值」映射（共享字符串/内联字符串已解析；空值为 null）。

本工具**不**做什么（缺项不得补造）：
  * 两份工作簿**没有**「标签原文用量」列。因此**不抽取、不推断、不生成**任何用量/剂量/
    浓度/安全间隔期字段；相关键一律为 `null` 并注明 `absent_in_source`。
  * 不做跨表插值、不把「适用地区」猜成「浙江适用」，只按显式字段证据分级。

用法：
    python tools/knowledge/extract_zhejiang_materials.py --samples-dir <仓外样本目录> \
        [--out packages/knowledge/zhejiang/materials-zhejiang-v1.json] [--release 2026-10-14]
    python tools/knowledge/extract_zhejiang_materials.py --samples-dir <...> --verify
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import import_workbook_staging as iws  # noqa: E402  复用既有有界读取

GENERATOR_VERSION = "gy-i03-zhejiang-extract-v1"
REGION_CODE = "330000"
REGION_NAME = "浙江省"

WEED_FILE = "中国各省份农田常见杂草识别与防除时期汇总表.xlsx"
HERB_FILE = "市面常见除草剂环境风险与适用信息汇总表.xlsx"

# 来源文件身份：与仓外 MANIFEST.md 登记的 sha256 一致（不随抽取结果变动）
SOURCE_FILES = {
    "src_gengyun_weed_summary_workbook": {
        "file": WEED_FILE,
        "sha256": "e708577e1cd035b435686c8d249209aa96d345d86a33a9a870e01cd6cdddc420",
        "bytes": 74680,
        "sheet_inventory": ["杂草总表", "省份索引表", "防除时期速查", "说明与使用提示"],
        "title": "中国各省份农田常见杂草识别与防除时期汇总表（用户提供整理稿）",
        "source_kind": "verified_seed",
        "evidence_kind": "mixed",
        "version": "weed-summary-2026.10",
    },
    "src_gengyun_herbicide_risk_workbook": {
        "file": HERB_FILE,
        "sha256": "c4905d850b3750c712b10fd8278b5029448a651308fb92c186df604a527c9e70",
        "bytes": 27422,
        "sheet_inventory": ["除草剂汇总表", "说明与使用提示"],
        "title": "市面常见除草剂环境风险与适用信息汇总表（用户提供整理稿）",
        "source_kind": "verified_seed",
        "evidence_kind": "mixed",
        "version": "herbicide-risk-2026.10",
    },
}

WEED_MASTER_SHEET = "杂草总表"
PROVINCE_SHEET = "省份索引表"
TIMING_SHEET = "防除时期速查"
NOTES_SHEET = "说明与使用提示"
HERB_SHEET = "除草剂汇总表"

WEED_COLUMNS = ["杂草名称", "学名", "科属", "伴生作物", "分布省份（中国）",
                "各生长时期状态描述", "最佳防除时期", "推荐施药／防除窗口", "识别要点"]
WEED_FIELDS = ["weed_name", "scientific_name", "family_genus", "companion_crops_text",
               "distribution_text", "growth_stages_text", "best_control_stage_text",
               "spray_window_text", "identification_key_text"]
PROVINCE_COLUMNS = ["省份／省级行政区", "所属大区", "该省常见农田杂草（数量）", "常见杂草清单",
                    "该省主要作物与说明"]
TIMING_COLUMNS = ["作物／场景", "防除关键期", "主要杂草对象", "要点提示"]
TIMING_FIELDS = ["scene_text", "critical_window_text", "target_weeds_text", "key_points_text"]
HERB_COLUMNS = ["除草剂名称", "常见别称／商品名", "对环境危害等级", "对环境主要造成的危害",
                "常用于防除的对象（杂草）", "适用／常用地区"]
HERB_FIELDS = ["herbicide_name", "aliases_text", "hazard_level_text", "hazard_detail_text",
               "target_weeds_text", "region_text"]

# 浙江适用性证据分级（只按字段显式证据，不做跨表猜测）
REGION_TOKENS = {
    "zhejiang_explicit": ["浙江"],
    "yangtze_mid_lower_xref": ["长江中下游", "长江下游", "长江流域"],
    "regional_inference": ["华东", "华中", "江南", "南方", "华南"],
}
REGION_BASIS = {
    "zhejiang_explicit": "适用／常用地区字段直接列出「浙江」",
    "yangtze_mid_lower_xref": "字段含「长江中下游/长江流域」；省份索引表浙江行（r12）所属大区即「长江中下游稻区」",
    "regional_inference": "字段含大区泛称（华东/华中/江南/南方/华南）；本工作簿未定义该泛称与浙江的对应，需人工复核",
    "not_evidenced": "字段未含任何与浙江或长江中下游相关的区域证据",
}
ZHEJIANG_EVIDENCE_ORDER = ["zhejiang_explicit", "yangtze_mid_lower_xref", "regional_inference",
                           "not_evidenced"]

# 说明工作表：只抽"使用约束/口径"行，不抄列结构定义
NOTE_FILTERS = {
    WEED_FILE: [r"^\d+\.\s"],
    HERB_FILE: [r"^\d+\.\s", r"^(高危|低危|生态环保)："],
}
NOTE_TOPIC_HINTS = [
    ("剂量/标签权威", ["用量", "标签", "安全间隔期", "登记信息", "植保"]),
    ("数据定位", ["不构成", "仅供参考", "非法规结论", "动态更新"]),
    ("危害等级口径", ["高危：", "低危：", "生态环保："]),
    ("农艺/抗性", ["抗药性", "轮作", "深翻", "根茎", "开花结实"]),
    ("施药安全", ["饮用水源", "水产养殖", "防护", "包装废弃物", "剂型"]),
    ("场景定义", ["工作表", "第1栏", "第2栏"]),
]


class ExtractionError(Exception):
    pass


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def row_sha256(sheet: str, excel_row: int, cells: dict) -> str:
    payload = json.dumps({"sheet": sheet, "excel_row": excel_row, "cells": cells},
                         ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return sha256_bytes(payload.encode("utf-8"))


def sheet_by_name(book: dict, name: str) -> dict:
    for s in book["sheets"]:
        if s["name"] == name:
            return s
    raise ExtractionError(f"{book['filename']}: 缺少工作表 {name}")


def cell(sheet: dict, coord: str):
    for row in sheet["rows"]:
        if coord in row["cells"]:
            return row["cells"][coord]
    return None


def row_cells(sheet: dict, excel_row: int) -> dict:
    for row in sheet["rows"]:
        if row["excel_row"] == excel_row:
            return row["cells"]
    raise ExtractionError(f"{sheet['name']}: 缺行 r{excel_row}")


def row_values(cells: dict) -> dict:
    """行内坐标 → 值（解析后的文本/原样存储值），用于行指纹与逐行抽取。"""
    return {coord: (c or {}).get("value") for coord, c in cells.items()}


def cval(cells: dict, excel_row: int, col: str) -> str:
    """取某行某列的值（已解析），缺失为 ''。"""
    return clean((cells.get(f"{col}{excel_row}") or {}).get("value"))


def col_coords(width: int, excel_row: int) -> str:
    return f"A{excel_row}:{chr(65 + width - 1)}{excel_row}"


def clean(value) -> str:
    return "" if value is None else str(value).strip()


def split_list(text: str) -> list[str]:
    return [x.strip() for x in re.split(r"[、，,；;]", text or "") if x.strip()]


def canonical_name(raw: str) -> str:
    return re.split(r"[（(]", raw or "")[0].strip()


def paren_aliases(raw: str) -> list[str]:
    out = []
    for group in re.findall(r"[（(]([^）)]*)[）)]", raw or ""):
        out.extend(split_list(group.replace("／", "、").replace("/", "、")))
    return [x for x in out if x]


def split_distribution(text: str) -> tuple[str, list[str]]:
    """分布字段 → (前缀说明, 省份清单)。"""
    note = ""
    body = text or ""
    m = re.match(r"^([^：:]{0,20}[：:])(.*)$", body, re.S)
    if m and ("全国" in m.group(1) or "各稻区" in m.group(1) or "各" in m.group(1)):
        note, body = m.group(1).rstrip("：:").strip(), m.group(2)
    return note, split_list(body)


def load_sources(samples_dir: str) -> dict:
    books = {}
    for sid, meta in SOURCE_FILES.items():
        path = os.path.join(samples_dir, meta["file"])
        if not os.path.exists(path):
            raise ExtractionError(f"缺少样本文件：{path}")
        book = iws.inspect_workbook(path)
        if book["sha256"] != meta["sha256"]:
            raise ExtractionError(f"{meta['file']} sha256 不符：实际 {book['sha256']}，"
                                  f"MANIFEST 期望 {meta['sha256']}")
        names = [s["name"] for s in book["sheets"]]
        if names != meta["sheet_inventory"]:
            raise ExtractionError(f"{meta['file']} 工作表清单与 MANIFEST 不一致：{names}")
        books[sid] = book
    return books


def src_ref(sid: str, sheet: str, excel_row: int, width: int, values: dict) -> dict:
    meta = SOURCE_FILES[sid]
    cr = col_coords(width, excel_row)
    return {
        "source_id": sid,
        "source_version": meta["version"],
        "file": meta["file"],
        "file_sha256": meta["sha256"],
        "sheet": sheet,
        "excel_row": excel_row,
        "cell_range": cr,
        "row_sha256": row_sha256(sheet, excel_row, values),
        "locator": f"file={meta['file']};sha256={meta['sha256']};sheet={sheet};row={excel_row};cells={cr}",
    }


def build(samples_dir: str, release: str) -> dict:
    books = load_sources(samples_dir)
    weed_book = books["src_gengyun_weed_summary_workbook"]
    herb_book = books["src_gengyun_herbicide_risk_workbook"]

    province = sheet_by_name(weed_book, PROVINCE_SHEET)
    master = sheet_by_name(weed_book, WEED_MASTER_SHEET)
    timing = sheet_by_name(weed_book, TIMING_SHEET)
    herb = sheet_by_name(herb_book, HERB_SHEET)

    # ---- 省份行（浙江）----
    zj_row = None
    for row in province["rows"][1:]:
        if cval(row["cells"], row["excel_row"], "A") == "浙江":
            zj_row = row["excel_row"]
    if zj_row is None:
        raise ExtractionError("省份索引表未找到「浙江」行")
    zj_raw = row_cells(province, zj_row)
    zj_values = row_values(zj_raw)
    zj_province = {
        "province": cval(zj_raw, zj_row, "A"),
        "macro_region": cval(zj_raw, zj_row, "B"),
        "weed_count_text": cval(zj_raw, zj_row, "C"),
        "weed_list": split_list(cval(zj_raw, zj_row, "D")),
        "main_crops_text": cval(zj_raw, zj_row, "E"),
        "source": src_ref("src_gengyun_weed_summary_workbook", PROVINCE_SHEET, zj_row, 5,
                          zj_values),
    }
    zj_province["main_crops"] = split_list(zj_province["main_crops_text"])
    province_list = set(zj_province["weed_list"])

    # ---- 杂草总表：省名单命中 ∪ 分布字段含浙江 ----
    weeds = []
    for row in master["rows"][1:]:
        r = row["excel_row"]
        cells = row["cells"]
        a = cval(cells, r, "A")
        canon = canonical_name(a)
        e = cval(cells, r, "E")
        evidence = []
        if canon and canon in province_list:
            evidence.append("province_index_name_match")
        if "浙江" in e:
            evidence.append("distribution_lists_zhejiang")
        if not evidence:
            continue
        note, provinces = split_distribution(e)
        item = {
            "item_id": f"zj-weed-r{r}",
            "weed_name": a,
            "canonical_name": canon,
            "parenthetical_aliases": paren_aliases(a),
            "scientific_name": cval(cells, r, "B"),
            "family_genus": cval(cells, r, "C"),
            "companion_crops_text": cval(cells, r, "D"),
            "companion_crops": split_list(cval(cells, r, "D")),
            "distribution_text": e,
            "distribution_note": note,
            "distribution_provinces": provinces,
            "growth_stages_text": cval(cells, r, "F"),
            "best_control_stage_text": cval(cells, r, "G"),
            "spray_window_text": cval(cells, r, "H"),
            "identification_key_text": cval(cells, r, "I"),
            "zhejiang_selection": evidence,
            "zhejiang_evidence_strength": ("distribution_field" if "distribution_lists_zhejiang" in evidence
                                           else "name_only"),
            "source": src_ref("src_gengyun_weed_summary_workbook", WEED_MASTER_SHEET, r, 9,
                              row_values(cells)),
        }
        weeds.append(item)
    weeds_total = len(master["rows"]) - 1
    name_only = [w["weed_name"] for w in weeds if w["zhejiang_evidence_strength"] == "name_only"]

    # 省名单里在总表定位不到的名字（应为空；非空即缺口）
    unresolved = [n for n in zj_province["weed_list"] if n not in {w["canonical_name"] for w in weeds}]

    # ---- 防除时期速查 ----
    timings = []
    for row in timing["rows"][1:]:
        r = row["excel_row"]
        cells = row["cells"]
        scene = cval(cells, r, "A")
        base = re.split(r"[（(／/]", scene)[0].strip()
        crops = [c for c in zj_province["main_crops"]
                 if c and (c in scene or (base and (base in c or c in base)))]
        if any(x in scene for x in ("非耕地", "田埂", "铁路", "公路", "沟渠")):
            crops = []
        zhejiang_scope = "scene_matches_zhejiang_main_crop" if crops else "no_zhejiang_link_in_workbook"
        timings.append({
            "item_id": f"zj-timing-r{r}",
            "scene_text": scene,
            "critical_window_text": cval(cells, r, "B"),
            "target_weeds_text": cval(cells, r, "C"),
            "key_points_text": cval(cells, r, "D"),
            "zhejiang_scope": zhejiang_scope,
            "zhejiang_scope_basis": (
                "场景作物与省份索引表浙江行（r%d）主要作物一致：%s" % (zj_row, "、".join(crops))
                if crops else
                "本工作簿未给出该场景与浙江的对应关系（省份索引表浙江行主要作物为 %s）"
                % "、".join(zj_province["main_crops"])),
            "matched_main_crops": crops,
            "source": src_ref("src_gengyun_weed_summary_workbook", TIMING_SHEET, r, 4,
                              row_values(cells)),
        })

    # ---- 除草剂汇总表 ----
    herbicides = []
    for row in herb["rows"][1:]:
        r = row["excel_row"]
        cells = row["cells"]
        region = cval(cells, r, "F")
        evidence = "not_evidenced"
        tokens = []
        for level in ZHEJIANG_EVIDENCE_ORDER:
            hit = [t for t in REGION_TOKENS.get(level, []) if t in region]
            if hit:
                evidence = level
                tokens = hit
                break
        herbicides.append({
            "item_id": f"zj-herbicide-r{r}",
            "herbicide_name": cval(cells, r, "A"),
            "aliases_text": cval(cells, r, "B"),
            "hazard_level_text": cval(cells, r, "C"),
            "hazard_detail_text": cval(cells, r, "D"),
            "target_weeds_text": cval(cells, r, "E"),
            "region_text": region,
            "zhejiang_evidence": evidence,
            "matched_region_tokens": tokens,
            "zhejiang_basis": REGION_BASIS[evidence],
            "in_zhejiang_first_batch": evidence in ("zhejiang_explicit", "yangtze_mid_lower_xref"),
            # 缺项：源表无用量/施用方法/注意事项列
            "dose_text": None,
            "dose_status": "absent_in_source",
            "application_method_text": None,
            "application_method_status": "absent_in_source",
            "precautions_text": None,
            "precautions_status": "absent_in_source",
            "registration_number": None,
            "registration_number_status": "absent_in_source",
            "usable_as_dose": False,
            "card_ready": False,
            "source": src_ref("src_gengyun_herbicide_risk_workbook", HERB_SHEET, r, 6,
                              row_values(cells)),
        })

    # ---- 说明与使用提示：只抽使用约束行 ----
    notes = []
    for sid, book in (("src_gengyun_weed_summary_workbook", weed_book),
                      ("src_gengyun_herbicide_risk_workbook", herb_book)):
        sheet = sheet_by_name(book, NOTES_SHEET)
        patterns = NOTE_FILTERS[SOURCE_FILES[sid]["file"]]
        for row in sheet["rows"]:
            r = row["excel_row"]
            text = cval(row["cells"], r, "A")
            if not text:
                continue
            if not any(re.search(p, text) for p in patterns):
                continue
            topic = next((t for t, kws in NOTE_TOPIC_HINTS if any(k in text for k in kws)), "其他")
            notes.append({
                "item_id": f"zj-note-{sid.split('_')[2]}-r{r}",
                "topic": topic,
                "text": text,
                "source": src_ref(sid, NOTES_SHEET, r, 1, row_values(row["cells"])),
            })

    first_batch_herb = [h for h in herbicides if h["in_zhejiang_first_batch"]]
    timing_linked = [t for t in timings if t["zhejiang_scope"] == "scene_matches_zhejiang_main_crop"]

    doc = {
        "schema": "gengyun.knowledge.zhejiang-materials.v1",
        "dataset": "zhejiang-first-batch",
        "release": release,
        "generated_by": "tools/knowledge/extract_zhejiang_materials.py",
        "generator_version": GENERATOR_VERSION,
        "region": {"code": REGION_CODE, "name": REGION_NAME,
                   "macro_region_from_source": zj_province["macro_region"]},
        "extraction_discipline": [
            "原工作簿与原始媒体保存在仓库外，一律不入库；仓内只有带来源引用的派生条目。",
            "有界读取：复用 import_workbook_staging.inspect_workbook（≤25MB、拒绝外部链接工作表、不执行公式）。",
            "先按 MANIFEST sha256 校验整份文件，再逐行抽取。",
            "每条记录带 file_sha256/sheet/excel_row/cell_range/row_sha256/locator，可逐条回源复核。",
            "缺列不补造：两份工作簿无「标签原文用量」列，dose/method/precautions 一律 null 且注明 absent_in_source。",
            "适用性只按源字段显式证据分级，不做跨表插值；浙江适用性证据与依据逐条记录。",
        ],
        "sources": [
            {
                "id": sid,
                "title": meta["title"],
                "publisher": "用户提供的整理稿（发布方未标注）",
                "canonical_url": "repo-external://samples/" + meta["file"],
                "source_kind": meta["source_kind"],
                "evidence_kind": meta["evidence_kind"],
                "version": meta["version"],
                "file": {"name": meta["file"], "sha256": meta["sha256"], "bytes": meta["bytes"]},
                "manifest_ref": "仓外样本目录 MANIFEST.md（路径映射不写入仓库）",
                "sheet_inventory": meta["sheet_inventory"],
                "validity": "valid",
                "review_status": "unverified",
                "retrieved_at": release,
                "license": {
                    "survey_status": "deferred",
                    "licensed": False,
                    "note": "许可调查暂缓；未获许可，不得写为已许可。原文件不入库。",
                },
                "authority": "none_asserted_by_source",
                "note": "整理稿，未标注逐条权威出处；本仓库只登记可复核的派生条目，不代其声明权威性。",
            }
            for sid, meta in SOURCE_FILES.items()
        ],
        "province_index_entry": zj_province,
        "weed_items": weeds,
        "control_timing_items": timings,
        "herbicide_items": herbicides,
        "usage_notes": notes,
        "dosage_policy": {
            "dose_text": "absent_in_source",
            "application_method_text": "absent_in_source",
            "precautions_text": "absent_in_source",
            "summary": "两份工作簿字段仅为名称/别称/危害等级/危害/防除对象/适用地区与杂草九栏，无标签原文用量、施用方法、注意事项、安全间隔期；严禁据此推断或补造用量，DoseCard 一律不可生成。",
            "required_authority_for_dose": "中国农药信息网登记信息、产品标签及当地植保部门指导（源表自述）",
        },
        "coverage": {
            "weed_master_rows_total": weeds_total,
            "weed_items_selected": len(weeds),
            "weed_selected_with_distribution_evidence": sum(
                1 for w in weeds if w["zhejiang_evidence_strength"] == "distribution_field"),
            "weed_selected_name_only": len(name_only),
            "weed_name_only_examples": name_only,
            "province_index_weed_names": len(zj_province["weed_list"]),
            "province_index_names_unresolved_in_master": unresolved,
            "control_timing_rows_total": len(timings),
            "control_timing_items_linked_to_zhejiang": len(timing_linked),
            "control_timing_items_unlinked": len(timings) - len(timing_linked),
            "herbicide_rows_total": len(herbicides),
            "herbicide_first_batch": len(first_batch_herb),
            "herbicide_explicit_zhejiang": sum(
                1 for h in herbicides if h["zhejiang_evidence"] == "zhejiang_explicit"),
            "herbicide_yangtze_xref": sum(
                1 for h in herbicides if h["zhejiang_evidence"] == "yangtze_mid_lower_xref"),
            "herbicide_regional_inference": sum(
                1 for h in herbicides if h["zhejiang_evidence"] == "regional_inference"),
            "herbicide_not_evidenced": sum(
                1 for h in herbicides if h["zhejiang_evidence"] == "not_evidenced"),
            "usage_note_rows_selected": len(notes),
            "rows_with_row_sha256": (len(weeds) + len(timings) + len(herbicides) + len(notes)
                                     + 1),
        },
        "gaps": [
            {"id": "gap-dose", "item": "标签原文用量 / DoseCard",
             "status": "absent_in_source",
             "detail": "所给两份工作簿不含用量、施用方法、注意事项、安全间隔期字段；本轮不推断、不补造，usable_as_dose=false、card_ready=false。"},
            {"id": "gap-authority", "item": "逐条权威出处",
             "status": "unverified",
             "detail": "工作簿为整理稿，未标注逐条权威出处；review_status=unverified，不进入 v_active_source_version。"},
            {"id": "gap-license", "item": "再分发许可",
             "status": "deferred",
             "detail": "许可调查暂缓；原文件不入库，licensed=false，不得写为已许可。"},
            {"id": "gap-crops", "item": "作物目录外场景",
             "status": "blocked_on_scope",
             "detail": "浙江行主要作物为 %s；首批 crop 目录只有水稻/玉米/大豆/油菜，蔬菜/茶园/果园/蚕豆 无 crop_id，需需求确认后扩充，本轮不自行扩目录。" % zj_province["main_crops_text"]},
            {"id": "gap-timing-unlinked", "item": "防除时期速查未取证场景",
             "status": "deferred",
             "detail": "%d 行场景（如玉米、大豆、花生／棉花等）本工作簿未给出与浙江的对应关系，保留在清单但不入首批库。" % (len(timings) - len(timing_linked))},
            {"id": "gap-herbicide-outside", "item": "除草剂非首批条目",
             "status": "deferred",
             "detail": "%d 行仅含其他大区/全国泛称，无浙江或长江中下游证据，保留在清单但不入首批库。" % (len(herbicides) - len(first_batch_herb))},
            {"id": "gap-science-eval", "item": "八组科普评估（GY-I03 的一部分）",
             "status": "not_done",
             "detail": "需既定评估方案与真实来源核对，本轮未做，不标通过。"},
            {"id": "gap-runtime", "item": "云库 / 受控 HTTPS / 正式 real 启动 / 双手机真机",
             "status": "not_done",
             "detail": "本轮不触碰生产库、不发起付费调用；未跑的项不写通过。#3 不因本交付关闭。"},
        ],
    }
    return doc


def dumps(doc: dict) -> str:
    return json.dumps(doc, ensure_ascii=False, indent=2) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples-dir", required=True, help="仓外只读样本目录")
    ap.add_argument("--out", default=os.path.join("packages", "knowledge", "zhejiang",
                                                  "materials-zhejiang-v1.json"))
    ap.add_argument("--release", default="2026-10-14")
    ap.add_argument("--verify", action="store_true", help="只比对已提交文件与重算结果，不写入")
    args = ap.parse_args()

    try:
        doc = build(args.samples_dir, args.release)
    except ExtractionError as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    text = dumps(doc)

    if args.verify:
        if not os.path.exists(args.out):
            print(f"FAIL: 缺少已提交清单 {args.out}", file=sys.stderr)
            return 1
        with open(args.out, encoding="utf-8") as fh:
            existing = fh.read()
        # 检出时可能因 core.autocrlf 变成 CRLF；比对前统一换行符。
        same = existing.replace("\r\n", "\n") == text
        print(f"verify: committed={len(existing)}B recomputed={len(text)}B identical={same}")
        if not same:
            print("FAIL: 重算结果与已提交清单不一致（样本或抽取逻辑已变）", file=sys.stderr)
            return 1
        print("PASS: 清单可由仓外样本确定性重算")
        return 0

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)
    cov = doc["coverage"]
    print(f"wrote {args.out}: {len(text.encode('utf-8'))} bytes")
    for k in sorted(cov):
        print(f"  {k} = {cov[k]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

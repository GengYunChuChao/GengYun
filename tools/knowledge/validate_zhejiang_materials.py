#!/usr/bin/env python3
"""GY-I03 浙江首批资料清单校验（仅 Python 标准库，可独立运行）。

校验对象：
  * packages/knowledge/zhejiang/materials-zhejiang-v1.json（浙江首批资料派生清单）
  * db/seeds/seed_zhejiang_materials.sql、db/seeds/rollback_zhejiang_materials.sql（本批次种子/回滚）
  * 只读消费 packages/knowledge/catalog/*.json（作物/物种目录），不修改任何文件

设计原则（与 tools/knowledge/validate_knowledge.py 一致）：
  * 失败即非 0 退出并逐条报错，不静默跳过；重复运行结果一致；除 `--emit-report` 外不改写文件。
  * **缺项不得补造**：源工作簿无「标签原文用量」列，任何非空 dose/用量字段一律判为失败。
  * 每条记录必须可回源：source_id / file_sha256 / sheet / excel_row / cell_range / row_sha256 / locator。
  * 来源必须 review_status=unverified（作者侧不是法定审核责任人），不得标 validated/verified。

用法：
  python tools/knowledge/validate_zhejiang_materials.py --root .
  python tools/knowledge/validate_zhejiang_materials.py --root . --samples-dir <仓外样本目录>
  python tools/knowledge/validate_zhejiang_materials.py --root . --emit-report out.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import uuid

HEX64 = re.compile(r"^[0-9a-f]{64}$")
REGION_CODE = "330000"
MANDATORY_GAPS = {"gap-dose", "gap-science-eval", "gap-runtime"}
HERB_EVIDENCE = {"zhejiang_explicit", "yangtze_mid_lower_xref", "regional_inference", "not_evidenced"}
WEED_STRENGTH = {"distribution_field", "name_only"}
DOSE_FORBIDDEN_KEYS = ("dose_text", "dosage_text", "dose", "dosage", "rate_text",
                       "concentration_text", "label_text", "unit_text")
DOSE_STATUS_KEYS = ("dose_status", "application_method_status", "precautions_status",
                    "registration_number_status")


class Fail(Exception):
    pass


def load(path: str):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        raise Fail(f"缺少文件：{path}")
    except json.JSONDecodeError as exc:
        raise Fail(f"JSON 解析失败 {path}: {exc}")


def uid(key: str) -> str:
    return str(uuid.uuid5(uuid.UUID("6ba7b811-9dad-11d1-80b4-00c04fd430c8"), key))


def iter_items(doc: dict):
    for group in ("weed_items", "control_timing_items", "herbicide_items", "usage_notes"):
        for it in doc.get(group, []):
            yield group, it


def check_source_ref(where, item, src_by_id, errors):
    ref = item.get("source")
    if not isinstance(ref, dict):
        errors.append(f"{where}: 缺 source 来源引用")
        return
    sid = ref.get("source_id")
    src = src_by_id.get(sid)
    if src is None:
        errors.append(f"{where}: source_id {sid!r} 未在清单 sources 中登记")
        return
    for key in ("sheet", "excel_row", "cell_range", "row_sha256", "locator", "file_sha256",
                "file", "source_version"):
        if ref.get(key) in (None, ""):
            errors.append(f"{where}: source 缺字段 {key}")
    if ref.get("file_sha256") != src["file"]["sha256"]:
        errors.append(f"{where}: source.file_sha256 与来源声明的文件哈希不一致")
    if ref.get("source_version") != src["version"]:
        errors.append(f"{where}: source.source_version 与来源版本不一致")
    if ref.get("sheet") not in src.get("sheet_inventory", []):
        errors.append(f"{where}: sheet {ref.get('sheet')!r} 不在来源工作表清单内")
    if not isinstance(ref.get("excel_row"), int) or ref.get("excel_row", 0) < 2:
        errors.append(f"{where}: excel_row 非法 {ref.get('excel_row')!r}（数据行应 ≥ 2）")
    if not HEX64.match(str(ref.get("row_sha256", ""))):
        errors.append(f"{where}: row_sha256 非 64 位十六进制")
    cr = str(ref.get("cell_range", ""))
    if not re.fullmatch(r"[A-Z]{1,2}\d+:[A-Z]{1,2}\d+", cr):
        errors.append(f"{where}: cell_range 格式非法 {cr!r}")
    elif not cr.endswith(str(ref.get("excel_row"))):
        errors.append(f"{where}: cell_range {cr} 与 excel_row {ref.get('excel_row')} 不匹配")
    loc = str(ref.get("locator", ""))
    for token in (str(ref.get("sheet")), f"row={ref.get('excel_row')}",
                  src["file"]["sha256"], src["file"]["name"]):
        if token not in loc:
            errors.append(f"{where}: locator 缺少可回源信息 {token!r}")


def scan_dose(obj, where, errors, path=""):
    """递归：任何非空用量类字段一律失败（源表无此列）。"""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in DOSE_FORBIDDEN_KEYS and v not in (None, "", False) and k != "unit_text":
                errors.append(f"{where}{path}.{k}: 源工作簿无用量列，非空值即视为补造（{v!r}）")
            scan_dose(v, where, errors, f"{path}.{k}")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            scan_dose(v, where, errors, f"{path}[{i}]")


def validate(root: str, samples_dir: str | None) -> tuple[list[str], dict]:
    errors: list[str] = []
    stats: dict = {}
    k = os.path.join(root, "packages", "knowledge")
    path = os.path.join(k, "zhejiang", "materials-zhejiang-v1.json")
    doc = load(path)

    if doc.get("schema") != "gengyun.knowledge.zhejiang-materials.v1":
        errors.append(f"schema 非法：{doc.get('schema')!r}")
    region = doc.get("region", {})
    if region.get("code") != REGION_CODE:
        errors.append(f"region.code 必须为 {REGION_CODE}，实际 {region.get('code')!r}")
    pi = doc.get("province_index_entry", {})
    if pi.get("province") != "浙江":
        errors.append(f"province_index_entry.province 应为「浙江」，实际 {pi.get('province')!r}")

    # ---- 来源登记 ----
    sources = doc.get("sources", [])
    src_by_id = {}
    for s in sources:
        sid = s.get("id")
        if not sid:
            errors.append("来源缺 id")
            continue
        if sid in src_by_id:
            errors.append(f"来源 id 重复：{sid}")
        src_by_id[sid] = s
        f = s.get("file", {})
        if not HEX64.match(str(f.get("sha256", ""))):
            errors.append(f"source {sid}: file.sha256 非法")
        if s.get("review_status") != "unverified":
            errors.append(f"source {sid}: 作者侧必须是 review_status=unverified，实际 {s.get('review_status')!r}")
        if s.get("validity") != "valid":
            errors.append(f"source {sid}: validity 应为 valid，实际 {s.get('validity')!r}")
        if s.get("license", {}).get("licensed"):
            errors.append(f"source {sid}: 许可调查暂缓，licensed 不得为 true")
        if not s.get("sheet_inventory"):
            errors.append(f"source {sid}: 缺 sheet_inventory")
    stats["sources"] = len(sources)

    # ---- 逐条来源引用 ----
    ids = {}
    counts = {"weed_items": 0, "control_timing_items": 0, "herbicide_items": 0, "usage_notes": 0}
    for group, item in iter_items(doc):
        counts[group] += 1
        where = f"{group}/{item.get('item_id')}"
        iid = item.get("item_id")
        if not iid:
            errors.append(f"{where}: 缺 item_id")
        elif iid in ids:
            errors.append(f"{where}: item_id 重复（另一处 {ids[iid]}）")
        else:
            ids[iid] = where
        check_source_ref(where, item, src_by_id, errors)
    stats.update(counts)
    for key in ("weed_items", "control_timing_items", "herbicide_items"):
        if counts[key] == 0:
            errors.append(f"{key} 为空：清单不得整项丢失")

    # ---- 用量缺项门（不得补造）----
    pol = doc.get("dosage_policy", {})
    for key in ("dose_text", "application_method_text", "precautions_text"):
        if pol.get(key) != "absent_in_source":
            errors.append(f"dosage_policy.{key} 应为 absent_in_source，实际 {pol.get(key)!r}")
    for h in doc.get("herbicide_items", []):
        where = f"herbicide_items/{h.get('item_id')}"
        for key in ("dose_text", "application_method_text", "precautions_text", "registration_number"):
            if h.get(key) is not None:
                errors.append(f"{where}: {key} 必须为 null（源表无标签原文用量/登记号）")
        for key in DOSE_STATUS_KEYS:
            if h.get(key) != "absent_in_source":
                errors.append(f"{where}: {key} 应为 absent_in_source，实际 {h.get(key)!r}")
        if h.get("usable_as_dose") is not False:
            errors.append(f"{where}: usable_as_dose 必须为 false")
        if h.get("card_ready") is not False:
            errors.append(f"{where}: card_ready 必须为 false")
        ev = h.get("zhejiang_evidence")
        if ev not in HERB_EVIDENCE:
            errors.append(f"{where}: zhejiang_evidence 非法 {ev!r}")
        elif h.get("in_zhejiang_first_batch") != (ev in ("zhejiang_explicit", "yangtze_mid_lower_xref")):
            errors.append(f"{where}: in_zhejiang_first_batch 与证据等级 {ev} 不一致")
        if not h.get("zhejiang_basis"):
            errors.append(f"{where}: 缺 zhejiang_basis 依据说明")
    scan_dose(doc.get("herbicide_items", []), "herbicide_items", errors)

    for w in doc.get("weed_items", []):
        where = f"weed_items/{w.get('item_id')}"
        if w.get("zhejiang_evidence_strength") not in WEED_STRENGTH:
            errors.append(f"{where}: zhejiang_evidence_strength 非法 {w.get('zhejiang_evidence_strength')!r}")
        if not w.get("zhejiang_selection"):
            errors.append(f"{where}: 缺 zhejiang_selection 选取依据")
        if "浙江" not in (w.get("distribution_text") or "") and w.get("zhejiang_evidence_strength") != "name_only":
            errors.append(f"{where}: 非 name_only 却未在分布字段列浙江")
    for t in doc.get("control_timing_items", []):
        where = f"control_timing_items/{t.get('item_id')}"
        if t.get("zhejiang_scope") not in ("scene_matches_zhejiang_main_crop",
                                           "no_zhejiang_link_in_workbook"):
            errors.append(f"{where}: zhejiang_scope 非法 {t.get('zhejiang_scope')!r}")
        if not t.get("zhejiang_scope_basis"):
            errors.append(f"{where}: 缺 zhejiang_scope_basis")

    # ---- 覆盖统计自洽 ----
    cov = doc.get("coverage", {})
    expect = {
        "weed_items_selected": counts["weed_items"],
        "control_timing_rows_total": counts["control_timing_items"],
        "herbicide_rows_total": counts["herbicide_items"],
        "usage_note_rows_selected": counts["usage_notes"],
        "weed_selected_with_distribution_evidence": sum(
            1 for w in doc["weed_items"] if w["zhejiang_evidence_strength"] == "distribution_field"),
        "weed_selected_name_only": sum(
            1 for w in doc["weed_items"] if w["zhejiang_evidence_strength"] == "name_only"),
        "herbicide_first_batch": sum(1 for h in doc["herbicide_items"] if h["in_zhejiang_first_batch"]),
        "herbicide_explicit_zhejiang": sum(
            1 for h in doc["herbicide_items"] if h["zhejiang_evidence"] == "zhejiang_explicit"),
        "herbicide_yangtze_xref": sum(
            1 for h in doc["herbicide_items"] if h["zhejiang_evidence"] == "yangtze_mid_lower_xref"),
        "herbicide_regional_inference": sum(
            1 for h in doc["herbicide_items"] if h["zhejiang_evidence"] == "regional_inference"),
        "herbicide_not_evidenced": sum(
            1 for h in doc["herbicide_items"] if h["zhejiang_evidence"] == "not_evidenced"),
        "province_index_weed_names": len(pi.get("weed_list", [])),
        "rows_with_row_sha256": counts["weed_items"] + counts["control_timing_items"]
                                + counts["herbicide_items"] + counts["usage_notes"] + 1,
    }
    for key, want in expect.items():
        if cov.get(key) != want:
            errors.append(f"coverage.{key} 与实际不符：声明 {cov.get(key)!r}，实际 {want}")
    stats["coverage_checked"] = len(expect)

    # ---- 必须如实标注的缺项（不得整项关闭）----
    gap_ids = {g.get("id") for g in doc.get("gaps", [])}
    missing_gaps = MANDATORY_GAPS - gap_ids
    if missing_gaps:
        errors.append(f"gaps 缺必列缺项：{sorted(missing_gaps)}")
    for g in doc.get("gaps", []):
        for key in ("id", "item", "status", "detail"):
            if not g.get(key):
                errors.append(f"gap {g.get('id')}: 缺 {key}")
    stats["gaps"] = len(doc.get("gaps", []))

    # ---- 种子 SQL 与 JSON 一致（含幂等/回滚文件）----
    seed_p = os.path.join(root, "db", "seeds", "seed_zhejiang_materials.sql")
    rb_p = os.path.join(root, "db", "seeds", "rollback_zhejiang_materials.sql")
    db_items = [w["item_id"] for w in doc["weed_items"]]
    db_items += [t["item_id"] for t in doc["control_timing_items"]
                 if t["zhejiang_scope"] == "scene_matches_zhejiang_main_crop"]
    db_items += [h["item_id"] for h in doc["herbicide_items"] if h["in_zhejiang_first_batch"]]
    stats["db_target_items"] = len(db_items)
    for p in (seed_p, rb_p):
        if not os.path.exists(p):
            errors.append(f"缺少种子/回滚文件：{p}")
    if os.path.exists(seed_p):
        text = open(seed_p, encoding="utf-8").read()
        if "BEGIN;" not in text or text.count("COMMIT;") < 1:
            errors.append("种子 SQL 缺 BEGIN/COMMIT")
        insert_count = text.count("INSERT INTO knowledge_versions")
        if insert_count != len(db_items):
            errors.append(f"种子 SQL knowledge_versions 插入数 {insert_count} != 清单应入库 {len(db_items)}")
        for iid in db_items:
            if f'"item_id":"{iid}"' not in text:
                errors.append(f"种子 SQL 缺条目 {iid}（JSON 与 SQL 不一致）")
        leaked = re.findall(r'"dose_text":\s*"[^"]', text)
        if leaked:
            errors.append(f"种子 SQL 出现非空 dose_text 字面量：{leaked[:3]}")
        if '"dose_text":null' not in text:
            errors.append("种子 SQL 未显式写入 dose_text null")
        if text.count("ON CONFLICT (id) DO NOTHING") < len(db_items):
            errors.append("种子 SQL 幂等 ON CONFLICT 覆盖不足")
    if os.path.exists(rb_p):
        text = open(rb_p, encoding="utf-8").read()
        for s in sources:
            for key in (f"source:{s['id']}", f"source_version:{s['id']}:{s['version']}"):
                if uid(key) not in text:
                    errors.append(f"回滚 SQL 缺本批次 id {key}")
        tables = set(re.findall(r"DELETE FROM\s+([a-z_]+)", text))
        allowed = {"knowledge_versions", "catalog_source_update_events", "source_versions", "sources"}
        if not tables:
            errors.append("回滚 SQL 未删除任何本批次行")
        if tables - allowed:
            errors.append(f"回滚 SQL 触碰本批次范围外的表：{sorted(tables - allowed)}")
        if "UPDATE catalog_import_runs SET status='reverted'" not in text:
            errors.append("回滚 SQL 未标记本批次导入运行 reverted")
    stats["seed_sql_items"] = stats["db_target_items"]

    # ---- 与 packages/knowledge/coverage-report.json 的浙江块保持同步 ----
    cov_p = os.path.join(k, "coverage-report.json")
    if not os.path.exists(cov_p):
        errors.append("缺少 packages/knowledge/coverage-report.json")
    else:
        blk = (load(cov_p) or {}).get("zhejiang_first_batch")
        if not isinstance(blk, dict):
            errors.append("coverage-report.json 缺 zhejiang_first_batch 块")
        else:
            want = {
                "weed_items": counts["weed_items"],
                "control_timing_items": sum(
                    1 for t in doc["control_timing_items"]
                    if t["zhejiang_scope"] == "scene_matches_zhejiang_main_crop"),
                "herbicide_items": sum(1 for h in doc["herbicide_items"] if h["in_zhejiang_first_batch"]),
                "db_knowledge_rows": len(db_items),
            }
            for key, val in want.items():
                got = (blk.get("selected") or {}).get(key)
                if got != val:
                    errors.append(f"coverage-report.json zhejiang_first_batch.selected.{key} "
                                  f"与清单不符：声明 {got!r}，实际 {val}")
            declared = {s.get("sha256") for s in blk.get("sources", [])}
            for s in sources:
                if s["file"]["sha256"] not in declared:
                    errors.append(f"coverage-report.json 缺来源哈希 {s['file']['sha256'][:12]}…")
            if blk.get("review_status") != "unverified":
                errors.append("coverage-report.json 浙江块 review_status 必须为 unverified")
            if (blk.get("dose") or {}).get("dose_text") != "absent_in_source":
                errors.append("coverage-report.json 浙江块 dose_text 必须为 absent_in_source")
    stats["coverage_report_synced"] = True

    # ---- 可选：用仓外样本确定性重算并逐字节比对 ----
    if samples_dir:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import extract_zhejiang_materials as ext  # noqa: E402
        try:
            rebuilt = ext.dumps(ext.build(samples_dir, doc["release"]))
        except ext.ExtractionError as exc:
            errors.append(f"仓外样本重算失败：{exc}")
        else:
            # 检出时可能因 core.autocrlf 变成 CRLF；比对前统一换行符。
            with open(path, encoding="utf-8") as fh:
                committed = fh.read()
            if rebuilt != committed.replace("\r\n", "\n"):
                errors.append("仓外样本重算结果与已提交清单不一致（来源或抽取逻辑已变）")
            else:
                stats["recompute_from_samples"] = "identical"
                digest = hashlib.sha256(rebuilt.encode("utf-8")).hexdigest()
                stats["recomputed_sha256"] = digest

    return errors, stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--samples-dir", default=None,
                    help="仓外只读样本目录；给出时额外做确定性重算比对")
    ap.add_argument("--emit-report", default=None)
    args = ap.parse_args()

    try:
        errors, stats = validate(args.root, args.samples_dir)
    except Fail as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1

    print("== GY-I03 浙江首批资料清单校验 ==")
    for key in sorted(stats):
        print(f"  {key} = {stats[key]}")
    if errors:
        print(f"\nFAIL: {len(errors)} 项")
        for e in errors:
            print(f"  - {e}")
        return 1
    print("\nPASS: 来源可回源、用量缺项未被补造、覆盖自洽、种子与回滚一致")
    if args.emit_report:
        report = {"stats": stats, "errors": [], "status": "pass"}
        with open(args.emit_report, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        print(f"报告写入 {args.emit_report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

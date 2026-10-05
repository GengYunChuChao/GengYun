#!/usr/bin/env python3
"""GY-I03 资料清单与适配层校验（仅 Python 标准库，可独立运行）。

校验对象：
  packages/knowledge/catalog/*.json、packages/knowledge/herbicides/records-2026.json、
  db/seeds/*.sql、契约枚举 packages/contracts/states.json（只读消费，不修改）。

设计原则：
  * 失败即非 0 退出并逐条报错，不静默跳过。
  * 重复运行结果一致（幂等），不改写任何文件（除非 `--emit-report`）。
  * 缺字段/未核对/模拟不得被标为可用；真实记录不得使用 SIM- 前缀。

用法：
  python tools/knowledge/validate_knowledge.py --root .
  python tools/knowledge/validate_knowledge.py --root . --mode real
  python tools/knowledge/validate_knowledge.py --root . --emit-report out.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

REQUIRED_CROPS = {"水稻", "玉米", "大豆", "油菜"}
REQUIRED_GROUPS = {"稗草", "狗尾草", "荨麻类", "马唐", "牛筋草", "看麦娘", "藜", "空心莲子草"}
ALLOWED_RECORD_STATUS = {"partial", "verified_complete", "expired", "conflicting", "missing", "unverified"}
REAL_REG_NUMBER = re.compile(r"^PD[0-9]{8}$|^[A-Z]{1,4}[0-9]{4,12}$|^LS[0-9]{6,}$")


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


def check_enum(value, allowed, where, errors):
    if value not in allowed:
        errors.append(f"{where}: 值 {value!r} 不在允许枚举 {sorted(allowed)}")


def validate(root: str, mode: str | None) -> tuple[list[str], dict]:
    errors: list[str] = []
    stats: dict = {}
    k = os.path.join(root, "packages", "knowledge")

    # ---- 契约枚举（只读）----
    states = load(os.path.join(root, "packages", "contracts", "states.json"))
    enums = states["states"]
    source_kinds = set(enums["SourceKind"])
    evidence_kinds = set(enums["EvidenceKind"])
    exec_modes = set(enums["ExecutionMode"])
    if mode is not None and mode not in exec_modes:
        errors.append(f"--mode {mode!r} 不在 ExecutionMode 枚举 {sorted(exec_modes)}")

    # ---- 区划 ----
    regions = load(os.path.join(k, "catalog", "regions-zhejiang.json"))
    codes = [r["code"] for r in regions["regions"]]
    if len(codes) != len(set(codes)):
        errors.append("区划代码存在重复")
    if "330000" not in codes:
        errors.append("区划缺少 330000 浙江省")
    by_code = {r["code"]: r for r in regions["regions"]}
    for r in regions["regions"]:
        if not re.fullmatch(r"33\d{4}", r["code"]):
            errors.append(f"区划代码格式错误：{r['code']}")
        if r["parent_code"] is not None and r["parent_code"] not in by_code:
            errors.append(f"区划 {r['code']} 的 parent_code {r['parent_code']} 不存在")
        if r["level"] not in ("province", "prefecture", "county"):
            errors.append(f"区划 {r['code']} level 非法：{r['level']}")
    stats["regions_total"] = len(codes)
    stats["regions_prefecture"] = sum(1 for r in regions["regions"] if r["level"] == "prefecture")
    stats["regions_county"] = sum(1 for r in regions["regions"] if r["level"] == "county")
    if stats["regions_prefecture"] != 11:
        errors.append(f"预取 11 个地市，实际 {stats['regions_prefecture']}")
    if stats["regions_county"] < 80:
        errors.append(f"县级条目过少：{stats['regions_county']}")

    # ---- 作物 ----
    crops = load(os.path.join(k, "catalog", "crops.json"))["crops"]
    crop_names = {c["name"] for c in crops}
    missing_crops = REQUIRED_CROPS - crop_names
    if missing_crops:
        errors.append(f"缺少作物：{sorted(missing_crops)}")
    crop_ids = {c["id"] for c in crops}
    stats["crops"] = len(crops)

    # ---- 物种 ----
    species = load(os.path.join(k, "catalog", "species.json"))["species"]
    group_names = {s["group_name"] for s in species}
    missing_groups = REQUIRED_GROUPS - group_names
    if missing_groups:
        errors.append(f"缺少杂草组：{sorted(missing_groups)}")
    if len(species) != 8:
        errors.append(f"物种组应为 8，实际 {len(species)}")
    species_ids = {s["id"] for s in species}
    stats["species_groups"] = len(species)

    # ---- 来源 ----
    sources_doc = load(os.path.join(k, "catalog", "sources.json"))
    sources = sources_doc["sources"]
    src_by_id = {s["id"]: s for s in sources}
    urls_seen = set()
    for s in sources:
        where = f"source {s['id']}"
        check_enum(s["source_kind"], source_kinds, where + ".source_kind", errors)
        check_enum(s["evidence_kind"], evidence_kinds, where + ".evidence_kind", errors)
        if not str(s["canonical_url"]).startswith(("https://", "http://")):
            errors.append(f"{where}: canonical_url 非法 {s['canonical_url']!r}")
        lic = s.get("license", {})
        if lic.get("licensed") and lic.get("survey_status") != "licensed_explicit":
            errors.append(f"{where}: licensed=true 但未经显式许可核查")
        urls_seen.add(s["canonical_url"])
    stats["sources"] = len(sources)

    # ---- 除草剂记录 ----
    hb = load(os.path.join(k, "herbicides", "records-2026.json"))
    records = hb["records"]
    if hb["target"] != 20:
        errors.append(f"目标应为 20，实际 {hb['target']}")
    stats["records_target"] = hb["target"]
    stats["records_achieved"] = len(records)
    if len(records) != hb["achieved"]:
        errors.append("achieved 与 records 数量不一致")
    if len(records) + hb.get("gap", 0) != hb["target"]:
        errors.append("achieved + gap != target")
    stats["records_gap"] = hb.get("gap", 0)

    reg_numbers = set()
    usable_as_dose = 0
    card_eligible = 0
    for rec in records:
        where = f"record {rec.get('record_id')}"
        num = rec.get("registration_number", "")
        if not num:
            errors.append(f"{where}: 缺登记证号")
        if num.upper().startswith("SIM"):
            errors.append(f"{where}: 真实记录不得使用模拟前缀 SIM-（{num}）")
        if not REAL_REG_NUMBER.match(num):
            errors.append(f"{where}: 登记证号格式可疑 {num!r}（须来自官方来源，不得编造）")
        if num in reg_numbers:
            errors.append(f"{where}: 登记证号重复 {num}")
        reg_numbers.add(num)

        if rec["record_status"] not in ALLOWED_RECORD_STATUS:
            errors.append(f"{where}: record_status 非法 {rec['record_status']!r}")
        for fld in ("registered_name", "producer", "dosage_form", "ingredients_text", "use_scene", "target_original"):
            if not rec.get(fld):
                errors.append(f"{where}: 缺字段 {fld}")
        for cid in rec.get("crop_ids", []):
            if cid not in crop_ids:
                errors.append(f"{where}: crop_id {cid} 未在 crops.json 登记")
        src = rec.get("source", {})
        if src.get("source_id") not in src_by_id:
            errors.append(f"{where}: source_id {src.get('source_id')!r} 未在 sources.json 登记")
        for u in (src.get("original_url"), src.get("attachment_url")):
            if not u or not str(u).startswith(("https://", "http://")):
                errors.append(f"{where}: 来源 URL 非法 {u!r}")

        ver = rec.get("verification", {})
        if ver.get("card_eligible"):
            card_eligible += 1
            # 允许 card_eligible 仅当剂量/方法/注意齐全
            for fld in ("dose_text", "method_text", "precautions_text", "unit_text"):
                if not rec.get(fld):
                    errors.append(f"{where}: card_eligible=true 但缺 {fld}（缺项不得标为可用）")
        if ver.get("usable_as_dose"):
            usable_as_dose += 1
        if rec["record_status"] == "partial" and not ver.get("not_collected"):
            errors.append(f"{where}: partial 记录必须列明未采集字段")
    stats["records_card_eligible"] = card_eligible
    stats["records_usable_as_dose"] = usable_as_dose

    # 模式与来源类型一致性
    if mode == "real":
        sim = [s["id"] for s in sources if s["source_kind"] == "simulation"]
        if any(r["source"]["source_id"] in sim for r in records):
            errors.append("real 模式不得引用模拟来源")
        if usable_as_dose == 0:
            errors.append("real 模式需可作用量数据，但 usable_as_dose=0（预期：本轮未接入真实库）")
    if mode == "preset_demo":
        if not all(r["source"]["source_id"] == "src_sim_demo_gyi03" for r in records):
            errors.append("preset_demo 模式应只含模拟记录")

    # ---- SQL 种子一致性 ----
    seed_dir = os.path.join(root, "db", "seeds")
    hb_sql = os.path.join(seed_dir, "seed_herbicides_verified.sql")
    if not os.path.exists(hb_sql):
        errors.append(f"缺少种子 SQL：{hb_sql}")
    else:
        text = open(hb_sql, encoding="utf-8").read()
        for num in reg_numbers:
            if f"'{num}'" not in text:
                errors.append(f"种子 SQL 缺登记证号 {num}（JSON 与 SQL 不一致）")
        stats["seed_sql_records"] = sum(text.count(f"'{n}'") for n in reg_numbers)

    # ---- 覆盖报表存在性 ----
    if not os.path.exists(os.path.join(k, "coverage-report.json")):
        errors.append("缺少 coverage-report.json")

    # ---- 迁移/SQL 结构检查（静态）----
    mig = os.path.join(root, "services", "api", "db", "migrations", "0002_knowledge_catalog.sql")
    down = os.path.join(root, "services", "api", "db", "migrations", "rollback", "0002_knowledge_catalog.down.sql")
    if not os.path.exists(mig):
        errors.append(f"缺少迁移文件：{mig}")
    else:
        sql = open(mig, encoding="utf-8").read()
        for token in (
            "v_active_source_version",
            "v_queryable_seed_version",
            "v_simulation_only",
            "v_knowledge_applicability",
            "card_ready",
            "CREATE TABLE IF NOT EXISTS formulations",
            "CREATE TABLE IF NOT EXISTS registrations",
            "CREATE TABLE IF NOT EXISTS applicability",
            "CREATE TABLE IF NOT EXISTS restriction_rules",
            "CREATE TABLE IF NOT EXISTS knowledge_versions",
            "CREATE TABLE IF NOT EXISTS catalog_import_runs",
        ):
            if token not in sql:
                errors.append(f"迁移缺少关键对象：{token}")
        # 共享字典表由 0001 拥有，0002 不得重复创建（否则会与 0001 的 uuid 列集冲突）
        for shared in ("crops", "species", "regions", "sources", "source_versions"):
            if f"CREATE TABLE IF NOT EXISTS {shared}" in sql:
                errors.append(f"迁移不得重复创建共享字典表 {shared}（应由 0001 拥有）")
        if sql.count("BEGIN;") != 1 or sql.count("COMMIT;") != 1:
            errors.append("迁移 BEGIN/COMMIT 不配对")
    if not os.path.exists(down):
        errors.append(f"缺少回滚文件：{down}")
    else:
        dsql = open(down, encoding="utf-8").read()
        if "DROP VIEW IF EXISTS v_active_source_version" not in dsql:
            errors.append("回滚缺少视图清理")
        if "DROP TABLE IF EXISTS crops" in dsql:
            errors.append("回滚不得删除与 0001 共享的字典表 crops")

    return errors, stats


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--mode", choices=["real", "stub", "preset_demo"], default=None)
    ap.add_argument("--emit-report", default=None)
    args = ap.parse_args()

    try:
        errors, stats = validate(args.root, args.mode)
    except Fail as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1

    print("== GY-I03 资料校验 ==")
    if args.mode:
        print(f"mode={args.mode}")
    for k in sorted(stats):
        print(f"  {k} = {stats[k]}")
    if errors:
        print(f"\nFAIL: {len(errors)} 项")
        for e in errors:
            print(f"  - {e}")
        return 1
    print("\nPASS: 全部检查通过")
    if args.emit_report:
        report = {"mode": args.mode, "stats": stats, "errors": [], "status": "pass"}
        with open(args.emit_report, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        print(f"报告写入 {args.emit_report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

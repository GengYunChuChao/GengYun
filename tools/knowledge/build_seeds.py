#!/usr/bin/env python3
"""从 packages/knowledge 的 JSON 清单生成 db/seeds/*.sql（可重复、确定性）。

只使用 Python 标准库。UUID 由 uuid5(NAMESPACE_URL, key) 确定性派生，保证同一输入
每次生成同样的字节。SQL 字符串统一转义单引号，NULL 显式书写，禁止拼接裸值。

用法：
    python tools/knowledge/build_seeds.py --root .
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import uuid

NS = uuid.UUID("6ba7b811-9dad-11d1-80b4-00c04fd430c8")  # NAMESPACE_URL


def uid(key: str) -> str:
    return str(uuid.uuid5(NS, key))


def sha256(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def q(s: str | None) -> str:
    if s is None:
        return "NULL"
    return "'" + str(s).replace("'", "''") + "'"


def qj(obj) -> str:
    return "'" + json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("'", "''") + "'::jsonb"


def load(path: str):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


UNITS = ["克/升", "克/千克", "克/公顷", "克/亩", "g/L", "g/kg", "亿CFU/克", "CFU/克", "%"]


def parse_ingredients(text: str) -> list[dict]:
    parts = [p.strip() for p in re.split(r"[、,，;；]", text) if p.strip()]
    out = []
    for p in parts:
        name, content, unit = p, p, "原文"
        for u in UNITS:
            m = re.match(rf"^(?P<name>.+?)\s*(?P<num>[0-9][0-9\.\,]*)\s*{re.escape(u)}$", p)
            if m:
                name = m.group("name").strip()
                content = f"{m.group('num')}{u}"
                unit = u
                break
        else:
            m = re.match(r"^(?P<name>.+?)\s*(?P<num>[0-9][0-9\.\,]*)$", p)
            if m:
                name = m.group("name").strip()
                content = m.group("num")
                unit = "原文"
        out.append({"name": name or p, "content_text": content or p, "unit_text": unit})
    return out


def build(root: str) -> dict[str, str]:
    k = os.path.join(root, "packages", "knowledge")
    crops = load(os.path.join(k, "catalog", "crops.json"))["crops"]
    species = load(os.path.join(k, "catalog", "species.json"))["species"]
    sources = load(os.path.join(k, "catalog", "sources.json"))["sources"]
    regions = load(os.path.join(k, "catalog", "regions-zhejiang.json"))["regions"]
    records = load(os.path.join(k, "herbicides", "records-2026.json"))["records"]

    # ---- 来源与版本 ----
    # sources.id 在 0001 为 uuid PRIMARY KEY DEFAULT gen_random_uuid()；种子显式写入
    # 确定性 uuid（uuid5），保证可重复 + FK 可引用。
    def src_db_id(sid: str) -> str:
        return uid(f"source:{sid}")

    src_db: dict[str, str] = {s["id"]: src_db_id(s["id"]) for s in sources}

    sv_ids: dict[str, str] = {}

    def sv_id(source_id: str, version: str) -> str:
        return uid(f"source_version:{source_id}:{version}")

    sv_rows = []
    for s in sources:
        if s["id"] == "src_moa_pd_2026":
            for iss in s["issues"]:
                ver = iss["issue"]
                vid = sv_id(s["id"], ver)
                sv_ids[ver] = vid
                sv_rows.append((vid, src_db[s["id"]], ver, iss["attachment_sha256"], iss["attachment_url"], "2026-10-04"))
        elif s["id"] == "src_mca_xzqh_2023":
            ver = "mca-xzqh-2023"
            vid = sv_id(s["id"], ver)
            sv_ids[s["id"]] = vid
            sv_rows.append((vid, src_db[s["id"]], ver, s["retrieved_content_sha256"], s["canonical_url"], "2026-10-04"))
        else:  # simulation
            ver = "sim-2026.10"
            vid = sv_id(s["id"], ver)
            sv_ids[s["id"]] = vid
            sv_rows.append((vid, src_db[s["id"]], ver, sha256("gengyun-simulation-placeholder"), s["canonical_url"], "2026-10-04"))

    # ---- 参考数据 ----
    ref = []
    ref.append("-- 生成文件：请勿手工编辑；改 JSON 后运行 tools/knowledge/build_seeds.py\n")
    ref.append("-- 参考数据：模式 / 配置 / 来源 / 来源版本 / 作物 / 物种 / 浙江区划\n")
    ref.append("BEGIN;\n")

    ref.append("-- 数据集模式（来源类型与执行模式分离）\n")
    modes = [
        ("real", "接入真实资料数据库；只接受 database/verified_seed，不接受模拟。", False, True, False, False),
        ("stub", "无真实库时的有来源种子联调；接受 verified_seed，必须标注“未核对”。", False, True, True, True),
        ("preset_demo", "比赛演示兜底；只接受 simulation 明显模拟数据，必须显示标记。", False, False, True, True),
    ]
    for m, desc, ad, av, asim, lab in modes:
        ref.append(
            f"INSERT INTO knowledge_dataset_modes (mode, description, accepts_database, accepts_verified_seed, accepts_simulation, requires_clear_label) "
            f"VALUES ({q(m)}, {q(desc)}, {str(ad).lower()}, {str(av).lower()}, {str(asim).lower()}, {str(lab).lower()}) "
            f"ON CONFLICT (mode) DO UPDATE SET description=EXCLUDED.description, accepts_database=EXCLUDED.accepts_database, "
            f"accepts_verified_seed=EXCLUDED.accepts_verified_seed, accepts_simulation=EXCLUDED.accepts_simulation, "
            f"requires_clear_label=EXCLUDED.requires_clear_label;\n"
        )

    ref.append("\n-- 当前生效配置：未接入真实库前保持 stub\n")
    ref.append(
        f"INSERT INTO knowledge_dataset_config (key, value, mode) VALUES ('active_mode', 'stub', 'stub') "
        f"ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, mode=EXCLUDED.mode, updated_at=now();\n"
    )
    ref.append(
        f"INSERT INTO knowledge_dataset_config (key, value, mode) VALUES ('database_connected', 'false', 'stub') "
        f"ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now();\n"
    )

    ref.append("\n-- 来源（id 为 uuid5 确定性派生；license 调查本轮暂缓，不落库）\n")
    for s in sources:
        ref.append(
            "INSERT INTO sources (id, title, canonical_url, publisher, source_kind, evidence_kind) VALUES "
            f"({q(src_db[s['id']])}::uuid, {q(s['title'])}, {q(s['canonical_url'])}, {q(s['publisher'])}, {q(s['source_kind'])}, "
            f"{q(s['evidence_kind'])}) "
            "ON CONFLICT (id) DO NOTHING;\n"
        )

    ref.append("\n-- 来源版本（review_status=unverified：开发侧非法定审核责任人；validity 反映公告是否有效）\n")
    for vid, sid, ver, chash, loc, ret in sv_rows:
        validity = "valid" if sid != src_db["src_sim_demo_gyi03"] else "unknown"
        ref.append(
            "INSERT INTO source_versions (id, source_id, version, content_hash, locator, retrieved_at, valid_from, validity, review_status) VALUES "
            f"({q(vid)}::uuid, {q(sid)}::uuid, {q(ver)}, {q(chash)}, {q(loc)}, {q(ret)}::timestamptz, {q(ret)}::timestamptz, {q(validity)}, 'unverified') "
            "ON CONFLICT (id) DO NOTHING;\n"
        )

    ref.append("\n-- 4 类作物\n")
    for c in crops:
        ref.append(
            "INSERT INTO crops (id, name, active) VALUES "
            f"({q(c['id'])}, {q(c['name'])}, {str(bool(c.get('active', True))).lower()}) "
            "ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, active=EXCLUDED.active;\n"
        )

    ref.append("\n-- 8 组杂草规范对象\n")
    for sp in species:
        ref.append(
            "INSERT INTO species (id, canonical_name, scientific_name, aliases, coverage_state) VALUES "
            f"({q(sp['id'])}, {q(sp['canonical_name'])}, {q(sp.get('scientific_name'))}, {qj(sp.get('aliases', []))}, {q(sp['coverage_state'])}) "
            "ON CONFLICT (id) DO UPDATE SET canonical_name=EXCLUDED.canonical_name, scientific_name=EXCLUDED.scientific_name, "
            "aliases=EXCLUDED.aliases, coverage_state=EXCLUDED.coverage_state;\n"
        )

    ref.append("\n-- 浙江区划\n")
    for r in regions:
        ref.append(
            "INSERT INTO regions (code, parent_code, name, catalog_version, supported) VALUES "
            f"({q(r['code'])}, {q(r['parent_code'])}, {q(r['name'])}, {q(r['catalog_version'])}, {str(bool(r['supported'])).lower()}) "
            "ON CONFLICT (code) DO UPDATE SET parent_code=EXCLUDED.parent_code, name=EXCLUDED.name, "
            "catalog_version=EXCLUDED.catalog_version, supported=EXCLUDED.supported;\n"
        )
    ref.append("\nCOMMIT;\n")

    # ---- 20 条已核对来源的除草剂资料 ----
    formulation_ids: list[str] = []
    hb = []
    hb.append("-- 生成文件：20 条普通除草剂记录（来源：农业农村部农药管理司公告附表，非编造）\n")
    hb.append("-- card_ready 一律 false：公告附表无用药量/施用方法/注意事项，不得当作用量依据。\n")
    hb.append("BEGIN;\n")
    for rec in records:
        regnum = rec["registration_number"]
        ing = parse_ingredients(rec["ingredients_text"])
        ing_text = "|".join(f"{i['name']}={i['content_text']}{i['unit_text'] or ''}" for i in ing)
        identity = sha256(f"{regnum}|{rec['producer']}|{rec['dosage_form']}|{ing_text}")
        fid = uid(f"formulation:{regnum}:{identity}")
        formulation_ids.append(fid)
        sv = sv_ids[rec["source"]["issue"]]
        rid = uid(f"registration:{regnum}:{sv}")
        cond = sha256(f"{rid}|{rec['use_scene']}|{rec['target_original']}")
        aid = uid(f"applicability:{rid}:{cond}")
        crop_id = rec["crop_ids"][0] if rec["crop_ids"] else None
        species_id = None
        if rec["target_original"] in ("稗草",):
            species_id = "species_barnyardgrass"
        hb.append(
            "INSERT INTO formulations (id, registration_number, producer, dosage_form, ingredients, identity_hash) VALUES "
            f"({q(fid)}::uuid, {q(regnum)}, {q(rec['producer'])}, {q(rec['dosage_form'])}, {qj(ing)}, {q(identity)}) "
            "ON CONFLICT (id) DO NOTHING;\n"
        )
        hb.append(
            "INSERT INTO registrations (id, formulation_id, source_version_id, registered_name, registration_valid_from, registration_valid_to, status) VALUES "
            f"({q(rid)}::uuid, {q(fid)}::uuid, {q(sv)}::uuid, {q(rec['registered_name'])}, NULL, NULL, 'unknown') "
            "ON CONFLICT (id) DO NOTHING;\n"
        )
        hb.append(
            "INSERT INTO applicability (id, registration_id, source_version_id, crop_id, species_id, region_code, growth_stage, planting_method, use_scene, method_text, precautions_text, dose_text, unit_text, locator, content_hash, conditions_hash, card_ready) VALUES "
            f"({q(aid)}::uuid, {q(rid)}::uuid, {q(sv)}::uuid, {q(crop_id)}, {q(species_id)}, NULL, NULL, NULL, {q(rec['use_scene'])}, "
            f"NULL, NULL, NULL, NULL, {q(rec['source']['attachment_url'])}, {q(sha256(rec['ingredients_text']))}, {q(cond)}, false) "
            "ON CONFLICT (id) DO NOTHING;\n"
        )
    hb.append("\nCOMMIT;\n")

    # ---- 明显模拟数据 ----
    sim = []
    sim.append("-- 生成文件：明显模拟数据（source_kind=simulation）。登记证号为 SIM- 合成占位，非真实登记号。\n")
    sim.append("-- 仅用于演示模式链路与失败/边界测试；禁止进入真实用量依据或评估答案。\n")
    sim.append("BEGIN;\n")
    sim_sv = sv_ids["src_sim_demo_gyi03"]
    demo = [
        ("SIM-0001", "模拟除草剂A（合成）", "模拟生产者（合成）", "可湿性粉剂", "模拟成分 10%", "模拟水稻田"),
        ("SIM-0002", "模拟除草剂B（合成）", "模拟生产者（合成）", "乳油", "模拟成分 20%", "模拟玉米田"),
    ]
    for num, name, prod, df, ing, scene in demo:
        fid = uid(f"sim_formulation:{num}")
        formulation_ids.append(fid)
        rid = uid(f"sim_registration:{num}")
        aid = uid(f"sim_applicability:{num}")
        ingj = [{"name": "模拟成分（合成，无真实数据）", "content_text": ing, "unit_text": "模拟"}]
        sim.append(
            "INSERT INTO formulations (id, registration_number, producer, dosage_form, ingredients, identity_hash) VALUES "
            f"({q(fid)}::uuid, {q(num)}, {q(prod)}, {q(df)}, {qj(ingj)}, {q(sha256('sim:'+num))}) ON CONFLICT (id) DO NOTHING;\n"
        )
        sim.append(
            "INSERT INTO registrations (id, formulation_id, source_version_id, registered_name, registration_valid_from, registration_valid_to, status) VALUES "
            f"({q(rid)}::uuid, {q(fid)}::uuid, {q(sim_sv)}::uuid, {q(name)}, NULL, NULL, 'unknown') ON CONFLICT (id) DO NOTHING;\n"
        )
        sim.append(
            "INSERT INTO applicability (id, registration_id, source_version_id, crop_id, species_id, region_code, growth_stage, planting_method, use_scene, method_text, precautions_text, dose_text, unit_text, locator, content_hash, conditions_hash, card_ready) VALUES "
            f"({q(aid)}::uuid, {q(rid)}::uuid, {q(sim_sv)}::uuid, NULL, NULL, NULL, NULL, NULL, {q(scene)}, NULL, NULL, NULL, NULL, "
            f"{q('simulation://'+num)}, {q(sha256('sim:'+num))}, {q(sha256('sim-cond:'+num))}, false) ON CONFLICT (id) DO NOTHING;\n"
        )
    sim.append("\nCOMMIT;\n")

    # ---- 种子回滚 ----
    src_ids = [src_db[s["id"]] for s in sources]
    sv_list = ", ".join(q(sv_ids[x]) + "::uuid" for x in sv_ids)
    fid_list = ", ".join(q(f) + "::uuid" for f in formulation_ids)
    src_id_list = ", ".join(q(x) + "::uuid" for x in src_ids)
    rb = []
    rb.append("-- 生成文件：回滚本次种子（只删本目录 seed 写入的行；共享表结构不动）\n")
    rb.append("BEGIN;\n")
    rb.append("-- 先标记导入运行回退（若有）\n")
    rb.append("UPDATE catalog_import_runs SET status='reverted' WHERE dataset IN ('zhejiang-verified-seed','simulation-demo') AND status='succeeded';\n")
    rb.append("-- 解除 sources.current_version_id 对 source_versions 的引用（种子未设置，防御性）\n")
    rb.append(f"UPDATE sources SET current_version_id = NULL WHERE id IN ({src_id_list});\n")
    rb.append("-- 按依赖顺序删除：适用 → 登记 → 制剂（仅本次种子写入的 id）\n")
    rb.append(f"DELETE FROM applicability WHERE source_version_id IN ({sv_list});\n")
    rb.append(f"DELETE FROM registrations WHERE source_version_id IN ({sv_list});\n")
    rb.append(f"DELETE FROM formulations WHERE id IN ({fid_list});\n")
    rb.append("-- 删除来源更新事件与来源版本/来源\n")
    rb.append(f"DELETE FROM catalog_source_update_events WHERE source_id IN ({src_id_list}) OR source_version_id IN ({sv_list});\n")
    rb.append(f"DELETE FROM source_versions WHERE id IN ({sv_list});\n")
    rb.append(f"DELETE FROM sources WHERE id IN ({src_id_list});\n")
    rb.append("\nCOMMIT;\n")

    zj = build_zhejiang(root)
    return {
        "seed_reference.sql": "".join(ref),
        "seed_herbicides_verified.sql": "".join(hb),
        "seed_simulation.sql": "".join(sim),
        "rollback_seed.sql": "".join(rb),
        "seed_zhejiang_materials.sql": zj["seed"],
        "rollback_zhejiang_materials.sql": zj["rollback"],
    }


# ---------------------------------------------------------------------------
# 浙江首批资料（GY-I03 / #3）
# 输入：packages/knowledge/zhejiang/materials-zhejiang-v1.json（由仓外两份真实工作簿确定性抽取）
# 输出：db/seeds/seed_zhejiang_materials.sql + db/seeds/rollback_zhejiang_materials.sql
#
# 复用 0002 已有的表与语义：
#   * sources / source_versions 登记来源与版本（review_status=unverified，不进 v_active_source_version）
#   * knowledge_versions 承载条目（按 region_codes=[330000] 限定浙江；visibility=private 未发布）
#   * catalog_import_runs / catalog_source_update_events 记录本批次导入与来源事件
# 幂等：uuid5 确定性 id + ON CONFLICT DO NOTHING。回滚：只删本批次这些 id，不触碰其他种子/样例。
# ---------------------------------------------------------------------------
ZJ_DATASET = "zhejiang-first-batch-v1"
ZJ_DOSE_KEYS = ("dose_text", "application_method_text", "precautions_text", "registration_number")


def zj_crop_id(crops: list[dict], name: str):
    for c in crops:
        if c["name"] == name or name in c.get("aliases", []):
            return c["id"]
    return None


def zj_species_id(species: list[dict], item: dict):
    tokens = {item.get("canonical_name", "")} | set(item.get("parenthetical_aliases", []))
    tokens.discard("")
    for sp in species:
        names = {sp.get("canonical_name", ""), sp.get("group_name", "")} | set(sp.get("aliases", []))
        if tokens & names:
            return sp["id"]
    return None


def zj_dedupe(seq):
    out = []
    for x in seq:
        if x and x not in out:
            out.append(x)
    return out


def build_zhejiang(root: str) -> dict:
    k = os.path.join(root, "packages", "knowledge")
    crops = load(os.path.join(k, "catalog", "crops.json"))["crops"]
    species = load(os.path.join(k, "catalog", "species.json"))["species"]
    zj_path = os.path.join(k, "zhejiang", "materials-zhejiang-v1.json")
    zj = load(zj_path)
    with open(zj_path, "rb") as fh:
        zj_bytes = fh.read()
    release = zj["release"]

    sources = zj["sources"]
    src_db = {s["id"]: uid(f"source:{s['id']}") for s in sources}
    ver_db = {s["id"]: uid(f"source_version:{s['id']}:{s['version']}") for s in sources}

    rows = []          # (id, knowledge_id, title, body_json, type, source_id, crop_ids, species_ids)
    for w in zj["weed_items"]:
        sid = w["source"]["source_id"]
        crop_ids = zj_dedupe([zj_crop_id(crops, c) for c in w.get("companion_crops", [])])
        sp = zj_species_id(species, w)
        body = {
            "kind": "weed",
            "item_id": w["item_id"],
            "weed_name": w["weed_name"],
            "canonical_name": w["canonical_name"],
            "scientific_name": w["scientific_name"],
            "family_genus": w["family_genus"],
            "companion_crops": w["companion_crops"],
            "distribution_note": w["distribution_note"],
            "distribution_provinces": w["distribution_provinces"],
            "growth_stages_text": w["growth_stages_text"],
            "best_control_stage_text": w["best_control_stage_text"],
            "spray_window_text": w["spray_window_text"],
            "identification_key_text": w["identification_key_text"],
            "zhejiang_evidence_strength": w["zhejiang_evidence_strength"],
            "dose_text": None,
            "usable_as_dose": False,
            "card_ready": False,
            "provenance": w["source"],
        }
        rows.append((w["item_id"], f"浙江适用杂草：{w['weed_name']}", body, "species", sid,
                     crop_ids, [sp] if sp else []))
    for t in zj["control_timing_items"]:
        if t["zhejiang_scope"] != "scene_matches_zhejiang_main_crop":
            continue
        sid = t["source"]["source_id"]
        crop_ids = zj_dedupe([zj_crop_id(crops, c) for c in t.get("matched_main_crops", [])])
        body = {
            "kind": "control_timing",
            "item_id": t["item_id"],
            "scene_text": t["scene_text"],
            "critical_window_text": t["critical_window_text"],
            "target_weeds_text": t["target_weeds_text"],
            "key_points_text": t["key_points_text"],
            "zhejiang_scope_basis": t["zhejiang_scope_basis"],
            "dose_text": None,
            "usable_as_dose": False,
            "card_ready": False,
            "provenance": t["source"],
        }
        rows.append((t["item_id"], f"浙江防除时期：{t['scene_text']}", body, "scheme", sid,
                     crop_ids, []))
    for h in zj["herbicide_items"]:
        if not h["in_zhejiang_first_batch"]:
            continue
        sid = h["source"]["source_id"]
        body = {
            "kind": "herbicide_applicability",
            "item_id": h["item_id"],
            "herbicide_name": h["herbicide_name"],
            "aliases_text": h["aliases_text"],
            "hazard_level_text": h["hazard_level_text"],
            "hazard_detail_text": h["hazard_detail_text"],
            "target_weeds_text": h["target_weeds_text"],
            "region_text": h["region_text"],
            "zhejiang_evidence": h["zhejiang_evidence"],
            "zhejiang_basis": h["zhejiang_basis"],
            "dose_text": None,
            "dose_status": "absent_in_source",
            "application_method_text": None,
            "precautions_text": None,
            "registration_number": None,
            "usable_as_dose": False,
            "card_ready": False,
            "provenance": h["source"],
        }
        rows.append((h["item_id"], f"浙江适用除草剂（环境风险与适用信息）：{h['herbicide_name']}",
                     body, "herbicide", sid, [], []))

    out = []
    out.append("-- 生成文件：浙江首批资料（GY-I03 / #3）。请勿手工编辑；改 JSON 后运行\n")
    out.append("--   python tools/knowledge/build_seeds.py --root .\n")
    out.append("-- 依赖：0001 + 0002 迁移，且先执行 db/seeds/seed_reference.sql"
               "（knowledge_dataset_modes 的 'stub' 行）。\n")
    out.append("-- 来源 review_status 一律 unverified、visibility=private：")
    out.append("未核对不进 v_active_source_version，不得当作权威资料。\n")
    out.append("-- 用量：源工作簿无「标签原文用量」列，dose_text 显式为 null，"
               "usable_as_dose/card_ready 一律 false。\n")
    out.append("-- 幂等：uuid5 确定性 id + ON CONFLICT DO NOTHING。\n")
    out.append("BEGIN;\n")

    out.append("\n-- 来源与来源版本（sha256 为仓外原文件哈希；原文件不入库）\n")
    for s in sources:
        out.append(
            "INSERT INTO sources (id, title, canonical_url, publisher, source_kind, evidence_kind) VALUES "
            f"({q(src_db[s['id']])}::uuid, {q(s['title'])}, {q(s['canonical_url'])}, {q(s['publisher'])}, "
            f"{q(s['source_kind'])}, {q(s['evidence_kind'])}) ON CONFLICT (id) DO NOTHING;\n"
        )
    for s in sources:
        out.append(
            "INSERT INTO source_versions (id, source_id, version, content_hash, locator, retrieved_at, "
            "valid_from, validity, review_status) VALUES "
            f"({q(ver_db[s['id']])}::uuid, {q(src_db[s['id']])}::uuid, {q(s['version'])}, "
            f"{q(s['file']['sha256'])}, {q('repo-external://samples/' + s['file']['name'])}, "
            f"{q(release)}::timestamptz, {q(release)}::timestamptz, {q(s['validity'])}, {q(s['review_status'])}) "
            "ON CONFLICT (id) DO NOTHING;\n"
        )
    for s in sources:
        out.append(f"UPDATE sources SET current_version_id = {q(ver_db[s['id']])}::uuid "
                   f"WHERE id = {q(src_db[s['id']])}::uuid;\n")

    out.append(f"\n-- 浙江适用条目 {len(rows)} 条（杂草/防除时期/药剂适用；逐条带来源定位与行哈希）\n")
    for item_id, title, body, ktype, sid, crop_ids, species_ids in rows:
        kid = uid(f"knowledge:zhejiang:{item_id}")
        rid = uid(f"knowledge_row:zhejiang:{item_id}:1")
        out.append(
            "INSERT INTO knowledge_versions (id, knowledge_id, revision, title, body, type, "
            "source_version_id, crop_ids, species_ids, region_codes, visibility) VALUES "
            f"({q(rid)}::uuid, {q(kid)}::uuid, 1, {q(title)}, {q(json.dumps(body, ensure_ascii=False, separators=(',', ':')))}, "
            f"{q(ktype)}, {q(ver_db[sid])}::uuid, {qj(crop_ids)}, {qj(species_ids)}, "
            f"{qj(['330000'])}, 'private') ON CONFLICT (id) DO NOTHING;\n"
        )

    run_id = uid(f"import_run:{ZJ_DATASET}")
    out.append("\n-- 本批次导入审计（mode=stub：未接真实库；records_in=records_ok，冲突 0，未跳过）\n")
    out.append(
        "INSERT INTO catalog_import_runs (id, mode, dataset, started_at, finished_at, status, records_in, "
        "records_ok, records_conflict, records_skipped, output_hash, note) VALUES "
        f"({q(run_id)}::uuid, 'stub', {q(ZJ_DATASET)}, {q(release)}::timestamptz, {q(release)}::timestamptz, "
        f"'succeeded', {len(rows)}, {len(rows)}, 0, 0, {q(hashlib.sha256(zj_bytes).hexdigest())}, "
        f"{q('浙江首批资料 v1：来源未核对(review_status=unverified)，无用量字段，card_ready=false')}) "
        "ON CONFLICT (id) DO NOTHING;\n"
    )
    for s in sources:
        ev = uid(f"source_event:imported:{s['id']}:{s['version']}")
        out.append(
            "INSERT INTO catalog_source_update_events (id, source_id, source_version_id, event, old_validity, "
            "new_validity, occurred_at, reason) VALUES "
            f"({q(ev)}::uuid, {q(src_db[s['id']])}::uuid, {q(ver_db[s['id']])}::uuid, 'imported', NULL, "
            f"{q(s['validity'])}, {q(release)}::timestamptz, "
            f"{q('浙江首批资料 v1 派生条目入库；来源 review_status=unverified，作者侧非法定审核责任人')}) "
            "ON CONFLICT (id) DO NOTHING;\n"
        )
    out.append("\nCOMMIT;\n")

    src_list = ", ".join(q(v) + "::uuid" for v in src_db.values())
    ver_list = ", ".join(q(v) + "::uuid" for v in ver_db.values())
    rb = []
    rb.append("-- 生成文件：精确回滚浙江首批资料批次（只删本批次写入的行；表结构不动）\n")
    rb.append("-- 其他种子（seed_reference/seed_herbicides_verified/seed_simulation）、脱敏样例与\n")
    rb.append("-- knowledge_staging 批次不在本文件范围内，不删、不改。\n")
    rb.append("BEGIN;\n")
    rb.append(f"UPDATE catalog_import_runs SET status='reverted' WHERE dataset = {q(ZJ_DATASET)} AND status <> 'reverted';\n")
    rb.append("-- 先解除 sources.current_version_id 对 source_versions 的引用（FK 前置）\n")
    rb.append(f"UPDATE sources SET current_version_id = NULL WHERE id IN ({src_list});\n")
    rb.append("-- 知识条目 → 来源事件 → 来源版本 → 来源（按依赖顺序，仅本批次 id）\n")
    rb.append(f"DELETE FROM knowledge_versions WHERE source_version_id IN ({ver_list});\n")
    rb.append(f"DELETE FROM catalog_source_update_events WHERE source_version_id IN ({ver_list}) OR source_id IN ({src_list});\n")
    rb.append(f"DELETE FROM source_versions WHERE id IN ({ver_list});\n")
    rb.append(f"DELETE FROM sources WHERE id IN ({src_list});\n")
    rb.append("\nCOMMIT;\n")

    return {"seed": "".join(out), "rollback": "".join(rb)}



def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    args = ap.parse_args()
    outdir = os.path.join(args.root, "db", "seeds")
    os.makedirs(outdir, exist_ok=True)
    files = build(args.root)
    for name, content in files.items():
        path = os.path.join(outdir, name)
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(content)
        print(f"wrote {path}: {len(content)} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

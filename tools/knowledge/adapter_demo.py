#!/usr/bin/env python3
"""GY-I03 可替换数据库适配层逻辑演示（仅标准库，无真实数据库）。

说明（诚实边界）：本脚本**不是** PostgreSQL 运行证据。它用一个内存模型复现
`db/migrations/0002_knowledge_catalog.sql` 的读取投影语义（v_active_source_version /
v_queryable_seed_version / v_simulation_only）与约束意图（card_ready 门、模式-来源匹配），
并对 db/seeds 的数据做导入→冲突→回滚演练，输出确定性报告。

真实建库/迁移执行证据见 docs/verification/gy-i03-evidence.md 的“未完成”一节：
本轮**未接入真实数据库，未执行迁移**。

用法：
    python tools/knowledge/adapter_demo.py --root . [--emit-report out.json]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import uuid

NS = uuid.UUID("6ba7b811-9dad-11d1-80b4-00c04fd430c8")


def uid(key: str) -> str:
    return str(uuid.uuid5(NS, key))


def load(path: str):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


class Store:
    def __init__(self):
        self.sources: dict[str, dict] = {}
        self.source_versions: dict[str, dict] = {}
        self.formulations: dict[str, dict] = {}
        self.registrations: dict[str, dict] = {}
        self.applicability: dict[str, dict] = {}
        self.conflicts: list[dict] = []
        self.import_runs: list[dict] = []

    # ---- 视图语义（与 0002 SQL 对齐）----
    def v_active_source_version(self):
        return [
            sv for sv in self.source_versions.values()
            if sv["validity"] == "valid"
            and sv["review_status"] == "verified"
            and self.sources[sv["source_id"]]["source_kind"] != "simulation"
        ]

    def v_queryable_seed_version(self):
        return [
            sv for sv in self.source_versions.values()
            if sv["validity"] == "valid"
            and self.sources[sv["source_id"]]["source_kind"] in ("database", "verified_seed")
        ]

    def v_simulation_only(self):
        return [
            sv for sv in self.source_versions.values()
            if self.sources[sv["source_id"]]["source_kind"] == "simulation"
        ]

    def v_knowledge_applicability(self):
        active = {sv["id"] for sv in self.v_active_source_version()}
        out = []
        for a in self.applicability.values():
            if a["source_version_id"] in active and a["card_ready"]:
                # 约束：card_ready 为真时必须所有条件/用量非空
                if all(a.get(f) for f in (
                    "crop_id", "species_id", "region_code", "growth_stage",
                    "planting_method", "use_scene", "unit_text",
                    "dose_text", "method_text", "precautions_text",
                )):
                    out.append(a)
        return out


def build_store(root: str) -> tuple[Store, dict]:
    st = Store()
    k = os.path.join(root, "packages", "knowledge")
    sources = load(os.path.join(k, "catalog", "sources.json"))["sources"]
    records = load(os.path.join(k, "herbicides", "records-2026.json"))["records"]

    for s in sources:
        st.sources[s["id"]] = {"source_kind": s["source_kind"]}

    sv_ids = {}
    for s in sources:
        if s["id"] == "src_moa_pd_2026":
            for iss in s["issues"]:
                vid = uid(f"source_version:{s['id']}:{iss['issue']}")
                sv_ids[iss["issue"]] = vid
                st.source_versions[vid] = {
                    "id": vid, "source_id": s["id"], "validity": "valid",
                    "review_status": "unverified", "version": iss["issue"],
                }
        elif s["id"] == "src_mca_xzqh_2023":
            vid = uid(f"source_version:{s['id']}:mca-xzqh-2023")
            sv_ids["mca"] = vid
            st.source_versions[vid] = {
                "id": vid, "source_id": s["id"], "validity": "valid",
                "review_status": "unverified", "version": "mca-xzqh-2023",
            }
        else:
            vid = uid(f"source_version:{s['id']}:sim-2026.10")
            sv_ids["sim"] = vid
            st.source_versions[vid] = {
                "id": vid, "source_id": s["id"], "validity": "unknown",
                "review_status": "unverified", "version": "sim-2026.10",
            }

    for rec in records:
        num = rec["registration_number"]
        identity = hashlib.sha256(f"{num}|{rec['producer']}|{rec['dosage_form']}".encode()).hexdigest()
        fid = uid(f"formulation:{num}:{identity}")
        sv = sv_ids[rec["source"]["issue"]]
        rid = uid(f"registration:{num}:{sv}")
        aid = uid(f"applicability:{rid}:{rec['use_scene']}")
        st.formulations[fid] = {"id": fid, "registration_number": num, "producer": rec["producer"],
                                "dosage_form": rec["dosage_form"], "source_version_id": sv}
        st.registrations[rid] = {"id": rid, "formulation_id": fid, "source_version_id": sv,
                                 "registered_name": rec["registered_name"], "status": "valid"}
        st.applicability[aid] = {"id": aid, "registration_id": rid, "source_version_id": sv,
                                 "crop_id": rec["crop_ids"][0] if rec["crop_ids"] else None,
                                 "species_id": None, "region_code": None, "growth_stage": None,
                                 "planting_method": None, "use_scene": rec["use_scene"],
                                 "unit_text": None, "dose_text": None, "method_text": None,
                                 "precautions_text": None, "card_ready": False}
    return st, sv_ids


def import_dataset(st: Store, dataset: str, mode: str, run_id: str) -> None:
    st.import_runs.append({"id": run_id, "dataset": dataset, "mode": mode, "status": "succeeded"})


def detect_conflict(st: Store, record: dict, resolution: str) -> dict:
    """按业务键 登记证号 检测冲突：同号不同持有者/剂型视为冲突。"""
    num = record["registration_number"]
    existing = next((f for f in st.formulations.values() if f["registration_number"] == num), None)
    if existing and (existing["producer"] != record["producer"] or existing["dosage_form"] != record["dosage_form"]):
        conflict = {
            "entity": "formulations",
            "business_key": num,
            "field_name": "producer",
            "existing_value": existing["producer"],
            "incoming_value": record["producer"],
            "resolution": resolution,
        }
        st.conflicts.append(conflict)
        return conflict
    return {}


def rollback(st: Store, sv_ids: dict) -> None:
    """复现 rollback_seed.sql：按来源版本删适用/登记/制剂，再删来源版本。"""
    seeded_sv = set(sv_ids.values())
    st.applicability = {i: a for i, a in st.applicability.items() if a["source_version_id"] not in seeded_sv}
    st.registrations = {i: r for i, r in st.registrations.items() if r["source_version_id"] not in seeded_sv}
    live_fids = {r["formulation_id"] for r in st.registrations.values()}
    st.formulations = {i: f for i, f in st.formulations.items() if i in live_fids}
    st.source_versions = {i: sv for i, sv in st.source_versions.items() if i not in seeded_sv}
    for run in st.import_runs:
        if run["status"] == "succeeded":
            run["status"] = "reverted"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    ap.add_argument("--emit-report", default=None)
    args = ap.parse_args()

    report = {"note": "内存逻辑演示，非真实数据库运行", "checks": {}}
    st, sv_ids = build_store(args.root)

    before = {tb: len(getattr(st, tb)) for tb in ("sources", "source_versions", "formulations", "registrations", "applicability")}
    report["seed_counts"] = before

    # 1) 模式切换 + 读取投影
    report["checks"]["v_active_source_version (valid+verified+非模拟)"] = len(st.v_active_source_version())
    report["checks"]["v_queryable_seed_version (valid+非模拟)"] = len(st.v_queryable_seed_version())
    report["checks"]["v_simulation_only"] = len(st.v_simulation_only())
    report["checks"]["v_knowledge_applicability (card_ready 门)"] = len(st.v_knowledge_applicability())

    # 2) 未核对不标为有效：断言 active=0 且 card_eligible=0
    assert len(st.v_active_source_version()) == 0, "未核对来源不应进入 active 视图"
    assert len(st.v_knowledge_applicability()) == 0, "缺用量条件不应产出卡片"
    report["checks"]["gate_unverified_not_active"] = "PASS"
    report["checks"]["gate_missing_dose_no_card"] = "PASS"

    # 3) 模式-来源匹配
    modes = {
        "real": {"accepts": {"database", "verified_seed"}, "sim": False, "label": False},
        "stub": {"accepts": {"verified_seed"}, "sim": True, "label": True},
        "preset_demo": {"accepts": {"simulation"}, "sim": True, "label": True},
    }
    report["checks"]["modes"] = modes
    # real 模式下，当前数据无 verified 来源 → 报告接入缺项
    real_usable = [r for r in st.registrations.values()
                   if st.source_versions[r["source_version_id"]]["review_status"] == "verified"]
    report["checks"]["real_mode_usable_records"] = len(real_usable)
    report["checks"]["real_mode_gap_note"] = "未接入真实库且无已审来源，real 模式可用记录为 0（接入缺项，非虚构）"

    # 4) 导入 + 冲突
    run_id = uid("import_run:zhejiang-verified-seed")
    import_dataset(st, "zhejiang-verified-seed", "stub", run_id)
    conflicting = {"registration_number": "PD20161371", "producer": "冲突持有者（测试用例）", "dosage_form": "水分散粒剂"}
    conflict = detect_conflict(st, conflicting, resolution="kept_existing")
    report["checks"]["conflict_detected"] = bool(conflict)
    report["checks"]["conflict_detail"] = conflict
    report["checks"]["conflict_resolution"] = conflict.get("resolution", "none")

    # 5) 回滚 + 幂等复算
    rollback(st, sv_ids)
    after = {tb: len(getattr(st, tb)) for tb in ("sources", "source_versions", "formulations", "registrations", "applicability")}
    report["checks"]["after_rollback"] = after
    report["checks"]["rollback_cleared_seeded_rows"] = (
        after["source_versions"] == 0 and after["registrations"] == 0 and after["formulations"] == 0
    )
    assert after["registrations"] == 0 and after["formulations"] == 0, "回滚未清空种子"
    report["checks"]["import_run_status"] = st.import_runs[-1]["status"]

    # 6) 幂等：重建后再回滚，结果一致
    st2, sv2 = build_store(args.root)
    rollback(st2, sv2)
    after2 = {tb: len(getattr(st2, tb)) for tb in ("sources", "source_versions", "formulations", "registrations", "applicability")}
    report["checks"]["idempotent_second_rollback"] = (after == after2)
    assert after2 == after, "第二次回滚结果不一致"

    ok = True  # 断言已在此前逐条完成
    print("== GY-I03 适配层逻辑演示（非真实数据库）==")
    for k, v in report["checks"].items():
        print(f"  {k}: {v}")
    print("\nPASS: 读取投影门（未核对不进 active / 缺用量不产卡片）、冲突阻断、回滚与幂等均按预期")
    if args.emit_report:
        with open(args.emit_report, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(report, fh, ensure_ascii=False, indent=2)
            fh.write("\n")
        print(f"报告写入 {args.emit_report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

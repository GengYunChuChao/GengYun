#!/usr/bin/env python3
"""GY-I03 浙江首批资料校验器负例自测（仅标准库）。

在临时目录复制仓库资料，逐条注入缺陷，断言 validate_zhejiang_materials.validate() 必须报错。
覆盖：补造用量、缺项门被绕过、来源引用不可回源/不可信、覆盖统计漂移、必列缺项被删、
JSON↔种子 SQL 不一致、回滚越范围改动。

用法：python tools/knowledge/test_zhejiang_materials.py --root .
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import validate_zhejiang_materials as vz  # noqa: E402

REL = os.path.join("packages", "knowledge", "zhejiang", "materials-zhejiang-v1.json")
SEED = os.path.join("db", "seeds", "seed_zhejiang_materials.sql")
ROLLBACK = os.path.join("db", "seeds", "rollback_zhejiang_materials.sql")


def load(p):
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)


def dump(p, obj):
    with open(p, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def edit_json(work, mutate):
    p = os.path.join(work, REL)
    d = load(p)
    mutate(d)
    dump(p, d)


def edit_text(work, rel, mutate):
    p = os.path.join(work, rel)
    text = open(p, encoding="utf-8").read()
    open(p, "w", encoding="utf-8", newline="\n").write(mutate(text))


def mutate_dose(d):
    d["herbicide_items"][0]["dose_text"] = "100克/亩"


def mutate_dose_status(d):
    d["herbicide_items"][3]["application_method_status"] = "present"


def mutate_row_hash(d):
    d["weed_items"][0]["source"]["row_sha256"] = d["weed_items"][0]["source"]["row_sha256"][:32]


def mutate_file_hash(d):
    d["weed_items"][0]["source"]["file_sha256"] = "0" * 64


def mutate_unregistered_source(d):
    d["weed_items"][2]["source"]["source_id"] = "src_not_registered"


def mutate_duplicate_item(d):
    d["control_timing_items"][1]["item_id"] = d["control_timing_items"][0]["item_id"]


def mutate_no_source(d):
    d["weed_items"][5].pop("source")


def mutate_coverage(d):
    d["coverage"]["weed_items_selected"] = d["coverage"]["weed_items_selected"] + 1


def mutate_region(d):
    d["region"]["code"] = "320000"


def mutate_drop_gap(d):
    d["gaps"] = [g for g in d["gaps"] if g["id"] != "gap-dose"]


def mutate_source_verified(d):
    d["sources"][0]["review_status"] = "verified"


def mutate_seed_drop_item(work):
    p = os.path.join(work, REL)
    iid = load(p)["weed_items"][0]["item_id"]
    edit_text(work, SEED, lambda t: t.replace(f'"item_id":"{iid}"', '"item_id":"REMOVED"'))


def mutate_rollback_out_of_scope(work):
    edit_text(work, ROLLBACK,
              lambda t: t.replace("COMMIT;", "DELETE FROM formulations;\nCOMMIT;"))


def mutate_seed_dose(work):
    edit_text(work, SEED, lambda t: t.replace('"dose_text":null', '"dose_text":"50毫升/亩"', 1))


def copy_tree(root: str) -> str:
    tmp = tempfile.mkdtemp(prefix="gyi03-zj-neg-")
    dst = os.path.join(tmp, "repo")
    shutil.copytree(root, dst, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns(".git", "node_modules", ".local"))
    return dst


def run_case(name: str, root: str, mutate) -> bool:
    work = copy_tree(root)
    mutate(work)
    errors, _ = vz.validate(work, None)
    ok = len(errors) > 0
    print(f"[{'PASS' if ok else 'FAIL'}] {name}: {'拒绝' if ok else '未拒绝'} ({len(errors)} errors)")
    if errors:
        print("        ", errors[0])
    shutil.rmtree(os.path.dirname(work), ignore_errors=True)
    return ok


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=".")
    args = ap.parse_args()
    root = os.path.abspath(args.root)

    json_cases = [
        ("补造用量 dose_text", mutate_dose),
        ("缺项状态被改成 present", mutate_dose_status),
        ("行指纹被截断", mutate_row_hash),
        ("来源文件哈希不符", mutate_file_hash),
        ("来源未登记", mutate_unregistered_source),
        ("item_id 重复", mutate_duplicate_item),
        ("条目缺来源引用", mutate_no_source),
        ("覆盖统计漂移", mutate_coverage),
        ("浙江省代码被改错", mutate_region),
        ("必列缺项被删除", mutate_drop_gap),
        ("来源被标为 verified", mutate_source_verified),
    ]
    text_cases = [
        ("种子缺条目(JSON 与 SQL 不一致)", mutate_seed_drop_item),
        ("种子写入非空用量", mutate_seed_dose),
        ("回滚越范围删除其他表", mutate_rollback_out_of_scope),
    ]

    results = []
    for name, fn in json_cases:
        results.append(run_case(name, root, lambda w, f=fn: edit_json(w, f)))
    for name, fn in text_cases:
        results.append(run_case(name, root, fn))

    print(f"\n{sum(results)}/{len(results)} 负例被拒绝")
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())

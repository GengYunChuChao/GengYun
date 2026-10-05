#!/usr/bin/env python3
"""GY-I03 校验器负例自测（仅标准库）。

在临时目录复制仓库资料，逐条注入缺陷，断言 validate_knowledge.validate() 必须报错。
覆盖：伪造模拟证号混入真实记录、来源未登记、区划格式错误、登记证号格式可疑、
card_eligible 缺用量字段、缺登记证号重复。

用法：python tools/knowledge/test_knowledge.py --root .
"""
from __future__ import annotations

import argparse
import copy
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import validate_knowledge as vk  # noqa: E402


def load(p):
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)


def dump(p, obj):
    with open(p, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)
        fh.write("\n")


def copy_tree(root: str) -> str:
    tmp = tempfile.mkdtemp(prefix="gyi03-neg-")
    dst = os.path.join(tmp, "repo")
    shutil.copytree(root, dst, dirs_exist_ok=True,
                    ignore=shutil.ignore_patterns(".git", "node_modules"))
    return dst


def run_case(name: str, root: str, mutate) -> bool:
    work = copy_tree(root)
    mutate(work)
    errors, _ = vk.validate(work, None)
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
    rec_p = os.path.join(root, "packages", "knowledge", "herbicides", "records-2026.json")
    reg_p = os.path.join(root, "packages", "knowledge", "catalog", "regions-zhejiang.json")

    def m_sim_number(work):
        p = os.path.join(work, "packages", "knowledge", "herbicides", "records-2026.json")
        d = load(p); d["records"][0]["registration_number"] = "SIM-0001"; dump(p, d)

    def m_unregistered_source(work):
        p = os.path.join(work, "packages", "knowledge", "herbicides", "records-2026.json")
        d = load(p); d["records"][0]["source"]["source_id"] = "src_not_registered"; dump(p, d)

    def m_bad_region(work):
        p = os.path.join(work, "packages", "knowledge", "catalog", "regions-zhejiang.json")
        d = load(p); d["regions"][5]["code"] = "999999"; dump(p, d)

    def m_suspicious_number(work):
        p = os.path.join(work, "packages", "knowledge", "herbicides", "records-2026.json")
        d = load(p); d["records"][0]["registration_number"] = "FAKE-123"; dump(p, d)

    def m_card_missing_dose(work):
        p = os.path.join(work, "packages", "knowledge", "herbicides", "records-2026.json")
        d = load(p); d["records"][0]["verification"]["card_eligible"] = True; dump(p, d)

    def m_delete_record(work):
        p = os.path.join(work, "packages", "knowledge", "herbicides", "records-2026.json")
        d = load(p); d["records"] = d["records"][:19]; dump(p, d)

    cases = [
        ("模拟证号混入真实记录", m_sim_number),
        ("来源未登记", m_unregistered_source),
        ("区划代码格式错误", m_bad_region),
        ("登记证号格式可疑(疑编造)", m_suspicious_number),
        ("card_eligible 缺用量字段", m_card_missing_dose),
        ("记录数不足(缺1条)", m_delete_record),
    ]
    results = [run_case(name, root, fn) for name, fn in cases]
    print(f"\n{sum(results)}/{len(results)} 负例被拒绝")
    return 0 if all(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())

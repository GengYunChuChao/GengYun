"""Validate the development baseline and its initial issue dependency graph."""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
errors = []


def check(condition, message):
    if not condition:
        errors.append(message)


def ids(text, prefix, pattern):
    return re.findall(pattern.replace("PREFIX", prefix), text, re.M)


manifest = json.loads((ROOT / "docs/initial-issues.json").read_text(encoding="utf-8"))
tasks = manifest["tasks"]
expected = [f"GY-I{i:02d}" for i in range(1, 28)]
check(manifest.get("schema_version") == 2, "Expected task schema v2")
check(manifest.get("development_version") == "v1.1", "Expected development baseline v1.1")
check(manifest.get("requirements_version") == "v1.0", "Do not silently change the requirement baseline")
check(manifest.get("platform") == "wechat-native", "User application must be a native WeChat Mini Program")
check(manifest.get("task_count") == len(tasks) == 27, "Initial baseline must contain 27 tasks")
check([item["id"] for item in tasks] == expected, "Initial task IDs must be GY-I01..27")
check(manifest["stage"] == "initial", "Only initial-stage issues may be published")
check(manifest["due_date"] == "2026-11-15", "Initial target must match the requirement baseline")
task_map = {item["id"]: item for item in tasks}
for item in tasks:
    for field in ("title", "description", "scope", "acceptance", "evidence"):
        check(bool(item.get(field)), f"{item['id']}: missing {field}")
    check(item["phase"] in ("M1", "M2", "M3", "M4"), f"{item['id']}: not initial phase")
    start_phase = item.get("start_phase", item["phase"])
    check(start_phase in ("M1", "M2", "M3", "M4") and start_phase <= item["phase"],
          f"{item['id']}: invalid start phase")
    check(item["status"] in ("待领取", "进行中", "待审PR", "需修改", "待验证", "依赖阻塞", "已验证合并"),
          f"{item['id']}: unsupported progress state")
    for dependency in item["dependencies"]:
        check(dependency in task_map and dependency != item["id"], f"{item['id']}: invalid dependency {dependency}")
    check(len(item["dependencies"]) == len(set(item["dependencies"])), f"{item['id']}: duplicate dependency")
    for fid in item["function_ids"]:
        check(re.fullmatch(r"F(?:0[1-9]|1[0-9]|20)", fid) is not None, f"{item['id']}: invalid function {fid}")
    for aid in item["acceptance_ids"]:
        check(re.fullmatch(r"AC(?:0[1-9]|1[0-9]|2[0-9])", aid) is not None, f"{item['id']}: invalid acceptance {aid}")
    check(not ({"AC03", "AC04", "AC05", "AC10", "AC20", "AC24", "AC25", "AC26", "AC27"} & set(item["acceptance_ids"])),
          f"{item['id']}: later acceptance leaked into initial issues")
    number, url = item.get("github_number"), item.get("github_url")
    check((number is None) == (url is None), f"{item['id']}: incomplete GitHub mapping")
    if number is not None:
        check(url == f"https://github.com/GengYunChuChao/GengYun/issues/{number}", f"{item['id']}: unexpected issue URL")

visiting, visited = set(), set()


def visit(task_id):
    if task_id in visiting:
        errors.append("Dependency cycle at " + task_id)
        return
    if task_id in visited:
        return
    visiting.add(task_id)
    for dependency in task_map[task_id]["dependencies"]:
        if dependency in task_map:
            visit(dependency)
    visiting.remove(task_id)
    visited.add(task_id)


for task_id in task_map:
    visit(task_id)

for task_id in ("GY-I04", "GY-I06", "GY-I12", "GY-I19"):
    check("GY-I27" in task_map[task_id]["dependencies"], f"{task_id}: privacy foundation must precede acceptance")
for task_id in ("GY-I04", "GY-I09", "GY-I10", "GY-I11", "GY-I12", "GY-I13", "GY-I14"):
    check("GY-I25" in task_map[task_id]["dependencies"], f"{task_id}: real integration feasibility gate missing")
check("GY-I11" not in task_map["GY-I12"]["dependencies"], "Text questions must not wait for the complete ASR feature")
check(task_map["GY-I26"]["dependencies"] == ["GY-I02"], "Base pages must be independent of AI and voice features")
check(task_map["GY-I21"].get("start_phase") == "M1", "Evaluation preparation must start in M1")

initial_functions = {"F01", "F02", "F03", "F04", "F05", "F08", "F12", "F13",
                     "F14", "F15", "F16", "F18", "F19", "F20"}
initial_acceptance = {"AC01", "AC02", "AC06", "AC07", "AC08", "AC09",
                      "AC11", "AC12", "AC13", "AC14", "AC15", "AC16", "AC17",
                      "AC18", "AC19", "AC21", "AC22", "AC23", "AC28", "AC29"}
check(initial_functions <= {fid for item in tasks for fid in item["function_ids"]}, "Initial function coverage incomplete")
check(initial_acceptance <= {aid for item in tasks for aid in item["acceptance_ids"]}, "Initial acceptance coverage incomplete")

product = (ROOT / "docs/product-requirements.md").read_text(encoding="utf-8")
code = (ROOT / "docs/implementation-requirements.md").read_text(encoding="utf-8")
index = (ROOT / "docs/requirements.md").read_text(encoding="utf-8")
check(ids(product, "B", r"^### (PREFIX\d+) ") == [f"B{i:02d}" for i in range(1, 23)], "Business section numbering incomplete")
check(ids(code, "F", r"^### (PREFIX\d+) ") == [f"F{i:02d}" for i in range(1, 21)], "Function numbering incomplete")
acceptance = code.split("## 8 软件验收场景", 1)[1].split("## 9 ", 1)[0]
check(ids(acceptance, "AC", r"^\| (PREFIX\d+) \|") == [f"AC{i:02d}" for i in range(1, 30)], "Acceptance numbering incomplete")
pq = product.split("## 10 本文维护的确认事项", 1)[1].split("## 11 ", 1)[0]
cq = code.split("## 9 本文维护的确认事项", 1)[1].split("## 10 ", 1)[0]
pids, cids = ids(pq, "Q", r"^\| (PREFIX\d+) \|"), ids(cq, "Q", r"^\| (PREFIX\d+) \|")
check(len(pids) == 17 and len(cids) == 12 and not set(pids) & set(cids)
      and set(pids + cids) == {f"Q{i:02d}" for i in range(1, 30)}, "Requirement ownership incomplete")
check(ids(index, "Q", r"^\| (PREFIX\d+) \|") == [f"Q{i:02d}" for i in range(1, 30)], "Requirement navigation incomplete")

markdown_files = [ROOT / "README.md", ROOT / "AGENTS.md", ROOT / ".github/PULL_REQUEST_TEMPLATE.md"]
markdown_files += list((ROOT / "docs").rglob("*.md"))
for path in markdown_files:
    text = path.read_text(encoding="utf-8")
    check("\ufffd" not in text, f"{path.name}: invalid character")
    previous = None
    for line_number, line in enumerate(text.splitlines(), 1):
        if line.startswith("|"):
            columns = len(re.split(r"(?<!\\)\|", line)) - 2
            check(previous is None or columns == previous, f"{path.name}:{line_number}: inconsistent table")
            previous = columns
        else:
            previous = None
    for target in re.findall(r"\]\(([^)]+)\)", text):
        if "://" in target or target.startswith("#"):
            continue
        check((path.parent / target.split("#")[0]).exists(), f"{path.name}: missing link {target}")

numbers = [item["github_number"] for item in tasks if item.get("github_number") is not None]
check(len(numbers) == len(set(numbers)), "Duplicate GitHub issue mapping")
if errors:
    print("\n".join("ERROR: " + error for error in errors))
    raise SystemExit(1)
print(f"PASS: {len(tasks)} initial tasks; acyclic dependencies; complete F/AC/Q mapping; Markdown links and tables")

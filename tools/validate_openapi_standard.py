"""Optional independent OpenAPI check using the official schema and jsonschema.

Usage: python tools/validate_openapi_standard.py --schema <downloaded official
schema> [--dependency-path <isolated jsonschema install>]. No downloads or installs
are performed by this script. Ordinary CI uses validate_contracts.py instead.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--schema', type=Path, required=True)
parser.add_argument('--dependency-path', type=Path)
args = parser.parse_args()
if args.dependency_path:
    sys.path.insert(0, str(args.dependency_path.resolve()))
try:
    from jsonschema import Draft202012Validator, FormatChecker
except ImportError:
    raise SystemExit('jsonschema unavailable; install in an isolated directory, do not claim standard validation passed')

root = Path(__file__).resolve().parents[1]
raw = args.schema.read_bytes()
schema = json.loads(raw)
expected_id = 'https://spec.openapis.org/oas/3.1/schema/2022-10-07'
if schema.get('$id') != expected_id:
    raise SystemExit('Unexpected official schema ID')
spec = json.loads((root / 'packages/contracts/openapi.json').read_text(encoding='utf-8'))
Draft202012Validator.check_schema(schema)
Draft202012Validator(schema, format_checker=FormatChecker()).validate(spec)
for name, component in spec['components']['schemas'].items():
    Draft202012Validator.check_schema(component)
fixtures = json.loads((root / 'packages/contracts/examples.json').read_text(encoding='utf-8'))['fixtures']
for fixture in fixtures:
    standalone = {'$ref': '#/components/schemas/' + fixture['schema'], 'components': spec['components']}
    Draft202012Validator(standalone, format_checker=FormatChecker()).validate(fixture['value'])
print(f"PASS: official OpenAPI 3.1 schema; {len(spec['components']['schemas'])} Draft2020-12 component schemas; {len(fixtures)} design fixtures")
print('Official schema SHA256: ' + hashlib.sha256(raw).hexdigest())

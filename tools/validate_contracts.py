"""Offline checks for the GY-I01 contract and its sanitized design fixtures.

This is deliberately not a complete OpenAPI/JSON Schema validator or a server
test. Full specification validation and runtime evidence are recorded separately.
"""
import json
import re
from datetime import datetime
from pathlib import Path
from uuid import UUID

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    return json.loads((ROOT / 'packages/contracts' / name).read_text(encoding='utf-8'))


def resolve(spec, node):
    if '$ref' not in node:
        return node
    target = spec
    reference = node['$ref']
    if not reference.startswith('#/'):
        raise ValueError('External reference is not allowed: ' + reference)
    for part in reference[2:].split('/'):
        target = target[part.replace('~1', '/').replace('~0', '~')]
    return target


def walk(value):
    yield value
    if isinstance(value, dict):
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def validate_value(spec, schema, value, path='$'):
    """Check the subset used by these fixtures; reject unsupported assertions."""
    if '$ref' in schema:
        name = schema['$ref'].rsplit('/', 1)[-1]
        validate_value(spec, resolve(spec, schema), value, path)
        validate_semantics(name, value)
        return
    allowed = {'type', 'properties', 'required', 'additionalProperties', 'items',
               'maxItems', 'minItems', 'uniqueItems', 'minimum', 'maximum',
               'minLength', 'maxLength', 'pattern', 'format', 'enum', 'const',
               'anyOf', 'oneOf', 'discriminator', 'description', 'default', 'title'}
    if set(schema) - allowed:
        raise ValueError('Unsupported fixture assertion: ' + str(set(schema) - allowed))
    for keyword in ('anyOf', 'oneOf'):
        if keyword in schema:
            successes = 0
            for branch in schema[keyword]:
                try:
                    validate_value(spec, branch, value, path)
                    successes += 1
                except (ValueError, TypeError, KeyError):
                    pass
            if successes == 0 or keyword == 'oneOf' and successes != 1:
                raise ValueError(path + ': ' + keyword + ' mismatch')
            return
    if 'const' in schema and (value != schema['const'] or type(schema['const']) is bool and type(value) is not bool):
        raise ValueError(path + ': const mismatch')
    if 'enum' in schema and value not in schema['enum']:
        raise ValueError(path + ': enum mismatch')
    kind = schema.get('type')
    predicates = {'object': lambda v: isinstance(v, dict),
                  'array': lambda v: isinstance(v, list),
                  'string': lambda v: isinstance(v, str),
                  'integer': lambda v: type(v) is int,
                  'number': lambda v: type(v) in (int, float),
                  'boolean': lambda v: type(v) is bool,
                  'null': lambda v: v is None}
    if kind and not predicates[kind](value):
        raise ValueError(path + ': wrong type ' + kind)
    if kind == 'object':
        props = schema.get('properties', {})
        if set(schema.get('required', [])) - value.keys():
            raise ValueError(path + ': missing required fields')
        if schema.get('additionalProperties') is False and value.keys() - props.keys():
            raise ValueError(path + ': unknown fields')
        for key, item in value.items():
            if key in props:
                validate_value(spec, props[key], item, path + '.' + key)
    if kind == 'array':
        if len(value) > schema.get('maxItems', float('inf')) or len(value) < schema.get('minItems', 0):
            raise ValueError(path + ': array size')
        if schema.get('uniqueItems') and len({json.dumps(v, sort_keys=True) for v in value}) != len(value):
            raise ValueError(path + ': duplicate items')
        for i, item in enumerate(value):
            validate_value(spec, schema['items'], item, f'{path}[{i}]')
    if kind == 'string':
        if len(value) > schema.get('maxLength', float('inf')) or len(value) < schema.get('minLength', 0):
            raise ValueError(path + ': string size')
        if 'pattern' in schema and re.search(schema['pattern'], value) is None:
            raise ValueError(path + ': pattern mismatch')
        if schema.get('format') == 'uuid':
            UUID(value)
        if schema.get('format') == 'date-time':
            parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
            if parsed.tzinfo is None:
                raise ValueError(path + ': timezone required')
        if schema.get('format') == 'uri' and not re.match(r'^https://[^/\s]+', value):
            raise ValueError(path + ': HTTPS URI required')
    if kind in ('number', 'integer'):
        if value < schema.get('minimum', -float('inf')) or value > schema.get('maximum', float('inf')):
            raise ValueError(path + ': numeric bounds')


def validate_semantics(name, value):
    if name == 'DoseCard':
        source = value['source']
        if (source['source_kind'] == 'simulation' or source['evidence_kind'] == 'experience'
                or source['validity'] != 'valid' or source['review_status'] != 'verified'):
            raise ValueError('DoseCard: source is not usable')
        required = {'crop_id', 'region_code', 'species_id', 'growth_stage', 'planting_method', 'use_scene'}
        if not required <= value['conditions'].keys():
            raise ValueError('DoseCard: incomplete conditions')
    if name == 'Verification':
        if value['match_state'] == 'matched' and (value['registration'] is None or value['conflict_fields'] or value['missing_fields']):
            raise ValueError('Verification: matched with conflict/missing registration')
        if value['match_state'] != 'matched' and value['dose_cards']:
            raise ValueError('Verification: unmatched dose card')
    if name == 'Job':
        if value['state'] in ('succeeded', 'uncertain'):
            if value['result'] is None or value['result']['kind'] != value['kind']:
                raise ValueError('Job: successful result kind missing/mismatched')
        elif value['result'] is not None:
            raise ValueError('Job: premature result')
    if name in ('Post', 'Comment') and value['visibility'] == 'published' and value['audit_state'] != 'approved':
        raise ValueError('Content: published before approval')
    if name == 'Transcription' and ((value['confirmed_text'] is None) != (value['confirmed_at'] is None)):
        raise ValueError('Transcription: partial confirmation')
    if name == 'Answer':
        if value['status'] == 'answered' and (value['check_state'] != 'passed' or not value['citations']):
            raise ValueError('Answer: unchecked or missing citations')
        if value['status'] != 'answered' and value['dose_cards']:
            raise ValueError('Answer: blocked/insufficient with dose cards')
    if name == 'UploadInput':
        purpose = value['purpose']
        limit = 10485760 if purpose == 'voice_question' else 5242880 if purpose == 'community_image' else 2097152
        if value['bytes'] > limit:
            raise ValueError('Upload: purpose byte limit')
        audio = value['mime'].startswith('audio/')
        if audio != (purpose == 'voice_question') or audio and 'duration_ms' not in value:
            raise ValueError('Upload: purpose/format/duration mismatch')
        if not audio and 'duration_ms' in value:
            raise ValueError('Upload: image with duration')
    if name == 'SynthesisInput' and value['checked_content_ref']['type'] not in ('answer', 'scheme', 'herbicide', 'species', 'static_region', 'dose_card'):
        raise ValueError('TTS: unchecked target type')
    if name == 'FavoriteInput' and value['target_ref']['type'] not in ('species', 'herbicide', 'scheme'):
        raise ValueError('Favorite: unsupported target type')


def check_contract(spec, states, manifest, fixtures):
    errors = []

    def check(condition, message):
        if not condition:
            errors.append(message)

    check(spec['openapi'] == '3.1.1', 'OpenAPI version')
    check(spec['info']['version'] == states['contract_version'] == manifest['contract_version'] == '1.0.0', 'Contract version drift')
    check(spec['servers'] == [{'url': '/api/v1', 'description': '相对地址，部署由GY-I25确认；不是已在线服务'}], 'Unexpected live server')
    for node in walk(spec):
        if isinstance(node, dict) and '$ref' in node:
            try:
                resolve(spec, node)
            except (KeyError, ValueError):
                errors.append('Broken reference ' + node['$ref'])
        if isinstance(node, dict) and node.get('type') == 'object':
            check(set(node.get('required', [])) <= node.get('properties', {}).keys(), 'Required field not defined')
    for name, values in states['states'].items():
        check(spec['components']['schemas'][name]['enum'] == values, 'State drift ' + name)
    check(spec['x-error-status-map'] == states['error_status_map'], 'Error/status drift')
    transitions = states['job_transitions']
    check(set(transitions) == set(states['states']['JobState']), 'Job states incomplete')
    for terminal in ('succeeded', 'uncertain', 'failed', 'timed_out', 'cancelled'):
        check(transitions[terminal] == [], 'Terminal resurrection ' + terminal)
    for state, targets in transitions.items():
        check(set(targets) <= transitions.keys() and state not in targets, 'Invalid transition ' + state)
    anonymous = {('/public/home', 'get'), ('/auth/wechat', 'post'), ('/admin/auth/session', 'post')}
    actual = []
    seen = set()
    for path, methods in spec['paths'].items():
        check(not re.search(r'/(payments|votes|plans|feedback|training|expert|alerts|reports/export)(/|$)', path), 'Later-stage endpoint ' + path)
        for method, op in methods.items():
            oid = op['operationId']
            check(oid not in seen, 'Duplicate operationId ' + oid)
            seen.add(oid)
            scope = op['x-scope']
            expected = [] if (path, method) in anonymous else [{'adminSession' if path.startswith('/admin/') else 'deletionReceipt' if path.startswith('/account/deletions/') else 'userSession': []}]
            check(op['security'] == expected, 'Authentication boundary ' + oid)
            check((scope == 'public') == ((path, method) in anonymous), 'Public scope mismatch ' + oid)
            if path.startswith('/admin/') and (path, method) not in anonymous:
                check(':' in scope, 'Missing admin scope ' + oid)
            params = [resolve(spec, p) for p in op.get('parameters', [])]
            headers = {p['name']: p for p in params if p['in'] == 'header'}
            if method != 'get':
                check(headers.get('Idempotency-Key', {}).get('required') is True, 'Missing idempotency ' + oid)
            if op['x-version-required']:
                check(headers.get('If-Match', {}).get('required') is True, 'Missing version guard ' + oid)
            names = {p['name'] for p in params if p['in'] == 'path' and p.get('required')}
            check(names == set(re.findall(r'{([^}]+)}', path)), 'Path params ' + oid)
            if any(p['name'] == 'cursor' for p in params):
                limit = next((p for p in params if p['name'] == 'limit'), {})
                check(limit.get('schema', {}).get('maximum') == 50, 'Unbounded pagination ' + oid)
            check(any(code.startswith('2') for code in op['responses']), 'No success response ' + oid)
            check(set(states['error_status_map']) <= op['responses'].keys(), 'Missing error response ' + oid)
            actual.append({'id': oid, 'path': path, 'method': method, 'scope': scope, 'version_required': op['x-version-required']})
    ordering = lambda item: (item['path'], item['method'])
    check(sorted(actual, key=ordering) == sorted(manifest['operations'], key=ordering), 'Operations manifest drift')
    for fixture in fixtures:
        try:
            validate_value(spec, {'$ref': '#/components/schemas/' + fixture['schema']}, fixture['value'])
        except (ValueError, KeyError, TypeError) as exc:
            errors.append('Fixture ' + fixture['name'] + ': ' + str(exc))
    return errors


if __name__ == '__main__':
    spec, states, manifest, fixtures = (load(name) for name in ('openapi.json', 'states.json', 'operations.json', 'examples.json'))
    problems = check_contract(spec, states, manifest, fixtures['fixtures'])
    if problems:
        print('\n'.join('ERROR: ' + p for p in problems))
        raise SystemExit(1)
    print(f"PASS: {len(manifest['operations'])} operations; references/security/idempotency/version/state/error consistency; {len(fixtures['fixtures'])} sanitized design fixtures (not runtime tests)")

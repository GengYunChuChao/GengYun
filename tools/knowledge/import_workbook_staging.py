"""Read OOXML without running formulas/links; emit private, unreviewed staging SQL.

Standard-library only. Does not connect to databases or publish knowledge records.
"""
import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import unicodedata
import uuid
import zipfile
import xml.etree.ElementTree as ET

VERSION = 'herbicide-summary-v1'
MAX_WORKBOOK_BYTES = 25_000_000
MAX_INTAKE_ROWS = 10_000
MAX_INTAKE_JSON_BYTES = 8_000_000
HEADERS = ['除草剂名称', '常见别称／商品名', '对环境危害等级',
           '对环境主要造成的危害', '常用于防除的对象（杂草）', '适用／常用地区']
FIELDS = ['name_text', 'aliases_text', 'risk_grade_text', 'risk_text', 'weed_text', 'region_text']
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'


def normalized(value):
    return unicodedata.normalize('NFKC', str(value)).strip() if value is not None else None


def inspect_workbook(path, max_rows=None):
    """Preserve coordinates, stored values, types, formulas and cached results."""
    # Never reopen the path: save/sync may replace it after this bounded read.
    # Size, identity and all ZIP members describe this exact immutable snapshot.
    with Path(path).open('rb') as source:
        content = source.read(MAX_WORKBOOK_BYTES + 1)
    if len(content) > MAX_WORKBOOK_BYTES:
        raise ValueError('WORKBOOK_TOO_LARGE')
    sheets = []
    row_count = 0
    cell_count = 0
    with zipfile.ZipFile(io.BytesIO(content)) as archive:
        if sum(i.file_size for i in archive.infolist()) > 100_000_000:
            raise ValueError('EXPANDED_WORKBOOK_TOO_LARGE')
        parts = archive.namelist()
        shared = []
        if 'xl/sharedStrings.xml' in parts:
            shared = [''.join(t.text or '' for t in x.findall('.//m:t', NS))
                      for x in ET.fromstring(archive.read('xl/sharedStrings.xml')).findall('m:si', NS)]
        relations = {x.attrib['Id']: x.attrib for x in
                     ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))}
        book = ET.fromstring(archive.read('xl/workbook.xml'))
        for sheet in book.findall('m:sheets/m:sheet', NS):
            relation = relations[sheet.attrib['{' + REL + '}id']]
            if relation.get('TargetMode') == 'External':
                raise ValueError('EXTERNAL_WORKSHEET_FORBIDDEN')
            target = relation['Target']
            part = target.lstrip('/') if target.startswith('/') else str(PurePosixPath('xl') / target)
            if '..' in PurePosixPath(part).parts:
                raise ValueError('INVALID_WORKSHEET_PART')
            root = ET.fromstring(archive.read(part))
            rows = []
            for row in root.findall('m:sheetData/m:row', NS):
                cells = {}
                for cell in row.findall('m:c', NS):
                    cell_count += 1
                    if max_rows is not None and cell_count > 100_000:
                        raise ValueError('INTAKE_LIMIT_EXCEEDED')
                    value_node = cell.find('m:v', NS)
                    stored = value_node.text if value_node is not None else None
                    kind = cell.attrib.get('t', 'n')
                    value = shared[int(stored)] if kind == 's' and stored is not None else stored
                    if kind == 'inlineStr':
                        value = ''.join(t.text or '' for t in cell.findall('.//m:t', NS))
                    formula = cell.find('m:f', NS)
                    cells[cell.attrib['r']] = {'value': value, 'stored': stored, 'type': kind,
                                               'formula': (formula.text or '') if formula is not None else None,
                                               'formula_attributes': formula.attrib if formula is not None else None,
                                               'style': cell.attrib.get('s')}
                if any(c['value'] not in (None, '') or c['formula'] is not None for c in cells.values()):
                    row_count += 1
                    if max_rows is not None and row_count > max_rows:
                        raise ValueError('INTAKE_LIMIT_EXCEEDED')
                    rows.append({'excel_row': int(row.attrib['r']), 'cells': cells})
            comments = []
            relpart = str(PurePosixPath(part).parent / '_rels' / (PurePosixPath(part).name + '.rels'))
            if relpart in parts:
                comments = [x.attrib for x in ET.fromstring(archive.read(relpart))
                            if x.attrib.get('Type', '').endswith('/comments')]
            sheets.append({'name': sheet.attrib['name'], 'state': sheet.attrib.get('state', 'visible'),
                           'rows': rows, 'merged': [m.attrib['ref'] for m in root.findall('m:mergeCells/m:mergeCell', NS)],
                           'comment_parts': comments})
        return {'sha256': hashlib.sha256(content).hexdigest(), 'filename': Path(path).name,
                'sheets': sheets, 'macro_present': any('vbaproject' in x.lower() for x in parts),
                'external_links_present': any('externalLinks/' in x for x in parts)}


def build_import(book):
    main = next((s for s in book['sheets'] if s['name'] == '除草剂汇总表'), None)
    if main is None or not main['rows'] or main['merged']:
        raise ValueError('EXPECTED_TABLE_MISSING_OR_MERGED')
    first = main['rows'][0]
    headers = [first['cells'].get(f'{chr(65+i)}1', {}).get('value') for i in range(6)]
    if headers != HEADERS or any(c['formula'] is not None for c in first['cells'].values()):
        raise ValueError('HEADER_MAPPING_MISMATCH')
    if book['macro_present'] or book['external_links_present']:
        raise ValueError('ACTIVE_WORKBOOK_CONTENT_FORBIDDEN')
    data = main['rows'][1:]
    counts = Counter(normalized(r['cells'].get(f'A{r["excel_row"]}', {}).get('value')) for r in data)
    batch_id = str(uuid.uuid5(uuid.NAMESPACE_URL, book['sha256'] + ':' + VERSION))
    rows = []
    missing = [0] * 6
    for sheet in book['sheets']:
        for row in sheet['rows']:
            is_data = sheet is main and row['excel_row'] > 1
            fields = {}
            issues = []
            if is_data:
                for i, key in enumerate(FIELDS):
                    value = row['cells'].get(f'{chr(65+i)}{row["excel_row"]}', {}).get('value')
                    fields[key] = value
                    if value is None or not normalized(value):
                        missing[i] += 1
                        issues.append('MISSING_' + key.upper())
                fields['name_search'] = normalized(fields['name_text'])
                if counts[fields['name_search']] > 1:
                    issues.append('DUPLICATE_NAME')
                if any(c['formula'] is not None for c in row['cells'].values()):
                    issues.append('FORMULA_NOT_EVALUATED')
                if any(c['type'] == 'e' for c in row['cells'].values()):
                    issues.append('CELL_ERROR')
                if any(not re.fullmatch(r'[A-F][0-9]+', coord) for coord in row['cells']):
                    issues.append('UNMAPPED_COLUMN')
                fields.update(registration_number=None, dosage_form=None, concentration_text=None,
                              unit_text=None, label_text=None, source_url=None, validity='unknown',
                              review_status='unverified', card_ready=False)
            raw = {'cells': row['cells'], 'sheet_state': sheet['state']}
            digest = hashlib.sha256(json.dumps(raw, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
            rows.append({'sheet': sheet['name'], 'excel_row': row['excel_row'], 'row_hash': digest,
                         'raw': raw, 'mapped': fields,
                         'state': 'quarantined' if issues else 'unreviewed' if is_data else 'context',
                         'issues': issues})
    quality = {'data_rows': len(data), 'missing_by_header': dict(zip(HEADERS, missing)),
               'duplicate_name_groups': sum(v > 1 for k, v in counts.items() if k),
               'quarantined_rows': sum(r['state'] == 'quarantined' for r in rows),
               'formula_cells': sum(c['formula'] is not None for s in book['sheets'] for r in s['rows'] for c in r['cells'].values()),
               'comment_part_count': sum(len(s['comment_parts']) for s in book['sheets']),
               'merged_count': sum(len(s['merged']) for s in book['sheets']),
               'macro_present': book['macro_present'], 'external_links_present': book['external_links_present'],
               'source_url_column_present': False, 'registration_column_present': False,
               'sheets': [{'name': s['name'], 'nonempty_rows': len(s['rows']), 'state': s['state']} for s in book['sheets']]}
    return {'batch_id': batch_id, 'sha256': book['sha256'], 'filename': book['filename'],
            'mapping_version': VERSION, 'extracted_at': datetime.now(timezone.utc).isoformat(),
            'quality': quality, 'rows': rows}


def literal(value):
    # Standard-conforming strings are explicitly enabled in emitted SQL.
    return "'" + str(value).replace("'", "''") + "'"


def sql_for(payload):
    batch = payload['batch_id']
    statements = ['BEGIN;', 'SET LOCAL standard_conforming_strings = on;',
                  f"SELECT pg_advisory_xact_lock(hashtext({literal(batch)}));",
                  'INSERT INTO knowledge_staging.workbook_batches (id, file_sha256, filename, mapping_version, quality) VALUES (' +
                  ','.join(literal(x) for x in [batch, payload['sha256'], payload['filename'], payload['mapping_version'],
                                                json.dumps(payload['quality'], ensure_ascii=False)]) + ') ON CONFLICT (file_sha256,mapping_version) DO NOTHING;']
    for row in payload['rows']:
        values = [literal(batch), literal(row['sheet']), str(row['excel_row']), literal(row['row_hash']),
                  literal(json.dumps(row['raw'], ensure_ascii=False)), literal(json.dumps(row['mapped'], ensure_ascii=False)),
                  literal(row['state']), literal(json.dumps(row['issues']))]
        statements.append('INSERT INTO knowledge_staging.workbook_rows (batch_id,sheet_name,excel_row,row_hash,raw,mapped,state,issues) VALUES (' +
                          ','.join(values) + ') ON CONFLICT (batch_id,sheet_name,excel_row) DO NOTHING;')
    statements.append('COMMIT;')
    return '\n'.join(statements) + '\n'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workbook')
    parser.add_argument('--output', help='New ignored local directory; refuses overwrite')
    parser.add_argument('--internal-json', action='store_true', help='Private subprocess pipe only; no output files')
    args = parser.parse_args()
    if args.internal_json:
        if any(os.environ.get(k) for k in ('DATABASE_URL', 'DATABASE_TEST_URL', 'STAGING_PG_TEST_URL', 'STAGING_INTAKE_TEST_URL')):
            raise ValueError('PRIVATE_DATABASE_ENV_FORBIDDEN')
        if args.output is not None:
            parser.error('Internal pipe does not accept output files')
        payload = build_import(inspect_workbook(args.workbook, max_rows=MAX_INTAKE_ROWS))
        encoded = json.dumps(payload, ensure_ascii=False)
        if len(payload['rows']) > MAX_INTAKE_ROWS or len(encoded.encode('utf-8')) > MAX_INTAKE_JSON_BYTES:
            raise ValueError('INTAKE_LIMIT_EXCEEDED')
        print(encoded)
        return
    if args.output is None:
        parser.error('Output directory required')
    out = Path(args.output).resolve()
    root = Path(__file__).resolve().parents[2]
    if not out.is_relative_to(root / '.local'):
        parser.error('Output must be within this repository .local directory')
    payload = build_import(inspect_workbook(args.workbook))
    out.mkdir(parents=True, exist_ok=False)
    (out / 'staging.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
    (out / 'import.sql').write_text(sql_for(payload), encoding='utf-8')
    (out / 'rollback.sql').write_text('BEGIN;\nDELETE FROM knowledge_staging.workbook_batches WHERE id=' + literal(payload['batch_id']) + ';\nCOMMIT;\n', encoding='utf-8')
    print(json.dumps(payload['quality'], ensure_ascii=False))


if __name__ == '__main__':
    main()

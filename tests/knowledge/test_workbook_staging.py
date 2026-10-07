import copy
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
import zipfile
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('intake', ROOT / 'tools/knowledge/import_workbook_staging.py')
intake = importlib.util.module_from_spec(spec)
spec.loader.exec_module(intake)


def fixture():
    def row(number, values):
        return {'excel_row': number, 'cells': {f'{chr(65+i)}{number}':
                {'value': v, 'stored': v, 'type': 'inlineStr', 'formula': None, 'style': None}
                for i, v in enumerate(values)}}
    main = {'name': '除草剂汇总表', 'state': 'visible', 'merged': [], 'comment_parts': [],
            'rows': [row(1, intake.HEADERS), row(2, ["合成'药", '示例别称', '表内等级', '未核验风险', '未知', '未知'])]}
    notes = {'name': '说明与使用提示', 'state': 'visible', 'merged': [], 'comment_parts': [],
             'rows': [row(3, ['合成说明；不是标签'])]}
    return {'sha256': 'a' * 64, 'filename': 'synthetic.xlsx', 'macro_present': False,
            'external_links_present': False, 'sheets': [main, notes]}


class IntakeTests(unittest.TestCase):
    def test_ooxml_relationships_and_original_coordinates(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / 'synthetic.xlsx'
            ns = intake.NS['m']
            with zipfile.ZipFile(path, 'w') as z:
                z.writestr('xl/workbook.xml', f'<workbook xmlns="{ns}" xmlns:r="{intake.REL}"><sheets><sheet name="除草剂汇总表" sheetId="9" r:id="sheet9"/></sheets></workbook>')
                z.writestr('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="sheet9" Target="worksheets/unusual.xml"/></Relationships>')
                rows = []
                for r in fixture()['sheets'][0]['rows']:
                    cells = ''.join(f'<c r="{coord}" t="inlineStr"><is><t>{escape(c["value"])}</t></is></c>' for coord, c in r['cells'].items())
                    rows.append(f'<row r="{r["excel_row"]}">{cells}</row>')
                z.writestr('xl/worksheets/unusual.xml', f'<worksheet xmlns="{ns}"><sheetData>{"".join(rows)}</sheetData></worksheet>')
            book = intake.inspect_workbook(path)
            self.assertEqual(book['sheets'][0]['rows'][1]['cells']['A2']['value'], "合成'药")
            self.assertEqual(intake.build_import(book)['quality']['data_rows'], 1)

    def test_missing_duplicates_and_formula_cache_stay_quarantined(self):
        book = fixture()
        second = copy.deepcopy(book['sheets'][0]['rows'][1])
        second['excel_row'] = 4
        second['cells'] = {coord[0] + '4': value for coord, value in second['cells'].items()}
        second['cells']['B4']['value'] = None
        second['cells']['C4']['formula'] = '1/0'
        second['cells']['C4']['value'] = '#DIV/0!'
        second['cells']['C4']['type'] = 'e'
        book['sheets'][0]['rows'].append(second)
        payload = intake.build_import(book)
        self.assertEqual(payload['quality']['quarantined_rows'], 2)
        self.assertIn('CELL_ERROR', payload['rows'][2]['issues'])
        self.assertIn('FORMULA_NOT_EVALUATED', payload['rows'][2]['issues'])
        self.assertEqual(payload['rows'][2]['mapped']['aliases_text'], None)

    def test_header_drift_and_active_parts_fail_closed(self):
        for key in ['macro_present', 'external_links_present']:
            book = fixture(); book[key] = True
            with self.assertRaises(ValueError): intake.build_import(book)
        book = fixture(); book['sheets'][0]['rows'][0]['cells']['A1']['value'] = '登记号'
        with self.assertRaises(ValueError): intake.build_import(book)

    def test_idempotent_batch_keeps_raw_and_never_promotes(self):
        first = intake.build_import(fixture()); second = intake.build_import(fixture())
        self.assertEqual(first['batch_id'], second['batch_id'])
        self.assertEqual(first['rows'][1]['mapped']['name_text'], "合成'药")
        self.assertIsNone(first['rows'][1]['mapped']['registration_number'])
        sql = intake.sql_for(first)
        self.assertIn("合成''药", sql)
        self.assertIn('ON CONFLICT', sql)
        self.assertNotIn('INSERT INTO sources', sql)
        self.assertFalse(first['rows'][1]['mapped']['card_ready'])


if __name__ == '__main__':
    if '--sql' in sys.argv:
        print(intake.sql_for(intake.build_import(fixture())))
    else:
        unittest.main()

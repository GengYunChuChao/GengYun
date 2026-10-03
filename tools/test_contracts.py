"""Regression tests for the contract checker, not for unimplemented APIs."""
import copy
import unittest

from validate_contracts import check_contract, load, validate_value, validate_media_trace, validate_knowledge_roundtrip


class ContractChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spec = load('openapi.json')
        cls.states = load('states.json')
        cls.manifest = load('operations.json')
        cls.examples = load('examples.json')
        cls.fixtures = cls.examples['fixtures']

    def test_valid_contract(self):
        self.assertEqual([], check_contract(self.spec, self.states, self.manifest, self.fixtures,
                                           self.examples['community_media_traces'], self.examples['knowledge_roundtrips']))

    def test_structural_boundary_mutations_rejected(self):
        mutations = {
            'missing_ref': lambda s: s['components']['schemas']['Media']['properties'].update({'purpose': {'$ref': '#/components/schemas/Missing'}}),
            'anonymous_private': lambda s: s['paths']['/me/profile']['get'].update({'security': []}),
            'user_admin': lambda s: s['paths']['/admin/jobs']['get'].update({'security': [{'userSession': []}]}),
            'no_idempotency': lambda s: s['paths']['/posts']['post'].update({'parameters': []}),
            'no_revision': lambda s: s['paths']['/posts/{id}']['patch'].update({'parameters': []}),
            'state_drift': lambda s: s['components']['schemas']['JobState']['enum'].append('resurrected'),
            'no_scoped_media_token': lambda s: s['paths']['/community/media/{grant_id}/content']['get'].update({'parameters': []}),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                changed = copy.deepcopy(self.spec)
                mutate(changed)
                self.assertTrue(check_contract(changed, self.states, self.manifest, self.fixtures))

    def test_terminal_resurrection_rejected(self):
        changed = copy.deepcopy(self.states)
        changed['job_transitions']['cancelled'] = ['running']
        self.assertTrue(check_contract(self.spec, changed, self.manifest, self.fixtures))

    def test_design_fixture_mutations_rejected(self):
        fixtures = {f['name']: f for f in self.fixtures}
        cases = [
            ('speech_turn', lambda v: v.update({'confirmed': False})),
            ('speech_turn', lambda v: v.update({'confirmed': 1})),
            ('dose_card', lambda v: v['source'].update({'source_kind': 'simulation'})),
            ('dose_card', lambda v: v['conditions'].pop('growth_stage')),
            ('published_post', lambda v: v.update({'audit_state': 'pending'})),
            ('recognition_job', lambda v: v.update({'state': 'cancelled'})),
            ('voice_upload', lambda v: v.update({'bytes': 10485761})),
            ('voice_upload', lambda v: v.update({'purpose': 'community_image'})),
            ('insufficient_answer', lambda v: v.update({'dose_cards': [fixtures['dose_card']['value']]})),
            ('published_post_media', lambda v: v['media'][0].pop('media_revision')),
            ('published_post_media', lambda v: v['media'][0].update({'media_id': '00000000-0000-4000-8000-000000000099'})),
            ('community_avatar_request', lambda v: v.update({'author_revision': None})),
            ('comment_avatar', lambda v: v.update({'visibility': 'hidden'})),
            ('post_with_knowledge', lambda v: v.pop('linked_knowledge_ref')),
            ('post_with_knowledge', lambda v: v['linked_knowledge']['target_ref'].update({'revision': 99})),
            ('post_unavailable_knowledge', lambda v: v['linked_knowledge'].update({'summary': {'title': 'restricted old title'}})),
        ]
        for name, mutate in cases:
            with self.subTest(name=name):
                fixture = fixtures[name]
                value = copy.deepcopy(fixture['value'])
                mutate(value)
                with self.assertRaises(ValueError):
                    validate_value(self.spec, {'$ref': '#/components/schemas/' + fixture['schema']}, value)

    def test_author_and_reader_media_transcripts(self):
        for trace in self.examples['community_media_traces']:
            with self.subTest(name=trace['name']):
                validate_media_trace(self.spec, trace)
        reader = next(t for t in self.examples['community_media_traces'] if t['name'] == 'other_reader_attachment')
        self.assertNotEqual(reader['request']['content_ref']['revision'], reader['request']['media_ref']['media_revision'])

    def test_media_guard_and_grant_mutations_rejected(self):
        originals = {t['name']: t for t in self.examples['community_media_traces']}
        mutations = [
            ('other_reader_attachment', lambda t: t['request']['media_ref'].update({'media_revision': 7})),
            ('other_reader_attachment', lambda t: t.update({'if_match': '"11"'})),
            ('other_reader_attachment', lambda t: t['grant']['media_ref'].update({'media_revision': 7})),
            ('other_reader_attachment', lambda t: t['consume_request'].update({'access_token': 'another-grant'})),
            ('hidden_content', lambda t: t.update({'consume_status': 200})),
            ('private_content', lambda t: t.update({'consume_status': 200})),
            ('private_recognition', lambda t: t.update({'consume_status': 200})),
            ('old_content', lambda t: t.update({'consume_status': 200})),
            ('old_media_version', lambda t: t.update({'consume_status': 200})),
            ('avatar_anonymized', lambda t: t.update({'consume_status': 200})),
            ('reader_question_at_grant', lambda t: t.update({'grant_status': 200})),
        ]
        for name, mutate in mutations:
            with self.subTest(name=name):
                trace = copy.deepcopy(originals[name])
                mutate(trace)
                with self.assertRaises(ValueError):
                    validate_media_trace(self.spec, trace)

    def test_knowledge_reference_roundtrips(self):
        for trace in self.examples['knowledge_roundtrips']:
            with self.subTest(name=trace['name']):
                validate_knowledge_roundtrip(self.spec, trace)

    def test_lost_reference_and_hidden_summary_rejected(self):
        originals = {t['name']: t for t in self.examples['knowledge_roundtrips']}
        mutations = [
            ('valid_link', lambda t: t['detail'].update({'linked_knowledge_ref': None, 'linked_knowledge': None})),
            ('valid_link', lambda t: t['listed'].update({'linked_knowledge_ref': None, 'linked_knowledge': None})),
            ('edit_omit_keep_link', lambda t: t['edited'].update({'linked_knowledge_ref': None, 'linked_knowledge': None})),
            ('edit_clear_link', lambda t: t['edited'].update({'linked_knowledge_ref': t['detail']['linked_knowledge_ref'], 'linked_knowledge': t['detail']['linked_knowledge']})),
            ('not_visible_link', lambda t: t['detail']['linked_knowledge'].update({'summary': {'title': 'restricted'}})),
        ]
        for name, mutate in mutations:
            with self.subTest(name=name):
                trace = copy.deepcopy(originals[name])
                mutate(trace)
                with self.assertRaises(ValueError):
                    validate_knowledge_roundtrip(self.spec, trace)


if __name__ == '__main__':
    unittest.main(verbosity=2)

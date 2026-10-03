"""Regression tests for the contract checker, not for unimplemented APIs."""
import copy
import unittest

from validate_contracts import check_contract, load, validate_value


class ContractChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.spec = load('openapi.json')
        cls.states = load('states.json')
        cls.manifest = load('operations.json')
        cls.fixtures = load('examples.json')['fixtures']

    def test_valid_contract(self):
        self.assertEqual([], check_contract(self.spec, self.states, self.manifest, self.fixtures))

    def test_structural_boundary_mutations_rejected(self):
        mutations = {
            'missing_ref': lambda s: s['components']['schemas']['Media']['properties'].update({'purpose': {'$ref': '#/components/schemas/Missing'}}),
            'anonymous_private': lambda s: s['paths']['/me/profile']['get'].update({'security': []}),
            'user_admin': lambda s: s['paths']['/admin/jobs']['get'].update({'security': [{'userSession': []}]}),
            'no_idempotency': lambda s: s['paths']['/posts']['post'].update({'parameters': []}),
            'no_revision': lambda s: s['paths']['/posts/{id}']['patch'].update({'parameters': []}),
            'state_drift': lambda s: s['components']['schemas']['JobState']['enum'].append('resurrected'),
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
        ]
        for name, mutate in cases:
            with self.subTest(name=name):
                fixture = fixtures[name]
                value = copy.deepcopy(fixture['value'])
                mutate(value)
                with self.assertRaises(ValueError):
                    validate_value(self.spec, {'$ref': '#/components/schemas/' + fixture['schema']}, value)


if __name__ == '__main__':
    unittest.main(verbosity=2)

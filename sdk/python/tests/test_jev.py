import copy
import json
import unittest
from pathlib import Path
from chronograph_connectors.jev import jev_decision

EXAMPLES = Path(__file__).resolve().parents[3] / 'examples/jev'

class JevTests(unittest.TestCase):
    def setUp(self):
        self.request = json.loads((EXAMPLES/'request.json').read_text())
        self.response = json.loads((EXAMPLES/'response.fixture.json').read_text())
        self.options = dict(request=self.request, src='9007199254740993', dst='18446744073709551615', timestamp_us='0', mode='fixture')

    def test_preserves_types_exact_ids_and_privacy_default(self):
        result = jev_decision(self.response, **self.options)
        self.assertEqual(result['src'], self.options['src'])
        self.assertEqual(result['fields']['answers'], self.response['answers'])
        self.assertEqual(result['assets'], {})
        self.assertNotIn('state', result['fields'])
        self.assertEqual(len(result['fields']['input_sha256']), 64)
        self.response['answers']['review_priority']['legend']['1'] = {'rubric':'Review soon'}
        jev_decision(self.response, **self.options)

    def test_invalid_results_fail_before_upload(self):
        cases = [('obstructed','noul',True), ('obstructed','noul',1.01), ('route','choice','unknown'),
                 ('route','probabilities',{'a':0.9}), ('review_priority','score',30), ('route','confidence',float('nan'))]
        for name,key,value in cases:
            bad = copy.deepcopy(self.response); bad['answers'][name][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError): jev_decision(bad, **self.options)
        del self.request['questions']['route']
        with self.assertRaises(ValueError): jev_decision(self.response, **self.options)

    def test_attachments_are_explicit_json_assets(self):
        class Capture:
            def __init__(self): self.raw = []
            def asset(self, data, **meta): self.raw.append((json.loads(data),meta)); return str(len(self.raw))
        client=Capture()
        r=jev_decision(self.response, client=client, attach_inputs=True, **self.options)
        self.assertEqual(r['assets'], {'request':'1','response':'2'})
        self.assertEqual(client.raw[0][0], self.request)
        self.assertEqual(client.raw[0][1]['kind'],'opaque')

if __name__ == '__main__': unittest.main()

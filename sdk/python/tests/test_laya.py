import copy
import json
from pathlib import Path
import unittest
from chronograph_connectors.laya import laya_decision
from chronograph_connectors.jev import jev_decision

ROOT = Path(__file__).resolve().parents[3] / 'examples/laya'

class LayaTests(unittest.TestCase):
    def setUp(self):
        self.response=json.loads((ROOT/'response.fixture.json').read_text())
        self.request=json.loads((ROOT/'request.json').read_text())
        self.options=dict(request=self.request,src='9007199254740993',dst='9007199254740994',timestamp_us='1700000000000000',mode='fixture')

    def test_routing_privacy_and_provenance(self):
        r=laya_decision(self.response,checkpoint_revision='test-artifact-v1',**self.options)
        self.assertEqual(r['fields']['provider'],'convai')
        self.assertEqual(r['fields']['checkpoint'],'convaiinnovations/laya')
        self.assertEqual(r['fields']['model'],'laya-rl-agent')
        self.assertEqual(r['fields']['routing'],self.response['routing'])
        self.assertEqual(r['fields']['answers'],self.response['answers'])
        self.assertNotIn('state',r['fields']); self.assertEqual(r['assets'],{})
        self.assertEqual(r['src'],'9007199254740993')

    def test_direct_runtime_needs_explicit_checkpoint(self):
        del self.response['routing']
        with self.assertRaises(ValueError):laya_decision(self.response,**self.options)
        r=laya_decision(self.response,checkpoint='local-artifact',**self.options)
        self.assertEqual(r['fields']['checkpoint'],'local-artifact')
        self.assertNotIn('checkpoint_revision',r['fields'])

    def test_rounded_mass_preserved_but_jev_remains_strict(self):
        self.request['questions']={'many':{'type':'choice'}}
        self.response['answers']={'many':{'type':'choice','choice':'0','confidence':0.01,'probabilities':{str(k):0.0156 for k in range(64)}}}
        r=laya_decision(self.response,**self.options)
        self.assertEqual(r['fields']['answers'],self.response['answers'])
        with self.assertRaises(ValueError):jev_decision(self.response,**self.options)
        self.response['answers']['many']['probabilities']['0']=0.5
        with self.assertRaises(ValueError):laya_decision(self.response,**self.options)

    def test_invalid_records_do_not_upload(self):
        class Assets:
            def asset(self,*args,**kwargs):raise AssertionError('Must validate before uploading')
        for options in [dict(src=True),dict(mode='fake'),dict(checkpoint=''),dict(checkpoint_revision=1)]:
            # Explicit empty checkpoint can be replaced by the reported routing repo.
            if options.get('checkpoint')=='':options['checkpoint']='x'*257
            with self.subTest(options=options), self.assertRaises((ValueError,TypeError)):
                laya_decision(self.response,client=Assets(),attach_inputs=True,**(self.options|options))

    def test_attachments_identify_the_real_provider(self):
        calls=[]
        class Assets:
            def asset(self,data,**metadata):calls.append((data,metadata));return 'asset-id'
        r=laya_decision(self.response,client=Assets(),attach_inputs=True,**self.options)
        self.assertEqual(set(r['assets']),{'request','response'})
        self.assertEqual(calls[0][1]['provenance']['provider'],'convai')
        self.assertEqual(json.loads(calls[1][0]),self.response)

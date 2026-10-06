import importlib.util
import unittest
from pathlib import Path
from datetime import datetime, timezone
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('publisher_watermark',Path(__file__).resolve().parents[1]/'tools/publish_dashboard.py')
publisher=importlib.util.module_from_spec(spec);spec.loader.exec_module(publisher)

class PublisherWatermarkTests(unittest.TestCase):
    def test_observation_start_precedes_first_upstream_read(self):
        events=[]
        times=iter([datetime(2026,10,6,14,0,tzinfo=timezone.utc),datetime(2026,10,6,14,2,tzinfo=timezone.utc)])
        def clock(*args):
            events.append('clock');return next(times)
        def pages(base,path,token):
            events.append('read')
            return [{'id':2,'parent_project_id':0,'title':'PMO-DSTA','is_archived':False},
                    {'id':3,'parent_project_id':2,'title':'LT1','is_archived':False}] if path=='/api/v1/projects' else []
        with patch.object(publisher,'pages',side_effect=pages),patch.object(publisher,'datetime') as dt:
            dt.now.side_effect=clock
            result=publisher.fetch_dashboard('http://fake.test','synthetic')
        self.assertEqual(events[0],'clock','capture collection start before reading potentially stale rows')
        self.assertEqual(result['observationStartedAt'],'2026-10-06T14:00:00+00:00')
        self.assertEqual(result['timestamp'],'2026-10-06T14:02:00+00:00')

if __name__=='__main__':unittest.main()

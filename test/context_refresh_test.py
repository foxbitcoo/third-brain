import datetime as dt
import importlib.util
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('context_refresh', Path(__file__).resolve().parents[1] / 'src/context_refresh.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class ContextRefreshTests(unittest.TestCase):
    def test_structured_calendar_time_and_no_original_start_fallback(self):
        self.assertEqual(m.timestamp({'datetime': '2026-01-08T11:00:00+08:00'}), '2026-01-08T11:00:00+08:00')
        self.assertIsNone(m.timestamp('2026-01-08T11:00:00'))
        now = dt.datetime(2026, 1, 8, tzinfo=dt.timezone.utc)
        e = m.normalize_event({'id': 'event', 'original_start_time': {'datetime': '2026-01-08T11:00:00+08:00'}}, [], 'cal', now)
        self.assertEqual(e['state'], 'TIME_UNAVAILABLE')

    def test_canceled_declined_and_self_never_create_candidates(self):
        events = [dict(calendarId='c', eventId='e', start='s', state='NOT_DUE', attendees=[
            dict(user_id='owner', response_status='accepted'), dict(user_id='peer', name='Example'),
            dict(user_id='declined', response_status='declined')])]
        self.assertEqual([x['userId'] for x in m.attendee_candidates(events, 'owner')], ['peer'])
        events[0]['state'] = 'CANCELED'
        self.assertEqual(m.attendee_candidates(events, 'owner'), [])

    def test_no_listening_from_invite(self):
        events = [dict(calendarId='c', eventId='e', start='s', state='NOT_DUE', attendees=[dict(user_id='peer')])]
        row = m.attendee_candidates(events, 'owner')[0]
        self.assertFalse(row['listening'])
        self.assertEqual(row['chatResolution'], 'PENDING_IDENTITY_MATCH')

    def test_peer_binding_uses_native_id_and_does_not_accept_name_only(self):
        class Client:
            def get(self, path, params):
                return dict(data=dict(items=[dict(chat=dict(id='chat',type='p2p',name='Example',
                    p2p_ext_attrs=dict(peer=dict(id='actual-peer'))))]))
        rows=[dict(name='Example',userId='actual-peer'),dict(name='Example',userId='other-peer')]
        m.resolve_candidates(rows,Client())
        self.assertEqual(rows[0]['candidateChatIds'],['chat'])
        self.assertEqual(rows[0]['chatResolution'],'VERIFIED_PEER_ID')
        self.assertEqual(rows[1]['candidateChatIds'],[])

    def test_version_change_and_missing_media_force_read(self):
        old = dict(contentHash='hash', sourceVersion=1, sourceModifiedAt=10, mediaChecked=True)
        self.assertFalse(m.needs_read(dict(version=1, mtime=10), old))
        self.assertTrue(m.needs_read(dict(version=2, mtime=10), old))
        self.assertTrue(m.needs_read(dict(version=1, mtime=10), {**old, 'mediaChecked': False}))

    def test_rotating_media_url_does_not_change_text_identity(self):
        self.assertEqual(m.semantic_hash('hello ![chart](https://media.example/a?sig=1)'),
                         m.semantic_hash('hello ![chart](https://media.example/a?sig=2)'))
        self.assertNotEqual(m.semantic_hash('hello'), m.semantic_hash('updated'))

    def test_missing_image_url_is_an_explicit_gap(self):
        self.assertEqual(m.image_refs('# Report\n![image]()')[0]['state'], 'MISSING_URL')

    def test_failed_provider_and_repeated_cursor_are_not_success(self):
        with self.assertRaisesRegex(RuntimeError, 'PROVIDER_403'):
            m.unwrap(dict(data=dict(code=403)))
        with self.assertRaisesRegex(RuntimeError, 'REPEATED_CURSOR'):
            m.pages(lambda *_: dict(data=dict(items=[], next_page_token='same')), '/example', {})

    def test_pagination_cap_preserves_partial_status(self):
        rows, complete = m.pages(lambda *_: dict(data=dict(items=[1], next_page_token='next')), '/example', {}, 1)
        self.assertEqual(rows, [1])
        self.assertFalse(complete)

    def test_media_urls_reject_local_and_credential_urls(self):
        for url in ['http://127.0.0.1/x', 'https://wps.cn.evil.example/x', 'https://user:pw@wps.cn/x']:
            with self.assertRaises(RuntimeError):
                m.check_media_url(url)

    def test_future_meeting_does_not_request_records(self):
        event = m.normalize_event(dict(id='e', start_time={'datetime': '2099-01-08T10:00:00+08:00'},
            end_time={'datetime': '2099-01-08T11:00:00+08:00'}), [], 'c', dt.datetime.now(dt.timezone.utc))
        self.assertEqual(event['state'], 'NOT_DUE')

    def test_vision_budget_blocks_dispatch(self):
        settings = dict(enabled=True, endpoint='https://example.test', inputCnyPerMillion=10,
            outputCnyPerMillion=10, maxCny=0, keyEnv='UNUSED')
        ledger = dict(reservedCny=0, calls=0)
        self.assertIsNone(m.vision(b'image', 'image/png', '', settings, ledger))
        self.assertEqual(ledger['calls'], 0)

    def test_lock_is_not_removed_when_owned_by_another_run(self):
        with tempfile.TemporaryDirectory() as temp:
            lock = Path(temp) / '.refresh.lock'
            lock.mkdir()
            with self.assertRaises(FileExistsError):
                m.refresh({}, temp)
            self.assertTrue(lock.exists())


if __name__ == '__main__':
    unittest.main()

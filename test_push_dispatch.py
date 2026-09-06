"""B2: isolated Firestore/Google/FCM tests; no live credentials or network."""
import copy
import hashlib
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from unittest.mock import MagicMock

import google.cloud.firestore
import google.genai
import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("GEMINI_API_KEY", "test")
google.cloud.firestore.Client = MagicMock()
google.genai.Client = MagicMock()
import backend.main as main
from firebase_admin import exceptions as fcm_errors
from firebase_admin import messaging as fcm

REAL_SENDER = main.send_formation_push


NOW = datetime(2026, 9, 6, tzinfo=timezone.utc)
PATH = "/api/internal/notifications/dispatch"
EVENT = ("formation_push_outbox", "gw_post1")
AUTH = {"Authorization": "Bearer test-id-token"}


class Snapshot:
    def __init__(self, ref, data):
        self.reference, self.id = ref, ref.id
        self.exists = data is not None
        self.data = copy.deepcopy(data)

    def to_dict(self):
        return copy.deepcopy(self.data)


class Document:
    def __init__(self, database, collection, key):
        self.database, self.path, self.id = database, (collection, key), key

    def get(self, transaction=None):
        if transaction:
            assert not transaction.writes, "Firestore read-after-write"
        if self.database.fail_reads:
            raise RuntimeError("private-token external-error")
        return Snapshot(self, self.database.data.get(self.path))


class Query:
    def __init__(self, database, name, filters=(), order=None, maximum=None):
        self.database, self.name = database, name
        self.filters, self.order, self.maximum = filters, order, maximum

    def document(self, key):
        return Document(self.database, self.name, key)

    def where(self, *, filter):
        return Query(self.database, self.name, self.filters + (filter,), self.order, self.maximum)

    def order_by(self, field):
        return Query(self.database, self.name, self.filters, field, self.maximum)

    def limit(self, count):
        return Query(self.database, self.name, self.filters, self.order, count)

    def stream(self, transaction=None):
        if transaction:
            assert not transaction.writes, "Firestore query after write"
        if self.database.fail_reads:
            raise RuntimeError("private-token external-error")
        rows = []
        for (collection, key), data in list(self.database.data.items()):
            if collection != self.name:
                continue
            matched = True
            for f in self.filters:
                value = data.get(f.field_path)
                if value is None:
                    matched = False
                    break
                if f.op_string == "==":
                    matched &= value == f.value
                elif f.op_string == "<=":
                    matched &= value <= f.value
                elif f.op_string == ">=":
                    matched &= value >= f.value
                else:
                    raise AssertionError("unsupported query")
            if matched and (not self.order or self.order in data):
                rows.append(Snapshot(self.document(key), data))
        if self.order:
            rows.sort(key=lambda row: row.data[self.order])
        return iter(rows[:self.maximum])


class Transaction:
    def __init__(self, database):
        self.database, self.writes = database, []

    def set(self, reference, values, merge=False):
        self.writes.append((reference, values, merge))


class Database:
    def __init__(self):
        self.data, self.lock = {}, threading.RLock()
        self.fail_reads = self.fail_writes = False

    def collection(self, name):
        return Query(self, name)

    def transaction(self):
        return Transaction(self)


def transactional(fn):
    def run(txn, *args, **kwargs):
        with txn.database.lock:
            result = fn(txn, *args, **kwargs)
            if txn.database.fail_writes:
                raise RuntimeError("private-token write-error")
            for ref, values, merge in txn.writes:
                data = copy.deepcopy(txn.database.data.get(ref.path, {})) if merge else {}
                for key, value in values.items():
                    if value is main.firestore.DELETE_FIELD:
                        data.pop(key, None)
                    elif value is main.firestore.SERVER_TIMESTAMP:
                        data[key] = NOW
                    else:
                        data[key] = copy.deepcopy(value)
                txn.database.data[ref.path] = data
            return result
    return run


class Clock(datetime):
    current = NOW

    @classmethod
    def now(cls, tz=None):
        return cls.current


def identity(**changes):
    return dict({"iss": "https://accounts.google.com", "aud": "https://api.test",
                 "exp": time.time() + 3600, "email_verified": True,
                 "email": "scheduler@test.iam.gserviceaccount.com"}, **changes)


@pytest.fixture
def setup(monkeypatch):
    database = Database()
    monkeypatch.setattr(main, "_portal_db", database)
    monkeypatch.setattr(main.firestore, "transactional", transactional)
    monkeypatch.setattr(main, "datetime", Clock)
    # Timestamp checks still accept normal datetime fixtures when the clock is patched.
    monkeypatch.setattr(main, "_push_timestamp", lambda value: isinstance(value, datetime) and value.tzinfo is not None)
    Clock.current = NOW
    monkeypatch.setenv("PUSH_DISPATCH_AUDIENCE", "https://api.test")
    monkeypatch.setenv("PUSH_DISPATCH_SERVICE_ACCOUNT", "scheduler@test.iam.gserviceaccount.com")
    monkeypatch.setenv("PORTAL_PUSH_ENABLED", "true")
    verifier = MagicMock(return_value=identity())
    monkeypatch.setattr(main.google_id_token, "verify_oauth2_token", verifier)
    sender = MagicMock(side_effect=lambda event, targets: send_result(targets))
    monkeypatch.setattr(main, "send_formation_push", sender)
    forbidden_ai = MagicMock(side_effect=AssertionError("AI database used"))
    monkeypatch.setattr(main, "db", forbidden_ai)
    yield database, TestClient(main.app, raise_server_exceptions=False), sender, verifier
    assert forbidden_ai.mock_calls == []


def send_result(targets, retry=(), permanent=(), config=(), top=False):
    ids = {target["installation_hash"] for target in targets}
    errors = set(retry) | set(permanent) | set(config)
    return {
        "success_count": 0 if top else len(ids - errors),
        "config_error": bool(config),
        "retryable_installations": [{"installation_hash": key} for key in retry],
        "permanent_installations": [{"installation_hash": key} for key in permanent],
        "unregistered_installations": [{"installation_hash": key} for key in permanent],
        "details": ([{"error": "RequestError"}] if top else
                    [{"installation_hash": key, "error": "DeliveryFailed"} for key in errors]),
    }


def seed(database, count=1, snapshot=False):
    ids = []
    for index in range(count):
        key = hashlib.sha256(str(index).encode()).hexdigest()
        ids.append(key)
        database.data[("notification_tokens", key)] = {
            "schema_version": 2, "enabled": True, "token": f"private-token-{index}",
            "revision": 1, "updated_at": NOW,
        }
    database.data[("portal_meta", "notification_capacity")] = {"active_count": count}
    database.data[("formations_gw", "post1")] = {"schema_version": 2}
    database.data[EVENT] = {
        "schema_version": 1, "category": "gw", "post_id": "post1", "created_at": NOW,
        "status": "pending", "next_attempt_at": NOW, "attempts": 0,
        "delivered": [], "permanent_failed": [], "round_attempted": [],
        "expires_at": NOW + timedelta(days=7),
    }
    if snapshot:
        database.data[EVENT]["recipients"] = ids
    return ids


@pytest.mark.parametrize("header", [None, "", "Basic abc", "Bearer", "Bearer a b"])
def test_missing_or_bad_bearer(setup, header):
    _, client, sender, verifier = setup
    response = client.post(PATH, headers={} if header is None else {"Authorization": header})
    assert response.status_code == 401
    verifier.assert_not_called()
    sender.assert_not_called()


@pytest.mark.parametrize("claims,status", [
    ({"exp": 1}, 401), ({"aud": "wrong"}, 401), ({"iss": "https://evil.test"}, 401),
    ({"email_verified": False}, 403), ({"email_verified": "true"}, 403),
    ({"email": "other@test"}, 403), ({}, 200),
])
def test_oidc_claims(setup, claims, status):
    _, client, _, verifier = setup
    verifier.return_value = identity(**claims)
    response = client.post(PATH, headers=AUTH)
    assert response.status_code == status
    assert verifier.call_args.kwargs == {"audience": "https://api.test"}


def test_signature_failure_is_sanitized(setup, capsys):
    _, client, _, verifier = setup
    verifier.side_effect = ValueError("private-token authorization secret")
    response = client.post(PATH, headers=AUTH)
    assert response.status_code == 401
    assert "private-token" not in response.text + capsys.readouterr().out


@pytest.mark.parametrize("missing", ["PUSH_DISPATCH_AUDIENCE", "PUSH_DISPATCH_SERVICE_ACCOUNT"])
def test_missing_oidc_config(setup, monkeypatch, missing):
    _, client, _, _ = setup
    monkeypatch.delenv(missing)
    assert client.post(PATH, headers=AUTH).status_code == 503


def test_push_default_off_still_authenticates(setup, monkeypatch):
    database, client, sender, verifier = setup
    seed(database)
    before = copy.deepcopy(database.data)
    monkeypatch.delenv("PORTAL_PUSH_ENABLED")
    assert client.post(PATH).status_code == 401
    response = client.post(PATH, headers=AUTH)
    assert response.json() == {"claimed": 0, "sent": 0, "retryable": 0, "permanent": 0}
    verifier.assert_called_once()
    assert database.data == before
    sender.assert_not_called()


def test_concurrent_claim_and_recovery(setup):
    database, _, _, _ = setup
    seed(database)
    barrier = threading.Barrier(2)
    def worker():
        barrier.wait()
        return main.claim_push_event(NOW)
    with ThreadPoolExecutor(2) as pool:
        outcomes = list(pool.map(lambda _: worker(), range(2)))
    assert sum(item is not None for item in outcomes) == 1
    old_lease = database.data[EVENT]["lease_id"]
    assert database.data[EVENT]["next_attempt_at"] == NOW + timedelta(seconds=120)
    assert main.claim_push_event(NOW + timedelta(seconds=119)) is None
    recovered = main.claim_push_event(NOW + timedelta(seconds=121))
    assert recovered and recovered[1] != old_lease
    before = copy.deepcopy(database.data[EVENT])
    assert not main.save_delivery_results(recovered[0], old_lease, [], [], [], False, NOW + timedelta(seconds=121))
    assert database.data[EVENT] == before


def test_250_pages_snapshot_and_no_redelivery(setup):
    database, client, sender, _ = setup
    seed(database, 250)
    for count in (100, 100, 50):
        response = client.post(PATH, headers=AUTH)
        assert response.status_code == 200, response.text
        assert response.json()["sent"] == count
        assert database.data[EVENT]["attempts"] == 0
    batches = [call.args[1] for call in sender.call_args_list]
    assert len({item["installation_hash"] for batch in batches for item in batch}) == 250
    data = database.data[EVENT]
    assert data["status"] == "sent" and len(data["delivered"]) == 250
    assert not {"next_attempt_at", "lease_id", "lease_until"} & data.keys()
    assert "private-token" not in repr(data)
    assert client.post(PATH, headers=AUTH).json()["claimed"] == 0


def test_rotation_off_and_new_recipient_excluded(setup):
    database, client, sender, _ = setup
    ids = seed(database, 2, snapshot=True)
    database.data[("notification_tokens", ids[0])].update(token="new-token", revision=9)
    database.data[("notification_tokens", ids[1])].update(enabled=False, token=None)
    extra = "f" * 64
    database.data[("notification_tokens", extra)] = dict(database.data[("notification_tokens", ids[0])])
    response = client.post(PATH, headers=AUTH)
    assert response.json() == {"claimed": 1, "sent": 1, "retryable": 0, "permanent": 1}
    assert sender.call_args.args[1] == [{"installation_hash": ids[0], "token": "new-token", "revision": 9}]
    assert database.data[EVENT]["recipients"] == ids


def test_stale_cleanup_without_event_and_cap(setup):
    database, client, sender, _ = setup
    ids = seed(database, 105)
    del database.data[EVENT]
    for key in ids:
        database.data[("notification_tokens", key)]["updated_at"] = NOW - timedelta(days=31)
    assert client.post(PATH, headers=AUTH).json()["claimed"] == 0
    assert sum(not database.data[("notification_tokens", key)]["enabled"] for key in ids) == 100
    assert database.data[("portal_meta", "notification_capacity")]["active_count"] == 5
    assert database.data[("notification_tokens", ids[0])]["revision"] == 2
    assert "token" not in database.data[("notification_tokens", ids[0])]
    assert database.data[("notification_tokens", ids[0])]["disabled_reason"] == "stale"
    sender.assert_not_called()


def test_stale_rotation_preserves_new_token(setup, monkeypatch):
    database, _, _, _ = setup
    ids = seed(database)
    record = database.data[("notification_tokens", ids[0])]
    record["updated_at"] = NOW - timedelta(days=31)
    original = main.disable_token_if_unchanged
    def rotate(key, revision, token, *, reason="unregistered"):
        assert reason == "stale"
        record.update(token="new-token", revision=2, updated_at=NOW)
        return original(key, revision, token, reason=reason)
    monkeypatch.setattr(main, "disable_token_if_unchanged", rotate)
    main.cleanup_stale_subscriptions(NOW)
    assert record["token"] == "new-token" and record["enabled"]
    assert database.data[("portal_meta", "notification_capacity")]["active_count"] == 1


@pytest.mark.parametrize("count,status", [(0, "sent"), (500, "retry"), (501, "failed")])
def test_capacity(setup, count, status):
    database, client, sender, _ = setup
    seed(database, count)
    assert client.post(PATH, headers=AUTH).status_code == 200
    assert database.data[EVENT]["status"] == status
    if count == 0:
        sender.assert_not_called()
        assert "last_error_code" not in database.data[EVENT]
    if count == 501:
        sender.assert_not_called()
        assert database.data[EVENT]["last_error_code"] == "CAPACITY_INCONSISTENT"


@pytest.mark.parametrize("case,status,code", [
    ("deleted", "canceled", "POST_NOT_FOUND"), ("legacy", "canceled", "POST_NOT_FOUND"),
    ("expired", "failed", "DELIVERY_EXPIRED"),
])
def test_post_and_expiry_gate(setup, case, status, code):
    database, client, sender, _ = setup
    seed(database)
    if case == "deleted":
        del database.data[("formations_gw", "post1")]
    elif case == "legacy":
        database.data[("formations_gw", "post1")]["schema_version"] = 1
    else:
        database.data[EVENT]["created_at"] = NOW - timedelta(hours=25)
    assert client.post(PATH, headers=AUTH).status_code == 200
    assert database.data[EVENT]["status"] == status
    assert database.data[EVENT]["last_error_code"] == code
    sender.assert_not_called()


def test_retry_round_pages_and_1_5_15_schedule(setup):
    database, client, sender, _ = setup
    ids = seed(database, 200, snapshot=True)
    sender.side_effect = lambda event, targets: send_result(targets, retry=[t["installation_hash"] for t in targets])
    for round_index, delay in enumerate((60, 300, 900, None)):
        start = Clock.current
        assert client.post(PATH, headers=AUTH).json()["retryable"] == 100
        assert database.data[EVENT]["attempts"] == round_index
        assert len(database.data[EVENT]["round_attempted"]) == 100
        assert client.post(PATH, headers=AUTH).json()["retryable"] == 100
        first, second = sender.call_args_list[-2:]
        assert {t["installation_hash"] for t in first.args[1]}.isdisjoint(t["installation_hash"] for t in second.args[1])
        if delay:
            assert database.data[EVENT]["next_attempt_at"] == start + timedelta(seconds=delay)
            assert database.data[EVENT]["attempts"] == round_index + 1
            assert database.data[EVENT]["round_attempted"] == []
            assert client.post(PATH, headers=AUTH).json()["claimed"] == 0
            Clock.current += timedelta(seconds=delay)
        else:
            assert database.data[EVENT]["status"] == "failed"
            assert database.data[EVENT]["last_error_code"] == "RETRY_EXHAUSTED"


def test_mixed_config_error_preserves_proven_success(setup):
    database, client, sender, _ = setup
    ids = seed(database, 3, snapshot=True)
    sender.side_effect = lambda event, targets: send_result(targets, config=[ids[1]], permanent=[ids[2]])
    assert client.post(PATH, headers=AUTH).json() == {"claimed": 1, "sent": 1, "retryable": 0, "permanent": 1}
    data = database.data[EVENT]
    assert data["status"] == "failed" and data["last_error_code"] == "CONFIG_ERROR"
    assert data["delivered"] == [ids[0]] and data["permanent_failed"] == [ids[2]]
    assert database.data[("notification_tokens", ids[1])]["enabled"]


def test_top_level_config_failure_never_infers_success(setup):
    database, client, sender, _ = setup
    ids = seed(database, 2)
    sender.side_effect = lambda event, targets: send_result(targets, config=ids, top=True)
    assert client.post(PATH, headers=AUTH).json()["sent"] == 0
    assert database.data[EVENT]["delivered"] == []
    assert database.data[EVENT]["permanent_failed"] == []


def test_store_failure_sanitized_and_lease_recovers(setup, capsys):
    database, client, sender, _ = setup
    seed(database)
    def crash(event, targets):
        database.fail_writes = True
        return send_result(targets)
    sender.side_effect = crash
    response = client.post(PATH, headers=AUTH)
    assert response.status_code == 503
    assert "private-token" not in response.text + capsys.readouterr().out
    assert database.data[EVENT]["status"] == "processing"
    database.fail_writes = False
    assert main.claim_push_event(NOW + timedelta(seconds=121)) is not None


@pytest.mark.parametrize("exception,expected", [
    (fcm.SenderIdMismatchError("private-token"), "CONFIG_ERROR"),
    (fcm_errors.InvalidArgumentError("private-token"), "CONFIG_ERROR"),
    (fcm_errors.PermissionDeniedError("private-token"), "CONFIG_ERROR"),
    (fcm_errors.UnauthenticatedError("private-token"), "CONFIG_ERROR"),
    (fcm_errors.UnavailableError("private-token"), "retry"),
    (fcm_errors.ResourceExhaustedError("private-token"), "retry"),
    (fcm_errors.InternalError("private-token"), "retry"),
    (TimeoutError("private-token"), "retry"),
    (RuntimeError("private-token"), "retry"),
])
def test_b1_real_sender_error_classification(setup, monkeypatch, exception, expected, capsys):
    database, client, _, _ = setup
    ids = seed(database)
    monkeypatch.setattr(main, "send_formation_push", REAL_SENDER)
    monkeypatch.setattr(main, "get_fcm_app", MagicMock())
    monkeypatch.setattr(main.fcm_messaging, "send_each_for_multicast", MagicMock(side_effect=exception))
    response = client.post(PATH, headers=AUTH)
    assert response.status_code == 200
    data = database.data[EVENT]
    if expected == "CONFIG_ERROR":
        assert data["status"] == "failed" and data["last_error_code"] == expected
    else:
        assert data["status"] == "retry" and data["attempts"] == 1
        assert response.json()["retryable"] == 1
    assert database.data[("notification_tokens", ids[0])]["enabled"]
    assert data["permanent_failed"] == [] and data["delivered"] == []
    assert "private-token" not in repr(data) + response.text + capsys.readouterr().out


def test_real_b1_unregistered_disables_with_capacity(setup, monkeypatch):
    database, client, _, _ = setup
    ids = seed(database)
    monkeypatch.setattr(main, "send_formation_push", REAL_SENDER)
    monkeypatch.setattr(main, "get_fcm_app", MagicMock())
    delivery = MagicMock(success=False, exception=fcm.UnregisteredError("private-token"))
    monkeypatch.setattr(main.fcm_messaging, "send_each_for_multicast",
                        MagicMock(return_value=MagicMock(responses=[delivery])))
    assert client.post(PATH, headers=AUTH).json()["permanent"] == 1
    assert database.data[EVENT]["status"] == "sent"
    assert database.data[EVENT]["permanent_failed"] == ids
    token = database.data[("notification_tokens", ids[0])]
    assert token["enabled"] is False and token["revision"] == 2 and "token" not in token
    assert token["disabled_reason"] == "unregistered"
    assert database.data[("portal_meta", "notification_capacity")]["active_count"] == 0


def test_lease_lost_during_send_does_not_save(setup):
    database, client, sender, _ = setup
    seed(database)
    new_state = {}
    def steal(event, targets):
        database.data[EVENT].update(lease_id="new-worker", lease_until=NOW + timedelta(seconds=240))
        new_state.update(copy.deepcopy(database.data[EVENT]))
        return send_result(targets)
    sender.side_effect = steal
    assert client.post(PATH, headers=AUTH).status_code == 200
    assert database.data[EVENT] == new_state


def test_post_deleted_after_loading_targets(setup, monkeypatch):
    database, client, sender, _ = setup
    seed(database)
    original = main.load_delivery_targets
    def remove(ids, now):
        targets = original(ids, now)
        del database.data[("formations_gw", "post1")]
        return targets
    monkeypatch.setattr(main, "load_delivery_targets", remove)
    assert client.post(PATH, headers=AUTH).status_code == 200
    assert database.data[EVENT]["status"] == "canceled"
    sender.assert_not_called()


def test_first_snapshot_frozen_across_pages(setup):
    database, client, sender, _ = setup
    ids = seed(database, 101)
    assert client.post(PATH, headers=AUTH).json()["sent"] == 100
    newcomer = "e" * 64
    database.data[("notification_tokens", newcomer)] = dict(database.data[("notification_tokens", ids[0])])
    assert client.post(PATH, headers=AUTH).json()["sent"] == 1
    assert newcomer not in database.data[EVENT]["recipients"]


def test_failed_recipient_not_retried_before_rest_of_round(setup):
    database, client, sender, _ = setup
    ids = seed(database, 200, snapshot=True)
    sender.side_effect = lambda event, targets: send_result(targets, retry=set(ids[:100]) & {t["installation_hash"] for t in targets})
    assert client.post(PATH, headers=AUTH).json()["retryable"] == 100
    assert client.post(PATH, headers=AUTH).json()["sent"] == 100
    assert database.data[EVENT]["attempts"] == 1
    Clock.current += timedelta(seconds=60)
    sender.side_effect = lambda event, targets: send_result(targets)
    assert client.post(PATH, headers=AUTH).json()["sent"] == 100
    assert {t["installation_hash"] for t in sender.call_args.args[1]} == set(ids[:100])
    assert database.data[EVENT]["status"] == "sent"
    assert "last_error_code" not in database.data[EVENT]


def test_all_snapshot_recipients_off_skips_sender(setup):
    database, client, sender, _ = setup
    ids = seed(database, 3, snapshot=True)
    for key in ids:
        database.data[("notification_tokens", key)].update(enabled=False, token=None)
    response = client.post(PATH, headers=AUTH)
    assert response.json() == {"claimed": 1, "sent": 0, "retryable": 0, "permanent": 3}
    sender.assert_not_called()
    data = database.data[EVENT]
    assert data["status"] == "sent" and data["permanent_failed"] == sorted(ids)
    assert "last_error_code" not in data


def test_all_page_recipients_stale_skips_sender_and_uses_stale_reason(setup):
    database, client, sender, _ = setup
    ids = seed(database, 3, snapshot=True)
    for key in ids:
        database.data[("notification_tokens", key)]["updated_at"] = NOW - timedelta(days=31)
    response = client.post(PATH, headers=AUTH)
    assert response.json() == {"claimed": 1, "sent": 0, "retryable": 0, "permanent": 3}
    sender.assert_not_called()
    data = database.data[EVENT]
    assert data["status"] == "sent" and data["permanent_failed"] == sorted(ids)
    assert "last_error_code" not in data
    for key in ids:
        token = database.data[("notification_tokens", key)]
        assert token["enabled"] is False and token["disabled_reason"] == "stale"

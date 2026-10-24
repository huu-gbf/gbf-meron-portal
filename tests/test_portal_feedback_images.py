import base64
import copy
import io
import uuid
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from google.api_core.exceptions import Forbidden, AlreadyExists
from PIL import Image
from backend import portal_feedback as feedback


def image(fmt='PNG'):
    output = io.BytesIO()
    Image.new('RGB', (4, 4), 'red').save(output, format=fmt)
    return {'contentType': feedback.MIMES[fmt], 'data': base64.b64encode(output.getvalue()).decode()}


def payload(count=1):
    return dict(requestId=str(uuid.uuid4()), type='bug', message='報告\r\n内容', name='', target='',
                attachments=[image() for _ in range(count)])


@pytest.fixture
def fixture():
    docs, objects, deleted = {}, {}, []
    state = SimpleNamespace(fail_upload=0, uploads=0, fail_create=None, commit_then_fail=False,
                            fail_read=False, fail_cleanup=False, race=False)
    db, bucket = MagicMock(), MagicMock()
    def document(key):
        ref = MagicMock()
        def get():
            if state.fail_read: raise RuntimeError('read unavailable')
            return SimpleNamespace(exists=key in docs, to_dict=lambda: copy.deepcopy(docs.get(key)))
        def create(data):
            if state.race:
                docs[key] = {**data, 'attachments': []}
                raise AlreadyExists('racing create')
            if state.commit_then_fail:
                docs[key] = copy.deepcopy(data)
                raise RuntimeError('lost response')
            if state.fail_create: raise state.fail_create
            if key in docs: raise AlreadyExists('exists')
            docs[key] = copy.deepcopy(data)
        ref.get.side_effect = get
        ref.create.side_effect = create
        ref.delete.side_effect = lambda: docs.pop(key, None)
        return ref
    db.collection.return_value.document.side_effect = document
    def blob(path):
        value = MagicMock()
        def upload(raw, content_type, if_generation_match):
            assert if_generation_match == 0
            state.uploads += 1
            objects[path] = raw
            if state.uploads == state.fail_upload: raise RuntimeError('upload response lost')
        def delete():
            if state.fail_cleanup: raise RuntimeError('cleanup unavailable')
            deleted.append(path); objects.pop(path, None)
        value.upload_from_string.side_effect = upload
        value.delete.side_effect = delete
        value.download_as_bytes.side_effect = lambda: objects[path]
        return value
    bucket.blob.side_effect = blob
    bucket.list_blobs.side_effect = lambda prefix: [SimpleNamespace(name=key) for key in list(objects) if key.startswith(prefix)]
    app = FastAPI()
    def origin(request):
        if request.headers.get('origin') != 'http://127.0.0.1:5500': raise HTTPException(403)
    def verify(token):
        if token == 'admin': return {'uid': feedback.ADMIN_UID}
        raise ValueError('not admin')
    feedback.register(app, lambda: db, lambda: bucket, origin, lambda: None, verify)
    client = TestClient(app, raise_server_exceptions=False)
    return SimpleNamespace(client=client, docs=docs, objects=objects, deleted=deleted, state=state,
                           headers={'Origin': 'http://127.0.0.1:5500'}, admin={'Origin': 'http://127.0.0.1:5500', 'Authorization': 'Bearer admin'})


@pytest.mark.parametrize('count', [1, 3, 5])
def test_create_and_retry(fixture, count):
    f = fixture; p = payload(count)
    response = f.client.post('/api/portal-feedback', json=p, headers=f.headers)
    assert response.status_code == 200
    key = response.json()['id']
    assert len(f.objects) == count
    assert f.docs[key]['message'] == '報告\n内容'
    assert 'firebaseStorageDownloadTokens' not in str(f.docs)
    assert f.client.post('/api/portal-feedback', json=p, headers=f.headers).status_code == 200
    assert f.state.uploads == count
    p['message'] = 'changed'
    assert f.client.post('/api/portal-feedback', json=p, headers=f.headers).status_code == 409
    assert len(f.objects) == count


@pytest.mark.parametrize('fmt', ['PNG', 'JPEG', 'WEBP'])
def test_image_formats(fmt):
    p = payload(); p['attachments'] = [image(fmt)]
    assert len(feedback.validate(feedback.Submission(**p))[1]) == 1


@pytest.mark.parametrize('case', ['six', 'empty', 'type', 'fake', 'file_size', 'total_size', 'text', 'extra', 'path'])
def test_reject_before_writes(fixture, case):
    f = fixture; p = payload()
    if case == 'six': p = payload(6)
    if case == 'empty': p['attachments'] = []
    if case == 'type': p['attachments'][0]['contentType'] = 'image/jpeg'
    if case == 'fake': p['attachments'][0]['data'] = base64.b64encode(b'not an image').decode()
    if case == 'file_size': p['attachments'][0]['data'] = base64.b64encode(b'x' * (feedback.MAX_FILE + 1)).decode()
    if case == 'total_size':
        raw = base64.b64decode(image()['data'])
        p['attachments'] = [{'contentType': 'image/png', 'data': base64.b64encode(raw + b'\0' * (feedback.MAX_FILE - len(raw))).decode()} for _ in range(5)]
    if case == 'text': p['message'] = '\x00'
    if case == 'extra': p['admin'] = True
    if case == 'path': p['attachments'][0]['path'] = 'formations/other'
    assert f.client.post('/api/portal-feedback', json=p, headers=f.headers).status_code in (413, 422)
    assert not f.docs and not f.objects and f.state.uploads == 0


def test_partial_upload_cleanup_and_existing_data(fixture):
    f = fixture; f.docs['old'] = {'message': 'unchanged'}; f.objects['formations/old.jpg'] = b'old'
    f.state.fail_upload = 2
    assert f.client.post('/api/portal-feedback', json=payload(3), headers=f.headers).status_code == 503
    assert f.objects == {'formations/old.jpg': b'old'} and f.docs == {'old': {'message': 'unchanged'}}
    assert len(f.deleted) == 2


def test_definitive_create_failure_cleanup(fixture):
    f = fixture; f.state.fail_create = Forbidden('denied')
    assert f.client.post('/api/portal-feedback', json=payload(), headers=f.headers).status_code == 503
    assert not f.objects and not f.docs


def test_lost_commit_response_preserves_images(fixture):
    f = fixture; f.state.commit_then_fail = True
    assert f.client.post('/api/portal-feedback', json=payload(), headers=f.headers).status_code == 200
    assert len(f.objects) == 1 and not f.deleted


def test_racing_attempt_cleans_only_own_images(fixture):
    f = fixture; f.state.race = True; f.objects['formations/old.jpg'] = b'old'
    assert f.client.post('/api/portal-feedback', json=payload(), headers=f.headers).status_code == 200
    assert f.objects == {'formations/old.jpg': b'old'}


def test_admin_view_delete_and_path_isolation(fixture):
    f = fixture
    key = f.client.post('/api/portal-feedback', json=payload(2), headers=f.headers).json()['id']
    route = '/api/portal-feedback/' + key
    for headers in [{}, {'Authorization': 'Bearer member'}]:
        assert f.client.get(route + '/images/0', headers=headers).status_code == 403
        assert f.client.delete(route, headers={**f.headers, **headers}).status_code == 403
    response = f.client.get(route + '/images/0', headers=f.admin)
    assert response.status_code == 200 and response.headers['content-type'] == 'image/png'
    assert response.headers['cache-control'] == 'no-store'
    f.docs[key]['attachments'][0]['path'] = 'formations/private.jpg'
    assert f.client.get(route + '/images/0', headers=f.admin).status_code == 404
    f.objects['formations/private.jpg'] = b'untouched'
    assert f.client.delete(route, headers=f.admin).status_code == 200
    assert f.objects == {'formations/private.jpg': b'untouched'} and not f.docs


def test_cleanup_retry_after_document_deleted(fixture):
    f = fixture
    key = f.client.post('/api/portal-feedback', json=payload(), headers=f.headers).json()['id']
    f.state.fail_cleanup = True
    assert f.client.delete('/api/portal-feedback/' + key, headers=f.admin).status_code == 503
    assert not f.docs and f.objects
    f.state.fail_cleanup = False
    assert f.client.delete('/api/portal-feedback/' + key, headers=f.admin).status_code == 200
    assert not f.objects


def test_origin_denied(fixture):
    assert fixture.client.post('/api/portal-feedback', json=payload()).status_code == 403
    assert not fixture.objects


def test_exact_file_and_total_boundaries():
    raw = base64.b64decode(image()['data'])
    padded = base64.b64encode(raw + b'\0' * (feedback.MAX_FILE - len(raw))).decode()
    p = payload(); p['attachments'] = [{'contentType': 'image/png', 'data': padded}] * 4
    assert sum(len(raw) for raw, _ in feedback.validate(feedback.Submission(**p))[1]) == feedback.MAX_TOTAL
    p['attachments'].append(image())
    with pytest.raises(HTTPException) as failure:
        feedback.validate(feedback.Submission(**p))
    assert failure.value.status_code == 422


def test_unknown_commit_does_not_delete_possibly_committed_images(fixture):
    f = fixture; f.state.fail_create = RuntimeError('transport failure')
    assert f.client.post('/api/portal-feedback', json=payload(), headers=f.headers).status_code == 503
    assert not f.docs and len(f.objects) == 1 and not f.deleted


def test_stream_body_limit(fixture):
    f = fixture
    response = f.client.post('/api/portal-feedback', content=(b'x' * 1_000_000 for _ in range(29)),
                             headers={**f.headers, 'Content-Type': 'application/json'})
    assert response.status_code == 413 and not f.objects

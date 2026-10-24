"""Private screenshot reports on the existing portal backend and bucket.

No download tokens or public URLs are issued. Client Storage rules stay closed.
"""
import base64
import hashlib
import io
import json
import logging
import re
import uuid
import warnings

from fastapi import APIRouter, HTTPException, Request, Response
from google.api_core.exceptions import AlreadyExists, NotFound, Forbidden, InvalidArgument
from google.cloud import firestore
from pydantic import BaseModel, ConfigDict, StrictStr, Field, UUID4
from PIL import Image

ADMIN_UID = 'wJRZibao8FgMDqDDQ3csPdVuGkx1'
MAX_FILE = 5 * 1024 * 1024
MAX_TOTAL = 20 * 1024 * 1024
BODY_LIMIT = 28_100_000
MIMES = {'PNG': 'image/png', 'JPEG': 'image/jpeg', 'WEBP': 'image/webp'}
ID = re.compile(r'^img-[0-9a-f]{32}$')
log = logging.getLogger(__name__)


class Attachment(BaseModel):
    model_config = ConfigDict(extra='forbid')
    contentType: StrictStr
    data: StrictStr = Field(max_length=6990508)


class Submission(BaseModel):
    model_config = ConfigDict(extra='forbid')
    requestId: UUID4
    type: StrictStr
    message: StrictStr = Field(max_length=8000)
    name: StrictStr = Field(max_length=200)
    target: StrictStr = Field(max_length=400)
    attachments: list[Attachment] = Field(min_length=1, max_length=5)


def validate(payload):
    if payload.type not in ('bug', 'request', 'other'):
        raise HTTPException(422, 'Invalid type')
    data = {'schemaVersion': 1, 'type': payload.type}
    for field, limit in [('message', 4000), ('name', 40), ('target', 100)]:
        value = getattr(payload, field)
        if field == 'message':
            value = value.replace('\r\n', '\n').replace('\r', '\n')
        forbidden = r'[\x00-\x08\x0b-\x1f\x7f-\x9f]' if field == 'message' else r'[\x00-\x08\x0a-\x1f\x7f-\x9f\u2028\u2029]'
        if re.search(forbidden, value):
            raise HTTPException(422, 'Invalid text')
        value = value.strip()
        if len(value) > limit or (field == 'message' and not value):
            raise HTTPException(422, 'Invalid text length')
        data[field] = value
    images = []
    total = 0
    for item in payload.attachments:
        try:
            raw = base64.b64decode(item.data, validate=True)
            total += len(raw)
            if not raw or len(raw) > MAX_FILE or total > MAX_TOTAL:
                raise ValueError('size')
            with warnings.catch_warnings():
                warnings.simplefilter('error', Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(raw)) as image:
                    if MIMES.get(image.format) != item.contentType or item.contentType not in MIMES.values():
                        raise ValueError('type')
                    if image.width * image.height > 25_000_000 or getattr(image, 'n_frames', 1) != 1:
                        raise ValueError('dimensions or animation')
                    image.verify()
                with Image.open(io.BytesIO(raw)) as image:
                    image.load()
        except Exception as exc:
            raise HTTPException(422, 'Invalid image, size, or dimensions') from exc
        images.append((raw, item.contentType))
    digest = hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode())
    for raw, mime in images:
        digest.update(mime.encode() + hashlib.sha256(raw).digest())
    return data, images, digest.hexdigest()


def register(app, get_db, get_bucket, check_origin, require_enabled, verify_token):
    router = APIRouter(prefix='/api/portal-feedback')

    @app.middleware('http')
    async def guard(request: Request, call_next):
        if request.url.path.startswith('/api/portal-feedback') and request.method == 'POST':
            # Bound streamed bodies as well as Content-Length before JSON parsing.
            size, chunks = 0, []
            async for chunk in request.stream():
                size += len(chunk)
                if size > BODY_LIMIT:
                    return Response(status_code=413)
                chunks.append(chunk)
            request._body = b''.join(chunks)
        response = await call_next(request)
        if request.url.path.startswith('/api/portal-feedback'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    def admin(request):
        token = request.headers.get('authorization', '')
        try:
            if not token.startswith('Bearer ') or verify_token(token[7:]).get('uid') != ADMIN_UID:
                raise ValueError('not admin')
        except Exception as exc:
            raise HTTPException(403, 'Administrator required') from exc

    def report_ref(report_id):
        if not ID.fullmatch(report_id):
            raise HTTPException(422, 'Invalid report ID')
        return get_db().collection('portalFeedback').document(report_id)

    def cleanup(paths):
        failed = False
        for path in paths:
            # Never accept caller supplied paths, including paths in stored documents.
            if not re.fullmatch(r'portal-feedback/img-[0-9a-f]{32}/[0-9a-f]{32}/[0-4]', path):
                raise ValueError('Unsafe image path')
            try:
                get_bucket().blob(path).delete()
            except NotFound:
                pass
            except Exception:
                failed = True
                log.warning('Feedback image cleanup pending: %s', path)
        return not failed

    @router.post('')
    def submit(payload: Submission, request: Request):
        check_origin(request)
        require_enabled()
        data, images, fingerprint = validate(payload)
        report_id = 'img-' + payload.requestId.hex
        ref = report_ref(report_id)
        existing = ref.get()
        if existing.exists:
            if existing.to_dict().get('attachmentRequestHash') != fingerprint:
                raise HTTPException(409, 'Request ID already used')
            return {'id': report_id}
        paths = []
        attachments = []
        attempt = uuid.uuid4().hex
        try:
            for index, (raw, mime) in enumerate(images):
                path = f'portal-feedback/{report_id}/{attempt}/{index}'
                paths.append(path)  # Include writes whose response may be lost.
                get_bucket().blob(path).upload_from_string(raw, content_type=mime, if_generation_match=0)
                attachments.append({'path': path, 'contentType': mime, 'size': len(raw)})
        except Exception as exc:
            cleanup(paths)
            raise HTTPException(503, 'Image upload failed') from exc
        try:
            ref.create({**data, 'attachments': attachments, 'attachmentRequestHash': fingerprint,
                        'createdAt': firestore.SERVER_TIMESTAMP})
        except Exception as exc:
            # A timed out create may have committed. Never delete its images.
            try:
                saved = ref.get()
            except Exception:
                log.warning('Feedback commit uncertain; preserve images: %s/%s', report_id, attempt)
                raise HTTPException(503, 'Commit uncertain; retry same request') from exc
            if saved.exists:
                stored = saved.to_dict()
                if stored.get('attachments') != attachments:
                    cleanup(paths)
                if stored.get('attachmentRequestHash') == fingerprint:
                    return {'id': report_id}
                raise HTTPException(409, 'Request ID already used') from exc
            if isinstance(exc, (AlreadyExists, Forbidden, InvalidArgument)):
                cleanup(paths)
            else:
                # Unknown commit outcome: retain rather than risk dangling references.
                log.warning('Feedback commit failed; reconcile images: %s/%s', report_id, attempt)
            raise HTTPException(503, 'Report save failed') from exc
        return {'id': report_id}

    @router.get('/{report_id}/images/{index}')
    def image(report_id: str, index: int, request: Request):
        admin(request)
        snapshot = report_ref(report_id).get()
        attachments = snapshot.to_dict().get('attachments', []) if snapshot.exists else []
        if index < 0 or index >= len(attachments) or index > 4:
            raise HTTPException(404)
        item = attachments[index]
        path = item.get('path', '')
        if not re.fullmatch(r'portal-feedback/' + re.escape(report_id) + r'/[0-9a-f]{32}/' + str(index), path):
            raise HTTPException(404)
        mime = item.get('contentType')
        if mime not in MIMES.values():
            raise HTTPException(404)
        return Response(get_bucket().blob(path).download_as_bytes(), media_type=mime,
                        headers={'X-Content-Type-Options': 'nosniff'})

    @router.delete('/{report_id}')
    def delete(report_id: str, request: Request):
        check_origin(request)
        admin(request)
        require_enabled()
        ref = report_ref(report_id)
        ref.delete()
        # Exact report prefix also permits an admin retry after partial cleanup.
        paths = [blob.name for blob in get_bucket().list_blobs(prefix=f'portal-feedback/{report_id}/')]
        if not cleanup(paths):
            raise HTTPException(503, 'Report deleted; image cleanup pending, retry')
        return {'deleted': True}

    app.include_router(router)

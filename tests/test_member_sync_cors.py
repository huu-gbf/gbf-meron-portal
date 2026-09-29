"""Exercise the repository's actual CORS declaration without importing production clients."""
import ast
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.testclient import TestClient


def test_member_sync_preflight_and_bearer_header():
    tree = ast.parse(Path('backend/main.py').read_text(encoding='utf-8'))
    scope = {'app': FastAPI(), 'CORSMiddleware': CORSMiddleware}
    nodes = []
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'ALLOWED_ORIGINS' for t in node.targets):
            nodes.append(node)
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            call = node.value
            if isinstance(call.func, ast.Attribute) and call.func.attr == 'add_middleware' and call.args and isinstance(call.args[0], ast.Name) and call.args[0].id == 'CORSMiddleware':
                nodes.append(node)
    assert len(nodes) == 2
    exec(compile(ast.Module(body=nodes, type_ignores=[]), '<repository CORS>', 'exec'), scope)
    member = FastAPI()

    @member.get('/status')
    def status():
        return {'status': 'mock'}

    scope['app'].mount('/api/member-sync', member)
    with TestClient(scope['app']) as client:
        for method in ('GET', 'POST'):
            response = client.options('/api/member-sync/status', headers={
                'Origin': 'https://huu-gbf.github.io',
                'Access-Control-Request-Method': method,
                'Access-Control-Request-Headers': 'authorization,content-type'})
            assert response.status_code == 200
            assert response.headers['access-control-allow-origin'] == 'https://huu-gbf.github.io'
            assert 'authorization' in response.headers['access-control-allow-headers'].lower()
        response = client.get('/api/member-sync/status', headers={
            'Origin': 'https://huu-gbf.github.io', 'Authorization': 'Bearer mock-only'})
        assert response.status_code == 200
        assert response.headers['access-control-allow-origin'] == 'https://huu-gbf.github.io'

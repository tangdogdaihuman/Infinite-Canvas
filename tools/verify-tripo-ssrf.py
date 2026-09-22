# 回归验证：Tripo 下载端点（POST /api/tripo/download）的 SSRF 防御。
# 断言：内网 IP 字面量 / localhost / 链路本地 / 非 http 协议 / 空地址 一律 400 拦截，
# 不触发任何真实下载。注意：只拦字面量地址，不做 DNS 预检（Clash fake-ip 会误杀所有域名）。
# 用法：服务跑在 38080，python tools/verify-tripo-ssrf.py
import json, urllib.request

BASE = 'http://127.0.0.1:38080'

def post(url, payload):
    req = urllib.request.Request(BASE + url, data=json.dumps(payload).encode(),
                                 headers={'Content-Type': 'application/json'})
    try:
        r = urllib.request.urlopen(req, timeout=8)
        return r.status, r.read().decode()[:120]
    except Exception as e:
        body = ''
        try: body = e.read().decode()[:120]
        except Exception: pass
        return getattr(e, 'code', '?'), body

cases = [
    ('内网 IP 字面量', '/api/tripo/download', {'url': 'http://192.168.1.1/secret.glb', 'kind': 'model'}),
    ('localhost', '/api/tripo/download', {'url': 'http://localhost:8000/x.glb', 'kind': 'model'}),
    ('127.0.0.1', '/api/tripo/download', {'url': 'http://127.0.0.1:38080/api/app-info', 'kind': 'model'}),
    ('链路本地 169.254', '/api/tripo/download', {'url': 'http://169.254.169.254/latest/meta', 'kind': 'model'}),
    ('非 http 协议', '/api/tripo/download', {'url': 'file:///D:/secret.txt', 'kind': 'model'}),
    ('空地址', '/api/tripo/download', {'url': '', 'kind': 'model'}),
]
for name, path, payload in cases:
    code, body = post(path, payload)
    ok = (code == 400)
    print(('PASS' if ok else 'FAIL'), name, '->', code, body[:60])

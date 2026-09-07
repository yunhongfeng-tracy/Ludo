"""发布单文件网页；不修改 Nginx 配置，验证失败时回滚本次入口。"""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import urllib.request
import uuid

artifact = Path(sys.argv[1]).resolve(strict=True)
expected_hash = sys.argv[2].lower()
base = Path('/www/wwwroot/ludo')
route = Path('/usr/local/lighthouse/softwares/wordpress/ludo')
current = base / 'current'
payload = artifact.read_bytes()
if hashlib.sha256(payload).hexdigest() != expected_hash:
    raise RuntimeError('Upload hash does not match the local release')
payload.decode('utf-8', errors='strict')
if b'PRIVATE KEY' in payload or b'/*__APP__*/' in payload:
    raise RuntimeError('Invalid public artifact')
if route.exists() or route.is_symlink():
    if not route.is_symlink() or os.readlink(route) != str(current):
        raise RuntimeError('The public route already belongs to another deployment')
if current.exists() or current.is_symlink():
    if not current.is_symlink() or not current.resolve().is_relative_to(base / 'releases'):
        raise RuntimeError('Unexpected current release entry')
previous = os.readlink(current) if current.is_symlink() else None
route_existed = route.is_symlink()
release = base / 'releases' / expected_hash
release.mkdir(parents=True, exist_ok=True)
for directory in [base, base / 'releases', release]:
    directory.chmod(0o755)
target = release / 'index.html'
if target.exists():
    if hashlib.sha256(target.read_bytes()).hexdigest() != expected_hash:
        raise RuntimeError('An existing release has unexpected content')
else:
    upload = release / ('index-' + uuid.uuid4().hex + '.tmp')
    shutil.copyfile(artifact, upload)
    upload.chmod(0o644)
    os.replace(upload, target)


def switch_link(link_target):
    pending = base / ('current-' + uuid.uuid4().hex)
    pending.symlink_to(link_target)
    os.replace(pending, current)


try:
    switch_link('releases/' + expected_hash)
    if not route_existed:
        route.symlink_to(current)
    request = urllib.request.Request('http://127.0.0.1/ludo/', headers={'Host': '43.136.57.147', 'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=15) as response:
        result = response.read()
        if response.status != 200 or hashlib.sha256(result).hexdigest() != expected_hash:
            raise RuntimeError('Local HTTP verification failed')
except Exception:
    if previous:
        switch_link(previous)
    elif current.is_symlink():
        current.unlink()
    if not route_existed and route.is_symlink():
        route.unlink()
    raise

print(json.dumps({
    'deployedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'url': 'https://ludo.tracyyun.cn/',
    'legacyUrl': 'http://43.136.57.147/ludo/',
    'release': str(release),
    'publicRoute': str(route),
    'current': str(current),
    'previousRelease': previous,
    'sha256': expected_hash,
    'bytes': len(payload),
    'localHttpVerified': True,
    'nginxConfigurationChanged': False,
}, ensure_ascii=False, indent=2))

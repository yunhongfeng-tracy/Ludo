"""安装当前游戏独立站点配置，检查失败时恢复原配置。"""
from pathlib import Path
import datetime
import json
import os
import subprocess
import sys

source = Path(sys.argv[1])
config = Path('/www/server/panel/vhost/nginx/ludo.tracyyun.cn.conf')
expected_hash = sys.argv[2].lower()
text = source.read_text(encoding='utf-8')
if '\ufffd' in text or 'server_name ludo.tracyyun.cn;' not in text:
    raise RuntimeError('Invalid site configuration')
before = config.read_bytes() if config.exists() else None
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup = Path('/www/wwwroot/ludo/config-backups') / (stamp + '.conf')
if before:
    backup.parent.mkdir(parents=True, exist_ok=True)
    backup.write_bytes(before)
challenge = Path('/www/wwwroot/ludo/acme/.well-known/acme-challenge')
challenge.mkdir(parents=True, exist_ok=True)
for directory in [challenge, challenge.parent, challenge.parent.parent]:
    directory.chmod(0o755)
temporary = config.with_suffix('.conf.ludo-new')
temporary.write_text(text, encoding='utf-8')
temporary.chmod(0o644)
os.replace(temporary, config)
try:
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['nginx', '-s', 'reload'], check=True)
    # 重新加载为平滑切换，连接验证由外部请求进行，避免旧 worker 的短暂竞态。
except Exception:
    if before is None:
        config.unlink()
    else:
        config.write_bytes(before)
    subprocess.run(['nginx', '-t'], check=True)
    subprocess.run(['nginx', '-s', 'reload'], check=True)
    raise
print(json.dumps({'config': str(config), 'backup': str(backup) if before else None,
                  'expectedGameSha256': expected_hash, 'nginxValidatedAndReloaded': True}))

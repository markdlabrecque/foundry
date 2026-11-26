"""Post-run evidence collection only; does not run models or score acceptance."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess

repo = Path.cwd()
out = repo / 'docs/evidence/p0-real-ticket'
run = out / 'run'
result = json.loads((run / 'result.json').read_text())
root = Path(result['root'])
provider = Path.home() / '.pi/agent/extensions/pi-claude-subscription'
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
save = lambda p, v: p.write_text(json.dumps(v, indent=2) + '\n')
raw = {str(p.relative_to(out)): sha(p) for p in run.rglob('*') if p.is_file()}
# Read-only snapshot of disposable Foundry state, never an operator database.
db = sqlite3.connect(f'file:{run / "state/foundry.db"}?mode=ro&immutable=1', uri=True)
db.row_factory = sqlite3.Row
tables = [r[0] for r in db.execute("select name from sqlite_master where type='table' order by name")]
export = {t: [dict(r) for r in db.execute(f'SELECT * FROM "{t}"')] for t in tables}
save(run / 'store.json', export)
db.close()
(run / 'state/foundry.db').unlink()
save(out/'raw-hashes.json',raw)
# No live process matching an owned launch group or owned root may be removed.
ps = subprocess.check_output(['ps', '-eo', 'pid=,ppid=,pgid=,args='], text=True)
groups = {r['pid'] for r in export['launch']}
pids = groups | {result['daemonPid'], 3431121}
remaining = []
for line in ps.splitlines():
    parts = line.strip().split(None, 3)
    if len(parts) == 4 and (int(parts[0]) in pids or int(parts[2]) in groups or str(root) in parts[3]):
        remaining.append(line)
cleanup = {'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
           'ownedWorkerPgids': sorted(groups), 'ownedDaemonAndHostPids': [result['daemonPid'], 3431121],
           'remainingBeforeFallback': remaining, 'fallbackUsed': False,
           'sourceHead': subprocess.check_output(['git', '-C', str(root/'repo'), 'rev-parse', 'HEAD'], text=True).strip(),
           'cloneHead': subprocess.check_output(['git', '-C', str(root/'state/clones/realticket'), 'rev-parse', 'HEAD'], text=True).strip(),
           'sourceStatus': subprocess.check_output(['git', '-C', str(root/'repo'), 'status', '--porcelain'], text=True),
           'cloneStatus': subprocess.check_output(['git', '-C', str(root/'state/clones/realticket'), 'status', '--porcelain'], text=True),
           'cloneWorktrees': subprocess.check_output(['git', '-C', str(root/'state/clones/realticket'), 'worktree', 'list', '--porcelain'], text=True),
           'ticketWorktreeRootExists': (root/'worktrees').exists()}
if remaining:
    save(run/'cleanup.json', cleanup)
    raise SystemExit('Owned processes remain; root NOT removed')
# Save unchanged fixture source and true request, not model-imagined tool output.
for name in ['package.json', 'clamp.mjs']:
    (run/'fixture').mkdir(exist_ok=True)
    shutil.copyfile(root/'repo'/name, run/'fixture'/name)
shutil.copyfile(root/'request.md', run/'request.md')
shutil.rmtree(root)
cleanup['rootRemoved'] = not root.exists()
save(run/'cleanup.json', cleanup)
# Normalization changes only known path prefixes and trailing whitespace.
replacements = [(str(root), '<fixture>'), (str(repo), '<repo>'),
                (str(Path.home()/'.f135-tmp'), '<private-tmp>'),
                (str(provider), '<provider>'), (os.path.realpath(shutil.which('node')), '<node>')]
normalization = {}
for base in [run, out/'checks']:
    for p in base.rglob('*'):
        if not p.is_file():
            continue
        before = p.read_bytes()
        s = before.decode()
        for a,b in replacements:
            s = s.replace(a,b)
        s = '\n'.join(line.rstrip() for line in s.splitlines()).rstrip()+'\n'
        p.write_text(s)
        normalization[str(p.relative_to(out))] = {'beforeSha256': hashlib.sha256(before).hexdigest(), 'normalizedSha256': sha(p)}
save(out/'normalization.json', {'files': normalization})
paths = [p for p in (repo/'packages').rglob('*') if p.is_file() and ('src' in p.parts or 'dist' in p.parts) and p.suffix in ['.ts','.js','.json']]
paths += [repo/'package-lock.json', repo/'package.json']
provider_files = [p for p in provider.rglob('*') if p.is_file() and (p == provider/'index.ts' or p.parent == provider/'src') and p.suffix in ['.ts','.cjs','.mjs']]
versions = {name: subprocess.check_output(args,text=True).strip() for name,args in {
    'node':['node','--version'], 'npm':['npm','--version'], 'claude':['claude','--version'], 'kernel':['uname','-srmo']}.items()}
versions['workerPi'] = json.loads((repo/'node_modules/@earendil-works/pi-coding-agent/package.json').read_text())['version']
save(out/'provenance.json', {'productCommit': result['product'], 'versions':versions,
    'driverExecutedSha256': sha(out/'run.mjs'),
    'sourceAndBuildSha256': {str(p.relative_to(repo)):sha(p) for p in sorted(paths)},
    'providerCodeSha256': {str(p.relative_to(provider)):sha(p) for p in sorted(provider_files)},
    'authObservation':'claude auth status exit 0; stdout/stderr discarded; no credential file read',
    'normalization':'Known fixture/repo/provider/node/private TMPDIR prefixes, trailing whitespace only; IDs, argv order, response content and usage preserved. Binary DB replaced with read-only table export. Initial collector failed during normalization on SQLite sidecar; root cleanup and store export had completed. Final normalization resumed without model calls; original binary DB hash not retained.'})
print(json.dumps(cleanup,indent=2))

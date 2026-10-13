"""Compact per-run raw evidence: only previously unseen, referenced source hashes.

Normalized intervals remain in Git; original bytes are a separately retained
Actions artifact. Never collect arbitrary workspace files or credentials.
"""
import hashlib
import json
from pathlib import Path
import zipfile

APP=Path(__file__).resolve().parents[1]
CACHE=APP/'.local/transmission'


def main():
    audit=CACHE/'audit';audit.mkdir(parents=True,exist_ok=True)
    baseline=CACHE/'source-baseline.json'
    known=set(json.loads(baseline.read_text())) if baseline.exists() else set()
    data=json.loads((APP/'data/transmission-observations.json').read_text())
    wanted={row['sha256']:row for row in data['sources'] if row['sha256'] not in known}
    found=set()
    with zipfile.ZipFile(audit/'new-original-sources.zip','w',compression=zipfile.ZIP_DEFLATED,compresslevel=5) as archive:
        for path in sorted(CACHE.rglob('*')):
            if not path.is_file() or path.is_symlink() or audit in path.parents or path.stat().st_size>80*1024*1024:continue
            digest=hashlib.sha256()
            with path.open('rb') as handle:
                for chunk in iter(lambda:handle.read(1024*1024),b''):digest.update(chunk)
            sha=digest.hexdigest()
            if sha in wanted and sha not in found:
                archive.write(path,arcname=sha+'.bin');found.add(sha)
        archive.writestr('manifest.json',json.dumps({'sources':list(wanted.values()),'archivedHashes':sorted(found),'unavailableRawHashes':sorted(set(wanted)-found)},ensure_ascii=False,indent=2))
    report=CACHE/'latest-run.json'
    if report.exists():(audit/'collection-run.json').write_bytes(report.read_bytes())
    (audit/'coverage.json').write_text(json.dumps(data['coverage'],ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'newSources':len(wanted),'rawArchived':len(found),'missingRaw':len(wanted)-len(found)}))


if __name__=='__main__':main()

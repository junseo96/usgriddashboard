"""Compact per-run raw evidence: only previously unseen, referenced source hashes.

Normalized intervals remain in Git; original bytes are a separately retained
Actions artifact. Never collect arbitrary workspace files or credentials.
"""
import hashlib
import json
from pathlib import Path
import zipfile
from transmission_storage import gather_fragments

APP=Path(__file__).resolve().parents[1]
CACHE=APP/'.local/transmission'


def main():
    audit=CACHE/'audit';audit.mkdir(parents=True,exist_ok=True)
    baseline=CACHE/'source-baseline.json'
    known=set(json.loads(baseline.read_text())) if baseline.exists() else set()
    data=json.loads((APP/'data/transmission-observations.json').read_text())
    report_path=CACHE/'latest-run.json'
    report=json.loads(report_path.read_text()) if report_path.exists() else {}
    failed=report.get('status')=='failed'
    sources=list(data['sources'])
    # Failed assembly must remain reproducible without publishing its observations.
    # This directory contains only normalized public evidence, never account data.
    if failed:
        for fragment in gather_fragments(APP/'data/transmission-fragments'):
            sources.extend(fragment.get('sources',[]))
    wanted={row['sha256']:row for row in sources if row['sha256'] not in known}
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
        archive.writestr('manifest.json',json.dumps({'failedAssembly':failed,'sources':list(wanted.values()),'archivedHashes':sorted(found),'unavailableRawHashes':sorted(set(wanted)-found)},ensure_ascii=False,indent=2))
        if failed:
            root=APP/'data/transmission-fragments'
            for path in sorted(root.rglob('*.json')):
                if path.is_file() and not path.is_symlink():
                    archive.write(path,arcname='unpublished-normalized/'+str(path.relative_to(root)))
    if report_path.exists():(audit/'collection-run.json').write_bytes(report_path.read_bytes())
    (audit/'coverage.json').write_text(json.dumps(data['coverage'],ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'newSources':len(wanted),'rawArchived':len(found),'missingRaw':len(wanted)-len(found)}))


if __name__=='__main__':main()

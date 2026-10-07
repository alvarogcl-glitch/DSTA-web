import re, shutil, unicodedata
from pathlib import Path
ROOT=Path(r'C:\Users\admin\.openclaw\workspace\proyectos\pmo-dsta\07_reuniones')
ID_RE=re.compile(r'source_id:\s*"([^"]+)"')

def ascii_name(p):
    return unicodedata.normalize('NFKD',p.name).encode('ascii','ignore').decode()

def promote(root=ROOT):
    ROOT = root
    STAGING = ROOT / '.granola-summary-staging'
    ARCHIVE = ROOT / '.granola-transcript-archive'
    summaries=[]
    for src in STAGING.glob('*.md'):
        text=src.read_text(encoding='utf-8',errors='ignore')
        m=ID_RE.search(text)
        sections = re.findall(r'## (?:Resumen generado por Granola|Notas tomadas en Granola)\s*\n(.*?)(?=\n## |\Z)', text, re.S)
        ready = any(section.strip().casefold() not in {'', 'no summary', 'not available', 'no notes', 'none', 'null'} for section in sections)
        if m and ready: summaries.append((m.group(1),src,text))
    # An all-deferred export is valid; preserve existing published minutes.
    for mid,src,text in summaries:
        candidates=[]
        for old in ROOT.glob('*.md'):
            oldtext=old.read_text(encoding='utf-8',errors='ignore')
            if ID_RE.search(oldtext) and ID_RE.search(oldtext).group(1)==mid and 'transcript_sha256:' in oldtext:
                candidates.append(old)
        target=min(candidates,key=lambda p:(any(ord(c)>127 for c in p.name),len(p.name))) if candidates else ROOT/src.name
        if candidates:
            ARCHIVE.mkdir(parents=True,exist_ok=True)
            for old in candidates:
                shutil.copy2(old,ARCHIVE/old.name)
        shutil.copy2(src,target)
    return {'promoted':len(summaries),'archived_transcript_files':sum(1 for _ in ARCHIVE.glob('*.md')) if ARCHIVE.exists() else 0}


if __name__ == '__main__':
    print(promote())

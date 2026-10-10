#!/usr/bin/env python3
"""Check the exact production source union; do not infer behavioral acceptance."""
from pathlib import Path
import hashlib,json,sys
root=Path(__file__).resolve().parents[1]
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
inputs=json.loads((root/'provenance/INPUT-FILES.json').read_text())
union=json.loads((root/'provenance/SOURCE-UNION.json').read_text())
expected={p:h for p,h in inputs['B']['files'].items() if p.startswith('src/')}
for rows in union['changes'].values():
 for row in rows:expected[row['file']]=row['sha256']
actual={str(p.relative_to(root)):sha(p) for p in (root/'src').rglob('*') if p.is_file()}
bad=[p for p in sorted(set(actual)|set(expected)) if actual.get(p)!=expected.get(p)]
print(json.dumps({'sourceFileCount':len(expected),'mismatches':bad,'exactUnion':not bad}))
sys.exit(bool(bad))

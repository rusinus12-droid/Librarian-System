#!/usr/bin/env python3
"""Verify restored development/test support without changing product files.

Python standard library only. --run-gui additionally runs the original Node GUI
fixture test behind the shipped offline transport guard. No CBS regeneration.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys


def verify(root):
    errors = []
    manifest = json.loads((root / 'SUPPORT-INTEGRITY.json').read_text())
    for rel, expected in manifest['files'].items():
        pure = PurePosixPath(rel)
        if pure.is_absolute() or '..' in pure.parts:
            errors.append('unsafe_manifest_path:' + rel)
            continue
        path = root / rel
        if path.is_symlink():
            errors.append('symlink:' + rel)
        elif not path.is_file():
            errors.append('missing:' + rel)
        else:
            data = path.read_bytes()
            if len(data) != expected['bytes'] or hashlib.sha256(data).hexdigest() != expected['sha256']:
                errors.append('hash_mismatch:' + rel)
    for rel in manifest['forbiddenActiveLegacyPaths']:
        if (root / rel).exists():
            errors.append('forbidden_active_legacy:' + rel)
    source_checks = []
    generated = root / 'src/parts/11-risu-cbs-parity-generated.js'
    if generated.is_file():
        match = re.search(r'Source hashes: (\{[^\n]+\})', generated.read_text())
        if not match:
            errors.append('generated_source_hash_header_missing')
        else:
            hashes = json.loads(match.group(1))
            expected_names = {'scan.ts', 'calc.ts', 'evaluator.ts', 'candidates.ts', 'bridge.ts', 'runtime.ts'}
            if set(hashes) != expected_names:
                errors.append('generated_source_header_input_set_mismatch')
            for name, digest in hashes.items():
                path = root / 'vendor/risu-cbs-standalone/src' / name
                actual = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None
                source_checks.append({'file': name, 'expected': digest, 'actual': actual, 'match': actual == digest})
                if actual != digest:
                    errors.append('generated_input_mismatch:' + name)
    imports = []
    for path in sorted((root / 'vendor/risu-cbs-standalone/src').glob('*.ts')):
        for target in re.findall(r'from\s+[\'"]([^\'"]+)[\'"]', path.read_text()):
            if not target.startswith('./'):
                errors.append('nonlocal_vendor_import:' + path.name + ':' + target)
                continue
            expected = path.parent / (target[2:] if target.endswith('.ts') else target[2:] + '.ts')
            imports.append({'from': path.name, 'target': target, 'exists': expected.is_file()})
            if not expected.is_file():
                errors.append('missing_vendor_import:' + path.name + ':' + target)
    return {
        'ok': not errors,
        'errors': errors,
        'checkedFiles': len(manifest['files']),
        'protectedPredecessorFiles': manifest['protectedPredecessorFiles'],
        'restoredSupportFiles': manifest['restoredSupportFiles'],
        'generatedSourceHeaderInputs': source_checks,
        'localTypeScriptImports': imports,
        'runtimeChanged': False if not errors else 'not established',
        'cbsRegeneratorExecuted': False,
        'realRisuOrProviderCalls': 0,
        'scope': 'Support integrity and current generated-source input correspondence; not full product acceptance.',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', nargs='?', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--run-gui', action='store_true')
    args = parser.parse_args()
    root = args.root.resolve()
    try:
        report = verify(root)
        if args.run_gui and report['ok']:
            env = dict(os.environ)
            guard = str(root / 'tools/libra_final_delivery_offline_guard.cjs')
            env['NODE_OPTIONS'] = (env.get('NODE_OPTIONS', '') + ' --require=' + json.dumps(guard)).strip()
            proc = subprocess.run(['node', str(root / 'tools/libra_gui_ux_integration_test.cjs')], cwd=root, env=env, capture_output=True, text=True)
            report['gui'] = {'exitCode': proc.returncode, 'stdout': proc.stdout, 'stderr': proc.stderr}
            report['ok'] = proc.returncode == 0
            if proc.returncode:
                report['errors'].append('gui_test_failed')
            elif 'FINAL_DELIVERY_BLOCKED_TRANSPORTS' in proc.stderr:
                report['errors'].append('gui_test_attempted_transport')
                report['ok'] = False
    except (OSError, ValueError, KeyError) as exc:
        report = {'ok': False, 'errors': [type(exc).__name__ + ':' + str(exc)]}
    print(json.dumps(report, indent=2))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    sys.exit(main())

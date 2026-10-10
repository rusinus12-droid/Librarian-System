"""Stage a verified release inside Termux HOME; never overlay existing DATA."""
import argparse
import hashlib
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import tempfile
import zipfile


def install(archive, destination, home=None):
    home = Path(home or Path.home()).resolve()
    destination = Path(destination).resolve()
    if home not in destination.parents or str(home).startswith(('/storage/', '/sdcard/')):
        raise ValueError('설치 위치는 Termux 내부 HOME의 하위 폴더여야 합니다.')
    # Existing installs are intentionally not overlaid: an interrupted update must
    # not replace a running program or mix its DATA with release defaults.
    if destination.exists():
        raise ValueError('기존 설치가 있습니다. 다른 새 폴더에 설치하세요. 기존 DATA는 변경하지 않습니다.')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.librarian-install-', dir=destination.parent) as tmp:
        stage = Path(tmp)
        with zipfile.ZipFile(archive) as z:
            items = z.infolist()
            if len(items) > 20000 or sum(i.file_size for i in items) > 2 * 1024**3:
                raise ValueError('배포 ZIP의 파일 수 또는 크기 제한을 초과했습니다.')
            if shutil.disk_usage(stage).free < sum(i.file_size for i in items) + 64 * 1024**2:
                raise ValueError('내부 저장소의 여유 공간이 부족합니다.')
            seen = set()
            for item in items:
                name = item.filename
                path = PurePosixPath(name)
                if ('\\' in name or path.is_absolute() or '..' in path.parts
                        or ':' in name or not path.parts or name in seen
                        or stat.S_ISLNK(item.external_attr >> 16)):
                    raise ValueError('안전하지 않거나 중복된 ZIP 경로입니다: ' + name)
                seen.add(name)
                target = stage.joinpath(*path.parts)
                if item.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with z.open(item) as src, target.open('xb') as dst:
                        shutil.copyfileobj(src, dst)
        roots = [p.parent for p in stage.rglob('SHA256SUMS.txt')
                 if (p.parent / 'PROGRAM' / 'program-manifest.json').is_file()]
        if len(roots) != 1:
            raise ValueError('배포 패키지 구조와 SHA256SUMS.txt를 확인할 수 없습니다.')
        root = roots[0]
        verified = set()
        for line in (root / 'SHA256SUMS.txt').read_text(encoding='utf-8-sig').splitlines():
            if not line.strip():
                continue
            digest, relative = line.split(None, 1)
            relative = relative.lstrip('*').strip()
            file = (root / relative).resolve()
            if root not in file.parents or not file.is_file():
                raise ValueError('체크섬 파일 경로가 올바르지 않습니다.')
            if hashlib.sha256(file.read_bytes()).hexdigest() != digest.lower():
                raise ValueError('체크섬이 일치하지 않습니다: ' + relative)
            verified.add(file)
        program = root / 'PROGRAM'
        if not (program / '1_서버_실행.sh').is_file():
            raise ValueError('서버 실행 파일이 없습니다.')
        if any(p.resolve() not in verified for p in program.rglob('*') if p.is_file()):
            raise ValueError('검증 목록에 없는 프로그램 파일이 있습니다.')
        # Stage and destination have the same parent filesystem.
        if destination.exists():
            raise ValueError('설치 도중 대상 폴더가 생성되었습니다. 다시 확인하세요.')
        os.rename(root, destination)
    return destination


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('archive')
    parser.add_argument('--destination', default=str(Path.home() / 'librarian-system'))
    args = parser.parse_args()
    try:
        result = install(args.archive, args.destination)
        print('설치 완료: ' + str(result))
        print('실행: sh "' + str(result / 'PROGRAM/1_서버_실행.sh') + '"')
        print('종료: sh "' + str(result / 'PROGRAM/2_서버_종료.sh') + '"')
        print('연결 주소: http://127.0.0.1:47630')
    except Exception as error:
        parser.exit(1, '설치 중단: ' + str(error) + '\n기존 DATA는 변경하지 않았습니다.\n')

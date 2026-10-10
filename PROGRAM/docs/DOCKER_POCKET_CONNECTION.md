# Docker·PocketRisu 연결

PocketRisu의 `/proxy2`는 실제 목적지에 요청을 전달하는 경로입니다. 브라우저에서 보이는 URL에 proxy2가 있다고 해서 주소가 잘못 붙은 것은 아닙니다. 이 경로에서는 PocketRisu 서버에서 Memory Suite 서버로 연결할 수 있어야 합니다.

- 브라우저와 서버가 서로 다른 기기라면 `127.0.0.1`은 브라우저 기기를 뜻하지 않습니다.
- Docker 컨테이너의 기본 네트워크에서는 `127.0.0.1`이 그 컨테이너입니다.
- SDK는 `host.docker.internal`을 허용합니다. 이 이름의 해석과 호스트 서비스 접근 가능 여부는 Docker 구성에 따릅니다.
- 이번 구현은 Memory Suite 서버를 외부 인터페이스에 공개하지 않습니다. 기존 loopback 바인딩을 유지합니다. 별도 인증 없이 `0.0.0.0`으로 바꾸지 마세요.

현재 지원을 우선 검증할 배치는 PocketRisu와 Memory Suite가 같은 네트워크 환경의 loopback에 접근할 수 있는 구성입니다. Linux Docker의 host networking을 사용하거나, 같은 환경 안에서 두 서비스를 실행하는 배치가 해당합니다. Docker Desktop의 host networking 지원 여부와 활성화 조건은 사용 중인 Docker 버전에서 확인해야 합니다. 단순 주소 변경만으로 모든 bridge 네트워크에서 호스트 loopback 서비스에 접근할 수 있다고 보장하지 않습니다.

진단할 때 PocketRisu 버전, Docker 종류, Memory Suite 실행 위치, `/proxy2` HTTP 상태 및 응답 오류를 함께 확인하세요. 토큰과 원문은 공유하지 마세요. 주소 허용 실패와 연결 거부/시간 초과는 서로 다른 문제입니다.

실제 Docker Desktop·Linux Engine 및 브라우저 조합 전수 검증은 아직 수행하지 않았습니다. 전용 인증 중계 및 외부 listen 모드는 이 변경에 포함되지 않습니다.

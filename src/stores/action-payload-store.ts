/**
 * Slack action.value (~2,000 bytes) 및 private_metadata (~3,000 bytes) 크기 제한 대응.
 * 큰 페이로드를 서버 사이드에 저장하고 짧은 키만 버튼 값에 포함.
 * TTL 기반 자동 정리로 메모리 누수 방지.
 */

const store = new Map<string, { data: unknown; expiresAt: number }>();

const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000; // 2시간

function cleanup(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.expiresAt) store.delete(key);
  }
}

/**
 * 페이로드 저장
 */
export function setPayload(key: string, data: unknown, ttlMs = DEFAULT_TTL_MS): void {
  cleanup();
  store.set(key, { data, expiresAt: Date.now() + ttlMs });
}

/**
 * 페이로드 조회 (기본: 조회 후 삭제하지 않음)
 * @param remove true이면 조회 후 삭제 (일회성 데이터용)
 */
export function getPayload<T>(key: string, remove = false): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  if (remove) {
    store.delete(key);
  } else {
    // TTL 갱신: 접근 시 만료 시간 리셋 (사용자가 상호작용 중임을 표시)
    entry.expiresAt = Date.now() + DEFAULT_TTL_MS;
  }
  return entry.data as T;
}

/**
 * 페이로드 삭제
 */
export function removePayload(key: string): void {
  store.delete(key);
}

/**
 * 테스트용: 스토어 전체 초기화
 */
export function clearAllPayloads(): void {
  store.clear();
}

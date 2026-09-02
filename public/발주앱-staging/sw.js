// PWA 설치용 최소 서비스 워커 — 캐시 완전 비활성화
const CACHE_NAME = 'hanger-v101';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // 기존 캐시 전부 삭제 후 탭 제어권 획득
  // (페이지 측 controllerchange 이벤트가 새로고침 처리)
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  // Firebase Functions, Firestore 요청은 서비스워커 개입 없이 그대로 통과
  if (url.includes('cloudfunctions.net') || url.includes('firestore.googleapis.com') || url.includes('firebase')) {
    return;
  }
  // 그 외 요청만 캐시 우회
  e.respondWith(
    fetch(e.request, { cache: 'no-store' }).catch(() => caches.match(e.request))
  );
});

self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

(() => {
  const header = document.querySelector('[data-header]');
  const menu = document.querySelector('[data-menu]');
  const menuButton = document.querySelector('[data-menu-button]');

  const syncHeader = () => header?.classList.toggle('scrolled', window.scrollY > 12);
  syncHeader();
  window.addEventListener('scroll', syncHeader, { passive: true });

  menuButton?.addEventListener('click', () => {
    const isOpen = menu.classList.toggle('open');
    menuButton.classList.toggle('open', isOpen);
    menuButton.setAttribute('aria-expanded', String(isOpen));
    menuButton.setAttribute('aria-label', isOpen ? '메뉴 닫기' : '메뉴 열기');
  });

  menu?.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
    menu.classList.remove('open');
    menuButton?.classList.remove('open');
    menuButton?.setAttribute('aria-expanded', 'false');
    // [2026-09-03 Codex P2 fix] aria-label 도 원복 (스크린리더 "메뉴 닫기" 오안내 방지)
    menuButton?.setAttribute('aria-label', '메뉴 열기');
  }));

})();

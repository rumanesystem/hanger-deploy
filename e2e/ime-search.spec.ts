import { expect, test } from '@playwright/test';

test('IME 검색은 조합 완료 후 한 번만 반영하고 제거된 input의 타이머는 무시한다', async ({ page }) => {
  await page.goto('/');
  // [스테이징 대응] 실 Firebase 부팅 중 SPA navigation 으로 evaluate context 파괴 방지 —
  // _booted 플래그로 SPA 초기화 완료 대기 (F1-staging 스펙과 동일 패턴).
  await page.waitForSelector('#login-screen', { timeout: 30_000 });
  await page.waitForFunction(
    () => Boolean((window as any)._booted) && typeof (window as any)._imeSafeSearchInput === 'function',
    null,
    { timeout: 30_000 }
  );

  const result = await page.evaluate(async () => {
    const bind = (window as any)._imeSafeSearchInput;

    const staleInput = document.createElement('input');
    document.body.appendChild(staleInput);
    let staleCalls = 0;
    bind(staleInput, () => { staleCalls += 1; }, { delay: 30, focusFlagKey: '_e2eStaleIme' });
    staleInput.value = '겉';
    staleInput.dispatchEvent(new Event('input', { bubbles: true }));
    staleInput.remove();
    await new Promise(resolve => setTimeout(resolve, 60));

    const imeInput = document.createElement('input');
    document.body.appendChild(imeInput);
    const values: string[] = [];
    bind(imeInput, (value: string) => { values.push(value); }, { delay: 30, focusFlagKey: '_e2eActiveIme' });
    imeInput.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    imeInput.value = '겉서랍';
    imeInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 60));
    const callsDuringComposition = values.length;
    imeInput.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '겉서랍' }));
    await new Promise(resolve => setTimeout(resolve, 60));
    imeInput.remove();

    return { staleCalls, callsDuringComposition, values };
  });

  expect(result.staleCalls).toBe(0);
  expect(result.callsDuringComposition).toBe(0);
  expect(result.values).toEqual(['겉서랍']);
});


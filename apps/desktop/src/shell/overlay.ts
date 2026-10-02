// U07 ⑥ — 덮개 페이지. hubOverlay 셋만 쓴다. 커서 좌표는 덮개 왼쪽 위 기준 px(main 이 sendInputEvent 에 넣는 바로 그 점).
import type { AiTaskBand } from '@cmh-hub-app/contracts';

const band = document.getElementById('band') as HTMLElement;
const bandText = document.getElementById('band-text') as HTMLElement;
const bandStop = document.getElementById('band-stop') as HTMLButtonElement;
const cursor = document.getElementById('cursor') as unknown as SVGElement;

let current: AiTaskBand | null = null;

bandStop.addEventListener('click', () => {
  if (current) window.hubOverlay?.stop(current.paneId);
});

window.hubOverlay?.onBand((b) => {
  current = b;
  band.hidden = b === null;
  if (b) bandText.textContent = `AI 가 작업 중 · ${b.title} · ${b.step}/${b.steps} 단계`;
  if (b === null) cursor.setAttribute('hidden', '');
});

window.hubOverlay?.onCursor((p) => {
  if (!p) {
    cursor.setAttribute('hidden', '');
    return;
  }
  cursor.removeAttribute('hidden');
  (cursor as unknown as HTMLElement).style.transform = `translate(${p.x}px, ${p.y}px)`; // transition 없음 — 좌표가 곧 실제 입력 위치
});

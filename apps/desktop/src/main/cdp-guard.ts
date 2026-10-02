// T41-2 가드 · U07 8-3 — 원격 디버깅(CDP) 플래그가 있으면 앱을 끈다(세션 탈취 · 자동화 흔적)
import { app } from 'electron';

const FORBIDDEN = ['--remote-debugging-port', '--remote-debugging-pipe', '--inspect', '--inspect-brk', '--enable-automation'];

export function assertNoRemoteDebugging(argv: readonly string[] = process.argv): void {
  const hit = argv.find((a) => FORBIDDEN.some((f) => a === f || a.startsWith(`${f}=`)));
  if (hit) {
    console.error(`cmh-hub-app: 디버깅 플래그 ${hit} 가 있어 종료합니다`);
    app.exit(2);
  }
}

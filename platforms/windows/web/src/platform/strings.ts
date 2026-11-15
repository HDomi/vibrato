/** UI text of this platform that differs from the shared dictionary (lib/i18n.ts), which is written for macOS. */
export const STRINGS: Record<'en' | 'ko', Record<string, string>> = {
  en: {
    'common.revealInFinder': 'Show in Explorer',
    'files.moveToTrash': 'Move to Recycle Bin',
    'settings.keepAwake': 'Keep the PC awake while an agent is working or a terminal is busy',
    'usage.scheduleCount': '{n} enabled schedules on this PC',
    'remote.noHosts': 'No hosts yet. Add the address of the computer that allows remote access.',
    'remote.hostNamePh': 'Home PC',
    'remote.host.toggle': 'Allow remote access to this PC…',
    'remote.host.title': 'Remote access to this PC',
    'remote.host.desc': 'Another Vibrato (Mac or Windows) can then read and answer this PC\'s sessions and start new ones.\nNo screen sharing, shell, file access or deleting sessions: sessions only. Logins need the access code and the password.',
    'remote.host.forwardHint': 'From outside: forward TCP port {port} on your router to this PC, and connect to your public IP.\nWith the port open to the internet, pick a password that is hard to guess and issue a new code if it leaks.',
    'remote.host.webhookHint': 'Posts to the channel when a client logs in, and when wrong codes lock an address. The URL is kept only on this PC and shown masked.',
    'remote.host.keepAwake': 'Keep this PC awake while waiting',
    'remote.host.keepAwakeOnBatteryHint': 'Off: only while plugged in. Saves battery, but the PC may fall asleep and stop answering clients while unplugged.',
    'tb.offline': 'Runs locally · nothing leaves this PC',
    'pdf.dropHint': 'Files stay on this PC. Also open from a PDF\'s preview or right-click menu in the file list.',
    'tb.viaServer': 'Requests go out from this PC through the app server',
    'tb.net.thisMac': 'This PC',
    'tb.net.localOnly': 'this PC only',
    'tb.net.portsNote': '"Network too" means other devices on the same network can reach it.',
    'tb.net.qrHint': 'QR code with this PC\'s LAN address, to open on a phone',
    'tb.qr.devServer': 'Dev server on this PC',
  },
  ko: {
    'common.revealInFinder': '탐색기에서 보기',
    'settings.keepAwake': '에이전트가 일하거나 터미널이 바쁠 때 PC 절전 방지',
    'usage.scheduleCount': '이 PC 의 켜진 스케줄 {n}개',
    'remote.noHosts': '아직 호스트가 없습니다. 원격 접속을 허용한 컴퓨터의 주소를 추가하세요.',
    'remote.hostNamePh': '집 PC',
    'remote.host.toggle': '이 PC 원격 접속 허용…',
    'remote.host.title': '이 PC 원격 접속',
    'remote.host.desc': '다른 Vibrato(Mac · Windows)가 이 PC 의 세션을 보고 답하고, 새 세션을 시작할 수 있습니다.\n화면 공유 · 셸 · 파일 접근 · 세션 삭제는 없고 세션만 다룹니다. 로그인에는 접속 코드와 비밀번호가 둘 다 필요합니다.',
    'remote.host.forwardHint': '밖에서 접속하려면 공유기에서 TCP 포트 {port} 를 이 PC 로 포워딩하고, 공인 IP 로 연결하세요.\n포트를 인터넷에 열어 둘 때는 추측하기 어려운 비밀번호를 쓰고, 코드가 새면 바로 새로 발급하세요.',
    'remote.host.webhookHint': '클라이언트가 로그인하거나, 틀린 시도로 주소가 잠기면 채널에 알립니다. URL 은 이 PC 에만 저장하고 가려서 보여 줍니다.',
    'remote.host.keepAwake': '대기 중 이 PC 잠자기 방지',
    'remote.host.keepAwakeOnBatteryHint': '끄면 전원이 연결됐을 때만 막습니다. 배터리는 아끼지만, 전원을 뽑은 동안 PC 가 잠들면 클라이언트가 접속할 수 없습니다.',
    'pdf.dropHint': '파일은 이 PC 밖으로 나가지 않습니다. 파일 목록의 PDF 미리보기나 우클릭 메뉴에서도 열 수 있어요.',
    'tb.viaServer': '요청은 이 PC 의 앱 서버에서 나갑니다',
    'tb.net.thisMac': '이 PC',
    'tb.net.localOnly': '이 PC 만',
    'tb.net.portsNote': '"네트워크도" 는 같은 네트워크의 다른 기기에서도 접속된다는 뜻입니다.',
    'tb.net.qrHint': '이 PC 의 LAN 주소로 QR 코드 만들기 (폰에서 열기)',
    'tb.qr.devServer': '이 PC 의 개발 서버',
  },
};

const MODIFIER: Record<string, string> = { '⌘': 'Ctrl', '⌃': 'Ctrl', '⌥': 'Alt', '⇧': 'Shift' };
const ORDER = ['Ctrl', 'Alt', 'Shift'];

/** Shortcut labels as Windows writes them: "⇧⌘N" is "Ctrl+Shift+N", "⌘⌫" is "Ctrl+Backspace". */
export function keyLabel(s: string): string {
  if (!/[⌘⌃⌥⇧⌫↩↵⏎]/.test(s)) return s;
  return s
    .replace(/[⌘⌃⌥⇧]+/g, (run) => [...new Set([...run].map((c) => MODIFIER[c]))].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)).map((m) => `${m}+`).join(''))
    .replace(/⌫/g, 'Backspace')
    .replace(/[↩↵⏎]/g, 'Enter');
}

/** One argument for a terminal tab's shell (PowerShell): single-quoted, a quote inside doubled; nothing is expanded or run. */
export const quoteShellArg = (s: string): string => `'${s.replace(/['\u2018\u2019]/g, "$&$&")}'`;

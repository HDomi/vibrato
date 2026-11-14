/**
 * Looping animations (status dots, spinners, the dock's status ring) sit on glass cards, so every frame of
 * them makes Chromium recomposite the blurred layers. They keep running while the window is visible but not in
 * front, which is most of the time a session works. While the window is hidden or unfocused this puts
 * `motion-paused` on <html>, and index.css pauses those animations. Returns the cleanup function.
 */
export function watchMotionPause(): () => void {
  const root = document.documentElement;
  const update = () => root.classList.toggle('motion-paused', document.hidden || !document.hasFocus());
  update();
  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
  document.addEventListener('visibilitychange', update);
  return () => {
    window.removeEventListener('focus', update);
    window.removeEventListener('blur', update);
    document.removeEventListener('visibilitychange', update);
    root.classList.remove('motion-paused');
  };
}

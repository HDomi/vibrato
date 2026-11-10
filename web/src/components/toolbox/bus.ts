/**
 * Hand-off between tools ("open this request in HTTP", "use this IP in QR"). The payload waits in
 * memory until the target tool mounts and takes it, so it survives the lazy chunk load.
 */
const pending = new Map<string, unknown>();
let requested: string | null = null;

/**
 * Show tool `id` (the app switches to Tools mode). A tool that is already on screen does not remount,
 * so it also gets `vibe:tool-payload` and takes the payload then.
 */
export function openTool(id: string, payload?: unknown) {
  if (payload !== undefined) pending.set(id, payload);
  requested = id;
  window.dispatchEvent(new CustomEvent('vibe:toolbox-open', { detail: { id } }));
  window.dispatchEvent(new CustomEvent('vibe:tool-payload', { detail: { id } }));
}

/** The tool asked for before ToolboxView mounted (it was not there to hear the event). */
export function takeRequestedTool(): string | null {
  const id = requested;
  requested = null;
  return id;
}

/** Called once by a tool on mount; returns and clears whatever was sent to it. */
export function takePayload<T>(id: string): T | undefined {
  const v = pending.get(id) as T | undefined;
  pending.delete(id);
  return v;
}

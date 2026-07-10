/**
 * Toast + cancellable-progress notifications, rendered by the shell toolbar
 * renderer. Replaces vscode.window.show*Message (non-blocking form) and
 * withProgress. Blocking message boxes (with buttons) use Electron's native
 * dialog instead — see vscodeShim.ts.
 */
let sendShell: (message: unknown) => void = () => {};
let nextId = 1;
/** Toast id → callback fired when its button is clicked in the shell. */
const buttonWaiters = new Map<number, (button: string | undefined) => void>();

export function configureNotifications(sender: (message: unknown) => void): void {
  sendShell = sender;
}

/** Wire-up for the shell's `toastButton` message (index.ts). */
export function handleToastButton(id: number, button: string): void {
  const waiter = buttonWaiters.get(id);
  if (waiter) {
    buttonWaiters.delete(id);
    waiter(button);
  }
}

export function toast(kind: "info" | "warning" | "error", text: string): void {
  sendShell({ type: "toast", id: nextId++, kind, text });
}

export interface ProgressToast {
  report(text: string): void;
  done(): void;
  onCancel(cb: () => void): void;
}

export function progressToast(text: string, cancellable: boolean): ProgressToast {
  const id = nextId++;
  sendShell({ type: "toast", id, kind: "progress", text, buttons: cancellable ? ["Cancel"] : [] });
  let cancelCb: (() => void) | undefined;
  if (cancellable) {
    buttonWaiters.set(id, () => cancelCb?.());
  }
  return {
    report: (t: string) => sendShell({ type: "toastUpdate", id, text: t }),
    done: () => {
      buttonWaiters.delete(id);
      sendShell({ type: "toastUpdate", id, done: true });
    },
    onCancel: (cb: () => void) => {
      cancelCb = cb;
    },
  };
}

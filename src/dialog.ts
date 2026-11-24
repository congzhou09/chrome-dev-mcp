import CDP from 'chrome-remote-interface';

// The JavaScript dialog (alert, confirm, prompt or beforeunload) open in the connected tab, if any.
//
// A tab showing such a dialog answers no command that its renderer handles, so a call to it times
// out. Without this record, the error for that call can only list a dialog among the possible
// causes. With it, the error says which dialog holds the page, and the dialog's message when it
// has one. A beforeunload dialog has none: Chrome shows its own text (measured, Chrome 157).
//
// Both events are in the stable Page domain, and the protocol documents them as fired for each of
// the four dialog types: javascriptDialogOpening when a dialog "is about to open", and
// javascriptDialogClosed when it "has been closed". If Chrome stopped sending
// javascriptDialogOpening, the errors would go back to listing a dialog among the possible
// causes. If Chrome stopped sending javascriptDialogClosed, a timeout with another cause, which
// comes after a dialog was closed, would be blamed on that dialog. So the errors say the dialog
// "has not been reported closed" rather than that it is showing.
export type OpenDialog = { type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string };

let watched: CDP.Client | null = null;
let open: OpenDialog | null = null;

// Called on every new connection, before Page.enable is sent, so that no event is missed.
//
// A dialog that is already open when the connection is made is never recorded. Measured, Chrome
// 157, with an alert open: a new connection's Page.enable was not answered, and no
// javascriptDialogOpening came. Connecting to such a tab fails anyway, because the enables that
// connectToTarget (index.ts) sends are not answered. When the alert closed, that connection still
// got javascriptDialogClosed. Measured, Chrome 157, a background tab: javascriptDialogOpening came
// 100ms after alert() was called, with the dialog's type and message.
export function watchDialogs(client: CDP.Client): void {
  watched = client;
  open = null;
  client.Page.javascriptDialogOpening((event) => {
    if (client === watched) open = { type: event.type, message: event.message };
  });
  client.Page.javascriptDialogClosed(() => {
    if (client === watched) open = null;
  });
}

export const currentDialog = (): OpenDialog | null => open;

export const describeDialog = ({ type, message }: OpenDialog): string =>
  `${type === 'alert' ? 'an' : 'a'} ${type} dialog` + (message ? ` (${JSON.stringify(message)})` : '');

// The cause and the advice for a call that timed out while a dialog had not been reported closed.
export const dialogHold = (dialog: OpenDialog): { causes: string; advice: string } => ({
  causes: `held by ${describeDialog(dialog)} that the page opened and that has not been reported closed`,
  advice: 'A dialog holds back every command until it is closed in Chrome. Retry once it is closed.',
});

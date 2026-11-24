let watched = null;
let open = null;
// Called on every new connection, before Page.enable is sent, so that no event is missed.
//
// A dialog that is already open when the connection is made is never recorded. Measured, Chrome
// 157, with an alert open: a new connection's Page.enable was not answered, and no
// javascriptDialogOpening came. Connecting to such a tab fails anyway, because the enables that
// connectToTarget (index.ts) sends are not answered. When the alert closed, that connection still
// got javascriptDialogClosed. Measured, Chrome 157, a background tab: javascriptDialogOpening came
// 100ms after alert() was called, with the dialog's type and message.
export function watchDialogs(client) {
    watched = client;
    open = null;
    client.Page.javascriptDialogOpening((event) => {
        if (client === watched)
            open = { type: event.type, message: event.message };
    });
    client.Page.javascriptDialogClosed(() => {
        if (client === watched)
            open = null;
    });
}
export const currentDialog = () => open;
export const describeDialog = ({ type, message }) => `${type === 'alert' ? 'an' : 'a'} ${type} dialog` + (message ? ` (${JSON.stringify(message)})` : '');
// The cause and the advice for a call that timed out while a dialog had not been reported closed.
export const dialogHold = (dialog) => ({
    causes: `held by ${describeDialog(dialog)} that the page opened and that has not been reported closed`,
    advice: 'A dialog holds back every command until it is closed in Chrome. Retry once it is closed.',
});

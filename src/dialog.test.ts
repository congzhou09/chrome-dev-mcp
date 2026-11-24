import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'vitest';
import type CDP from 'chrome-remote-interface';
import { currentDialog, watchDialogs } from './dialog.js';
import { rendererTimedOut } from './constants.js';

function dialogClient() {
  const events = new EventEmitter();
  const client = {
    Page: {
      javascriptDialogOpening: (listener: (event: unknown) => void) => events.on('opening', listener),
      javascriptDialogClosed: (listener: (event: unknown) => void) => events.on('closed', listener),
    },
  };
  return { client: client as unknown as CDP.Client, events };
}

const opening = (type: string, message = '') => ({ url: 'http://localhost/', message, type, hasBrowserHandler: true });

describe('watchDialogs', () => {
  it('records a dialog from the moment it opens until it closes', () => {
    const { client, events } = dialogClient();
    watchDialogs(client);

    events.emit('opening', opening('confirm', 'Delete?'));
    expect(currentDialog()).toEqual({ type: 'confirm', message: 'Delete?' });

    events.emit('closed', { result: true, userInput: '' });
    expect(currentDialog()).toBeNull();
  });

  it('forgets the previous connection, and ignores its events', () => {
    const old = dialogClient();
    watchDialogs(old.client);
    old.events.emit('opening', opening('alert'));

    watchDialogs(dialogClient().client);
    expect(currentDialog()).toBeNull();

    old.events.emit('opening', opening('alert'));
    expect(currentDialog()).toBeNull();
  });
});

describe('rendererTimedOut', () => {
  it('names the open dialog instead of guessing, whatever causes the call passed', () => {
    const { client, events } = dialogClient();
    watchDialogs(client);
    events.emit('opening', opening('beforeunload'));

    const text = rendererTimedOut('get_html', { causes: 'something else', advice: '' }).content[0].text;

    expect(text).toContain('it is held by a beforeunload dialog that the page opened');
    expect(text).toContain('Retry once it is closed.');
    expect(text).not.toContain('something else');
  });

  it('lists a dialog among the possible causes when none is known to be open', () => {
    watchDialogs(dialogClient().client);

    expect(rendererTimedOut('get_html').content[0].text).toContain(
      'it may be blocked in a synchronous loop, or blocked on a modal dialog',
    );
  });
});

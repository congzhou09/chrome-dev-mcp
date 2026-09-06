import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import pkgInfo from '../package.json' with { type: 'json' };
import { createInspectorSession } from './inspector-session.js';
import { createNetworkCapture } from './network-capture.js';
import { registerConsoleTools } from './tools/console.js';
import { registerDebuggerTools } from './tools/debugger.js';
import { registerNetworkTools } from './tools/network.js';
import { registerPageTools } from './tools/page.js';
import { registerTabTools } from './tools/tabs.js';
// Assembly only. Two session objects own all the mutable state; each tool group is handed
// just the dependencies it actually uses, rather than one shared context object.
//
// The two sessions attach on deliberately different schedules: network capture is eager
// (index.ts calls attachNetwork at connect time, because Network.enable() does not replay
// history), while the Debugger/Console session is lazy (Debugger.enable() has a real cost,
// and Console.enable() replays history whenever it happens to run).
export function createServer(getClient, switchToTarget, getCurrentTargetId) {
    const session = createInspectorSession();
    const networkCapture = createNetworkCapture();
    const server = new McpServer({
        name: pkgInfo.name,
        version: pkgInfo.version,
    });
    registerTabTools(server, { switchToTarget, getCurrentTargetId, session });
    registerPageTools(server, getClient);
    registerDebuggerTools(server, getClient, session);
    registerConsoleTools(server, getClient, session);
    registerNetworkTools(server, getClient, networkCapture);
    return { server, attachNetwork: networkCapture.attach };
}

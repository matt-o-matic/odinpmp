import { routes as billing } from './billing.js';
import { routes as changes } from './changes.js';
import { routes as files } from './files.js';
import { routes as resources } from './resources.js';
import { routes as signing } from './signing.js';
import { routes as tickets } from './tickets.js';
import { routes as workflow } from './workflow.js';
import { routes as workspace } from './workspace.js';

// The MCP routes added by area, each next to the tools that call it. route-access.js checks these
// after its own list.
export const AREA_ROUTES = Object.freeze([...billing, ...changes, ...files, ...resources, ...signing, ...tickets, ...workflow, ...workspace]);

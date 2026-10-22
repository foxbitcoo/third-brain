#!/usr/bin/env node
import { startInstalledWorkbench } from '../src/installed-workbench.mjs';
const server = await startInstalledWorkbench();
process.stdout.write(`第三大脑工作台：http://127.0.0.1:${server.address().port}\n`);

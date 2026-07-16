#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join } from 'path';
import { initCommand } from './init';
import { deployCommand } from './deploy';
import { statusCommand } from './status';
import { logsCommand } from './logs';
import { terminateCommand } from './terminate';
import { fleetCommand } from './fleet';

// package.json is outside rootDir (./src), so readFileSync avoids TS6059
// that a direct `import … from '../../package.json'` would hit.
const { version } = JSON.parse(
  readFileSync(join(__dirname, '../../package.json'), 'utf-8'),
) as { version: string };

const program = new Command();

program
  .name('auraops')
  .description('Deploy AI agents to GPU')
  .version(version);

program.addCommand(initCommand);
program.addCommand(deployCommand);
program.addCommand(statusCommand);
program.addCommand(logsCommand);
program.addCommand(terminateCommand);
program.addCommand(fleetCommand);

program.parse();

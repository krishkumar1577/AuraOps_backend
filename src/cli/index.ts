#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from './init';
import { deployCommand } from './deploy';
import { statusCommand } from './status';
import { logsCommand } from './logs';
import { terminateCommand } from './terminate';
import { fleetCommand } from './fleet';

const program = new Command();

program
  .name('auraops')
  .description('Deploy AI agents to GPU in seconds')
  .version('0.1.0');

program.addCommand(initCommand);
program.addCommand(deployCommand);
program.addCommand(statusCommand);
program.addCommand(logsCommand);
program.addCommand(terminateCommand);
program.addCommand(fleetCommand);

program.parse();

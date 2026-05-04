#!/usr/bin/env node

import { Command } from 'commander';
import { initCommand } from './init';
import { deployCommand } from './deploy';
import { statusCommand } from './status';
import { logsCommand } from './logs';

const program = new Command();

program
  .name('auraops')
  .description('AuraOps - Deterministic AI agent deployment in seconds')
  .version('1.0.0-alpha');

program.addCommand(initCommand);
program.addCommand(deployCommand);
program.addCommand(statusCommand);
program.addCommand(logsCommand);

program.parse();

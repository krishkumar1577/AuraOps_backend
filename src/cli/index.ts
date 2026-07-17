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
import * as ui from './utils';

// package.json is outside rootDir (./src), so readFileSync avoids TS6059
// that a direct `import … from '../../package.json'` would hit.
const { version } = JSON.parse(
  readFileSync(join(__dirname, '../../package.json'), 'utf-8'),
) as { version: string };

const program = new Command();

program
  .name('auraops')
  .description('Deploy Python AI agents to GPU — Modal-first, minimal infra')
  .version(version)
  .addHelpText(
    'beforeAll',
    () => {
      ui.brand(version);
      return '';
    },
  )
  .addHelpText(
    'after',
    `
  ${'examples'}
    auraops init .
    auraops deploy
    auraops deploy --server
    auraops fleet crew.yaml -c 4
    auraops status <id>

  ${'tip'}  missing Modal/API tokens? the CLI will ask (interactive only)
`,
  );

program.addCommand(initCommand);
program.addCommand(deployCommand);
program.addCommand(statusCommand);
program.addCommand(logsCommand);
program.addCommand(terminateCommand);
program.addCommand(fleetCommand);

program.parse();
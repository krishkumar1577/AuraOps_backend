import { detectAndInitializeDocker, validateCustomDockerConnection } from '../utils/dockerDetection';
import * as readline from 'readline';
import * as ui from './utils';

/**
 * Interactive user input
 */
function askUser(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Check and initialize local GPU setup
 */
export async function checkLocalGpuSetup(): Promise<void> {
  ui.header('Checking LocalGPU setup...');
  ui.blank();
  
  const dockerStatus = await detectAndInitializeDocker();
  
  if (dockerStatus.canConnect) {
    ui.success('Docker is ready!');
    ui.success('You can use: auraops deploy --local');
    ui.blank();
    return;
  }
  
  // Docker not available - ask user what to do
  ui.fail('Docker is not available');
  ui.blank();
  process.stdout.write('Options:\n');
  process.stdout.write('1. Manually start Docker and try again\n');
  process.stdout.write('2. Connect to remote Docker daemon (host:port)\n');
  process.stdout.write('3. Skip local GPU testing\n');
  ui.blank();
  
  const answer = await askUser('Choose option (1-3): ');
  
  if (answer === '2') {
    const host = await askUser('Docker host (e.g., localhost): ');
    const portStr = await askUser('Docker port (e.g., 2375): ');
    const port = parseInt(portStr);
    
    if (isNaN(port)) {
      ui.fail('Invalid port number');
      ui.blank();
      return;
    }
    
    const connected = await validateCustomDockerConnection(host, port);
    
    if (connected) {
      ui.blank();
      ui.success(`Connected to Docker at ${host}:${port}`);
      ui.success('You can use: auraops deploy --local');
      ui.blank();
    } else {
      ui.fail('Could not connect to Docker');
      ui.blank();
    }
  } else if (answer === '1') {
    ui.blank();
    ui.info('Please start Docker manually:');
    process.stdout.write('   - macOS: Open Docker Desktop from Applications\n');
    process.stdout.write('   - Linux: Run: sudo systemctl start docker\n');
    process.stdout.write('   - Windows: Start Docker Desktop from Start Menu\n');
    process.stdout.write('\nThen run: auraops check-local-gpu\n\n');
  } else {
    ui.info('Skipping local GPU setup');
    ui.blank();
  }
}

// Run if called directly
if (require.main === module) {
  checkLocalGpuSetup().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    ui.fail(`Error: ${message}`);
    process.exit(1);
  });
}

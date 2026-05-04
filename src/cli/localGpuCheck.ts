import { detectAndInitializeDocker, validateCustomDockerConnection } from '../utils/dockerDetection';
import * as readline from 'readline';

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
  console.log('\n🔍 Checking LocalGPU setup...\n');
  
  const dockerStatus = await detectAndInitializeDocker();
  
  if (dockerStatus.canConnect) {
    console.log('✅ Docker is ready!');
    console.log('✅ You can use: auraops deploy --local\n');
    return;
  }
  
  // Docker not available - ask user what to do
  console.log('❌ Docker is not available\n');
  console.log('Options:');
  console.log('1. Manually start Docker and try again');
  console.log('2. Connect to remote Docker daemon (host:port)');
  console.log('3. Skip local GPU testing\n');
  
  const answer = await askUser('Choose option (1-3): ');
  
  if (answer === '2') {
    const host = await askUser('Docker host (e.g., localhost): ');
    const portStr = await askUser('Docker port (e.g., 2375): ');
    const port = parseInt(portStr);
    
    if (isNaN(port)) {
      console.log('❌ Invalid port number\n');
      return;
    }
    
    const connected = await validateCustomDockerConnection(host, port);
    
    if (connected) {
      console.log(`\n✅ Connected to Docker at ${host}:${port}`);
      console.log('✅ You can use: auraops deploy --local\n');
    } else {
      console.log('❌ Could not connect to Docker\n');
    }
  } else if (answer === '1') {
    console.log('\n📖 Please start Docker manually:');
    console.log('   - macOS: Open Docker Desktop from Applications');
    console.log('   - Linux: Run: sudo systemctl start docker');
    console.log('   - Windows: Start Docker Desktop from Start Menu');
    console.log('\nThen run: auraops check-local-gpu\n');
  } else {
    console.log('ℹ️ Skipping local GPU setup\n');
  }
}

// Run if called directly
if (require.main === module) {
  checkLocalGpuSetup().catch((error) => {
    console.error('❌ Error:', error.message);
    process.exit(1);
  });
}

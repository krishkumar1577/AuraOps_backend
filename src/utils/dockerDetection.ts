import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from './logger';

const execAsync = promisify(exec);

export interface DockerStatus {
  isInstalled: boolean;
  isDaemonRunning: boolean;
  canConnect: boolean;
  connectionInfo?: string;
  error?: string;
}

export interface DockerConnectionOptions {
  method: 'auto-detect' | 'auto-start' | 'manual-socket' | 'manual-tcp';
  socketPath?: string;  // /var/run/docker.sock
  host?: string;        // localhost
  port?: number;        // 2375
}

/**
 * STEP 1: Check if Docker is INSTALLED
 */
async function isDockerInstalled(): Promise<boolean> {
  try {
    await execAsync('docker --version');
    logger.info('✅ Docker is installed');
    return true;
  } catch {
    logger.warn('❌ Docker is NOT installed');
    return false;
  }
}

/**
 * STEP 2: Check if Docker DAEMON is RUNNING
 */
async function isDockerDaemonRunning(): Promise<boolean> {
  try {
    await execAsync('docker ps');
    logger.info('✅ Docker daemon is running');
    return true;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '';
    
    if (errorMsg.includes('Cannot connect to Docker daemon')) {
      logger.warn('⚠️ Docker daemon NOT running');
      return false;
    }
    
    if (errorMsg.includes('permission denied')) {
      logger.warn('⚠️ Docker permission denied - may need sudo');
      return false;
    }
    
    logger.error('❌ Docker error:', errorMsg);
    return false;
  }
}

/**
 * STEP 3: Try to AUTO-START Docker daemon
 * (Platform-specific: macOS, Linux, Windows)
 */
async function tryAutoStartDocker(): Promise<boolean> {
  const platform = process.platform;
  
  try {
    if (platform === 'darwin') {
      // macOS: Use launchctl or Docker Desktop
      logger.info('🔄 Attempting to start Docker on macOS...');
      await execAsync('open -a Docker');
      
      // Wait for Docker to start (max 30 seconds)
      for (let i = 0; i < 30; i++) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1000);
          t.unref?.();
        });
        const running = await isDockerDaemonRunning();
        if (running) {
          logger.info('✅ Docker started successfully on macOS');
          return true;
        }
      }
      logger.warn('⏱️ Docker startup timeout on macOS');
      return false;
    }
    
    if (platform === 'linux') {
      // Linux: Use systemctl
      logger.info('🔄 Attempting to start Docker on Linux...');
      await execAsync('sudo systemctl start docker');
      
      const running = await isDockerDaemonRunning();
      if (running) {
        logger.info('✅ Docker started successfully on Linux');
        return true;
      }
      return false;
    }
    
    if (platform === 'win32') {
      // Windows: Start Docker Desktop
      logger.info('🔄 Attempting to start Docker Desktop on Windows...');
      await execAsync('start "" "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"');
      
      // Wait for Docker to start
      for (let i = 0; i < 30; i++) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 1000);
          t.unref?.();
        });
        const running = await isDockerDaemonRunning();
        if (running) {
          logger.info('✅ Docker Desktop started successfully on Windows');
          return true;
        }
      }
      logger.warn('⏱️ Docker Desktop startup timeout on Windows');
      return false;
    }
  } catch (error) {
    logger.warn('⚠️ Auto-start failed:', error instanceof Error ? error.message : String(error));
    return false;
  }
  
  return false;
}

/**
 * STEP 4: Validate Docker connection
 */
async function validateDockerConnection(): Promise<boolean> {
  try {
    await execAsync('docker ps');
    logger.info('✅ Docker connection validated');
    return true;
  } catch (error) {
    logger.error('❌ Docker connection failed:', error instanceof Error ? error.message : String(error));
    return false;
  }
}

/**
 * MAIN: Complete Docker detection with auto-start
 */
export async function detectAndInitializeDocker(): Promise<DockerStatus> {
  logger.info('🔍 Detecting Docker setup...');
  
  // STEP 1: Check if installed
  const installed = await isDockerInstalled();
  if (!installed) {
    return {
      isInstalled: false,
      isDaemonRunning: false,
      canConnect: false,
      error: 'Docker is not installed. Please install Docker from https://www.docker.com/products/docker-desktop'
    };
  }
  
  // STEP 2: Check if daemon running
  let running = await isDockerDaemonRunning();
  
  // STEP 3: If not running, try to auto-start
  if (!running) {
    logger.info('🔄 Docker daemon not running. Attempting auto-start...');
    const autoStartSuccess = await tryAutoStartDocker();
    
    if (autoStartSuccess) {
      running = true;
    } else {
      // Auto-start failed, tell user what to do
      return {
        isInstalled: true,
        isDaemonRunning: false,
        canConnect: false,
        error: 'Docker daemon is not running and auto-start failed. Please manually start Docker and try again.'
      };
    }
  }
  
  // STEP 4: Validate connection
  const canConnect = await validateDockerConnection();
  
  if (canConnect) {
    return {
      isInstalled: true,
      isDaemonRunning: true,
      canConnect: true,
      connectionInfo: 'Docker is ready to use'
    };
  } else {
    return {
      isInstalled: true,
      isDaemonRunning: true,
      canConnect: false,
      error: 'Docker is running but connection failed. Check Docker daemon health.'
    };
  }
}

/**
 * ALTERNATIVE: Manual container connection
 * (If user has Docker running elsewhere - remote Docker daemon)
 */
export async function validateCustomDockerConnection(
  host: string,
  port: number
): Promise<boolean> {
  try {
    logger.info(`🔄 Validating Docker connection to ${host}:${port}...`);
    
    // Try to connect to remote Docker daemon
    await execAsync(`docker -H tcp://${host}:${port} ps`);
    
    logger.info(`✅ Connected to Docker at ${host}:${port}`);
    return true;
  } catch (error) {
    logger.error(`❌ Cannot connect to Docker at ${host}:${port}`);
    return false;
  }
}

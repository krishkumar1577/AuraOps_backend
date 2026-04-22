export class AuraOpsError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode: number = 500,
    public details?: Record<string, any>,
  ) {
    super(message);
    this.name = 'AuraOpsError';
  }
}

export class ValidationError extends AuraOpsError {
  constructor(message: string, details?: Record<string, any>) {
    super('VALIDATION_ERROR', message, 400, details);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends AuraOpsError {
  constructor(resource: string, id: string) {
    super('NOT_FOUND', `${resource} not found: ${id}`, 404);
    this.name = 'NotFoundError';
  }
}

export class FrameworkDetectionError extends AuraOpsError {
  constructor(message: string) {
    super('FRAMEWORK_DETECTION_ERROR', message, 400);
    this.name = 'FrameworkDetectionError';
  }
}

export class ManifestParsingError extends AuraOpsError {
  constructor(filename: string, message: string) {
    super('MANIFEST_PARSING_ERROR', `Failed to parse ${filename}: ${message}`, 400);
    this.name = 'ManifestParsingError';
  }
}

export class DeploymentError extends AuraOpsError {
  constructor(message: string, details?: Record<string, any>) {
    super('DEPLOYMENT_ERROR', message, 500, details);
    this.name = 'DeploymentError';
  }
}

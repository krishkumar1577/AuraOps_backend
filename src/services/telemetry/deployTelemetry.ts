import axios from 'axios';
import { logger } from '../../utils/logger';
import { config } from '../../utils/config';

const LOOPS_API_BASE = 'https://app.loops.so/api/v1';

export type DeployTelemetryEvent =
  | 'user_registered'
  | 'deploy_started'
  | 'deploy_succeeded'
  | 'deploy_failed'
  | 'first_deploy';

export interface TelemetryPayload {
  email: string;
  eventName: DeployTelemetryEvent;
  properties?: Record<string, string | number | boolean>;
}

/**
 * KRI-9: Fire-and-forget telemetry to Loops.so for CRO email onboarding.
 * Triggers Day 1/4/7 sequences when workflows are configured in Loops dashboard.
 */
export class DeployTelemetry {
  private readonly apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? config.loops_api_key;
  }

  isEnabled(): boolean {
    return this.apiKey.length > 0;
  }

  async trackContact(email: string, userId: string): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    try {
      const start = Date.now();
      await axios.post(
        `${LOOPS_API_BASE}/contacts/create`,
        {
          email,
          userId,
          source: 'auraops-api',
          subscribed: true,
          userGroup: 'deployers',
        },
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          timeout: 5000,
        },
      );
      logger.info(`✓ Loops contact created in ${Date.now() - start}ms: ${email}`);
    } catch (error) {
      logger.warn(
        `Loops contact create failed (non-blocking): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async trackEvent(payload: TelemetryPayload): Promise<void> {
    if (!this.isEnabled()) {
      return;
    }

    try {
      const start = Date.now();
      await axios.post(
        `${LOOPS_API_BASE}/events/send`,
        {
          email: payload.email,
          eventName: payload.eventName,
          eventProperties: payload.properties ?? {},
        },
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          timeout: 5000,
        },
      );
      logger.info(
        `✓ Loops event '${payload.eventName}' sent in ${Date.now() - start}ms: ${payload.email}`,
      );
    } catch (error) {
      logger.warn(
        `Loops event failed (non-blocking): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  trackEventAsync(payload: TelemetryPayload): void {
    void this.trackEvent(payload);
  }
}

export const deployTelemetry = new DeployTelemetry();

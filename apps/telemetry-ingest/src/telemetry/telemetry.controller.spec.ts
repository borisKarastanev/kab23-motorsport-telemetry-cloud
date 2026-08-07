import { MqttContext } from '@nestjs/microservices';
import { TelemetryController } from './telemetry.controller';
import { TelemetryService } from './telemetry.service';

const contextFor = (topic: string) =>
  ({ getTopic: () => topic }) as MqttContext;

describe('TelemetryController', () => {
  let controller: TelemetryController;
  let telemetryService: jest.Mocked<Partial<TelemetryService>>;

  beforeEach(() => {
    telemetryService = {
      handleFrame: jest.fn().mockResolvedValue(undefined),
      handleSessionEvent: jest.fn().mockResolvedValue(undefined),
      handleBackfill: jest.fn().mockResolvedValue(undefined),
    };

    controller = new TelemetryController(
      telemetryService as unknown as TelemetryService,
    );
  });

  describe('handleTelemetry', () => {
    it('extracts the deviceId from the topic and hands off the payload', async () => {
      const payload = { seq: 1 };

      await controller.handleTelemetry(
        payload,
        contextFor('cars/TEST123/telemetry'),
      );

      expect(telemetryService.handleFrame).toHaveBeenCalledWith(
        'TEST123',
        payload,
      );
    });

    it('does nothing when the topic does not match the expected shape', async () => {
      await controller.handleTelemetry({}, contextFor('not/a/known/topic'));

      expect(telemetryService.handleFrame).not.toHaveBeenCalled();
    });

    it('swallows a rejection from the service rather than throwing', async () => {
      telemetryService.handleFrame!.mockRejectedValue(new Error('boom'));

      await expect(
        controller.handleTelemetry({}, contextFor('cars/TEST123/telemetry')),
      ).resolves.toBeUndefined();
    });
  });

  describe('handleSession', () => {
    it('extracts the deviceId from the topic and hands off the payload', async () => {
      const payload = { type: 'start' };

      await controller.handleSession(
        payload,
        contextFor('cars/TEST123/session'),
      );

      expect(telemetryService.handleSessionEvent).toHaveBeenCalledWith(
        'TEST123',
        payload,
      );
    });

    it('does nothing when the topic does not match the expected shape', async () => {
      await controller.handleSession({}, contextFor('cars//session'));

      expect(telemetryService.handleSessionEvent).not.toHaveBeenCalled();
    });
  });

  describe('handleBackfill', () => {
    it('extracts the deviceId from the topic and hands off the payload', async () => {
      const payload = { frames: [] };

      await controller.handleBackfill(
        payload,
        contextFor('cars/TEST123/backfill'),
      );

      expect(telemetryService.handleBackfill).toHaveBeenCalledWith(
        'TEST123',
        payload,
      );
    });

    it('swallows a rejection from the service rather than throwing', async () => {
      telemetryService.handleBackfill!.mockRejectedValue(new Error('boom'));

      await expect(
        controller.handleBackfill({}, contextFor('cars/TEST123/backfill')),
      ).resolves.toBeUndefined();
    });
  });
});

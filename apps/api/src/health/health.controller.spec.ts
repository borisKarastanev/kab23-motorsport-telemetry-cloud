import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports ok status for the api service with a timestamp', () => {
    const controller = new HealthController();

    const result = controller.check();

    expect(result.status).toBe('ok');
    expect(result.service).toBe('api');
    expect(new Date(result.time).toString()).not.toBe('Invalid Date');
  });
});

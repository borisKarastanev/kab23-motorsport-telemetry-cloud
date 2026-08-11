import { MqttCredentialsDto } from './mqtt-credentials.dto';

describe('MqttCredentialsDto', () => {
  it('carries the username, password and issuedAt fields as given', () => {
    const issuedAt = new Date('2026-01-01T00:00:00Z');
    const dto = Object.assign(new MqttCredentialsDto(), {
      username: 'TEST123',
      password: 'broker-secret',
      issuedAt,
    });

    expect(dto).toEqual({
      username: 'TEST123',
      password: 'broker-secret',
      issuedAt,
    });
  });
});

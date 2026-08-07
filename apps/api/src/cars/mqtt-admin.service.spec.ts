import { EventEmitter } from 'events';
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect } from 'mqtt';
import {
  carPublishTopics,
  carRoleName,
  DYNSEC_RESPONSE_TOPIC,
} from '@app/common';
import { MqttAdminService } from './mqtt-admin.service';

jest.mock('mqtt', () => ({ connect: jest.fn() }));

const COMMAND_TIMEOUT_MS = 5_000;
const DEVICE_ID = 'DEVICE-1';
const TOPIC_COUNT = carPublishTopics(DEVICE_ID).length;

/**
 * Minimal stand-in for mqtt.js's `MqttClient`: an EventEmitter plus the three
 * methods `MqttAdminService` calls on it. Real mqtt.js is never loaded — the
 * `mqtt` module is replaced above so `connect()` hands the service one of
 * these instead of opening a socket.
 */
class FakeMqttClient extends EventEmitter {
  connected = false;
  subscribe = jest.fn(
    (_topic: string, _opts: unknown, cb?: (error?: Error) => void) => cb?.(),
  );
  publish = jest.fn(
    (
      _topic: string,
      _payload: string,
      _opts: unknown,
      cb?: (error?: Error) => void,
    ) => cb?.(),
  );
  end = jest.fn();
}

const configFor = (overrides: Record<string, unknown> = {}): ConfigService => {
  const values: Record<string, unknown> = {
    MQTT_ADMIN_USERNAME: 'admin',
    MQTT_ADMIN_PASSWORD: 'admin-secret-dummy',
    MQTT_URL: 'mqtt://localhost:1883',
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService;
};

/** Waits for the next `client.publish` call and returns the command it sent. */
async function nextCommand(
  client: FakeMqttClient,
): Promise<Record<string, unknown>> {
  const before = client.publish.mock.calls.length;
  for (let i = 0; i < 20 && client.publish.mock.calls.length === before; i++) {
    await Promise.resolve();
  }
  const call = client.publish.mock.calls[client.publish.mock.calls.length - 1];
  if (!call) {
    throw new Error('Expected a command to have been published by now');
  }
  return JSON.parse(call[1] as string).commands[0];
}

function emitResponse(
  client: FakeMqttClient,
  response: { command: string; error?: string; data?: unknown },
): void {
  client.emit(
    'message',
    DYNSEC_RESPONSE_TOPIC,
    Buffer.from(JSON.stringify({ responses: [response] })),
  );
}

/** Waits for the next command and answers it as a success, optionally with data. */
async function respondSuccess(
  client: FakeMqttClient,
  data?: unknown,
): Promise<Record<string, unknown>> {
  const command = await nextCommand(client);
  emitResponse(client, { command: command.command as string, data });
  return command;
}

/** Waits for the next command and answers it with the given error string. */
async function respondError(
  client: FakeMqttClient,
  error: string,
): Promise<Record<string, unknown>> {
  const command = await nextCommand(client);
  emitResponse(client, { command: command.command as string, error });
  return command;
}

describe('MqttAdminService', () => {
  let client: FakeMqttClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new FakeMqttClient();
    (connect as jest.Mock).mockImplementation(() => client);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const createConnectedService = (): MqttAdminService => {
    const service = new MqttAdminService(configFor());
    service.onModuleInit();
    client.connected = true;
    return service;
  };

  describe('onModuleInit', () => {
    it('refuses to boot without an admin username', () => {
      const service = new MqttAdminService(
        configFor({ MQTT_ADMIN_USERNAME: undefined }),
      );

      expect(() => service.onModuleInit()).toThrow(
        'MQTT_ADMIN_USERNAME and MQTT_ADMIN_PASSWORD are required',
      );
      expect(connect).not.toHaveBeenCalled();
    });

    it('refuses to boot without an admin password', () => {
      const service = new MqttAdminService(
        configFor({ MQTT_ADMIN_PASSWORD: undefined }),
      );

      expect(() => service.onModuleInit()).toThrow(
        'MQTT_ADMIN_USERNAME and MQTT_ADMIN_PASSWORD are required',
      );
      expect(connect).not.toHaveBeenCalled();
    });

    it('connects with the configured admin credentials', () => {
      const service = new MqttAdminService(configFor());

      service.onModuleInit();

      expect(connect).toHaveBeenCalledWith('mqtt://localhost:1883', {
        username: 'admin',
        password: 'admin-secret-dummy',
        reconnectPeriod: 5_000,
      });
    });

    it('subscribes to the dynsec response topic once connected', () => {
      const service = new MqttAdminService(configFor());
      service.onModuleInit();

      client.emit('connect');

      expect(client.subscribe).toHaveBeenCalledWith(
        DYNSEC_RESPONSE_TOPIC,
        { qos: 1 },
        expect.any(Function),
      );
    });

    it('logs a subscribe failure instead of crashing', () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      client.subscribe.mockImplementationOnce((_t, _o, cb) =>
        cb(new Error('not authorized')),
      );
      const service = new MqttAdminService(configFor());
      service.onModuleInit();

      client.emit('connect');

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('not authorized'),
      );
    });

    it('warns rather than throws on a broker connection error', () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const service = new MqttAdminService(configFor());
      service.onModuleInit();

      client.emit('error', new Error('ECONNREFUSED'));

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('ECONNREFUSED'),
      );
    });
  });

  describe('onApplicationShutdown', () => {
    it('ends the client connection', () => {
      const service = createConnectedService();

      service.onApplicationShutdown();

      expect(client.end).toHaveBeenCalledWith(true);
    });

    it('does nothing if the client never connected', () => {
      const service = new MqttAdminService(configFor());

      expect(() => service.onApplicationShutdown()).not.toThrow();
    });
  });

  describe('command plumbing', () => {
    it('rejects immediately when the broker is not connected', async () => {
      const service = new MqttAdminService(configFor());
      service.onModuleInit();
      client.connected = false;

      await expect(service.removeCar(DEVICE_ID)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      await expect(service.removeCar(DEVICE_ID)).rejects.toThrow(
        'MQTT broker unavailable',
      );
      expect(client.publish).not.toHaveBeenCalled();
    });

    it('times out a command that gets no response', async () => {
      jest.useFakeTimers();
      const service = createConnectedService();

      const result = service.removeCar(DEVICE_ID);
      const rejection = expect(result).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      const messageCheck = expect(result).rejects.toThrow(
        'MQTT broker did not respond',
      );
      await jest.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);
      await rejection;
      await messageCheck;
    });

    it('rejects when mqtt.js reports a publish failure', async () => {
      const service = createConnectedService();
      client.publish.mockImplementationOnce((_t, _p, _o, cb) =>
        cb(new Error('connection closed')),
      );

      await expect(service.removeCar(DEVICE_ID)).rejects.toThrow(
        'Could not reach the MQTT broker',
      );
    });

    it('ignores a stale publish callback for a command already superseded by another', async () => {
      // Regression guard for the race documented on `sendNow`'s publish
      // callback: mqtt.js flushes pending QoS 1 callbacks with an error when
      // a connection closes, and an unqualified settle would reject
      // whichever command happened to be in flight by then rather than the
      // one the callback actually belongs to.
      jest.useFakeTimers();
      const service = createConnectedService();

      const firstCall = service.removeCar('CAR-A');
      // Attached immediately so the rejection below never has a tick without
      // a handler — otherwise Node's unhandled-rejection bookkeeping can
      // misattribute it to whatever test happens to be running when it is
      // finally observed.
      firstCall.catch(() => undefined);
      await nextCommand(client); // deleteClient for CAR-A is now in flight
      const staleCallback = client.publish.mock.calls[0][3] as (
        error?: Error,
      ) => void;

      await jest.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);
      await expect(firstCall).rejects.toThrow('MQTT broker did not respond');

      // A second, unrelated caller's command has taken the in-flight slot.
      const secondCall = service.removeCar('CAR-B');
      await nextCommand(client);

      // CAR-A's publish callback finally fires late.
      staleCallback(new Error('connection closed'));

      // CAR-B must be unaffected by CAR-A's stale callback.
      await respondSuccess(client); // deleteClient for CAR-B
      await respondSuccess(client); // deleteRole for CAR-B
      await expect(secondCall).resolves.toBeUndefined();
    });

    it('ignores a response with no command in flight', () => {
      createConnectedService();

      expect(() =>
        emitResponse(client, { command: 'createRole' }),
      ).not.toThrow();
    });

    it('warns on an unparseable response and lets the command time out', async () => {
      jest.useFakeTimers();
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const service = createConnectedService();

      const result = service.removeCar(DEVICE_ID);
      await nextCommand(client);
      client.emit('message', DYNSEC_RESPONSE_TOPIC, Buffer.from('not json'));

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Unparseable'),
      );

      const rejection = expect(result).rejects.toThrow(
        'MQTT broker did not respond',
      );
      await jest.advanceTimersByTimeAsync(COMMAND_TIMEOUT_MS);
      await rejection;
    });

    it('ignores a response naming a different command than the one in flight', async () => {
      const service = createConnectedService();

      const result = service.removeCar(DEVICE_ID);
      await nextCommand(client); // deleteClient is in flight
      emitResponse(client, { command: 'createRole' }); // unrelated, ignored

      await respondSuccess(client); // the real deleteClient response
      await respondSuccess(client); // deleteRole
      await expect(result).resolves.toBeUndefined();
    });
  });

  describe('ensureCar', () => {
    it('creates the role, its publish ACLs, the client account, and grants the role', async () => {
      const service = createConnectedService();

      const result = service.ensureCar(DEVICE_ID);

      const createRole = await respondSuccess(client);
      expect(createRole).toMatchObject({
        command: 'createRole',
        rolename: carRoleName(DEVICE_ID),
      });

      const topics = carPublishTopics(DEVICE_ID);
      for (let i = 0; i < topics.length; i++) {
        const acl = await respondSuccess(client);
        expect(acl).toMatchObject({
          command: 'addRoleACL',
          rolename: carRoleName(DEVICE_ID),
          topic: topics[i],
          allow: true,
        });
      }

      const createClient = await respondSuccess(client);
      expect(createClient).toMatchObject({
        command: 'createClient',
        username: DEVICE_ID,
      });

      const getClient = await respondSuccess(client, {
        client: { username: DEVICE_ID, roles: [] },
      });
      expect(getClient).toMatchObject({
        command: 'getClient',
        username: DEVICE_ID,
      });

      const addClientRole = await respondSuccess(client);
      expect(addClientRole).toMatchObject({
        command: 'addClientRole',
        username: DEVICE_ID,
        rolename: carRoleName(DEVICE_ID),
      });

      await expect(result).resolves.toBeUndefined();
    });

    it('tolerates every "already exists" response while re-provisioning', async () => {
      const service = createConnectedService();

      const result = service.ensureCar(DEVICE_ID);

      await respondError(client, 'Role already exists'); // createRole
      for (let i = 0; i < TOPIC_COUNT; i++) {
        await respondError(client, 'ACL already in role'); // addRoleACL
      }
      await respondError(client, 'Client already exists'); // createClient
      await respondSuccess(client, {
        client: { username: DEVICE_ID, roles: [] },
      }); // getClient
      await respondSuccess(client); // addClientRole

      await expect(result).resolves.toBeUndefined();
    });

    it('skips granting the role when the client already holds it', async () => {
      const service = createConnectedService();

      const result = service.ensureCar(DEVICE_ID);

      await respondSuccess(client); // createRole
      for (let i = 0; i < TOPIC_COUNT; i++) {
        await respondSuccess(client); // addRoleACL
      }
      await respondSuccess(client); // createClient
      await respondSuccess(client, {
        client: {
          username: DEVICE_ID,
          roles: [{ rolename: carRoleName(DEVICE_ID) }],
        },
      }); // getClient: already has the role

      await expect(result).resolves.toBeUndefined();
      // createRole + 3 ACLs + createClient + getClient, and no addClientRole.
      expect(client.publish).toHaveBeenCalledTimes(3 + TOPIC_COUNT);
    });

    it('treats a getClient "not found" as no role and proceeds to grant it', async () => {
      const service = createConnectedService();

      const result = service.ensureCar(DEVICE_ID);

      await respondSuccess(client); // createRole
      for (let i = 0; i < TOPIC_COUNT; i++) {
        await respondSuccess(client); // addRoleACL
      }
      await respondSuccess(client); // createClient
      await respondError(client, 'Client does not exist'); // getClient, tolerated
      const addClientRole = await respondSuccess(client);
      expect(addClientRole.command).toBe('addClientRole');

      await expect(result).resolves.toBeUndefined();
    });

    it('does not swallow the "Internal error" quirk from re-adding a held role', async () => {
      // Documented regression: Mosquitto reports every other duplicate as
      // "already exists", but re-adding a role the client already holds
      // comes back as a bare "Internal error" — indistinguishable from a
      // real failure, so it must not be tolerated. `ensureCar` avoids ever
      // hitting this in practice by checking getClient first; this proves
      // that if addClientRole is ever reached anyway, the error still
      // propagates instead of being silently absorbed.
      const service = createConnectedService();

      const result = service.ensureCar(DEVICE_ID);

      await respondSuccess(client); // createRole
      for (let i = 0; i < TOPIC_COUNT; i++) {
        await respondSuccess(client); // addRoleACL
      }
      await respondSuccess(client); // createClient
      await respondSuccess(client, {
        client: { username: DEVICE_ID, roles: [] },
      }); // getClient: role not present, addClientRole is attempted
      await respondError(client, 'Internal error');

      await expect(result).rejects.toThrow('Internal error');
    });

    it('propagates a non-tolerated failure and stops the sequence', async () => {
      const service = createConnectedService();

      const result = service.ensureCar(DEVICE_ID);
      await respondError(client, 'Internal error'); // createRole fails hard

      await expect(result).rejects.toThrow('Internal error');
      expect(client.publish).toHaveBeenCalledTimes(1); // no ACLs attempted
    });
  });

  describe('issuePassword', () => {
    it('provisions the car and returns a fresh, URL-safe secret', async () => {
      const service = createConnectedService();
      jest.spyOn(service, 'ensureCar').mockResolvedValue(undefined);

      const resultPromise = service.issuePassword(DEVICE_ID);
      const setPassword = await respondSuccess(client);
      const password = await resultPromise;

      expect(service.ensureCar).toHaveBeenCalledWith(DEVICE_ID);
      expect(setPassword).toMatchObject({
        command: 'setClientPassword',
        username: DEVICE_ID,
      });
      expect(setPassword.password).toBe(password);
      expect(password).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    });

    it('propagates ensureCar failures without setting a password', async () => {
      const service = createConnectedService();
      jest
        .spyOn(service, 'ensureCar')
        .mockRejectedValue(new ServiceUnavailableException());

      await expect(service.issuePassword(DEVICE_ID)).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(client.publish).not.toHaveBeenCalled();
    });
  });

  describe('removeCar', () => {
    it('deletes the client and the role', async () => {
      const service = createConnectedService();

      const result = service.removeCar(DEVICE_ID);
      const deleteClient = await respondSuccess(client);
      const deleteRole = await respondSuccess(client);

      expect(deleteClient).toMatchObject({
        command: 'deleteClient',
        username: DEVICE_ID,
      });
      expect(deleteRole).toMatchObject({
        command: 'deleteRole',
        rolename: carRoleName(DEVICE_ID),
      });
      await expect(result).resolves.toBeUndefined();
    });

    it('tolerates deleting a car that was already gone', async () => {
      const service = createConnectedService();

      const result = service.removeCar(DEVICE_ID);
      await respondError(client, 'Client not found');
      await respondError(client, 'Role does not exist');

      await expect(result).resolves.toBeUndefined();
    });

    it('stops before deleting the role if deleting the client fails hard', async () => {
      const service = createConnectedService();

      const result = service.removeCar(DEVICE_ID);
      await respondError(client, 'Internal error');

      await expect(result).rejects.toThrow('Internal error');
      expect(client.publish).toHaveBeenCalledTimes(1);
    });
  });

  describe('credential hygiene', () => {
    it('never logs a command payload or the issued password', async () => {
      const logSpy = jest
        .spyOn(Logger.prototype, 'log')
        .mockImplementation(() => undefined);
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const errorSpy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const debugSpy = jest
        .spyOn(Logger.prototype, 'debug')
        .mockImplementation(() => undefined);
      const service = createConnectedService();

      const resultPromise = service.issuePassword(DEVICE_ID);

      await respondSuccess(client); // createRole
      for (let i = 0; i < TOPIC_COUNT; i++) {
        await respondSuccess(client); // addRoleACL
      }
      await respondSuccess(client); // createClient
      await respondSuccess(client, {
        client: { username: DEVICE_ID, roles: [] },
      }); // getClient
      await respondSuccess(client); // addClientRole
      await respondSuccess(client); // setClientPassword

      const password = await resultPromise;

      for (const spy of [logSpy, warnSpy, errorSpy, debugSpy]) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(password);
        }
      }
    });
  });
});

import { randomBytes } from 'crypto';
import {
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { connect, MqttClient } from 'mqtt';
import {
  carPublishTopics,
  carRoleName,
  DYNSEC_COMMAND_TOPIC,
  DYNSEC_RESPONSE_TOPIC,
} from '@app/common';

/** How long to wait for the broker to answer one command. */
const COMMAND_TIMEOUT_MS = 5_000;

/**
 * Error fragments that mean "the thing I asked you to create is already there".
 * Matched case-insensitively as substrings because the exact wording is the
 * broker's, not ours, and provisioning has to stay idempotent across it.
 */
const ALREADY_PRESENT = ['already exists', 'already in'];
const NOT_PRESENT = ['not found', 'does not exist'];

interface DynsecResponse {
  command: string;
  error?: string;
  data?: {
    client?: { username: string; roles?: { rolename: string }[] };
  };
}

/**
 * Manages per-car broker accounts through Mosquitto's dynamic-security plugin.
 *
 * A car is not a user: it authenticates to the broker with its own credential
 * and is confined by ACL to publishing on `cars/<its-deviceId>/…`. Nothing here
 * ever grants a car a subscription — a device has no reason to read the broker,
 * and denying it removes the easiest cross-tenant read.
 *
 * Commands go to `$CONTROL/dynamic-security/v1` and are answered on the
 * corresponding response topic. The protocol carries no request id, so commands
 * are serialised one-in-flight and matched to responses by arrival order.
 *
 * Nothing in this class logs a command payload: they carry car credentials in
 * plaintext.
 */
@Injectable()
export class MqttAdminService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MqttAdminService.name);
  private client?: MqttClient;
  private inFlight: {
    /**
     * Identity for this attempt. The command *name* is not enough to settle
     * against: `ensureCar` sends three `addRoleACL` commands in a row, so a
     * response that arrives after its own command timed out would name-match
     * the next one and resolve it against someone else's outcome.
     */
    token: number;
    command: string;
    resolve: (response: DynsecResponse | null) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;
  private nextToken = 0;
  /** Serialises commands; see the class comment on response correlation. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    const username = this.configService.get<string>('MQTT_ADMIN_USERNAME');
    const password = this.configService.get<string>('MQTT_ADMIN_PASSWORD');

    // Enforced here rather than in config.schema.ts, which every process shares
    // — see the comment there. Failing at boot is right: without these no car
    // can ever be provisioned, and finding that out at the track is too late.
    if (!username || !password) {
      throw new Error(
        'MQTT_ADMIN_USERNAME and MQTT_ADMIN_PASSWORD are required by the API ' +
          'to provision car broker accounts',
      );
    }

    this.client = connect(this.configService.get<string>('MQTT_URL'), {
      username,
      password,
      reconnectPeriod: 5_000,
    });

    this.client.on('connect', () => {
      this.client.subscribe(DYNSEC_RESPONSE_TOPIC, { qos: 1 }, (error) => {
        if (error) {
          this.logger.error(
            `Could not subscribe to the dynamic-security response topic: ${error.message}`,
          );
        }
      });
    });

    this.client.on('message', (_topic, payload) => this.onResponse(payload));

    // Warn rather than throw: the API must still boot and serve everything that
    // does not touch the broker when the broker is down. Provisioning calls
    // fail on their own with a 503.
    this.client.on('error', (error) =>
      this.logger.warn(`Broker connection error: ${error.message}`),
    );
  }

  onApplicationShutdown(): void {
    this.client?.end(true);
  }

  /**
   * Makes the car exist at the broker: its role, its publish ACLs, and a client
   * account holding that role.
   *
   * The account is created with a random password that is immediately thrown
   * away, so the car exists but cannot yet connect. A usable credential is only
   * ever produced by `issuePassword`, which is the one path that returns a
   * secret to a caller.
   *
   * Idempotent — safe to call on a car that is already provisioned, which is
   * what lets `issuePassword` heal a car whose creation raced a broker outage.
   */
  async ensureCar(deviceId: string): Promise<void> {
    const rolename = carRoleName(deviceId);

    await this.send({ command: 'createRole', rolename }, ALREADY_PRESENT);

    for (const topic of carPublishTopics(deviceId)) {
      await this.send(
        {
          command: 'addRoleACL',
          rolename,
          acltype: 'publishClientSend',
          topic,
          priority: 0,
          allow: true,
        },
        ALREADY_PRESENT,
      );
    }

    await this.send(
      {
        command: 'createClient',
        username: deviceId,
        password: MqttAdminService.generateSecret(),
      },
      ALREADY_PRESENT,
    );

    // Checked rather than tolerated. Every other duplicate here comes back as
    // "already exists", but re-adding a role the client already holds is
    // reported as a bare **"Internal error"** — indistinguishable from a real
    // failure, so it cannot go in ALREADY_PRESENT without also swallowing the
    // case where the car genuinely ends up with no role and silently cannot
    // publish. Verified against Mosquitto 2.1.2.
    if (!(await this.clientHasRole(deviceId, rolename))) {
      await this.send({
        command: 'addClientRole',
        username: deviceId,
        rolename,
        priority: -1,
      });
    }
  }

  private async clientHasRole(
    deviceId: string,
    rolename: string,
  ): Promise<boolean> {
    const response = await this.request(
      { command: 'getClient', username: deviceId },
      NOT_PRESENT,
    );

    return Boolean(
      response?.data?.client?.roles?.some((role) => role.rolename === rolename),
    );
  }

  /**
   * Issues a fresh credential for the car and returns it. This is the only
   * moment the secret exists outside the broker — the platform stores no copy,
   * so a caller that loses it must rotate rather than look it up.
   *
   * Rotation is the same call: setting a new password invalidates the old one.
   */
  async issuePassword(deviceId: string): Promise<string> {
    await this.ensureCar(deviceId);

    const password = MqttAdminService.generateSecret();
    await this.send({
      command: 'setClientPassword',
      username: deviceId,
      password,
    });

    return password;
  }

  /**
   * Revokes the car's broker access and removes its role.
   *
   * Callers must treat a failure here as fatal to whatever they were doing: a
   * car whose row is gone but whose broker account survives is a device that
   * still authenticates and still publishes, with nothing in the platform left
   * to show for it.
   */
  async removeCar(deviceId: string): Promise<void> {
    await this.send(
      { command: 'deleteClient', username: deviceId },
      NOT_PRESENT,
    );
    await this.send(
      { command: 'deleteRole', rolename: carRoleName(deviceId) },
      NOT_PRESENT,
    );
  }

  // ---------------------------------------------------------------------------
  // Command plumbing
  // ---------------------------------------------------------------------------

  private async send(
    command: Record<string, unknown>,
    tolerate: string[] = [],
  ): Promise<void> {
    await this.request(command, tolerate);
  }

  /**
   * As `send`, but resolves with the broker's response so a caller can read
   * `data` — needed by the handful of commands that are queries rather than
   * mutations. Null when the command failed in a tolerated way.
   */
  private async request(
    command: Record<string, unknown>,
    tolerate: string[] = [],
  ): Promise<DynsecResponse | null> {
    const run = () => this.sendNow(command);
    // Chained through both settle paths so one failed command does not strand
    // every command queued behind it.
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );

    try {
      return await result;
    } catch (error) {
      // A tolerated error is a no-op, not a failure: it means the object was
      // already in the state we were asking for. Null rather than a response,
      // because there is no result to read. Applied here rather than inside the
      // correlation record so that record stays pure plumbing — and so the
      // broker-unavailable rejections, which no caller tolerates, cannot be
      // caught by a fragment match.
      const message = (error as Error).message.toLowerCase();
      if (tolerate.some((fragment) => message.includes(fragment))) {
        return null;
      }
      throw error;
    }
  }

  private sendNow(
    command: Record<string, unknown>,
  ): Promise<DynsecResponse | null> {
    if (!this.client?.connected) {
      return Promise.reject(
        new ServiceUnavailableException('MQTT broker unavailable'),
      );
    }

    const token = ++this.nextToken;

    return new Promise<DynsecResponse | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(token, () =>
          reject(
            new ServiceUnavailableException('MQTT broker did not respond'),
          ),
        );
      }, COMMAND_TIMEOUT_MS);

      this.inFlight = {
        token,
        command: command.command as string,
        timer,
        resolve,
        reject,
      };

      this.client.publish(
        DYNSEC_COMMAND_TOPIC,
        JSON.stringify({ commands: [command] }),
        { qos: 1 },
        (error) => {
          if (error) {
            // Keyed on this attempt's token: mqtt.js flushes pending QoS 1
            // callbacks with an error when a connection closes, and an
            // unqualified settle here would clear whichever command happened to
            // be in flight by then — leaving that one with no timer and no
            // correlation entry, so it never settles and the queue behind it
            // deadlocks for the life of the process.
            this.settle(token, () =>
              reject(
                new ServiceUnavailableException(
                  'Could not reach the MQTT broker',
                ),
              ),
            );
          }
        },
      );
    });
  }

  private onResponse(payload: Buffer): void {
    if (!this.inFlight) {
      return;
    }

    let response: DynsecResponse | undefined;
    try {
      response = (
        JSON.parse(payload.toString()) as { responses?: DynsecResponse[] }
      ).responses?.[0];
    } catch {
      // Malformed frames are the broker's problem, not a command outcome; the
      // in-flight command falls through to its timeout.
      this.logger.warn('Unparseable dynamic-security response');
      return;
    }

    if (!response || response.command !== this.inFlight.command) {
      // Out-of-order or unsolicited: leave the in-flight command alone rather
      // than resolving it against somebody else's answer.
      return;
    }

    const { reject, resolve, token } = this.inFlight;
    this.settle(token, () =>
      response.error ? reject(new Error(response.error)) : resolve(response),
    );
  }

  /**
   * Completes `token`'s command, but only if it is still the one in flight — a
   * late callback for an abandoned command must not touch its successor.
   */
  private settle(token: number, finish: () => void): void {
    if (this.inFlight?.token !== token) {
      return;
    }

    clearTimeout(this.inFlight.timer);
    this.inFlight = null;
    finish();
  }

  /** 256 bits, URL-safe — it has to survive being pasted into a device config. */
  private static generateSecret(): string {
    return randomBytes(32).toString('base64url');
  }
}

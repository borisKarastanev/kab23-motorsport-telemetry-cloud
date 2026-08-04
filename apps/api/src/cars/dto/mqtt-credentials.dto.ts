/**
 * A car's broker credential, returned exactly once by
 * `POST /cars/:id/mqtt-credentials`.
 *
 * The platform keeps no copy — not plaintext, not hashed. If it is lost, the
 * only recovery is to call the endpoint again, which rotates the credential and
 * invalidates the previous one.
 */
export class MqttCredentialsDto {
  /** The car's `deviceId`; also the `<deviceId>` in every `cars/<deviceId>/…` topic. */
  username: string;

  /** Shown once. Not recoverable. */
  password: string;

  issuedAt: Date;
}

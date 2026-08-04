import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

@Module({
  imports: [
    PinoLoggerModule.forRoot({
      pinoHttp: {
        transport: {
          target: 'pino-pretty',
          options: {
            singleLine: true,
          },
        },
        // pino-http logs req.headers by default, which carries the JWT in the
        // `Authentication` cookie. Strip every credential-bearing field before
        // it reaches a log sink. Extend this list when new secrets appear.
        redact: {
          paths: [
            'req.headers.cookie',
            'req.headers.authorization',
            'req.headers.authentication',
            'res.headers["set-cookie"]',
            'req.body.password',
            'req.body.token',
            // Broker credentials (MqttAdminService, car provisioning). The
            // wildcards are defence in depth for any future log line that hands
            // pino an object carrying one — the provisioning path itself never
            // logs a command payload.
            'req.body.mqttPassword',
            '*.password',
            '*.mqttPassword',
          ],
          remove: true,
        },
      },
    }),
  ],
})
export class LoggerModule {}

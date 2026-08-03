import { DatabaseModule, LoggerModule } from '@app/common';
import { Module } from '@nestjs/common';
import { CarsModule } from '../cars/cars.module';
import { TeamsModule } from '../teams/teams.module';
import { SessionsController } from './sessions.controller';
import { SessionsService } from './sessions.service';
import { SessionsRepository } from './sessions.repository';
import { Session } from './entities/session.entity';

@Module({
  imports: [
    DatabaseModule.forFeature([Session]),
    LoggerModule,
    CarsModule,
    TeamsModule,
  ],
  controllers: [SessionsController],
  providers: [SessionsService, SessionsRepository],
  exports: [SessionsService],
})
export class SessionsModule {}

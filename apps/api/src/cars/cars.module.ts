import { DatabaseModule, LoggerModule } from '@app/common';
import { Module } from '@nestjs/common';
import { TeamsModule } from '../teams/teams.module';
import { CarsController } from './cars.controller';
import { CarsService } from './cars.service';
import { CarsRepository } from './cars.repository';
import { Car } from './entities/car.entity';

@Module({
  imports: [DatabaseModule.forFeature([Car]), LoggerModule, TeamsModule],
  controllers: [CarsController],
  providers: [CarsService, CarsRepository],
  // Sessions scope themselves through the car they belong to.
  exports: [CarsService],
})
export class CarsModule {}

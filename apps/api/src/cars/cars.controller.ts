import { AuthenticatedUser } from '@app/common';
import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { User } from '../users/entities/user.entity';
import { CarsService } from './cars.service';
import { Car } from './entities/car.entity';
import { CreateCarDto } from './dto/create-car.dto';
import { UpdateCarDto } from './dto/update-car.dto';
import { MqttCredentialsDto } from './dto/mqtt-credentials.dto';

@Controller('cars')
@UseGuards(JwtAuthGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class CarsController {
  constructor(private readonly carsService: CarsService) {}

  @Post()
  create(
    @AuthenticatedUser() user: User,
    @Body() createCarDto: CreateCarDto,
  ): Promise<Car> {
    return this.carsService.create(user, createCarDto);
  }

  @Get()
  findAll(@AuthenticatedUser() user: User): Promise<Car[]> {
    return this.carsService.findAll(user);
  }

  @Get(':id')
  findOne(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Car> {
    return this.carsService.findOne(user, id);
  }

  @Patch(':id')
  update(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() updateCarDto: UpdateCarDto,
  ): Promise<Car> {
    return this.carsService.update(user, id, updateCarDto);
  }

  /**
   * Issues or rotates this car's broker credential.
   *
   * POST, not GET: it mints a new secret and invalidates the previous one, so
   * it is neither safe nor idempotent. The password appears in this response
   * and nowhere else — the platform keeps no copy to look up later.
   */
  @Post(':id/mqtt-credentials')
  issueMqttCredentials(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<MqttCredentialsDto> {
    return this.carsService.issueMqttCredentials(user, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @AuthenticatedUser() user: User,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.carsService.remove(user, id);
  }
}
